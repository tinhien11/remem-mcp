import { SQLiteBackend } from "../storage/sqlite.js";
import { generateId } from "../utils/ulid.js";

/**
 * knowledge CLI command: list, create, or delete knowledge assets.
 *
 * Usage:
 *   remem-mcp knowledge --team-id <id>
 *   remem-mcp knowledge --team-id <id> --type wiki
 *   remem-mcp knowledge --team-id <id> --create --name "My Wiki" --type wiki --summary "..."
 *   remem-mcp knowledge --delete <id1> [<id2> ...]
 */
export async function knowledgeCommand(
  dbPath: string,
  flags: Record<string, string>,
): Promise<void> {
  const storage = new SQLiteBackend(dbPath);
  try {
    if (flags.delete) {
      const ids = flags.delete.split(",").map((s) => s.trim());
      const count = await storage.deleteKnowledge(ids);
      console.log(`Deleted ${count} knowledge asset(s).`);
      return;
    }

    if (flags.create) {
      const teamId = flags["team-id"];
      const name = flags.name;
      const type = flags.type ?? "wiki";
      if (!teamId || !name) {
        console.error("Error: --team-id and --name are required for --create.");
        process.exit(1);
      }
      const id = generateId();
      await storage.putKnowledge({
        id,
        teamId,
        name,
        type,
        summary: flags.summary,
        serviceUrl: flags["service-url"],
        repoUrl: flags["repo-url"],
        branch: flags.branch,
        createdAt: Date.now(),
      });
      console.log(`Knowledge created: ${id} (${type}: ${name})`);
      return;
    }

    // List mode
    const teamId = flags["team-id"];
    if (!teamId) {
      console.error("Error: --team-id is required. Use --create to add a new asset.");
      process.exit(1);
    }

    const entries = await storage.listKnowledge(teamId, flags.type);
    if (entries.length === 0) {
      console.log("No knowledge assets found.");
      return;
    }

    console.log(`Knowledge assets (${entries.length}):`);
    for (const e of entries) {
      console.log(`  ${e.id}  [${e.type}]  ${e.name}`);
      if (e.summary) console.log(`    ${e.summary}`);
      if (e.serviceUrl) console.log(`    service: ${e.serviceUrl}`);
      if (e.repoUrl) console.log(`    repo: ${e.repoUrl}${e.branch ? ` (${e.branch})` : ""}`);
    }
  } finally {
    storage.close();
  }
}
