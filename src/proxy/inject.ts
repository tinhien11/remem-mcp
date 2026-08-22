/**
 * Memory injection — queries recall + scenarios + persona + skills
 * and injects them into the system prompt.
 *
 * Reuses the same recall logic as the hook-recall handler.
 */

import type { SQLiteBackend } from "../storage/sqlite.js";
import type { LocalEmbedder } from "../embedding/local.js";

interface SessionBinding {
  teamId?: string;
  agentId?: string;
  userId?: string;
  taskId?: string;
}

interface Message {
  role: string;
  content: string;
}

/**
 * Inject memory into OpenAI-format messages.
 * - Queries recall with the last user message
 * - Prepends a system message with the memory block
 */
export async function injectMemory(
  messages: Message[],
  userMessage: string,
  storage: SQLiteBackend,
  embedder: LocalEmbedder,
  binding: SessionBinding,
): Promise<Message[]> {
  // Generate embedding for the query
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embedder.embed(userMessage);
    console.error(`[proxy inject] embedding: ${queryEmbedding?.length ?? 0} dims`);
  } catch (e) {
    console.error(`[proxy inject] embed error: ${e}`);
  }

  // Query recall (hybrid search)
  let results: Array<{ id: string; content: string; type: string; tags: string | null; score: number }> = [];
  try {
    const searchResults = await storage.search(userMessage, queryEmbedding, {
      sessionKey: "",
      limit: 5,
      offset: 0,
      mode: "hybrid",
      filters: {
        teamId: binding.teamId,
        agentId: binding.agentId,
        userId: binding.userId,
      },
    });
    results = searchResults.map((r) => ({
      id: r.entry.id,
      content: r.entry.content,
      type: r.entry.type,
      tags: r.entry.tags ?? null,
      score: r.score,
    }));
    console.error(`[proxy inject] search: ${results.length} results`);
  } catch (e) {
    console.error(`[proxy inject] search error: ${e}`);
  }

  // Query L1 atoms for the top captures
  const atoms: string[] = [];
  for (const result of results.slice(0, 3)) {
    try {
      const captureAtoms = await storage.listAtoms({ captureId: result.id, limit: 3 });
      for (const atom of captureAtoms) {
        atoms.push(atom.fact);
      }
    } catch {
      // best-effort
    }
  }

  // Query L2 scenarios
  let scenarios: string[] = [];
  if (binding.teamId) {
    try {
      const allScenarios = await storage.listScenarios({
        teamId: binding.teamId,
        agentId: binding.agentId,
        limit: 2,
      });
      scenarios = allScenarios.map((s) => s.summary);
    } catch {
      // best-effort
    }
  }

  // Query L3 persona
  let persona: string | null = null;
  if (binding.teamId && binding.agentId && binding.userId) {
    try {
      const p = await storage.readPersona(binding.teamId, binding.agentId, binding.userId);
      persona = p?.content ?? null;
    } catch {
      // best-effort
    }
  }

  // Query skills
  let skills: string[] = [];
  if (binding.teamId && binding.agentId) {
    try {
      const matchedSkills = await storage.searchSkills(binding.teamId, binding.agentId, userMessage, 2);
      skills = matchedSkills.map((s) => `**${s.name}**: ${s.description ?? ""}`);
    } catch {
      // best-effort
    }
  }

  // [F1: Canvas injection] Query canvas for this session if offload is enabled
  let canvasBlock: string | null = null;
  const offloadOn =
    process.env.REMEM_OFFLOAD_ENABLED === "true" ||
    process.env.REMEM_OFFLOAD_ENABLED === "1" ||
    process.env.REMEM_FLOW === "full";
  if (offloadOn) {
    try {
      // For proxy mode, use team_id as session key (no cwd available)
      const sessionKey = `proxy-${binding.teamId ?? "default"}`;
      const canvasRow = (storage as any).db
        .prepare("SELECT mermaid_text, node_count FROM canvases WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1")
        .get(sessionKey) as { mermaid_text: string | null; node_count: number } | undefined;
      if (canvasRow && canvasRow.mermaid_text && canvasRow.node_count > 0) {
        canvasBlock = `### Task Canvas (${canvasRow.node_count} steps)\n\`\`\`mermaid\n${canvasRow.mermaid_text}\n\`\`\``;
      }
    } catch {
      // best-effort
    }
  }

  // Build the memory block
  const memoryBlock = buildMemoryBlock(results, atoms, scenarios, persona, skills, canvasBlock);
  if (!memoryBlock) return messages;

  // Find the system message and append, or prepend a new one
  const systemIdx = messages.findIndex((m) => m.role === "system");
  if (systemIdx >= 0) {
    const newMessages = [...messages];
    newMessages[systemIdx] = {
      ...messages[systemIdx],
      content: `${messages[systemIdx].content}\n\n${memoryBlock}`,
    };
    return newMessages;
  }

  return [{ role: "system", content: memoryBlock }, ...messages];
}

/** Build the <remem-mcp> memory block for injection. */
function buildMemoryBlock(
  results: Array<{ content: string; type: string; tags: string | null }>,
  atoms: string[],
  scenarios: string[],
  persona: string | null,
  skills: string[],
  canvasBlock: string | null,
): string | null {
  const sections: string[] = [];

  if (atoms.length > 0) {
    sections.push(`### Relevant Facts\n${atoms.map((a) => `- ${a}`).join("\n")}`);
  }

  if (results.length > 0) {
    const captures = results.slice(0, 3).map((r) => `- [${r.type}] ${r.content.slice(0, 200)}`);
    sections.push(`### Past Memories\n${captures.join("\n")}`);
  }

  if (scenarios.length > 0) {
    sections.push(`### Scenarios\n${scenarios.map((s) => `- ${s}`).join("\n")}`);
  }

  if (persona) {
    sections.push(`### User Profile\n${persona}`);
  }

  if (skills.length > 0) {
    sections.push(`### Relevant Skills\n${skills.map((s) => `- ${s}`).join("\n")}`);
  }

  if (canvasBlock) {
    sections.push(canvasBlock);
  }

  if (sections.length === 0) return null;

  return `<remem-mcp>\n${sections.join("\n\n")}\n</remem-mcp>`;
}
