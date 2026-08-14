import { SQLiteBackend } from "../storage/sqlite.js";

/**
 * persona CLI command: read or write the L3 persona.
 *
 * Usage:
 *   remem-mcp persona --team-id <id> --agent-id <id> --user-id <id>
 *   remem-mcp persona --team-id <id> --agent-id <id> --user-id <id> --write "content"
 */
export async function personaCommand(dbPath: string, flags: Record<string, string>): Promise<void> {
  const teamId = flags["team-id"];
  const agentId = flags["agent-id"];
  const userId = flags["user-id"];

  if (!teamId || !agentId || !userId) {
    console.error("Error: --team-id, --agent-id, and --user-id are required.");
    process.exit(1);
  }

  const storage = new SQLiteBackend(dbPath);
  try {
    if (flags.write) {
      await storage.writePersona(teamId, agentId, userId, flags.write);
      console.log(`Persona written for team=${teamId} agent=${agentId} user=${userId}.`);
      return;
    }

    const persona = await storage.readPersona(teamId, agentId, userId);
    if (!persona) {
      console.log("No persona found. Use --write <content> to create one.");
      return;
    }

    console.log(`Persona (updated ${new Date(persona.updatedAt).toISOString()}):`);
    console.log(persona.content);
  } finally {
    storage.close();
  }
}
