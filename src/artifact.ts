import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

interface ArtifactFormat {
  version: number;
  exported_at: number;
  count: number;
  captures: ExportRow[];
}

/**
 * Team-shared artifact path: `.tdai-memory/memory-export.json` in the project root.
 * Commit this file to your repo so teammates can import your memory.
 */
export function artifactPath(projectRoot: string): string {
  return join(projectRoot, ".tdai-memory", "memory-export.json");
}

/**
 * Export all captures from the current session to `.tdai-memory/memory-export.json`.
 * Call this at the end of a session, or via a git pre-commit hook.
 */
export function exportArtifact(dbPath: string, projectRoot: string, sessionKey?: string): void {
  const db = new Database(dbPath, { readonly: true });

  let sql = "SELECT * FROM captures";
  const params: unknown[] = [];

  if (sessionKey) {
    sql += " WHERE session_key = ?";
    params.push(sessionKey);
  }

  sql += " ORDER BY created_at ASC";

  const rows = db.prepare(sql).all(...params) as ExportRow[];
  db.close();

  const data: ArtifactFormat = {
    version: 1,
    exported_at: Date.now(),
    count: rows.length,
    captures: rows,
  };

  const outPath = artifactPath(projectRoot);
  const dir = join(projectRoot, ".tdai-memory");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(outPath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`Team artifact written: ${outPath} (${rows.length} captures)`);
  console.log(`Commit this file to share memory with your team.`);
}

/**
 * Import captures from `.tdai-memory/memory-export.json` if it exists.
 * Called on server startup. Skips captures that already exist (by ID).
 * Returns the number of captures imported.
 */
export function importArtifact(dbPath: string, projectRoot: string): number {
  const artifactPath = join(projectRoot, ".tdai-memory", "memory-export.json");
  if (!existsSync(artifactPath)) {
    return 0;
  }

  let data: ArtifactFormat;
  try {
    const raw = readFileSync(artifactPath, "utf-8");
    data = JSON.parse(raw);
  } catch {
    console.error("[tdai-memory] Failed to parse team artifact. Skipping import.");
    return 0;
  }

  if (!data.captures || !Array.isArray(data.captures)) {
    return 0;
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  ensureSchema(db);

  let inserted = 0;
  let skipped = 0;

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata, team_id, user_id, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    for (const row of data.captures) {
      const result = insertStmt.run(
        row.id,
        row.session_key,
        row.agent_id,
        row.type,
        row.content,
        row.content_hash ?? createHash("sha256").update(row.content).digest("hex"),
        row.tags,
        row.created_at,
        row.metadata,
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
  });

  transaction();
  db.close();

  if (inserted > 0) {
    console.log(
      `[tdai-memory] Imported ${inserted} captures from team artifact (${skipped} already exist).`,
    );
  }

  return inserted;
}

/**
 * Check if a team artifact exists in the project root.
 */
export function hasArtifact(projectRoot: string): boolean {
  return existsSync(artifactPath(projectRoot));
}
