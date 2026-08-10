import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import type {
  CaptureEntry,
  DeleteFilter,
  DeleteResult,
  QueryOptions,
  SearchResult,
  StorageBackend,
} from "./types.js";
import { rrfMerge, type RankedResult } from "../utils/rrf.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * SQLite storage backend.
 * Uses better-sqlite3 + sqlite-vec + FTS5.
 * Default backend. Zero setup.
 */
export class SQLiteBackend implements StorageBackend {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Make sure the directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    // Load the sqlite-vec extension
    sqliteVec.load(this.db);

    // Detect the database state and run the migration
    this.detectAndMigrate(dbPath);
  }

  /**
   * Detect the database state and run the correct migration path.
   *
   * 1. If the database does not exist: create the full schema.
   * 2. If the database exists and the schema version is current: do nothing.
   * 3. If the database exists and the schema version is older: backup, migrate, update version.
   * 4. If the database exists but has no schema_version table: treat as version 0, backup, migrate all.
   */
  private detectAndMigrate(dbPath: string): void {
    const hasVersionTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() as { name: string } | undefined;

    if (!hasVersionTable) {
      // Fresh database or old database without versioning
      // Check if there are any existing tables (besides sqlite internal)
      const tables = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];

      if (tables.length > 0) {
        // Old database without versioning. Backup first.
        this.backupDatabase(dbPath);
      }

      // Run the full schema
      this.runSchema();
      this.writeSchemaVersion(1);
      return;
    }

    // Database has a schema_version table. Read the current version.
    const row = this.db.prepare("SELECT MAX(version) as version FROM schema_version").get() as
      | { version: number }
      | undefined;
    const currentVersion = row?.version ?? 0;

    if (currentVersion < 1) {
      this.backupDatabase(dbPath);
      this.runSchema();
      this.writeSchemaVersion(1);
    }
    // If currentVersion >= 1, the schema is current. Do nothing.
  }

  /** Backup the database to a .bak file. */
  private backupDatabase(dbPath: string): void {
    const backupPath = `${dbPath}.bak`;
    try {
      // Close the WAL files first by checkpointing
      this.db.pragma("wal_checkpoint(FULL)");
      copyFileSync(dbPath, backupPath);
      console.error(`[tdai-memory] Backed up database to ${backupPath}`);
    } catch (err) {
      console.error(`[tdai-memory] Backup failed: ${err}`);
    }
  }

  /** Run the schema.sql file. Idempotent. */
  private runSchema(): void {
    // Try multiple locations: dist/storage/, dist/, src/storage/
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
      throw new Error("Could not find schema.sql. Make sure the build copied it to dist/storage/.");
    }
    this.db.exec(schema);
  }

  /** Write the schema version to the schema_version table. */
  private writeSchemaVersion(version: number): void {
    this.db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      version,
      Date.now(),
    );
  }

  async put(entry: CaptureEntry): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO captures (id, session_key, agent_id, type, content, tags, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.id,
      entry.sessionKey,
      entry.agentId,
      entry.type,
      entry.content,
      JSON.stringify(entry.tags),
      entry.createdAt,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );
  }

  async putVector(id: string, embedding: number[]): Promise<void> {
    const buffer = new Float32Array(embedding);
    const stmt = this.db.prepare("INSERT INTO captures_vec (id, embedding) VALUES (?, ?)");
    stmt.run(id, Buffer.from(buffer.buffer));
  }

  async get(id: string): Promise<CaptureEntry | null> {
    const row = this.db.prepare("SELECT * FROM captures WHERE id = ?").get(id) as
      | DbRow
      | undefined;
    if (!row) return null;
    return rowToEntry(row);
  }

  async search(
    query: string,
    queryEmbedding: number[] | null,
    opts: QueryOptions,
  ): Promise<SearchResult[]> {
    const { mode, limit, offset, sessionKey, filters } = opts;

    let bm25Results: RankedResult[] = [];
    let vecResults: RankedResult[] = [];

    // BM25 search (FTS5)
    if (mode === "hybrid" || mode === "keyword") {
      bm25Results = this.bm25Search(query, limit * 2, sessionKey, filters);
    }

    // Vector search (sqlite-vec)
    if ((mode === "hybrid" || mode === "vector") && queryEmbedding) {
      vecResults = this.vectorSearch(queryEmbedding, limit * 2, sessionKey, filters);
    }

    // If only one mode has results, return them directly
    if (mode === "keyword") {
      return this.fetchEntries(bm25Results, limit, offset);
    }
    if (mode === "vector") {
      return this.fetchEntries(vecResults, limit, offset);
    }

    // Hybrid: fuse with RRF
    const fused = rrfMerge(bm25Results, vecResults, limit + offset);
    const paged = fused.slice(offset, offset + limit);
    return this.fetchEntriesById(paged);
  }

  /** Run a BM25 search via FTS5. */
  private bm25Search(
    query: string,
    limit: number,
    sessionKey?: string,
    filters?: QueryOptions["filters"],
  ): RankedResult[] {
    // Escape the query for FTS5
    const ftsQuery = this.escapeFtsQuery(query);
    if (!ftsQuery) return [];

    let sql = `
      SELECT fts.id as id, bm25(captures_fts) as score
      FROM captures_fts fts
      JOIN captures c ON c.id = fts.id
      WHERE captures_fts MATCH ?
    `;
    const params: unknown[] = [ftsQuery];

    if (sessionKey) {
      sql += " AND c.session_key = ?";
      params.push(sessionKey);
    }
    if (filters?.type) {
      sql += " AND c.type = ?";
      params.push(filters.type);
    }
    if (filters?.agentId) {
      sql += " AND c.agent_id = ?";
      params.push(filters.agentId);
    }
    if (filters?.dateFrom) {
      sql += " AND c.created_at >= ?";
      params.push(new Date(filters.dateFrom).getTime());
    }
    if (filters?.dateTo) {
      sql += " AND c.created_at <= ?";
      params.push(new Date(filters.dateTo).getTime());
    }

    sql += " ORDER BY score LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as { id: string; score: number }[];
    return rows.map((r) => ({ id: r.id, score: r.score }));
  }

  /** Run a vector search via sqlite-vec. */
  private vectorSearch(
    embedding: number[],
    limit: number,
    sessionKey?: string,
    filters?: QueryOptions["filters"],
  ): RankedResult[] {
    const buffer = new Float32Array(embedding);
    let sql = `
      SELECT vec.id as id, vec.distance as score
      FROM captures_vec vec
      JOIN captures c ON c.id = vec.id
      WHERE vec.embedding MATCH ? AND vec.k = ?
    `;
    const params: unknown[] = [Buffer.from(buffer.buffer), limit];

    if (sessionKey) {
      sql += " AND c.session_key = ?";
      params.push(sessionKey);
    }
    if (filters?.type) {
      sql += " AND c.type = ?";
      params.push(filters.type);
    }
    if (filters?.agentId) {
      sql += " AND c.agent_id = ?";
      params.push(filters.agentId);
    }
    if (filters?.dateFrom) {
      sql += " AND c.created_at >= ?";
      params.push(new Date(filters.dateFrom).getTime());
    }
    if (filters?.dateTo) {
      sql += " AND c.created_at <= ?";
      params.push(new Date(filters.dateTo).getTime());
    }

    sql += " ORDER BY vec.distance LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as { id: string; score: number }[];
    return rows.map((r) => ({ id: r.id, score: r.score }));
  }

  /** Fetch capture entries for a list of ranked results. */
  private async fetchEntries(
    results: RankedResult[],
    limit: number,
    offset: number,
  ): Promise<SearchResult[]> {
    const paged = results.slice(offset, offset + limit);
    return this.fetchEntriesById(paged);
  }

  /** Fetch capture entries by ID, preserving the order of the input list. */
  private async fetchEntriesById(results: { id: string; score: number }[]): Promise<SearchResult[]> {
    if (results.length === 0) return [];
    const ids = results.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM captures WHERE id IN (${placeholders})`)
      .all(...ids) as DbRow[];
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    return results
      .map((r) => {
        const row = rowMap.get(r.id);
        if (!row) return null;
        return { entry: rowToEntry(row), score: r.score };
      })
      .filter((r): r is SearchResult => r !== null);
  }

  /** Escape a query string for FTS5 MATCH. */
  private escapeFtsQuery(query: string): string {
    // FTS5 MATCH uses special syntax. Wrap each token in double quotes.
    const tokens = query.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return "";
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
  }

  async delete(id: string): Promise<DeleteResult> {
    const atomCount = this.db.prepare("DELETE FROM atoms WHERE capture_id = ?").run(id).changes;
    const scenarioCount = this.db
      .prepare("DELETE FROM scenarios WHERE atom_ids LIKE ?")
      .run(`%${id}%`).changes;
    const captureCount = this.db.prepare("DELETE FROM captures WHERE id = ?").run(id).changes;
    this.db.prepare("DELETE FROM captures_vec WHERE id = ?").run(id);
    return {
      captures: captureCount,
      atoms: atomCount,
      scenarios: scenarioCount,
    };
  }

  async deleteByFilter(filter: DeleteFilter): Promise<DeleteResult> {
    let sql = "SELECT id FROM captures WHERE 1=1";
    const params: unknown[] = [];

    if (filter.type) {
      sql += " AND type = ?";
      params.push(filter.type);
    }
    if (filter.dateBefore) {
      sql += " AND created_at < ?";
      params.push(new Date(filter.dateBefore).getTime());
    }
    if (filter.tags && filter.tags.length > 0) {
      // Match captures that have at least one of the tags
      const tagConditions = filter.tags.map(() => "tags LIKE ?").join(" OR ");
      sql += ` AND (${tagConditions})`;
      params.push(...filter.tags.map((t) => `%"${t}"%`));
    }

    const ids = this.db.prepare(sql).all(...params) as { id: string }[];

    let captures = 0;
    let atoms = 0;
    let scenarios = 0;
    for (const { id } of ids) {
      const result = await this.delete(id);
      captures += result.captures;
      atoms += result.atoms;
      scenarios += result.scenarios;
    }

    return { captures, atoms, scenarios };
  }

  close(): void {
    this.db.close();
  }
}

/** Database row type. */
interface DbRow {
  id: string;
  session_key: string;
  agent_id: string;
  type: string;
  content: string;
  tags: string | null;
  created_at: number;
  metadata: string | null;
}

/** Convert a database row to a CaptureEntry. */
function rowToEntry(row: DbRow): CaptureEntry {
  return {
    id: row.id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    type: row.type as CaptureEntry["type"],
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    createdAt: row.created_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}
