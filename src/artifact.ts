import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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

/**
 * Team-shared artifact path: `.tdai-memory/memory-export.jsonl` in the project root.
 * Uses JSONL (one JSON object per line) so git can merge line-by-line.
 * Commit this file to your repo so teammates can import your memory.
 */
export function artifactPath(projectRoot: string): string {
  return join(projectRoot, ".tdai-memory", "memory-export.jsonl");
}

/**
 * Legacy artifact path (v1, JSON array format).
 * Used for backward-compat import only.
 */
function legacyArtifactPath(projectRoot: string): string {
  return join(projectRoot, ".tdai-memory", "memory-export.json");
}

/**
 * Read existing capture IDs from the JSONL artifact file.
 * Returns a Set of IDs already in the file.
 */
function readExistingIds(filePath: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(filePath)) return ids;

  const raw = readFileSync(filePath, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { id?: string };
      if (obj.id) ids.add(obj.id);
    } catch {
      // Skip unparseable lines
    }
  }
  return ids;
}

/**
 * Append captures to `.tdai-memory/memory-export.jsonl`.
 *
 * Uses append-only JSONL format so parallel branches can merge without conflicts:
 * - Branch A appends line X, branch B appends line Y → git auto-merges (different lines)
 * - Only conflicts when both branches add the same capture ID (a real conflict)
 *
 * Only captures not already in the file are appended (dedup by ID).
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

  const outPath = artifactPath(projectRoot);
  const dir = join(projectRoot, ".tdai-memory");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Read existing IDs to avoid duplicates
  const existingIds = readExistingIds(outPath);

  // Append only new captures
  const newRows = rows.filter((r) => !existingIds.has(r.id));
  if (newRows.length === 0) {
    console.log(`Team artifact: no new captures to append (${existingIds.size} already in file).`);
    return;
  }

  const lines = `${newRows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  appendFileSync(outPath, lines, "utf-8");

  console.log(
    `Team artifact: appended ${newRows.length} capture(s) to ${outPath} (${existingIds.size} already existed).`,
  );
  console.log(`Commit this file to share memory with your team.`);
}

/**
 * Import captures from `.tdai-memory/memory-export.jsonl` (or legacy `.json`).
 * Called on server startup. Skips captures that already exist (by ID).
 * Returns the number of captures imported.
 */
export function importArtifact(dbPath: string, projectRoot: string): number {
  const jsonlPath = artifactPath(projectRoot);
  const legacyPath = legacyArtifactPath(projectRoot);

  // Collect rows from JSONL (preferred) or legacy JSON array
  const rows: ExportRow[] = [];

  if (existsSync(jsonlPath)) {
    // JSONL format: one JSON object per line
    const raw = readFileSync(jsonlPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed) as ExportRow);
      } catch {
        // Skip unparseable lines
      }
    }
  } else if (existsSync(legacyPath)) {
    // Legacy JSON array format (v1)
    try {
      const raw = readFileSync(legacyPath, "utf-8");
      const data = JSON.parse(raw) as { captures?: ExportRow[] };
      if (data.captures && Array.isArray(data.captures)) {
        rows.push(...data.captures);
      }
    } catch {
      console.error("[tdai-memory] Failed to parse legacy team artifact. Skipping import.");
      return 0;
    }
  } else {
    return 0;
  }

  if (rows.length === 0) return 0;

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
    for (const row of rows) {
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
 * Check if a team artifact exists in the project root (JSONL or legacy JSON).
 */
export function hasArtifact(projectRoot: string): boolean {
  return existsSync(artifactPath(projectRoot)) || existsSync(legacyArtifactPath(projectRoot));
}
