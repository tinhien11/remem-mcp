import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import * as sqliteVec from "sqlite-vec";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ImportRow {
  id: string;
  session_key: string;
  agent_id: string;
  type: string;
  content: string;
  tags: string | null;
  created_at: number;
  metadata: string | null;
}

interface ImportFormat {
  version: number;
  exported_at: number;
  count: number;
  captures: ImportRow[];
}

/** Run the schema if the database is new. */
function ensureSchema(db: Database.Database): void {
  const candidates = [
    join(__dirname, "storage", "schema.sql"),
    join(__dirname, "schema.sql"),
    join(__dirname, "..", "storage", "schema.sql"),
  ];

  let schema: string | null = null;
  for (const path of candidates) {
    try {
      schema = readFileSync(path, "utf-8");
      break;
    } catch {
      // Try the next candidate
    }
  }

  if (!schema) {
    throw new Error("Could not find schema.sql.");
  }
  db.exec(schema);
}

/** Import captures from a JSON file. Skips captures that already exist (by ID). */
export function importData(dbPath: string, inputPath: string): void {
  if (!existsSync(inputPath)) {
    console.error(`Error: File not found: ${inputPath}`);
    process.exit(1);
  }

  const raw = readFileSync(inputPath, "utf-8");
  let data: ImportFormat;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("Error: Invalid JSON file.");
    process.exit(1);
  }

  if (!data.captures || !Array.isArray(data.captures)) {
    console.error("Error: No captures array in the file.");
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  ensureSchema(db);

  let inserted = 0;
  let skipped = 0;

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO captures (id, session_key, agent_id, type, content, tags, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertVecStmt = db.prepare(
    "INSERT OR IGNORE INTO captures_vec (id, embedding) VALUES (?, ?)",
  );

  const transaction = db.transaction(() => {
    for (const row of data.captures) {
      const result = insertStmt.run(
        row.id,
        row.session_key,
        row.agent_id,
        row.type,
        row.content,
        row.tags,
        row.created_at,
        row.metadata,
      );

      if (result.changes > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }
  });

  transaction();
  db.close();

  console.log(`Imported ${inserted} captures, skipped ${skipped} (already exist).`);
}
