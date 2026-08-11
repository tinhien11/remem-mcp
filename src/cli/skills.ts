import { SQLiteBackend } from "../storage/sqlite.js";

/**
 * skills CLI command: list or search skills for a team.
 *
 * Usage:
 *   tdai-memory-mcp skills --team-id <id>
 *   tdai-memory-mcp skills --team-id <id> --agent-id <id>
 *   tdai-memory-mcp skills --team-id <id> --agent-id <id> --query "deploy"
 */
export async function skillsCommand(dbPath: string, flags: Record<string, string>): Promise<void> {
  const teamId = flags["team-id"];
  if (!teamId) {
    console.error("Error: --team-id is required.");
    process.exit(1);
  }

  const storage = new SQLiteBackend(dbPath);
  try {
    if (flags.query) {
      const agentId = flags["agent-id"];
      if (!agentId) {
        console.error("Error: --agent-id is required for --query.");
        process.exit(1);
      }
      const topK = flags.limit ? Number(flags.limit) : 10;
      const entries = await storage.searchSkills(teamId, agentId, flags.query, topK);
      if (entries.length === 0) {
        console.log("No matching skills found.");
        return;
      }
      console.log(`Matching skills (${entries.length}):`);
      for (const e of entries) {
        console.log(`  ${e.id}  v${e.version}  ${e.name}`);
        if (e.description) console.log(`    ${e.description}`);
      }
      return;
    }

    const entries = await storage.listSkills(teamId, flags["agent-id"]);
    if (entries.length === 0) {
      console.log("No skills found.");
      return;
    }

    console.log(`Skills (${entries.length}):`);
    for (const e of entries) {
      console.log(`  ${e.id}  v${e.version}  ${e.name}`);
      if (e.description) console.log(`    ${e.description}`);
    }
  } finally {
    storage.close();
  }
}
