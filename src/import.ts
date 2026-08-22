import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { generateId } from "./utils/ulid.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ImportRow {
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

interface ImportMessage {
  id: string;
  capture_id: string;
  role: string;
  content: string;
  seq: number;
  created_at: number;
}

interface ImportFormat {
  version: number;
  exported_at: number;
  count: number;
  captures: ImportRow[];
  messages?: ImportMessage[];
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
  let messagesInserted = 0;

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata, team_id, user_id, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsgStmt = db.prepare(`
    INSERT OR IGNORE INTO messages (id, capture_id, role, content, seq, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    for (const row of data.captures) {
      const result = insertStmt.run(
        row.id ?? generateId(),
        row.session_key ?? "import",
        row.agent_id ?? "import",
        row.type,
        row.content,
        row.content_hash ?? null,
        Array.isArray(row.tags) ? JSON.stringify(row.tags) : row.tags ?? null,
        row.created_at ?? new Date().toISOString(),
        row.metadata ?? null,
        row.team_id ?? null,
        row.user_id ?? null,
        row.task_id ?? null,
      );

      if (result.changes > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }

    // Import messages if present (export format v2+)
    if (data.messages && Array.isArray(data.messages)) {
      for (const msg of data.messages) {
        const result = insertMsgStmt.run(
          msg.id,
          msg.capture_id,
          msg.role,
          msg.content,
          msg.seq,
          msg.created_at,
        );
        if (result.changes > 0) {
          messagesInserted++;
        }
      }
    }
  });

  transaction();
  db.close();

  const msgNote = messagesInserted > 0 ? `, ${messagesInserted} messages` : "";
  console.log(`Imported ${inserted} captures${msgNote}, skipped ${skipped} (already exist).`);
}
