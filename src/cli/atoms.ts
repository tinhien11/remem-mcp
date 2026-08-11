import { SQLiteBackend } from "../storage/sqlite.js";
import type { AtomEntry } from "../storage/types.js";

/**
 * atoms CLI command: list or search L1 atoms.
 *
 * Usage:
 *   tdai-memory-mcp atoms [--team-id <id>] [--agent-id <id>] [--user-id <id>] [--query <text>] [--limit <n>]
 */
export async function atomsCommand(dbPath: string, flags: Record<string, string>): Promise<void> {
  const storage = new SQLiteBackend(dbPath);
  try {
    const opts = {
      teamId: flags["team-id"],
      agentId: flags["agent-id"],
      userId: flags["user-id"],
      limit: flags.limit ? Number(flags.limit) : 20,
      offset: 0,
    };

    let atoms: AtomEntry[];
    if (flags.query) {
      atoms = await storage.searchAtoms(flags.query, opts);
    } else {
      atoms = await storage.listAtoms(opts);
    }

    if (atoms.length === 0) {
      console.log("No atoms found.");
      return;
    }

    console.log(`Atoms (${atoms.length}):`);
    for (const atom of atoms) {
      const confidence = atom.confidence.toFixed(2);
      console.log(`  ${atom.id}  [${confidence}]  ${atom.fact}`);
    }
  } finally {
    storage.close();
  }
}
