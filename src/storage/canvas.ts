/**
 * Mermaid canvas storage — stores the top layer of short-term memory.
 *
 * Adapted from TencentDB Agent Memory's Mermaid canvas concept (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 *
 * The canvas is a Mermaid graph with nodes (tool calls / captures) and
 * edges (state transitions). It is kept in the agent's context (~hundreds
 * of tokens) while raw output is offloaded to refs/*.md.
 *
 * Storage: SQLite `canvases` + `canvas_nodes` + `canvas_edges` tables.
 * One canvas per session. Nodes and edges are appended incrementally.
 */

import type { Database } from "better-sqlite3";
import type { MermaidCanvas, MermaidEdge, MermaidNode } from "../pipeline/types.js";
import { generateId } from "../utils/ulid.js";

/** Canvas row in the canvases table. */
interface CanvasRow {
  id: string;
  session_key: string;
  mermaid_text: string | null;
  node_count: number;
  created_at: number;
  updated_at: number;
  team_id: string | null;
}

/** Canvas node row. */
interface CanvasNodeRow {
  id: string;
  canvas_id: string;
  node_id: string;
  label: string;
  capture_id: string | null;
  seq: number;
  created_at: number;
}

/** Canvas edge row. */
interface CanvasEdgeRow {
  id: string;
  canvas_id: string;
  from_node_id: string;
  to_node_id: string;
  label: string | null;
  created_at: number;
}

/**
 * Canvas storage — manages Mermaid canvas persistence in SQLite.
 */
export class CanvasStorage {
  constructor(private db: Database) {}

  /**
   * Get or create a canvas for a session.
   * @returns The canvas ID.
   */
  getOrCreateCanvas(sessionKey: string, teamId?: string): string {
    const existing = this.db
      .prepare("SELECT id FROM canvases WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(sessionKey) as { id: string } | undefined;

    if (existing) return existing.id;

    const id = generateId();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO canvases (id, session_key, mermaid_text, node_count, created_at, updated_at, team_id) VALUES (?, ?, NULL, 0, ?, ?, ?)",
      )
      .run(id, sessionKey, now, now, teamId ?? null);
    return id;
  }

