import { createHash } from "node:crypto";
import { SQLiteBackend } from "../storage/sqlite.js";
import { generateId } from "../utils/ulid.js";

/** Default session key: hash(cwd), matching the MCP server and hooks. */
function cliSessionKey(): string {
  if (process.env.REMEM_SESSION_KEY) return process.env.REMEM_SESSION_KEY;
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}

/**
 * consolidate CLI command: create an L2 scenario from atom IDs.
 *
 * Usage:
 *   remem-mcp consolidate --atom-ids <id1,id2,...> --summary "..." [--tags tag1,tag2]
 *   remem-mcp consolidate --list           List recent scenarios
 *   remem-mcp consolidate --auto           Auto-consolidate by topic (group atoms with shared keywords)
 */
export async function consolidateCommand(
  dbPath: string,
  flags: Record<string, string>,
): Promise<void> {
  const storage = new SQLiteBackend(dbPath);
  try {
    if (flags.list !== undefined) {
      const scenarios = await storage.listScenarios({
        teamId: flags["team-id"],
        limit: flags.limit ? Number(flags.limit) : 20,
      });
      if (scenarios.length === 0) {
        console.log("No scenarios found.");
        return;
      }
      console.log(`Scenarios (${scenarios.length}):`);
      for (const s of scenarios) {
        const tags = s.personaTags ? ` [${s.personaTags.join(", ")}]` : "";
        console.log(`  ${s.id}  ${s.atomIds.length} atoms${tags}`);
        console.log(`    ${s.summary}`);
      }
      return;
    }

    if (flags.auto !== undefined) {
      // Auto-consolidate: group atoms by shared keywords
      const atoms = await storage.listAtoms({
        teamId: flags["team-id"],
        limit: flags.limit ? Number(flags.limit) : 100,
      });
      if (atoms.length < 5) {
        console.log(`Not enough atoms to consolidate (${atoms.length} < 5).`);
        return;
      }

      // Group by first significant word in fact
      const groups = new Map<string, typeof atoms>();
      for (const a of atoms) {
        const words = a.fact
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3);
        const key = words[0] ?? "misc";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(a);
      }

      let count = 0;
      for (const [topic, groupAtoms] of groups) {
        if (groupAtoms.length < 3) continue;
        const summary = groupAtoms
          .slice(0, 5)
          .map((a) => a.fact)
          .join("; ");
        const id = generateId();
        await storage.putScenario({
          id,
          atomIds: groupAtoms.map((a) => a.id),
          summary: summary.slice(0, 300),
          personaTags: [topic],
          createdAt: Date.now(),
          sessionKey: cliSessionKey(),
        });
        console.log(`  [${topic}] ${groupAtoms.length} atoms → ${id}`);
        count++;
      }
      console.log(`\nCreated ${count} scenario(s).`);
      return;
    }

    // Manual consolidate
    const atomIdsStr = flags["atom-ids"];
    const summary = flags.summary;
    if (!atomIdsStr || !summary) {
      console.error('Usage: remem-mcp consolidate --atom-ids <id1,id2,...> --summary "..."');
      process.exit(1);
    }

    const atomIds = atomIdsStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (atomIds.length === 0) {
      console.error("Error: No atom IDs provided.");
      process.exit(1);
    }

    const tags = flags.tags ? flags.tags.split(",").map((s) => s.trim()) : undefined;
    const id = generateId();
    await storage.putScenario({
      id,
      atomIds,
      summary,
      personaTags: tags,
      createdAt: Date.now(),
      sessionKey: cliSessionKey(),
    });
    console.log(`Consolidated ${atomIds.length} atoms into scenario ${id}.`);
  } finally {
    storage.close();
  }
}
