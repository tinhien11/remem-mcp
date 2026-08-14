import { SQLiteBackend } from "../storage/sqlite.js";

/**
 * scenarios CLI command: list L2 scenarios.
 *
 * Usage:
 *   remem-mcp scenarios [--team-id <id>] [--agent-id <id>] [--user-id <id>] [--limit <n>]
 */
export async function scenariosCommand(
  dbPath: string,
  flags: Record<string, string>,
): Promise<void> {
  const storage = new SQLiteBackend(dbPath);
  try {
    const scenarios = await storage.listScenarios({
      teamId: flags["team-id"],
      agentId: flags["agent-id"],
      userId: flags["user-id"],
      limit: flags.limit ? Number(flags.limit) : 20,
      offset: 0,
    });

    if (scenarios.length === 0) {
      console.log("No scenarios found.");
      return;
    }

    console.log(`Scenarios (${scenarios.length}):`);
    for (const s of scenarios) {
      const tags = s.personaTags ? `  [${s.personaTags.join(", ")}]` : "";
      console.log(`  ${s.id}${tags}`);
      console.log(`    atoms: ${s.atomIds.length}`);
      console.log(`    summary: ${s.summary}`);
    }
  } finally {
    storage.close();
  }
}
