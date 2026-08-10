import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

interface ExportRow {
  id: string;
  session_key: string;
  agent_id: string;
  type: string;
  content: string;
  tags: string | null;
  created_at: number;
  metadata: string | null;
}

interface ExportFormat {
  version: number;
  exported_at: number;
  count: number;
  captures: ExportRow[];
}

/** Export all captures to a JSON file. */
export function exportData(
  dbPath: string,
  outputPath: string,
  filters?: { sessionKey?: string; type?: string },
): void {
  const db = new Database(dbPath, { readonly: true });

  let sql = "SELECT * FROM captures";
  const params: unknown[] = [];

  if (filters?.sessionKey) {
    sql += " WHERE session_key = ?";
    params.push(filters.sessionKey);
  }
  if (filters?.type) {
    if (sql.includes("WHERE")) {
      sql += " AND type = ?";
    } else {
      sql += " WHERE type = ?";
    }
    params.push(filters.type);
  }

  sql += " ORDER BY created_at ASC";

  const rows = db.prepare(sql).all(...params) as ExportRow[];
  db.close();

  const data: ExportFormat = {
    version: 1,
    exported_at: Date.now(),
    count: rows.length,
    captures: rows,
  };

  // If output is "-", write to stdout
  if (outputPath === "-") {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf-8");
    console.log(`Exported ${rows.length} captures to ${outputPath}`);
  }
}
