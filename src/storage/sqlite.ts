import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { type RankedResult, rrfMerge } from "../utils/rrf.js";
import { generateId } from "../utils/ulid.js";
import type {
  AtomEntry,
  CaptureEntry,
  ConflictResult,
  DeleteFilter,
  DeleteResult,
  KnowledgeEntry,
  MessageRow,
  PersonaEntry,
  QueryOptions,
  ResolveResult,
  ScenarioEntry,
  SearchResult,
  SkillEntry,
  StorageBackend,
  TrustState,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Current schema version. */
const CURRENT_SCHEMA_VERSION = 6;

/**
 * SQLite storage backend.
 * Uses better-sqlite3 + sqlite-vec + FTS5.
 * Default backend. Zero setup.
 */
export class SQLiteBackend implements StorageBackend {
  private db: Database.Database;

  /** Get the underlying database instance (for CodeGraph/Wiki operations). */
  getDatabase(): Database.Database {
    return this.db;
  }

  constructor(dbPath: string) {
    // Make sure the directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Try read-write first; fall back to read-only if the directory is not writable
    // (e.g. Codex CLI sandbox blocks writes outside the workdir)
    let readonly = false;
    try {
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
    } catch {
      // Read-only fallback — recall/search still work, captures will fail gracefully
      readonly = true;
      this.db = new Database(dbPath, { readonly: true });
    }

    // Pragmas that are safe for both read-write and read-only
    try {
      this.db.pragma("busy_timeout = 5000");
    } catch {
      /* read-only */
    }
    if (!readonly) {
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("foreign_keys = OFF");
    }

    // Load the sqlite-vec extension
    sqliteVec.load(this.db);

    // Detect the database state and run the migration (skipped in read-only mode)
    if (!readonly) {
      try {
        this.detectAndMigrate(dbPath);
      } catch {
        // Migration failed — non-fatal, schema might already be correct
      }
    }
  }

  /**
   * Detect the database state and run the correct migration path.
   */
  private detectAndMigrate(dbPath: string): void {
    const hasVersionTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() as { name: string } | undefined;

    if (!hasVersionTable) {
      // Fresh database or old database without versioning
      const tables = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];

      if (tables.length === 0) {
        // Fresh database: run the full schema, write current version
        this.runSchema();
        this.writeSchemaVersion(CURRENT_SCHEMA_VERSION);
      } else {
        // Old database without versioning. Backup, then run incremental migrations
        // to add missing columns before running the full schema (which creates new tables).
        this.backupDatabase(dbPath);
        this.migrateV1ToV2();
        this.migrateV2ToV3();
        this.migrateV3ToV4();
        this.migrateV4ToV5();
        this.migrateV5ToV6();
        // Now run the full schema to create any remaining tables/triggers/indexes
        this.runSchema();
        this.writeSchemaVersion(CURRENT_SCHEMA_VERSION);
      }
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
    if (currentVersion < 2) {
      this.backupDatabase(dbPath);
      this.migrateV1ToV2();
      this.writeSchemaVersion(2);
    }
    if (currentVersion < 3) {
      this.backupDatabase(dbPath);
      this.migrateV2ToV3();
      this.writeSchemaVersion(3);
    }
    if (currentVersion < 4) {
      this.backupDatabase(dbPath);
      this.migrateV3ToV4();
      this.writeSchemaVersion(4);
    }
    if (currentVersion < 5) {
      this.backupDatabase(dbPath);
      this.migrateV4ToV5();
      this.writeSchemaVersion(5);
    }
    if (currentVersion < 6) {
      // Tables are created by runSchema() via CREATE TABLE IF NOT EXISTS.
      // Run schema to create CodeGraph + Wiki tables.
      this.runSchema();
      this.migrateV5ToV6();
      this.writeSchemaVersion(6);
    }
  }

  /** Backup the database to a .bak file. */
  private backupDatabase(dbPath: string): void {
    const backupPath = `${dbPath}.bak`;
    try {
      this.db.pragma("wal_checkpoint(FULL)");
      copyFileSync(dbPath, backupPath);
      console.error(`[tdai-memory] Backed up database to ${backupPath}`);
    } catch (err) {
      console.error(`[tdai-memory] Backup failed: ${err}`);
    }
  }

  /** Run the schema.sql file. Idempotent. */
  private runSchema(): void {
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
    this.db
      .prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
      .run(version, Date.now());
  }

  /** Migrate schema v1 → v2: add content_hash column + index. */
  private migrateV1ToV2(): void {
    const cols = this.db.prepare("PRAGMA table_info(captures)").all() as { name: string }[];
    const hasContentHash = cols.some((c) => c.name === "content_hash");
    if (!hasContentHash) {
      this.db.exec("ALTER TABLE captures ADD COLUMN content_hash TEXT");
      console.error("[tdai-memory] Added content_hash column to captures");
    }
    const idxs = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_captures_hash'")
      .get() as { name: string } | undefined;
    if (!idxs) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_captures_hash ON captures (content_hash)");
    }
    // Backfill content_hash for existing rows
    const rows = this.db
      .prepare("SELECT id, content FROM captures WHERE content_hash IS NULL")
      .all() as { id: string; content: string }[];
    const stmt = this.db.prepare("UPDATE captures SET content_hash = ? WHERE id = ?");
    for (const row of rows) {
      const hash = createHash("sha256").update(row.content).digest("hex");
      stmt.run(hash, row.id);
    }
    if (rows.length > 0) {
      console.error(`[tdai-memory] Backfilled content_hash for ${rows.length} existing captures`);
    }
  }

  /** Migrate schema v2 → v3: add multi-tenant columns + new tables (messages, knowledge, skills, persona). */
  private migrateV2ToV3(): void {
    // Helper: add a column to a table if the table exists and the column is missing
    const addColumnIfMissing = (table: string, column: string, definition: string) => {
      const tableExists = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { name: string } | undefined;
      if (!tableExists) return;
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };

    // Add multi-tenant columns to captures
    addColumnIfMissing("captures", "team_id", "TEXT");
    addColumnIfMissing("captures", "user_id", "TEXT");
    addColumnIfMissing("captures", "task_id", "TEXT");

    // Add multi-tenant columns to atoms
    addColumnIfMissing("atoms", "team_id", "TEXT");
    addColumnIfMissing("atoms", "agent_id", "TEXT");
    addColumnIfMissing("atoms", "user_id", "TEXT");

    // Add multi-tenant columns to scenarios
    addColumnIfMissing("scenarios", "team_id", "TEXT");
    addColumnIfMissing("scenarios", "agent_id", "TEXT");
    addColumnIfMissing("scenarios", "user_id", "TEXT");

    // Create new tables (idempotent — schema.sql also has them, but run here for migration path
    // before schema.sql so that index creation in schema.sql doesn't fail)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        capture_id  TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS persona (
        team_id    TEXT NOT NULL,
        agent_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        content    TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, agent_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS knowledge (
        id          TEXT PRIMARY KEY,
        team_id     TEXT NOT NULL,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL,
        summary     TEXT,
        service_url TEXT,
        repo_url    TEXT,
        branch      TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        id          TEXT PRIMARY KEY,
        team_id     TEXT NOT NULL,
        agent_id    TEXT,
        name        TEXT NOT NULL,
        description TEXT,
        content     TEXT,
        version     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);
    // Indexes are created by the full schema.sql run, not here.

    console.error(
      "[tdai-memory] Migrated schema v2 → v3 (multi-tenant + messages + knowledge + skills + persona)",
    );
  }

  /** Migrate schema v3 → v4: add deleted_at column for soft delete (tombstone). */
  private migrateV3ToV4(): void {
    const cols = this.db.prepare("PRAGMA table_info(captures)").all() as { name: string }[];
    const hasDeletedAt = cols.some((c) => c.name === "deleted_at");
    if (!hasDeletedAt) {
      this.db.exec("ALTER TABLE captures ADD COLUMN deleted_at INTEGER");
      console.error("[tdai-memory] Added deleted_at column to captures (tombstone support)");
    }
    console.error("[tdai-memory] Migrated schema v3 → v4 (tombstone / soft delete)");
  }

  /** Migrate schema v4 → v5: add trust_state, rejection_reason, superseded_by columns. */
  private migrateV4ToV5(): void {
    const cols = this.db.prepare("PRAGMA table_info(captures)").all() as { name: string }[];
    const hasTrustState = cols.some((c) => c.name === "trust_state");
    if (!hasTrustState) {
      this.db.exec("ALTER TABLE captures ADD COLUMN trust_state TEXT NOT NULL DEFAULT 'candidate'");
      console.error("[tdai-memory] Added trust_state column to captures");
    }
    const hasRejectionReason = cols.some((c) => c.name === "rejection_reason");
    if (!hasRejectionReason) {
      this.db.exec("ALTER TABLE captures ADD COLUMN rejection_reason TEXT");
      console.error("[tdai-memory] Added rejection_reason column to captures");
    }
    const hasSupersededBy = cols.some((c) => c.name === "superseded_by");
    if (!hasSupersededBy) {
      this.db.exec("ALTER TABLE captures ADD COLUMN superseded_by TEXT REFERENCES captures(id)");
      console.error("[tdai-memory] Added superseded_by column to captures");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_captures_trust ON captures (trust_state)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_captures_rejected_hash ON captures (content_hash) WHERE trust_state = 'rejected'",
    );
    console.error("[tdai-memory] Migrated schema v4 → v5 (trust state + correction)");
  }

  /** Migrate schema v5 → v6: add CodeGraph + Wiki tables (created by runSchema). */
  private migrateV5ToV6(): void {
    // Tables are created by runSchema() which runs CREATE TABLE IF NOT EXISTS.
    // This migration is a no-op placeholder for version tracking.
    console.error("[tdai-memory] Migrated schema v5 → v6 (CodeGraph + Wiki tables)");
  }

  async put(entry: CaptureEntry): Promise<void> {
    const contentHash =
      entry.contentHash ?? createHash("sha256").update(entry.content).digest("hex");
    const stmt = this.db.prepare(`
      INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata, team_id, user_id, task_id, trust_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.id,
      entry.sessionKey,
      entry.agentId,
      entry.type,
      entry.content,
      contentHash,
      JSON.stringify(entry.tags),
      entry.createdAt,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.teamId ?? null,
      entry.userId ?? null,
      entry.taskId ?? null,
      entry.trustState ?? "candidate",
    );

    // Store role-based messages if provided
    if (entry.messages && entry.messages.length > 0) {
      const msgStmt = this.db.prepare(
        "INSERT INTO messages (id, capture_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (let i = 0; i < entry.messages.length; i++) {
        const msg = entry.messages[i];
        msgStmt.run(generateId(), entry.id, msg.role, msg.content, i, entry.createdAt);
      }
    }
  }

  async putVector(id: string, embedding: number[]): Promise<void> {
    const buffer = new Float32Array(embedding);
    const stmt = this.db.prepare("INSERT INTO captures_vec (id, embedding) VALUES (?, ?)");
    stmt.run(id, Buffer.from(buffer.buffer));
  }

  async get(id: string): Promise<CaptureEntry | null> {
    const row = this.db
      .prepare("SELECT * FROM captures WHERE id = ? AND deleted_at IS NULL")
      .get(id) as DbRow | undefined;
    if (!row) return null;
    return rowToEntry(row);
  }

  async findRejectedByContentHash(
    contentHash: string,
    sessionKey?: string,
  ): Promise<CaptureEntry[]> {
    let sql = "SELECT * FROM captures WHERE content_hash = ? AND trust_state = 'rejected'";
    const params: unknown[] = [contentHash];
    if (sessionKey) {
      sql += " AND session_key = ?";
      params.push(sessionKey);
    }
    const rows = this.db.prepare(sql).all(...params) as DbRow[];
    return rows.map(rowToEntry);
  }

  async getMessages(captureId: string): Promise<MessageRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE capture_id = ? ORDER BY seq ASC")
      .all(captureId) as MessageDbRow[];
    return rows.map((r) => ({
      id: r.id,
      captureId: r.capture_id,
      role: r.role,
      content: r.content,
      seq: r.seq,
      createdAt: r.created_at,
    }));
  }

  async findByContentHash(contentHash: string, sessionKey?: string): Promise<CaptureEntry[]> {
    let sql = "SELECT * FROM captures WHERE content_hash = ? AND deleted_at IS NULL";
    const params: unknown[] = [contentHash];
    if (sessionKey) {
      sql += " AND session_key = ?";
      params.push(sessionKey);
    }
    const rows = this.db.prepare(sql).all(...params) as DbRow[];
    return rows.map(rowToEntry);
  }

  async listByTags(tags: string[], limit = 50): Promise<CaptureEntry[]> {
    if (tags.length === 0) return [];
    const tagConditions = tags.map(() => "tags LIKE ?").join(" OR ");
    const sql = `SELECT * FROM captures WHERE (${tagConditions}) AND deleted_at IS NULL AND trust_state != 'rejected' ORDER BY created_at DESC LIMIT ?`;
    const params = [...tags.map((t) => `%"${t}"%`), limit];
    const rows = this.db.prepare(sql).all(...params) as DbRow[];
    return rows.map(rowToEntry);
  }

  async search(
    query: string,
    queryEmbedding: number[] | null,
    opts: QueryOptions,
  ): Promise<SearchResult[]> {
    const { mode, limit, offset, sessionKey, filters } = opts;

    let bm25Results: RankedResult[] = [];
    let vecResults: RankedResult[] = [];

    // In hybrid mode, use different candidate pool sizes for each channel:
    // - BM25: tight pool (limit*2) for high precision — only best keyword matches
    // - Vector: broad pool (limit*5, cap 200) for high recall — semantic matches
    // This prevents OR-semantics BM25 noise from drowning out vector results at scale.
    const bm25CandidateLimit = mode === "hybrid" ? limit * 2 : limit * 2;
    const vecCandidateLimit = mode === "hybrid" ? Math.min(Math.max(limit * 5, 50), 200) : limit * 2;

    // BM25 search (FTS5)
    if (mode === "hybrid" || mode === "keyword") {
      bm25Results = this.bm25Search(query, bm25CandidateLimit, sessionKey, filters);
    }

    // Vector search (sqlite-vec)
    if ((mode === "hybrid" || mode === "vector") && queryEmbedding) {
      vecResults = this.vectorSearch(queryEmbedding, vecCandidateLimit, sessionKey, filters);
    }

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
    const ftsQuery = this.escapeFtsQuery(query);
    if (!ftsQuery) return [];

    let sql: string;
    const params: unknown[] = [ftsQuery];
    try {
      sql = `
      SELECT fts.id as id, bm25(captures_fts) as score
      FROM captures_fts fts
      JOIN captures c ON c.id = fts.id
      WHERE captures_fts MATCH ? AND c.deleted_at IS NULL AND c.trust_state != 'rejected'
    `;

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
      if (filters?.teamId) {
        sql += " AND c.team_id = ?";
        params.push(filters.teamId);
      }
      if (filters?.userId) {
        sql += " AND c.user_id = ?";
        params.push(filters.userId);
      }
      if (filters?.taskId) {
        sql += " AND c.task_id = ?";
        params.push(filters.taskId);
      }
      if (filters?.tags && filters.tags.length > 0) {
        const tagConditions = filters.tags.map(() => "c.tags LIKE ?").join(" OR ");
        sql += ` AND (${tagConditions})`;
        params.push(...filters.tags.map((t) => `%"${t}"%`));
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
    } catch (err: unknown) {
      // FTS5 external content tables can get out of sync after schema changes
      // or crashes. Rebuild the index and retry once.
      if (err instanceof Error && err.message.includes("missing row")) {
        this.db.exec("INSERT INTO captures_fts(captures_fts) VALUES('rebuild')");
        const rows = this.db.prepare(sql).all(...params) as { id: string; score: number }[];
        return rows.map((r) => ({ id: r.id, score: r.score }));
      }
      throw err;
    }
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
      WHERE vec.embedding MATCH ? AND vec.k = ? AND c.deleted_at IS NULL AND c.trust_state != 'rejected'
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
    if (filters?.teamId) {
      sql += " AND c.team_id = ?";
      params.push(filters.teamId);
    }
    if (filters?.userId) {
      sql += " AND c.user_id = ?";
      params.push(filters.userId);
    }
    if (filters?.taskId) {
      sql += " AND c.task_id = ?";
      params.push(filters.taskId);
    }
    if (filters?.tags && filters.tags.length > 0) {
      const tagConditions = filters.tags.map(() => "c.tags LIKE ?").join(" OR ");
      sql += ` AND (${tagConditions})`;
      params.push(...filters.tags.map((t) => `%"${t}"%`));
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

  /** Fetch capture entries by ID, preserving the order of the input list. Applies memory decay and trust-state ranking. */
  private async fetchEntriesById(
    results: { id: string; score: number }[],
  ): Promise<SearchResult[]> {
    if (results.length === 0) return [];
    const ids = results.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM captures WHERE id IN (${placeholders})`)
      .all(...ids) as DbRow[];
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const now = Date.now();
    const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    // Trust-state multipliers: verified > candidate > stale
    const TRUST_BOOST: Record<string, number> = {
      verified: 1.5,
      candidate: 1.0,
      stale: 0.5,
      rejected: 0,
    };
    return results
      .map((r) => {
        const row = rowMap.get(r.id);
        if (!row) return null;
        const ageMs = now - row.created_at;
        const decay = 0.5 ** (ageMs / HALF_LIFE_MS);
        const trustBoost = TRUST_BOOST[row.trust_state ?? "candidate"] ?? 1.0;
        const decayed = Number.isNaN(r.score) ? 0 : r.score * decay;
        // BM25 scores are negative (lower = better). For negative scores, divide by boost
        // so a lower boost makes the score more negative (ranks lower). For positive scores
        // (RRF fusion), multiply so a lower boost makes the score lower.
        const finalScore = decayed >= 0 ? decayed * trustBoost : decayed / trustBoost;
        // Recency tiebreaker: add a small boost proportional to how recent the memory is.
        // This helps temporal reasoning queries where the latest fact should win,
        // even when scores are very close (memories stored seconds apart).
        const recencyBias = 1 / (1 + ageMs / 60000); // 1.0 for new, ~0.0 for 1hr old
        const biasedScore = finalScore >= 0
          ? finalScore * (1 + recencyBias * 0.01)
          : finalScore / (1 + recencyBias * 0.01);
        return { entry: rowToEntry(row), score: biasedScore };
      })
      .filter((r): r is SearchResult => r !== null)
      .sort((a, b) => b.score - a.score);
  }

  /** Escape a query string for FTS5 MATCH.
   *  Uses AND semantics (all tokens must match) for high precision.
   *  At scale (1K+ memories), OR semantics introduces too much BM25 noise
   *  that drowns out vector search results in RRF fusion.
   *  Semantic recall is handled by the vector search channel instead.
   */
  private escapeFtsQuery(query: string): string {
    const tokens = query.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return "";
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
  }

  async delete(id: string): Promise<DeleteResult> {
    // Soft delete: set deleted_at instead of hard delete
    const now = Date.now();
    const captureCount = this.db
      .prepare("UPDATE captures SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(now, id).changes;

    if (captureCount > 0) {
      // Remove from search indexes (FTS + vector) so tombstoned captures are not retrievable
      this.db.prepare("DELETE FROM captures_vec WHERE id = ?").run(id);
      // FTS5 external content: use the 'delete' command to remove from index
      const rowid = this.db.prepare("SELECT rowid FROM captures WHERE id = ?").get(id) as
        | { rowid: number }
        | undefined;
      if (rowid) {
        this.db
          .prepare(
            "INSERT INTO captures_fts(captures_fts, rowid, content, tags, type) VALUES('delete', ?, '', '', '')",
          )
          .run(rowid.rowid);
      }
    }

    return {
      captures: captureCount,
      atoms: 0,
      scenarios: 0,
    };
  }

  async deleteByFilter(filter: DeleteFilter): Promise<DeleteResult> {
    let sql = "SELECT id FROM captures WHERE deleted_at IS NULL";
    const params: unknown[] = [];

    if (filter.type) {
      sql += " AND type = ?";
      params.push(filter.type);
    }
    if (filter.dateBefore) {
      sql += " AND created_at < ?";
      params.push(new Date(filter.dateBefore).getTime());
    }
    if (filter.teamId) {
      sql += " AND team_id = ?";
      params.push(filter.teamId);
    }
    if (filter.userId) {
      sql += " AND user_id = ?";
      params.push(filter.userId);
    }
    if (filter.taskId) {
      sql += " AND task_id = ?";
      params.push(filter.taskId);
    }
    if (filter.tags && filter.tags.length > 0) {
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

  async reject(id: string, reason: string): Promise<DeleteResult> {
    const now = Date.now();
    const captureCount = this.db
      .prepare(
        "UPDATE captures SET trust_state = 'rejected', rejection_reason = ?, deleted_at = ? WHERE id = ? AND deleted_at IS NULL AND trust_state != 'rejected'",
      )
      .run(reason, now, id).changes;

    if (captureCount > 0) {
      // Remove from search indexes so rejected captures are not retrievable
      this.db.prepare("DELETE FROM captures_vec WHERE id = ?").run(id);
      const rowid = this.db.prepare("SELECT rowid FROM captures WHERE id = ?").get(id) as
        | { rowid: number }
        | undefined;
      if (rowid) {
        this.db
          .prepare(
            "INSERT INTO captures_fts(captures_fts, rowid, content, tags, type) VALUES('delete', ?, '', '', '')",
          )
          .run(rowid.rowid);
      }
    }

    return { captures: captureCount, atoms: 0, scenarios: 0 };
  }

  async findConflicts(
    embedding: number[],
    sessionKey: string,
    threshold: number,
  ): Promise<ConflictResult[]> {
    const buffer = new Float32Array(embedding);
    const rows = this.db
      .prepare(
        `SELECT vec.id as id, vec.distance as distance, c.content as content, c.trust_state as trust_state
         FROM captures_vec vec
         JOIN captures c ON c.id = vec.id
         WHERE vec.embedding MATCH ? AND vec.k = 20
           AND c.deleted_at IS NULL
           AND c.trust_state IN ('candidate', 'verified')
           AND c.session_key = ?
         ORDER BY vec.distance
         LIMIT 10`,
      )
      .all(Buffer.from(buffer.buffer), sessionKey) as {
      id: string;
      distance: number;
      content: string;
      trust_state: string;
    }[];

    return rows
      .filter((r) => {
        // sqlite-vec returns L2 (euclidean) distance for float[] columns.
        // Convert to cosine distance: cosine_dist = L2^2 / 2 (for normalized vectors).
        // Filter by cosine distance threshold.
        const cosineDist = (r.distance * r.distance) / 2;
        return cosineDist < threshold;
      })
      .map((r) => ({
        id: r.id,
        content: r.content,
        // Return cosine distance (not L2) so the caller gets a meaningful value.
        distance: (r.distance * r.distance) / 2,
        trustState: r.trust_state as TrustState,
      }));
  }

  async supersede(loserId: string, winnerId: string): Promise<ResolveResult> {
    const updated = this.db
      .prepare(
        "UPDATE captures SET trust_state = 'stale', superseded_by = ? WHERE id = ? AND deleted_at IS NULL AND trust_state != 'rejected'",
      )
      .run(winnerId, loserId).changes;
    return { winnerId, loserId, updated };
  }

  async setTrustState(id: string, state: TrustState): Promise<number> {
    return this.db
      .prepare("UPDATE captures SET trust_state = ? WHERE id = ? AND deleted_at IS NULL")
      .run(state, id).changes;
  }

  // ─── L1 atoms ───────────────────────────────────────────────

  async putAtom(atom: AtomEntry): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO atoms (id, capture_id, fact, confidence, created_at, team_id, agent_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        atom.id,
        atom.captureId,
        atom.fact,
        atom.confidence,
        atom.createdAt,
        atom.teamId ?? null,
        atom.agentId ?? null,
        atom.userId ?? null,
      );
  }

  async listAtoms(opts: {
    teamId?: string;
    agentId?: string;
    userId?: string;
    captureId?: string;
    limit?: number;
    offset?: number;
  }): Promise<AtomEntry[]> {
    let sql = "SELECT * FROM atoms WHERE 1=1";
    const params: unknown[] = [];
    if (opts.teamId) {
      sql += " AND team_id = ?";
      params.push(opts.teamId);
    }
    if (opts.agentId) {
      sql += " AND agent_id = ?";
      params.push(opts.agentId);
    }
    if (opts.userId) {
      sql += " AND user_id = ?";
      params.push(opts.userId);
    }
    if (opts.captureId) {
      sql += " AND capture_id = ?";
      params.push(opts.captureId);
    }
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(opts.limit ?? 20, opts.offset ?? 0);
    const rows = this.db.prepare(sql).all(...params) as AtomDbRow[];
    return rows.map((r) => ({
      id: r.id,
      captureId: r.capture_id,
      fact: r.fact,
      confidence: r.confidence,
      createdAt: r.created_at,
      teamId: r.team_id ?? undefined,
      agentId: r.agent_id ?? undefined,
      userId: r.user_id ?? undefined,
    }));
  }

  async searchAtoms(
    query: string,
    opts: { teamId?: string; agentId?: string; userId?: string; limit?: number } = {},
  ): Promise<AtomEntry[]> {
    // Atoms don't have FTS — use LIKE for keyword search
    let sql = "SELECT * FROM atoms WHERE fact LIKE ?";
    const params: unknown[] = [`%${query}%`];
    if (opts.teamId) {
      sql += " AND team_id = ?";
      params.push(opts.teamId);
    }
    if (opts.agentId) {
      sql += " AND agent_id = ?";
      params.push(opts.agentId);
    }
    if (opts.userId) {
      sql += " AND user_id = ?";
      params.push(opts.userId);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(opts.limit ?? 20);
    const rows = this.db.prepare(sql).all(...params) as AtomDbRow[];
    return rows.map((r) => ({
      id: r.id,
      captureId: r.capture_id,
      fact: r.fact,
      confidence: r.confidence,
      createdAt: r.created_at,
      teamId: r.team_id ?? undefined,
      agentId: r.agent_id ?? undefined,
      userId: r.user_id ?? undefined,
    }));
  }

  // ─── L2 scenarios ───────────────────────────────────────────

  async putScenario(scenario: ScenarioEntry): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO scenarios (id, atom_ids, summary, persona_tags, created_at, team_id, agent_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        scenario.id,
        JSON.stringify(scenario.atomIds),
        scenario.summary,
        scenario.personaTags ? JSON.stringify(scenario.personaTags) : null,
        scenario.createdAt,
        scenario.teamId ?? null,
        scenario.agentId ?? null,
        scenario.userId ?? null,
      );
  }

  async listScenarios(opts: {
    teamId?: string;
    agentId?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<ScenarioEntry[]> {
    let sql = "SELECT * FROM scenarios WHERE 1=1";
    const params: unknown[] = [];
    if (opts.teamId) {
      sql += " AND team_id = ?";
      params.push(opts.teamId);
    }
    if (opts.agentId) {
      sql += " AND agent_id = ?";
      params.push(opts.agentId);
    }
    if (opts.userId) {
      sql += " AND user_id = ?";
      params.push(opts.userId);
    }
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(opts.limit ?? 20, opts.offset ?? 0);
    const rows = this.db.prepare(sql).all(...params) as ScenarioDbRow[];
    return rows.map((r) => ({
      id: r.id,
      atomIds: JSON.parse(r.atom_ids) as string[],
      summary: r.summary,
      personaTags: r.persona_tags ? (JSON.parse(r.persona_tags) as string[]) : undefined,
      createdAt: r.created_at,
      teamId: r.team_id ?? undefined,
      agentId: r.agent_id ?? undefined,
      userId: r.user_id ?? undefined,
    }));
  }

  async getScenario(id: string): Promise<ScenarioEntry | null> {
    const row = this.db.prepare("SELECT * FROM scenarios WHERE id = ?").get(id) as
      | ScenarioDbRow
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      atomIds: JSON.parse(row.atom_ids) as string[],
      summary: row.summary,
      personaTags: row.persona_tags ? (JSON.parse(row.persona_tags) as string[]) : undefined,
      createdAt: row.created_at,
      teamId: row.team_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      userId: row.user_id ?? undefined,
    };
  }

  // ─── L3 persona ─────────────────────────────────────────────

  async readPersona(teamId: string, agentId: string, userId: string): Promise<PersonaEntry | null> {
    const row = this.db
      .prepare("SELECT * FROM persona WHERE team_id = ? AND agent_id = ? AND user_id = ?")
      .get(teamId, agentId, userId) as PersonaDbRow | undefined;
    if (!row) return null;
    return {
      teamId: row.team_id,
      agentId: row.agent_id,
      userId: row.user_id,
      content: row.content,
      updatedAt: row.updated_at,
    };
  }

  async writePersona(
    teamId: string,
    agentId: string,
    userId: string,
    content: string,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO persona (team_id, agent_id, user_id, content, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(team_id, agent_id, user_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      )
      .run(teamId, agentId, userId, content, Date.now());
  }

  // ─── Knowledge ──────────────────────────────────────────────

  async putKnowledge(entry: KnowledgeEntry): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO knowledge (id, team_id, name, type, summary, service_url, repo_url, branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.id,
        entry.teamId,
        entry.name,
        entry.type,
        entry.summary ?? null,
        entry.serviceUrl ?? null,
        entry.repoUrl ?? null,
        entry.branch ?? null,
        entry.createdAt,
      );
  }

  async getKnowledge(id: string): Promise<KnowledgeEntry | null> {
    const row = this.db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id) as
      | KnowledgeDbRow
      | undefined;
    if (!row) return null;
    return knowledgeRowToEntry(row);
  }

  async listKnowledge(teamId: string, type?: string): Promise<KnowledgeEntry[]> {
    let sql = "SELECT * FROM knowledge WHERE team_id = ?";
    const params: unknown[] = [teamId];
    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }
    sql += " ORDER BY created_at DESC";
    const rows = this.db.prepare(sql).all(...params) as KnowledgeDbRow[];
    return rows.map(knowledgeRowToEntry);
  }

  async deleteKnowledge(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = this.db
      .prepare(`DELETE FROM knowledge WHERE id IN (${placeholders})`)
      .run(...ids);
    return result.changes;
  }

  // ─── Skills ─────────────────────────────────────────────────

  async putSkill(entry: SkillEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO skills (id, team_id, agent_id, name, description, content, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, content = excluded.content, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(
        entry.id,
        entry.teamId,
        entry.agentId ?? null,
        entry.name,
        entry.description ?? null,
        entry.content ?? null,
        entry.version,
        entry.createdAt,
        entry.updatedAt,
      );
  }

  async getSkill(id: string): Promise<SkillEntry | null> {
    const row = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as
      | SkillDbRow
      | undefined;
    if (!row) return null;
    return skillRowToEntry(row);
  }

  async listSkills(teamId: string, agentId?: string): Promise<SkillEntry[]> {
    let sql = "SELECT * FROM skills WHERE team_id = ?";
    const params: unknown[] = [teamId];
    if (agentId) {
      sql += " AND (agent_id = ? OR agent_id IS NULL)";
      params.push(agentId);
    }
    sql += " ORDER BY updated_at DESC";
    const rows = this.db.prepare(sql).all(...params) as SkillDbRow[];
    return rows.map(skillRowToEntry);
  }

  async searchSkills(
    teamId: string,
    agentId: string,
    query: string,
    topK?: number,
  ): Promise<SkillEntry[]> {
    let sql =
      "SELECT * FROM skills WHERE team_id = ? AND (agent_id = ? OR agent_id IS NULL) AND (name LIKE ? OR description LIKE ?)";
    const params: unknown[] = [teamId, agentId, `%${query}%`, `%${query}%`];
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(topK ?? 10);
    const rows = this.db.prepare(sql).all(...params) as SkillDbRow[];
    return rows.map(skillRowToEntry);
  }

  close(): void {
    this.db.close();
  }
}

// ─── Database row types ────────────────────────────────────────

interface DbRow {
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
  deleted_at: number | null;
  trust_state: string | null;
  rejection_reason: string | null;
  superseded_by: string | null;
}

interface MessageDbRow {
  id: string;
  capture_id: string;
  role: string;
  content: string;
  seq: number;
  created_at: number;
}

interface AtomDbRow {
  id: string;
  capture_id: string;
  fact: string;
  confidence: number;
  created_at: number;
  team_id: string | null;
  agent_id: string | null;
  user_id: string | null;
}

interface ScenarioDbRow {
  id: string;
  atom_ids: string;
  summary: string;
  persona_tags: string | null;
  created_at: number;
  team_id: string | null;
  agent_id: string | null;
  user_id: string | null;
}

interface PersonaDbRow {
  team_id: string;
  agent_id: string;
  user_id: string;
  content: string;
  updated_at: number;
}

interface KnowledgeDbRow {
  id: string;
  team_id: string;
  name: string;
  type: string;
  summary: string | null;
  service_url: string | null;
  repo_url: string | null;
  branch: string | null;
  created_at: number;
}

interface SkillDbRow {
  id: string;
  team_id: string;
  agent_id: string | null;
  name: string;
  description: string | null;
  content: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

// ─── Row → Entry converters ────────────────────────────────────

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
    teamId: row.team_id ?? undefined,
    userId: row.user_id ?? undefined,
    taskId: row.task_id ?? undefined,
    trustState: (row.trust_state as TrustState) ?? "candidate",
    rejectionReason: row.rejection_reason ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
  };
}

function knowledgeRowToEntry(row: KnowledgeDbRow): KnowledgeEntry {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    type: row.type,
    summary: row.summary ?? undefined,
    serviceUrl: row.service_url ?? undefined,
    repoUrl: row.repo_url ?? undefined,
    branch: row.branch ?? undefined,
    createdAt: row.created_at,
  };
}

function skillRowToEntry(row: SkillDbRow): SkillEntry {
  return {
    id: row.id,
    teamId: row.team_id,
    agentId: row.agent_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    content: row.content ?? undefined,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