  /**
   * Append a node (and optional edges) to a session's canvas.
   * This is called by the MermaidPipeline after each capture.
   */
  appendNode(
    sessionKey: string,
    node: MermaidNode,
    edges: MermaidEdge[] = [],
    teamId?: string,
  ): void {
    const canvasId = this.getOrCreateCanvas(sessionKey, teamId);
    const now = Date.now();

    // Get the next sequence number
    const maxSeq = this.db
      .prepare("SELECT MAX(seq) as max_seq FROM canvas_nodes WHERE canvas_id = ?")
      .get(canvasId) as { max_seq: number | null } | undefined;
    const seq = (maxSeq?.max_seq ?? -1) + 1;

    // Insert the node
    this.db
      .prepare(
        "INSERT INTO canvas_nodes (id, canvas_id, node_id, label, capture_id, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(generateId(), canvasId, node.id, node.label, node.captureId, seq, now);

    // Insert edges
    for (const edge of edges) {
      this.db
        .prepare(
          "INSERT INTO canvas_edges (id, canvas_id, from_node_id, to_node_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(generateId(), canvasId, edge.from, edge.to, edge.label ?? null, now);
    }

    // Update node count + updated_at
    const nodeCount = this.db
      .prepare("SELECT COUNT(*) as count FROM canvas_nodes WHERE canvas_id = ?")
      .get(canvasId) as { count: number };
    this.db
      .prepare("UPDATE canvases SET node_count = ?, updated_at = ? WHERE id = ?")
      .run(nodeCount.count, now, canvasId);

    // Regenerate mermaid_text (cached for fast injection)
    const canvas = this.getCanvas(sessionKey);
    if (canvas) {
      const mermaidText = this.renderMermaid(canvas);
      this.db
        .prepare("UPDATE canvases SET mermaid_text = ? WHERE id = ?")
        .run(mermaidText, canvasId);
    }
  }

  /**
   * Get the latest canvas for a session.
   * @returns The canvas with all nodes and edges, or null if no canvas exists.
   */
  getCanvas(sessionKey: string): MermaidCanvas | null {
    const canvasRow = this.db
      .prepare("SELECT * FROM canvases WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(sessionKey) as CanvasRow | undefined;

    if (!canvasRow) return null;

    const nodeRows = this.db
      .prepare("SELECT * FROM canvas_nodes WHERE canvas_id = ? ORDER BY seq ASC")
      .all(canvasRow.id) as CanvasNodeRow[];

    const edgeRows = this.db
      .prepare("SELECT * FROM canvas_edges WHERE canvas_id = ? ORDER BY created_at ASC")
      .all(canvasRow.id) as CanvasEdgeRow[];

    const nodes: MermaidNode[] = nodeRows.map((r) => ({
      id: r.node_id,
      label: r.label,
      captureId: r.capture_id ?? "",
    }));

    const edges: MermaidEdge[] = edgeRows.map((r) => ({
      from: r.from_node_id,
      to: r.to_node_id,
      label: r.label ?? undefined,
    }));

    return { nodes, edges };
  }

  /**
   * Get the latest node in a session's canvas.
   * Used by MermaidPipeline to link new nodes to the previous one.
   */
  getLatestNode(sessionKey: string): MermaidNode | null {
    const canvasRow = this.db
      .prepare("SELECT id FROM canvases WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(sessionKey) as { id: string } | undefined;

    if (!canvasRow) return null;

    const nodeRow = this.db
      .prepare("SELECT * FROM canvas_nodes WHERE canvas_id = ? ORDER BY seq DESC LIMIT 1")
      .get(canvasRow.id) as CanvasNodeRow | undefined;

    if (!nodeRow) return null;

    return {
      id: nodeRow.node_id,
      label: nodeRow.label,
      captureId: nodeRow.capture_id ?? "",
    };
  }

  /**
   * Get the cached Mermaid text for a session (fast path, no re-render).
   */
  getMermaidText(sessionKey: string): string | null {
    const row = this.db
      .prepare(
        "SELECT mermaid_text FROM canvases WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(sessionKey) as { mermaid_text: string | null } | undefined;

    return row?.mermaid_text ?? null;
  }

  /**
   * Delete a session's canvas and all its nodes/edges.
   */
  deleteCanvas(sessionKey: string): void {
    const canvasRow = this.db
      .prepare("SELECT id FROM canvases WHERE session_key = ?")
      .get(sessionKey) as { id: string } | undefined;

    if (!canvasRow) return;

    this.db.prepare("DELETE FROM canvas_nodes WHERE canvas_id = ?").run(canvasRow.id);
    this.db.prepare("DELETE FROM canvas_edges WHERE canvas_id = ?").run(canvasRow.id);
    this.db.prepare("DELETE FROM canvases WHERE id = ?").run(canvasRow.id);
  }

  /**
   * Render a MermaidCanvas to Mermaid graph syntax.
   * This is the format injected into the agent's context.
   *
   * Example:
   * ```mermaid
   * graph LR
   *   n1["ran tests"] -->|failed| n2["fixed bug"]
   *   n2 -->|executed| n3["ran tests again"]
   * ```
   */
  renderMermaid(canvas: MermaidCanvas): string {
    const lines: string[] = ["graph LR"];

    for (const node of canvas.nodes) {
      const safeLabel = node.label.replace(/"/g, "'");
      lines.push(`  ${node.id}["${safeLabel}"]`);
    }

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
   * Get canvas stats for a session.
   */
  getStats(
    sessionKey: string,
  ): { nodeCount: number; edgeCount: number; tokenEstimate: number } | null {
    const canvas = this.getCanvas(sessionKey);
    if (!canvas) return null;

    const mermaidText = this.renderMermaid(canvas);
    return {
      nodeCount: canvas.nodes.length,
      edgeCount: canvas.edges.length,
      tokenEstimate: Math.ceil(mermaidText.length / 4),
    };
  }
}
