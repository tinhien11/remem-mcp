import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";

interface ExportRow {
  id: string;
  session_key: string;
  agent_id: string;
  type: string;
  content: string;
  content_hash: string | null;
  tags: string | null;
  created_at: number;
  metadata: string | null;
  team_id: string | null;
  user_id: string | null;
  task_id: string | null;
}

interface ExportMessage {
  id: string;
  capture_id: string;
  role: string;
  content: string;
  seq: number;
  created_at: number;
}

interface ExportFormat {
  version: number;
  exported_at: number;
  count: number;
  captures: ExportRow[];
  messages: ExportMessage[];
}

/** Export all captures to a JSON file. */
export function exportData(
  dbPath: string,
  outputPath: string,
  filters?: { sessionKey?: string; type?: string; teamId?: string },
): void {
  const db = new Database(dbPath, { readonly: true });

  let sql = "SELECT * FROM captures";
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (filters?.sessionKey) {
    conditions.push("session_key = ?");
    params.push(filters.sessionKey);
  }
  if (filters?.type) {
    conditions.push("type = ?");
    params.push(filters.type);
  }
  if (filters?.teamId) {
    conditions.push("team_id = ?");
    params.push(filters.teamId);
  }
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  sql += " ORDER BY created_at ASC";

  const rows = db.prepare(sql).all(...params) as ExportRow[];

  // Export messages for the captured entries
  let messages: ExportMessage[] = [];
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    messages = db
      .prepare(`SELECT * FROM messages WHERE capture_id IN (${placeholders}) ORDER BY seq ASC`)
      .all(...ids) as ExportMessage[];
  }

  db.close();

  const data: ExportFormat = {
    version: 2,
    exported_at: Date.now(),
    count: rows.length,
    captures: rows,
    messages,
  };

  if (outputPath === "-") {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf-8");
    console.log(`Exported ${rows.length} captures (${messages.length} messages) to ${outputPath}`);
  }
}
