/**
 * Mermaid pipeline (L0 → symbolic short-term memory).
 *
 * Adapted from TencentDB Agent Memory's symbolic memory concept (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 *
 * Three-layer compression:
 *   bottom = raw tool output offloaded to refs/*.md (filesystem)
 *   middle = step-level summary (jsonl, stored in canvas nodes)
 *   top    = Mermaid graph with node_id (kept in context, ~hundreds of tokens)
 *
 * The agent reasons over the Mermaid graph. To drill down to raw output,
 * it calls ref_read(node_id) which reads the corresponding refs/*.md file.
 */

import { generateId } from "../utils/ulid.js";
import type {
  CaptureInput,
  LLMClient,
  MermaidCanvas,
  MermaidEdge,
  MermaidNode,
  PipelineContext,
  PipelineOutput,
  PipelineStage,
} from "./types.js";

/**
 * Mermaid pipeline — extracts state transitions from a capture and appends
 * a node to the session's Mermaid canvas.
 *
 * Unlike AtomPipeline, this is short-term (per-session) not long-term.
 * It runs after every capture, regardless of type.
 */
export class MermaidPipeline implements PipelineStage {
  readonly name = "mermaid";
  readonly requiresLLM = false;

  async process(input: CaptureInput, ctx: PipelineContext): Promise<PipelineOutput> {
    // Generate a node for this capture
    const nodeId = generateId();
    const label = extractNodeLabel(input);
    const node: MermaidNode = {
      id: nodeId,
      label,
      captureId: input.id,
    };

    // Build edges: link to previous node in the same session (if any)
    const edges: MermaidEdge[] = [];
    try {
      const prevNode = await ctx.storage.getLatestCanvasNode(input.sessionKey);
      if (prevNode) {
        edges.push({
          from: prevNode.id,
          to: nodeId,
          label: inferEdgeLabel(prevNode, input),
        });
      }
    } catch {
      // getLatestCanvasNode may not exist on all backends — skip edge
    }

    // Save the node + edges to the canvas
    try {
      await ctx.storage.appendCanvasNode(input.sessionKey, node, edges);
    } catch {
      // appendCanvasNode may not exist — canvas is best-effort
    }

    // Offload raw content to refs/*.md (filesystem, not DB)
    // The ref file path is deterministic: refs/{sessionKey}/{nodeId}.md
    // Agent can drill down via ref_read(node_id)
    try {
      await ctx.storage.writeRef(input.sessionKey, nodeId, input.content);
    } catch {
      // writeRef may not exist — offload is best-effort
    }

    const canvas: MermaidCanvas = { nodes: [node], edges };
    return { canvas };
  }
}

/**
 * Mermaid pipeline with LLM — uses an LLM to generate richer node labels
 * and edge labels (e.g., "fixed bug", "tested", "refactored").
 */
export class LLMMermaidPipeline implements PipelineStage {
  readonly name = "mermaid-llm";
  readonly requiresLLM = true;

  constructor(private llm: LLMClient) {}

  async process(input: CaptureInput, ctx: PipelineContext): Promise<PipelineOutput> {
    const nodeId = generateId();

    // Use LLM to generate a concise label (max 40 chars)
    let label = extractNodeLabel(input);
    try {
      const prompt = `Summarize this ${input.type} in max 40 characters. Output ONLY the summary, no quotes:\n\n${input.content.slice(0, 500)}`;
      const response = await this.llm.complete(prompt);
      label = response.trim().slice(0, 40);
    } catch {
      // Fall back to rule-based label
    }

    const node: MermaidNode = { id: nodeId, label, captureId: input.id };
    const edges: MermaidEdge[] = [];

    try {
      const prevNode = await ctx.storage.getLatestCanvasNode(input.sessionKey);
      if (prevNode) {
        let edgeLabel = inferEdgeLabel(prevNode, input);
        try {
          const edgePrompt = `In one word, describe the transition from "${prevNode.label}" to "${label}". Output ONLY the word:`;
          const edgeResp = await this.llm.complete(edgePrompt);
          edgeLabel = edgeResp.trim().slice(0, 20);
        } catch {
          // Fall back to rule-based edge label
        }
        edges.push({ from: prevNode.id, to: nodeId, label: edgeLabel });
      }
    } catch {
      // skip edge
    }

    try {
      await ctx.storage.appendCanvasNode(input.sessionKey, node, edges);
    } catch {
      // best-effort
    }

    try {
      await ctx.storage.writeRef(input.sessionKey, nodeId, input.content);
    } catch {
      // best-effort
    }

    return { canvas: { nodes: [node], edges } };
  }
}

/**
 * Extract a concise node label from the capture.
 * Rule-based: first meaningful line, truncated to 40 chars.
 */
function extractNodeLabel(input: CaptureInput): string {
  const content = input.content.trim();

  // For errors: use the error message (first line after "Error:")
  if (input.type === "error") {
    const errorMatch = content.match(/Error[:\s]+(.+)/i);
    if (errorMatch) return truncate(errorMatch[1].trim(), 40);
  }

  // For decisions: use "Decision: {first sentence}"
  if (input.type === "decision") {
    const firstSentence = content.split(/[.!]\s/)[0];
    return truncate(firstSentence, 40);
  }

  // For tasks: use the task description
  if (input.type === "task") {
    return truncate(content.split("\n")[0], 40);
  }

  // Default: first non-empty line
  const firstLine = content.split("\n").find((l) => l.trim().length > 0);
  return truncate(firstLine ?? "untitled", 40);
}

/**
 * Infer an edge label based on the transition between nodes.
 */
function inferEdgeLabel(prev: MermaidNode, current: CaptureInput): string {
  if (current.type === "error") return "failed";
  if (current.type === "decision") return "decided";
  if (current.type === "task") return "executed";
  if (current.type === "learning") return "learned";
  return "next";
}

/** Truncate a string to maxLen characters, adding "..." if truncated. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

/**
 * Render a MermaidCanvas to Mermaid graph syntax.
 * This is used when injecting the canvas into the agent's context.
 *
 * Example output:
 * ```mermaid
 * graph LR
 *   n1["ran tests"] -->|failed| n2["fixed bug"]
 *   n2 -->|executed| n3["ran tests again"]
 * ```
 */
export function renderMermaid(canvas: MermaidCanvas): string {
  const lines: string[] = ["graph LR"];

  // Nodes
  for (const node of canvas.nodes) {
    const safeLabel = node.label.replace(/"/g, "'");
    lines.push(`  ${node.id}["${safeLabel}"]`);
  }

  // Edges
  for (const edge of canvas.edges) {
    if (edge.label) {
      const safeLabel = edge.label.replace(/"/g, "'");
      lines.push(`  ${edge.from} -->|${safeLabel}| ${edge.to}`);
    } else {
      lines.push(`  ${edge.from} --> ${edge.to}`);
    }
  }

  return lines.join("\n");
}

/**
 * Estimate the token count of a Mermaid canvas.
 * Rough heuristic: 1 token ≈ 4 characters.
 */
export function estimateCanvasTokens(canvas: MermaidCanvas): number {
  const mermaidText = renderMermaid(canvas);
  return Math.ceil(mermaidText.length / 4);
}
