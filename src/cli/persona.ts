import Database from "better-sqlite3";
import { SQLiteBackend } from "../storage/sqlite.js";

/**
 * persona CLI command: read or write L3 persona profile.
 *
 * Usage:
 *   remem-mcp persona                          Read persona
 *   remem-mcp persona --set "trait: value"     Set a trait
 *   remem-mcp persona --clear                  Clear persona
 */
export async function personaCommand(
  dbPath: string,
  flags: Record<string, string>,
): Promise<void> {
  const storage = new SQLiteBackend(dbPath);
  try {
    const teamId = flags["team-id"] ?? "default";
    const agentId = flags["agent-id"] ?? "unknown";
    const userId = flags["user-id"] ?? "default";

    if (flags.clear !== undefined) {
      await storage.writePersona(teamId, agentId, userId, "");
      console.log("Persona cleared.");
      return;
    }

    if (flags.set) {
      // Read existing, append/update
      const existing = await storage.readPersona(teamId, agentId, userId);
      const entry = flags.set;
      const [trait] = entry.split(":");
      let content: string;
      if (existing && existing.content) {
        const lines = existing.content.split("\n").filter((l) => l.trim());
        const traitPattern = new RegExp(
          `^${trait.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`,
          "i",
        );
        const idx = lines.findIndex((l) => traitPattern.test(l));
        if (idx >= 0) {
          lines[idx] = entry;
        } else {
          lines.push(entry);
        }
        content = lines.join("\n");
      } else {
        content = entry;
      }
      await storage.writePersona(teamId, agentId, userId, content);
      console.log(`Persona updated: ${entry}`);
      return;
    }

    // Read — query any agent_id (persona is user-level, not agent-level)
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT content FROM persona WHERE team_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1")
        .get(teamId, userId) as { content: string } | undefined;
      if (!row || !row.content) {
        console.log("No persona set. Use --set \"trait: value\" to add one.");
        return;
      }
      console.log("Persona (L3):");
      console.log(row.content);
    } finally {
      db.close();
    }
  } finally {
    storage.close();
  }
}
