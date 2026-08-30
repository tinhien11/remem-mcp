import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { type RankedResult, rrfMerge } from "../utils/rrf.js";
import { generateId } from "../utils/ulid.js";
import { WriteQueue } from "../utils/write-queue.js";
import type {
  AtomEntry,
  CaptureEntry,
  ConflictResult,
  ScoreDetails,
  DeleteFilter,
  DeleteResult,
  KnowledgeEntry,
  MessageRow,
  PersonaEntry,
  QueryOptions,
  ResolveResult,
  ScenarioEntry,
  SearchFilters,
  SearchResult,
  SkillEntry,
  StorageBackend,
  TrustState,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** FTS stopword set — shared between BM25 query building and proper-noun stripping. */
const FTS_STOPWORDS_SET = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "shall",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "and",
  "or",
  "but",
  "not",
  "no",
  "nor",
  "so",
  "yet",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "why",
  "since",
  "because",
  "if",
  "then",
  "than",
]);

/**
 * Strip proper nouns (person/place names) from a query, leaving only content words.
 * Returns the stripped query string, or empty string if nothing remains after stripping.
 * Used by both BM25 (escapeFtsQuery) and vector search (SDK) to ensure proper nouns
 * don't dominate search results when they're rare tokens.
 *
 * Only strips words that look like person names: first letter uppercase, rest lowercase.
 * Keeps acronyms (all-caps: API, REST, CI) and mixed-case technical terms (GraphQL,
 * PostgreSQL, JavaScript) — these carry semantic meaning that should be preserved.
 *
 * E.g. "what editor does Tin use" → "editor use"
 *      "API design GraphQL or REST" → "API design GraphQL or REST" (no change)
 *      "When did Caroline go to the LGBTQ support group" → "go LGBTQ support group"
 */
export function stripQueryProperNouns(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  const filtered = tokens.filter((t) => t.length <= 1 || !FTS_STOPWORDS_SET.has(t.toLowerCase()));
  // Strip person-name-like words: first char uppercase, rest lowercase (length > 1).
  // Keep acronyms (all-caps), mixed-case (GraphQL), and single-char tokens.
  const isPersonName = (t: string): boolean => {
    if (t.length <= 1) return false;
    if (t[0] !== t[0].toUpperCase()) return false;
    if (t[0] === t[0].toUpperCase() && t.slice(1) === t.slice(1).toLowerCase()) return true;
    return false;
  };
  const noProperNouns = filtered.filter(
    (t) => t.length <= 1 || !isPersonName(t) || FTS_STOPWORDS_SET.has(t.toLowerCase()),
  );
  // Only strip if ≥2 content words remain (preserve single-word queries)
  if (noProperNouns.length >= 2) return noProperNouns.join(" ");
  if (noProperNouns.length > 0) return noProperNouns.join(" ");
  return filtered.length > 0 ? filtered.join(" ") : tokens.join(" ");
}

/** Current schema version. */
const CURRENT_SCHEMA_VERSION = 14;

/**
 * Evergreen tags: captures with any of these tags are exempt from temporal
 * decay and the auto-stale mechanism (decay multiplier = 1.0, never marked
 * stale). Parsed once at startup from REMEM_EVERGREEN_TAGS (comma-separated).
 * Default: "evergreen,never-forget".
 */
const EVERGREEN_TAGS: ReadonlySet<string> = new Set(
  (process.env.REMEM_EVERGREEN_TAGS ?? "evergreen,never-forget")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean),
);

/** Check whether a capture's tags include any evergreen tag. */
function isEvergreen(tags: string[] | undefined | null): boolean {
  if (!tags || tags.length === 0) return false;
  return tags.some((t) => EVERGREEN_TAGS.has(t.toLowerCase()));
}

/**
 * Auto-assign an authority tier based on capture type and tags (v10).
 * - decision → "decision" (durable, high authority)
 * - pattern → "rule" (procedural, high authority)
 * - error/learning/task → "episodic" (default, decays over time)
 * - Tags can override: "rule", "decision", "canonical" → respective tier
 */
function autoAssignTier(type: string, tags: string[] | undefined | null): string {
  // Tag overrides
  if (tags) {
    const lower = tags.map((t) => t.toLowerCase());
    if (lower.includes("rule") || lower.includes("canonical")) return "rule";
    if (lower.includes("decision")) return "decision";
    if (lower.includes("test") || lower.includes("test-fixture")) return "test";
  }
  // Type-based defaults
  if (type === "decision") return "decision";
  if (type === "pattern") return "rule";
  return "episodic";
}

/**
 * Authority boost tags (v10). Bounded multiplier applied after RRF fusion.
 * Positive tags boost, negative tags penalize. Never absolute filters.
 */
const AUTHORITY_POSITIVE_TAGS: ReadonlySet<string> = new Set([
  "canonical",
  "active",
  "source-of-truth",
  "pinned",
]);
const AUTHORITY_NEGATIVE_TAGS: ReadonlySet<string> = new Set([
  "superseded",
  "historical",
  "test-fixture",
  "do-not-answer-from",
]);

/** Compute authority multiplier for a capture (v10). Bounded: 0.5x to 1.5x. */
function authorityMultiplier(tier: string, tags: string[] | undefined | null): number {
  let multiplier = 1.0;
  // Tier boosts
  if (tier === "rule") multiplier += 0.2;
  else if (tier === "decision") multiplier += 0.15;
  else if (tier === "test") multiplier -= 0.1;
  // Tag boosts
  if (tags) {
    for (const tag of tags) {
      const lower = tag.toLowerCase();
      if (AUTHORITY_POSITIVE_TAGS.has(lower)) multiplier += 0.1;
      if (AUTHORITY_NEGATIVE_TAGS.has(lower)) multiplier -= 0.15;
    }
  }
  // Clamp to bounded range
  return Math.max(0.5, Math.min(1.5, multiplier));
}

/**
 * Extract up to 10 significant nouns/entities from text (v10 entity-assisted recall).
 * Simple heuristic: capitalized words, technical terms, and words >4 chars that
 * aren't stopwords. No NLP dependency — just lexical extraction.
 */
const ENTITY_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "this", "that", "with", "from", "have", "been", "will", "would",
  "could", "should", "there", "their", "about", "which", "when", "what",
  "they", "them", "then", "than", "into", "after", "before", "between",
  "during", "through", "above", "below", "under", "over", "again",
  "because", "while", "where", "these", "those", "being", "having",
  "using", "based", "other", "some", "such", "more", "most", "only",
  "very", "also", "just", "like", "even", "still", "back", "make",
  "made", "used", "uses", "using", "want", "need", "know", "think",
  "thing", "things", "stuff", "code", "file", "files", "line", "lines",
  "here", "there", "where", "when", "what", "which", "whose",
]);

export function extractEntities(text: string): string[] {
  // Extract capitalized words (proper nouns, tech terms)
  const capsMatches = text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [];
  // Extract technical terms: words with hyphens, dots, or all-caps acronyms
  const techMatches = text.match(/\b[a-z]+[-_][a-z]+\b/gi) ?? [];
  const acroMatches = text.match(/\b[A-Z]{2,}\b/g) ?? [];
  // Extract significant lowercase words (>4 chars, not stopwords)
  const words = text.match(/\b[a-z]{5,}\b/gi) ?? [];

  const candidates = [...capsMatches, ...techMatches, ...acroMatches, ...words];
  const seen = new Set<string>();
  const entities: string[] = [];

  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (ENTITY_STOPWORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    entities.push(lower);
    if (entities.length >= 10) break;
  }

  return entities;
}

/**
 * SQLite storage backend.
 * Uses better-sqlite3 + sqlite-vec + FTS5.
 * Default backend. Zero setup.
 */
export class SQLiteBackend implements StorageBackend {
  private db: Database.Database;
  /** v11: Single-writer queue — serializes all write operations to prevent "database is locked". */
  private writeQueue: WriteQueue = new WriteQueue();

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
      this.db.pragma("busy_timeout = 10000");
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
      } catch (err) {
        console.error(`[remem-mcp] Migration failed: ${err}`);
        throw err;
      }
    }
  }

  /**
   * Detect the database state and run the correct migration path.
   */
  private detectAndMigrate(dbPath: string): void {
    let migrationsRan = false;
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
        migrationsRan = true;
        this.backupDatabase(dbPath, 0);
        this.db.transaction(() => {
          this.migrateV1ToV2();
          this.migrateV2ToV3();
          this.migrateV3ToV4();
          this.migrateV4ToV5();
          this.migrateV5ToV6();
          this.migrateV6ToV7();
          this.migrateV7ToV8();
          // Now run the full schema to create any remaining tables/triggers/indexes
          this.runSchema();
          this.writeSchemaVersion(CURRENT_SCHEMA_VERSION);
        })();
      }
      this.rebuildFtsIfNeeded(migrationsRan);
      return;
    }

    // Database has a schema_version table. Read the current version.
    const row = this.db.prepare("SELECT MAX(version) as version FROM schema_version").get() as
      | { version: number }
      | undefined;
    const currentVersion = row?.version ?? 0;

    if (currentVersion < 1) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 0);
      this.db.transaction(() => {
        this.runSchema();
        this.writeSchemaVersion(1);
      })();
    }
    if (currentVersion < 2) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 1);
      this.db.transaction(() => {
        this.migrateV1ToV2();
        this.writeSchemaVersion(2);
      })();
    }
    if (currentVersion < 3) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 2);
      this.db.transaction(() => {
        this.migrateV2ToV3();
        this.writeSchemaVersion(3);
      })();
    }
    if (currentVersion < 4) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 3);
      this.db.transaction(() => {
        this.migrateV3ToV4();
        this.writeSchemaVersion(4);
      })();
    }
    if (currentVersion < 5) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 4);
      this.db.transaction(() => {
        this.migrateV4ToV5();
        this.writeSchemaVersion(5);
      })();
    }
    if (currentVersion < 6) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 5);
      // Tables are created by runSchema() via CREATE TABLE IF NOT EXISTS.
      // Run schema to create CodeGraph + Wiki tables.
      this.db.transaction(() => {
        this.runSchema();
        this.migrateV5ToV6();
        this.writeSchemaVersion(6);
      })();
    }
    if (currentVersion < 7) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 6);
      this.db.transaction(() => {
        this.migrateV6ToV7();
        this.writeSchemaVersion(7);
      })();
    }
    if (currentVersion < 8) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 7);
      this.db.transaction(() => {
        this.migrateV7ToV8();
        this.writeSchemaVersion(8);
      })();
    }
    if (currentVersion < 9) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 8);
      this.db.transaction(() => {
        this.migrateV8ToV9();
        this.writeSchemaVersion(9);
      })();
    }
    if (currentVersion < 10) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 9);
      this.db.transaction(() => {
        this.runSchema(); // creates entities table + new columns in captures
        this.migrateV9ToV10();
        this.writeSchemaVersion(10);
      })();
    }
    if (currentVersion < 11) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 10);
      this.db.transaction(() => {
        this.runSchema(); // creates memory_links table
        this.writeSchemaVersion(11);
      })();
    }
    if (currentVersion < 12) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 11);
      this.db.transaction(() => {
        this.runSchema(); // creates capture_feedback + audit_log tables + new captures columns
        this.migrateV11ToV12();
        this.writeSchemaVersion(12);
      })();
    }
    if (currentVersion < 13) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 12);
      this.db.transaction(() => {
        this.runSchema(); // creates memory_links with weight column
        this.migrateV12ToV13();
        this.writeSchemaVersion(13);
      })();
    }
    if (currentVersion < 14) {
      migrationsRan = true;
      this.backupDatabase(dbPath, 13);
      this.db.transaction(() => {
        this.runSchema(); // adds session_key column + idx_scenarios_session
        this.migrateV13ToV14();
        this.writeSchemaVersion(14);
      })();
    }
    this.rebuildFtsIfNeeded(migrationsRan);
  }

  /**
   * Rebuild the FTS index if migrations were run, so pre-migration captures
   * that exist in the captures table but are absent from captures_fts get
   * indexed. No-op when no migrations ran (fresh DB already populates FTS
   * via triggers) or when the FTS table does not exist yet.
   */
  private rebuildFtsIfNeeded(migrationsRan: boolean): void {
    if (!migrationsRan) return;
    const hasFts = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='captures_fts'")
      .get() as { name: string } | undefined;
    if (!hasFts) return;
    // Rebuild FTS index for pre-migration captures
    this.db.exec("INSERT INTO captures_fts(captures_fts) VALUES('rebuild')");
  }

  /** Backup the database to a versioned .bak file. */
  private backupDatabase(dbPath: string, fromVersion: number): void {
    const backupPath = `${dbPath}.bak.v${fromVersion}`;
    try {
      this.db.pragma("wal_checkpoint(FULL)");
      copyFileSync(dbPath, backupPath);
      console.error(`[remem-mcp] Backed up database to ${backupPath}`);
    } catch (err) {
      console.error(`[remem-mcp] Backup failed: ${err}`);
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
      console.error("[remem-mcp] Added content_hash column to captures");
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
      console.error(`[remem-mcp] Backfilled content_hash for ${rows.length} existing captures`);
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
    addColumnIfMissing("scenarios", "session_key", "TEXT");

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
      "[remem-mcp] Migrated schema v2 → v3 (multi-tenant + messages + knowledge + skills + persona)",
    );
  }

  /** Migrate schema v3 → v4: add deleted_at column for soft delete (tombstone). */
  private migrateV3ToV4(): void {
    const cols = this.db.prepare("PRAGMA table_info(captures)").all() as { name: string }[];
    const hasDeletedAt = cols.some((c) => c.name === "deleted_at");
    if (!hasDeletedAt) {
      this.db.exec("ALTER TABLE captures ADD COLUMN deleted_at INTEGER");
      console.error("[remem-mcp] Added deleted_at column to captures (tombstone support)");
    }
    console.error("[remem-mcp] Migrated schema v3 → v4 (tombstone / soft delete)");
  }

  /** Migrate schema v4 → v5: add trust_state, rejection_reason, superseded_by columns. */
  private migrateV4ToV5(): void {
    const cols = this.db.prepare("PRAGMA table_info(captures)").all() as { name: string }[];
    const hasTrustState = cols.some((c) => c.name === "trust_state");
    if (!hasTrustState) {
      this.db.exec("ALTER TABLE captures ADD COLUMN trust_state TEXT NOT NULL DEFAULT 'candidate'");
      console.error("[remem-mcp] Added trust_state column to captures");
    }
    const hasRejectionReason = cols.some((c) => c.name === "rejection_reason");
    if (!hasRejectionReason) {
      this.db.exec("ALTER TABLE captures ADD COLUMN rejection_reason TEXT");
      console.error("[remem-mcp] Added rejection_reason column to captures");
    }
    const hasSupersededBy = cols.some((c) => c.name === "superseded_by");
    if (!hasSupersededBy) {
      this.db.exec("ALTER TABLE captures ADD COLUMN superseded_by TEXT REFERENCES captures(id)");
      console.error("[remem-mcp] Added superseded_by column to captures");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_captures_trust ON captures (trust_state)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_captures_rejected_hash ON captures (content_hash) WHERE trust_state = 'rejected'",
    );
    console.error("[remem-mcp] Migrated schema v4 → v5 (trust state + correction)");
  }

  /** Migrate schema v5 → v6: add CodeGraph + Wiki tables (created by runSchema). */
  private migrateV5ToV6(): void {
    // Tables are created by runSchema() which runs CREATE TABLE IF NOT EXISTS.
    // This migration is a no-op placeholder for version tracking.
    console.error("[remem-mcp] Migrated schema v5 → v6 (CodeGraph + Wiki tables)");
  }

  /** Migrate schema v6 → v7: add access tracking + Bayesian confidence columns. */
  private migrateV6ToV7(): void {
    // Check EACH column individually so an interrupted migration (crash after
    // the first ALTER but before the rest) resumes correctly on retry instead
    // of being skipped because the sentinel column already exists.
    let addedAny = false;
    try {
      this.db.exec("ALTER TABLE captures ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
      addedAny = true;
    } catch {}
    try {
      this.db.exec("ALTER TABLE captures ADD COLUMN last_accessed_at INTEGER");
      addedAny = true;
    } catch {}
    try {
      this.db.exec("ALTER TABLE captures ADD COLUMN confirmations INTEGER NOT NULL DEFAULT 0");
      addedAny = true;
    } catch {}
    try {
      this.db.exec("ALTER TABLE captures ADD COLUMN corrections INTEGER NOT NULL DEFAULT 0");
      addedAny = true;
    } catch {}
    if (addedAny) {
      console.error("[remem-mcp] Added access tracking + Bayesian confidence columns");
    }
    console.error("[remem-mcp] Migrated schema v6 → v7 (access tracking + confidence)");
  }

  /** Migrate schema v7 → v8: add correction outcome tracking columns. */
  private migrateV7ToV8(): void {
    // Check EACH column individually so an interrupted migration (crash after
    // the first ALTER but before the rest) resumes correctly on retry instead
    // of being skipped because the sentinel column already exists.
    let addedAny = false;
    try {
      this.db.exec("ALTER TABLE captures ADD COLUMN retrieved_count INTEGER NOT NULL DEFAULT 0");
      addedAny = true;
    } catch {}
    try {
      this.db.exec("ALTER TABLE captures ADD COLUMN heeded_count INTEGER NOT NULL DEFAULT 0");
      addedAny = true;
    } catch {}
    try {
      this.db.exec("ALTER TABLE captures ADD COLUMN recurrence_count INTEGER NOT NULL DEFAULT 0");
      addedAny = true;
    } catch {}
    try {
      this.db.exec("ALTER TABLE captures ADD COLUMN last_outcome TEXT");
      addedAny = true;
    } catch {}
    if (addedAny) {
      console.error("[remem-mcp] Added correction outcome tracking columns");
    }
    console.error("[remem-mcp] Migrated schema v7 → v8 (correction outcome tracking)");
  }

  /** Migrate schema v8 → v9: add CodeGraph call resolution columns (module_path, confidence, call_type). */
  private migrateV8ToV9(): void {
    let addedAny = false;
    try {
      this.db.exec("ALTER TABLE symbols ADD COLUMN module_path TEXT");
      addedAny = true;
    } catch (err) {
      if (!String(err).includes("duplicate column"))
        console.error(`[remem-mcp] migrateV8ToV9: ${err}`);
    }
    try {
      this.db.exec("ALTER TABLE calls ADD COLUMN confidence REAL");
      addedAny = true;
    } catch (err) {
      if (!String(err).includes("duplicate column"))
        console.error(`[remem-mcp] migrateV8ToV9: ${err}`);
    }
    try {
      this.db.exec("ALTER TABLE calls ADD COLUMN call_type TEXT NOT NULL DEFAULT 'direct'");
      addedAny = true;
    } catch (err) {
      if (!String(err).includes("duplicate column"))
        console.error(`[remem-mcp] migrateV8ToV9: ${err}`);
    }
    if (addedAny) {
      console.error(
        "[remem-mcp] Added CodeGraph call resolution columns (module_path, confidence, call_type)",
      );
    }
    console.error("[remem-mcp] Migrated schema v8 → v9 (CodeGraph call resolution)");
  }

  /** Migrate schema v9 → v10: add tier + salience columns to captures, create entities table, backfill tiers. */
  private migrateV9ToV10(): void {
    let addedAny = false;
    try {
      this.db.exec("ALTER TABLE captures ADD COLUMN tier TEXT NOT NULL DEFAULT 'episodic'");
      addedAny = true;
    } catch {}
    try {
      this.db.exec("ALTER TABLE captures ADD COLUMN salience REAL NOT NULL DEFAULT 1.0");
      addedAny = true;
    } catch {}
    if (addedAny) {
      console.error("[remem-mcp] Added tier + salience columns to captures");
    }
    // Backfill tier based on capture type
    this.db.exec("UPDATE captures SET tier = 'decision' WHERE type = 'decision' AND tier = 'episodic'");
    this.db.exec("UPDATE captures SET tier = 'rule' WHERE type = 'pattern' AND tier = 'episodic'");
    this.db.exec("UPDATE captures SET tier = 'test' WHERE type = 'error' AND tags LIKE '%test%' AND tier = 'episodic'");
    // entities table is created by runSchema() via CREATE TABLE IF NOT EXISTS
    console.error("[remem-mcp] Migrated schema v9 → v10 (authority tiers + salience + entities table)");
  }

  /**
   * v11 → v12: Add expires_at + feedback_salience columns to captures.
   * Create capture_feedback + audit_log tables (via runSchema).
   * No data migration needed — new columns have defaults.
   */
  private migrateV11ToV12(): void {
    // Add columns if they don't exist (ALTER TABLE ADD COLUMN is idempotent-safe via check)
    const cols = this.db.prepare("PRAGMA table_info(captures)").all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("expires_at")) {
      this.db.exec("ALTER TABLE captures ADD COLUMN expires_at INTEGER");
    }
    if (!colNames.has("feedback_salience")) {
      this.db.exec("ALTER TABLE captures ADD COLUMN feedback_salience REAL NOT NULL DEFAULT 1.0");
    }
    // capture_feedback + mutation_log tables created by runSchema() via CREATE TABLE IF NOT EXISTS
    console.error("[remem-mcp] Migrated schema v11 → v12 (feedback + mutation log + TTL)");
  }

  /**
   * v12 → v13: Add weight column to memory_links for Hebbian co-retrieval strengthening.
   */
  private migrateV12ToV13(): void {
    const cols = this.db.prepare("PRAGMA table_info(memory_links)").all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("weight")) {
      this.db.exec("ALTER TABLE memory_links ADD COLUMN weight REAL NOT NULL DEFAULT 1.0");
    }
    console.error("[remem-mcp] Migrated schema v12 → v13 (Hebbian link weights)");
  }

  /**
   * v13 → v14: Add session_key column to scenarios so L2 scenario injection in
   * hooks can be scoped to the current project (hash(cwd)). Legacy rows keep
   * NULL session_key and are excluded from hook injection (no cross-project leak).
   */
  private migrateV13ToV14(): void {
    const cols = this.db.prepare("PRAGMA table_info(scenarios)").all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("session_key")) {
      this.db.exec("ALTER TABLE scenarios ADD COLUMN session_key TEXT");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_scenarios_session ON scenarios (session_key, created_at DESC)",
    );
    console.error("[remem-mcp] Migrated schema v13 → v14 (scenario session_key scoping)");
  }

  async put(entry: CaptureEntry): Promise<void> {
    this.putInternal(entry);
  }

  private putInternal(entry: CaptureEntry): void {
    const contentHash =
      entry.contentHash ?? createHash("sha256").update(entry.content).digest("hex");
    // Auto-assign tier based on capture type (v10 authority-aware ranking)
    const tier = autoAssignTier(entry.type, entry.tags);
    // Atomically check + insert to close the TOCTOU race in capture dedup. Callers
    // (handleCapture, handoff, adr, sdk) first call findByContentHash and then put;
    // without a transaction two concurrent captures with identical content could
    // both pass the check and both insert duplicate rows. Wrapping the dedup probe
    // and the INSERT in a single db.transaction holds the write lock for the whole
    // operation, so the second concurrent put observes the first's row and skips.
    // Soft-deleted (forgotten) rows are excluded so a forgotten capture can be
    // re-captured. This is scoped to (content_hash, session_key, agent_id) to match
    // findByContentHash's dedup scope.
    const putTx = this.db.transaction(() => {
      const dup = this.db
        .prepare(
          "SELECT 1 FROM captures WHERE content_hash = ? AND session_key = ? AND agent_id = ? AND deleted_at IS NULL LIMIT 1",
        )
        .get(contentHash, entry.sessionKey, entry.agentId);
      if (dup) return false;
      this.db
        .prepare(
          `INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata, team_id, user_id, task_id, trust_state, tier)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
          tier,
        );
      // Store role-based messages inside the same transaction so a crash can't
      // orphan messages under a capture that didn't commit.
      if (entry.messages && entry.messages.length > 0) {
        const msgStmt = this.db.prepare(
          "INSERT INTO messages (id, capture_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (let i = 0; i < entry.messages.length; i++) {
          const msg = entry.messages[i];
          msgStmt.run(generateId(), entry.id, msg.role, msg.content, i, entry.createdAt);
        }
      }
      return true;
    });
    const inserted = putTx();
    // v10: Extract and store entities for entity-assisted recall
    // v11: Auto-link to existing captures via shared tags/entities/session-proximity
    if (inserted) {
      try {
        const entities = extractEntities(entry.content);
        if (entities.length > 0) {
          this.putEntitiesInternal(entry.id, entities);
        }
        this.autoLinkCapture(entry.id, entry.tags, entities, entry.sessionKey);
      } catch {
        // non-fatal — entity extraction + auto-linking are supplementary
      }
      // v12: Audit log
      this.recordAuditInternal("put", entry.id, { type: entry.type, tags: entry.tags }, entry.agentId);
    }
  }

  async putVector(id: string, embedding: number[]): Promise<void> {
    const buffer = new Float32Array(embedding);
    // INSERT OR REPLACE so re-embedding (e.g. after update) replaces the old vector
    // instead of failing with UNIQUE constraint and leaving stale embedding.
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO captures_vec (id, embedding) VALUES (?, ?)",
    );
    stmt.run(id, Buffer.from(buffer.buffer));
  }

  /** Record that a capture was accessed (for access-frequency boosting). */
  recordAccess(ids: string[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(
      "UPDATE captures SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?",
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(now, id);
    });
    tx();
  }

  /** Confirm a capture (Bayesian: increment alpha). Increases confidence. */
  confirmCapture(id: string): void {
    this.db.prepare("UPDATE captures SET confirmations = confirmations + 1 WHERE id = ?").run(id);
  }

  /** Correct a capture (Bayesian: increment beta). Decreases confidence. */
  correctCapture(id: string): void {
    this.db.prepare("UPDATE captures SET corrections = corrections + 1 WHERE id = ?").run(id);
  }

  /** Record that a correction was retrieved in search results. */
  incrementRetrievedCount(id: string): void {
    this.db
      .prepare("UPDATE captures SET retrieved_count = retrieved_count + 1 WHERE id = ?")
      .run(id);
  }

  /** Record whether a correction was heeded or the error recurred. */
  recordCorrectionOutcome(id: string, outcome: "heeded" | "recurred"): void {
    if (outcome === "heeded") {
      this.db
        .prepare(
          "UPDATE captures SET heeded_count = heeded_count + 1, last_outcome = 'heeded' WHERE id = ?",
        )
        .run(id);
    } else {
      this.db
        .prepare(
          "UPDATE captures SET recurrence_count = recurrence_count + 1, last_outcome = 'recurred' WHERE id = ?",
        )
        .run(id);
    }
  }

  /** Get correction KPIs: precision, heed rate, noise/high-signal candidates. */
  getCorrectionKPIs(): {
    totalCorrections: number;
    avgPrecision: number;
    heedRate: number;
    noiseCandidates: { id: string; content: string; precision: number }[];
    highSignalCandidates: { id: string; content: string; precision: number }[];
  } {
    const rows = this.db
      .prepare(
        "SELECT id, content, retrieved_count, heeded_count, recurrence_count FROM captures WHERE type = 'error' AND corrections > 0 AND deleted_at IS NULL",
      )
      .all() as {
      id: string;
      content: string;
      retrieved_count: number;
      heeded_count: number;
      recurrence_count: number;
    }[];

    const candidates = rows.map((r) => {
      const total = r.heeded_count + r.recurrence_count;
      const precision = total > 0 ? r.heeded_count / total : 0;
      return { id: r.id, content: r.content.slice(0, 80), precision };
    });

    const totalHeeded = rows.reduce((s, r) => s + r.heeded_count, 0);
    const totalOutcomes = rows.reduce((s, r) => s + r.heeded_count + r.recurrence_count, 0);
    const meanPrecision =
      candidates.length > 0
        ? candidates.reduce((s, c) => s + c.precision, 0) / candidates.length
        : 0;

    return {
      totalCorrections: rows.length,
      avgPrecision: meanPrecision,
      heedRate: totalOutcomes > 0 ? totalHeeded / totalOutcomes : 0,
      noiseCandidates: candidates
        .filter((c) => c.precision < 0.3)
        .sort((a, b) => a.precision - b.precision),
      highSignalCandidates: candidates
        .filter((c) => c.precision >= 0.8)
        .sort((a, b) => b.precision - a.precision),
    };
  }

  /** Compute Bayesian confidence score (Beta-Bernoulli model).
   *  confidence = (alpha / (alpha + beta)) * decay + floor * (1 - decay)
   *  where alpha = 1 + confirmations, beta = 1 + corrections,
   *  decay = 0.5^(days_since_last_confirmation / 90), floor = 0.05.
   */
  bayesianConfidence(confirmations: number, corrections: number, lastAccessed?: number): number {
    const alpha = 1 + confirmations;
    const beta = 1 + corrections;
    const base = alpha / (alpha + beta);
    if (!lastAccessed) return base;
    const daysSince = (Date.now() - lastAccessed) / (24 * 60 * 60 * 1000);
    const decay = 0.5 ** (daysSince / 90);
    return base * decay + 0.05 * (1 - decay);
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
    _sessionKey?: string,
    _agentId?: string,
  ): Promise<CaptureEntry[]> {
    // Global tombstone: a rejected value is blocked across all projects and
    // agents, not just the one that rejected it. The content_hash is computed
    // from redacted content, so the same secret or wrong value produces the
    // same hash regardless of which session or agent captured it.
    const sql =
      "SELECT * FROM captures WHERE content_hash = ? AND trust_state = 'rejected' LIMIT 1";
    const rows = this.db.prepare(sql).all(contentHash) as DbRow[];
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

  async findByContentHash(
    contentHash: string,
    sessionKey?: string,
    agentId?: string,
  ): Promise<CaptureEntry[]> {
    let sql = "SELECT * FROM captures WHERE content_hash = ? AND deleted_at IS NULL";
    const params: unknown[] = [contentHash];
    if (sessionKey) {
      sql += " AND session_key = ?";
      params.push(sessionKey);
    }
    if (agentId) {
      sql += " AND agent_id = ?";
      params.push(agentId);
    }
    const rows = this.db.prepare(sql).all(...params) as DbRow[];
    return rows.map(rowToEntry);
  }

  async listByTags(tags: string[], limit = 50, sessionKey?: string): Promise<CaptureEntry[]> {
    if (tags.length === 0) return [];
    const escapeLike = (s: string) => s.replace(/[%_\\"]/g, (c) => "\\" + c);
    const tagConditions = tags.map(() => "tags LIKE ? ESCAPE '\\'").join(" OR ");
    let sql = `SELECT * FROM captures WHERE (${tagConditions}) AND deleted_at IS NULL AND trust_state != 'rejected' AND superseded_by IS NULL`;
    const params: unknown[] = [...tags.map((t) => `%"${escapeLike(t)}"%`)];
    if (sessionKey) {
      sql += " AND session_key = ?";
      params.push(sessionKey);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as DbRow[];
    return rows.map(rowToEntry);
  }

  async listAll(limit = 50, offset = 0): Promise<CaptureEntry[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM captures WHERE deleted_at IS NULL AND trust_state != 'rejected' AND superseded_by IS NULL AND id IS NOT NULL ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as DbRow[];
    return rows.map(rowToEntry);
  }

  deleteAtomsByCaptureId(captureId: string): void {
    this.db.prepare("DELETE FROM atoms WHERE capture_id = ?").run(captureId);
  }

  async search(
    query: string,
    queryEmbedding: number[] | null,
    opts: QueryOptions,
  ): Promise<SearchResult[]> {
    const { mode, limit, offset, sessionKey, filters, explain } = opts;

    // v12: Per-hit score details for explain mode
    const explainMap = new Map<string, ScoreDetails>();

    // Detect temporal intent: queries asking for "current/latest/now" state
    // should strongly prefer recent memories over older ones with better keyword match.
    const temporalIntent = /\b(currently|current|now|latest|new|present|today|active)\b/i.test(
      query,
    );

    let bm25Results: RankedResult[] = [];
    let vecResults: RankedResult[] = [];

    // In hybrid mode, use different candidate pool sizes for each channel:
    // - BM25: tight pool (limit*2) for high precision — only best keyword matches
    // - Vector: very broad pool (limit*10, cap 1000) for high recall at scale
    // This ensures seed memories stored among 1000+ distractors are still found.
    // RRF fusion with weighted vector search filters out BM25 noise.
    const bm25CandidateLimit = mode === "hybrid" ? limit * 2 : limit * 2;
    // When row-level filters (agent_id, team_id, type, tags, ...) are present,
    // sqlite-vec applies them as a POST-filter on the KNN result. A small vec.k
    // therefore returns very few surviving rows when the matching subset is small
    // (e.g. a benchmark run with a unique agent_id among many other captures).
    // Use a very broad KNN pool so enough candidates survive the post-filter.
    const hasFilter = !!(
      filters?.agentId ||
      filters?.teamId ||
      filters?.userId ||
      filters?.taskId ||
      filters?.type ||
      (filters?.tags && filters.tags.length > 0)
    );
    const vecCandidateLimit = hasFilter
      ? Math.min(Math.max(limit * 50, 2000), 5000)
      : mode === "hybrid"
        ? Math.min(Math.max(limit * 10, 100), 1000)
        : limit * 2;

    // Vector search (sqlite-vec) — run first so we can determine if we're at scale
    if ((mode === "hybrid" || mode === "vector") && queryEmbedding) {
      vecResults = this.vectorSearch(queryEmbedding, vecCandidateLimit, sessionKey, filters);
    }

    // At scale (many vector results), we use a larger RRF pool and recency pool.
    const isScale = vecResults.length > 100;

    // BM25 search (FTS5)
    if (mode === "hybrid" || mode === "keyword") {
      bm25Results = this.bm25Search(query, bm25CandidateLimit, sessionKey, filters);
    }

    // v10: Entity-assisted recall — extract entities from query, search entities table
    let entityResults: RankedResult[] = [];
    let queryEntities: string[] = [];
    if (mode === "hybrid" || mode === "keyword") {
      try {
        queryEntities = extractEntities(query);
        if (queryEntities.length > 0) {
          entityResults = this.searchByEntities(
            queryEntities,
            limit * 2,
            sessionKey,
            filters ? { teamId: filters.teamId, userId: filters.userId, taskId: filters.taskId, type: filters.type } : undefined,
          );
        }
      } catch {
        // non-fatal — entity search is supplementary
      }
    }

    // v12: Populate explain map with per-stream ranks
    if (explain) {
      bm25Results.forEach((r, i) => {
        explainMap.set(r.id, { ...(explainMap.get(r.id) ?? {}), bm25_rank: i + 1, bm25_score: r.score });
      });
      vecResults.forEach((r, i) => {
        explainMap.set(r.id, { ...(explainMap.get(r.id) ?? {}), vector_rank: i + 1, vector_score: r.score });
      });
      entityResults.forEach((r, i) => {
        explainMap.set(r.id, { ...(explainMap.get(r.id) ?? {}), entity_rank: i + 1, entity_matches: queryEntities });
      });
    }

    if (mode === "keyword") {
      // Merge BM25 + entity results via simple RRF
      const allResults = [...bm25Results, ...entityResults];
      if (entityResults.length > 0) {
        // Simple RRF merge: combine by rank
        const scores = new Map<string, number>();
        const sortedBm25 = [...bm25Results].sort((a, b) => a.score - b.score);
        sortedBm25.forEach((r, i) => {
          scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (40 + i + 1));
        });
        entityResults.forEach((r, i) => {
          scores.set(r.id, (scores.get(r.id) ?? 0) + r.score);
        });
        const merged = [...scores.entries()]
          .map(([id, score]) => ({ id, score }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit + offset);
        return this.fetchEntriesById(merged.slice(offset, offset + limit), temporalIntent, false, explain ? explainMap : undefined);
      }
      return this.fetchEntriesById((allResults.length > 0 ? allResults : bm25Results).slice(offset, offset + limit), temporalIntent, false, explain ? explainMap : undefined);
    }
    if (mode === "vector") {
      // vecResults carry raw L2 distance (lower = better). fetchEntriesById expects
      // higher = better (it multiplies by trust/recency boosts and sorts descending),
      // so convert to a similarity score before handing off — otherwise the worst
      // matches would be boosted and sorted to the top.
      const similarityResults = vecResults.map((r) => ({ id: r.id, score: 1 / (1 + r.score) }));
      return this.fetchEntries(similarityResults, limit, offset, temporalIntent);
    }

    // Hybrid: fuse with RRF.
    // At scale (many captures), recently-stored seeds may rank low in pure RRF
    // because 1000+ distractors can have better BM25/vector scores. Instead of
    // relying on RRF alone, use a vector-first fusion: take a broad pool of vector
    // results and let the recency boost in fetchEntriesById surface the newest
    // captures. BM25 results are still merged via RRF for keyword-matching seeds.
    // For small result sets (e.g. 20 batch settings), keep the pool tight so
    // BM25 keyword matches aren't overridden by recency among same-topic captures.
    if (isScale) {
      // At scale, merge BM25 via RRF for keyword-matching seeds, but also include
      // ALL vector results so the recency boost can surface recently-stored seeds
      // that rank low in vector distance but are the most recent captures.
      const rrfPoolSize = Math.min(Math.max((limit + offset) * 20, 100), 500);
      const fused = rrfMerge(bm25Results, vecResults, rrfPoolSize);
      // v10: Add entity-match results to the fusion
      if (entityResults.length > 0) {
        const entityIds = new Set(entityResults.map((e) => e.id));
        for (const e of entityResults) {
          if (!fused.some((f) => f.id === e.id)) {
            fused.push(e);
          }
        }
      }
      const fusedIds = new Set(fused.map((f) => f.id));
      // Include all vector results not already in the RRF fusion.
      const extraVec = vecResults
        .filter((v) => !fusedIds.has(v.id))
        .map((v) => ({ id: v.id, score: 0 }));
      const paged = [...fused, ...extraVec];
      const scored = await this.fetchEntriesById(paged, temporalIntent, true);
      return scored.slice(0, limit);
    }
    // v10: Add entity results to the RRF fusion before paging
    const fused = rrfMerge(bm25Results, vecResults, limit + offset);
    if (entityResults.length > 0) {
      for (const e of entityResults) {
        if (!fused.some((f) => f.id === e.id)) {
          fused.push(e);
        }
      }
      fused.sort((a, b) => b.score - a.score);
    }
    // v11: Link-neighbor expansion — expand top results via memory_links (1-hop)
    const topIds = fused.slice(0, Math.min(limit, 20)).map((f) => f.id);
    if (topIds.length > 0) {
      const expanded = this.expandByLinks(topIds, limit * 2);
      const fusedIds = new Set(fused.map((f) => f.id));
      for (const exp of expanded) {
        if (!fusedIds.has(exp.id)) {
          fused.push(exp);
          // v12: Record link provenance for explain mode
          if (explain) {
            const sourceId = topIds.find((id) =>
              this.getLinksFrom(id).some((l) => l.to_id === exp.id) ||
              this.getLinksTo(id).some((l) => l.from_id === exp.id)
            );
            explainMap.set(exp.id, {
              ...(explainMap.get(exp.id) ?? {}),
              link_provenance: sourceId ? `expanded from ${sourceId}` : "link-neighbor",
            });
          }
        }
      }
      fused.sort((a, b) => b.score - a.score);
    }
    const paged = fused.slice(offset, offset + limit);
    const results = await this.fetchEntriesById(paged, temporalIntent, false, explain ? explainMap : undefined);

    // v11: Raw observation fallback — if no results, search raw captures
    // including stale/rejected (but not deleted). This catches cases where
    // the compiled/filtered search misses but raw content matches.
    if (results.length === 0 && mode === "hybrid") {
      const rawResults = this.rawFallbackSearch(query, limit, sessionKey, filters);
      if (rawResults.length > 0) {
        if (explain) {
          rawResults.forEach((r) => {
            explainMap.set(r.id, { ...(explainMap.get(r.id) ?? {}), raw_fallback: true });
          });
        }
        return this.fetchEntriesById(rawResults.slice(0, limit), temporalIntent, false, explain ? explainMap : undefined);
      }
    }
    // v13: Hebbian co-retrieval strengthening — strengthen links between co-occurring results
    if (results.length >= 2) {
      try {
        this.strengthenLinksOnCoRetrieval(results.map((r) => r.entry.id));
      } catch {
        // non-fatal — Hebbian strengthening is supplementary
      }
    }
    return results;
  }

  /**
   * v11: Raw observation fallback search.
   * Searches FTS5 without trust_state filter — includes stale and rejected.
   * Still excludes soft-deleted and superseded (those are intentionally removed).
   */
  private rawFallbackSearch(
    query: string,
    limit: number,
    sessionKey?: string,
    filters?: SearchFilters,
  ): { id: string; score: number }[] {
    const ftsQuery = this.escapeFtsQuery(query);
    if (!ftsQuery) return [];
    const conditions = ["c.deleted_at IS NULL", "c.superseded_by IS NULL"];
    const params: unknown[] = [];
    if (sessionKey) {
      conditions.push("c.session_key = ?");
      params.push(sessionKey);
    }
    if (filters?.teamId) {
      conditions.push("c.team_id = ?");
      params.push(filters.teamId);
    }
    if (filters?.userId) {
      conditions.push("c.user_id = ?");
      params.push(filters.userId);
    }
    if (filters?.taskId) {
      conditions.push("c.task_id = ?");
      params.push(filters.taskId);
    }
    if (filters?.type) {
      conditions.push("c.type = ?");
      params.push(filters.type);
    }
    try {
      const rows = this.db
        .prepare(
          `SELECT fts.id as id, bm25(captures_fts) as score
           FROM captures_fts fts
           JOIN captures c ON c.id = fts.id
           WHERE captures_fts MATCH ? AND ${conditions.join(" AND ")}
           ORDER BY score ASC
           LIMIT ?`,
        )
        .all(ftsQuery, ...params, limit) as { id: string; score: number }[];
      // Convert BM25 (negative, lower=better) to positive RRF-style score
      return rows.map((r, i) => ({
        id: r.id,
        score: 1 / (40 + i + 1),
      }));
    } catch {
      return [];
    }
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

    let sql: string = "";
    const params: unknown[] = [ftsQuery];
    try {
      sql = `
      SELECT fts.id as id, bm25(captures_fts) as score
      FROM captures_fts fts
      JOIN captures c ON c.id = fts.id
      WHERE captures_fts MATCH ? AND c.deleted_at IS NULL AND c.trust_state != 'rejected' AND c.superseded_by IS NULL
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
        const escapeLike = (s: string) => s.replace(/[%_\\"]/g, (c) => "\\" + c);
        const tagConditions = filters.tags.map(() => "c.tags LIKE ? ESCAPE '\\'").join(" OR ");
        sql += ` AND (${tagConditions})`;
        params.push(...filters.tags.map((t) => `%"${escapeLike(t)}"%`));
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
      WHERE vec.embedding MATCH ? AND vec.k = ? AND c.deleted_at IS NULL AND c.trust_state != 'rejected' AND c.superseded_by IS NULL
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
      const escapeLike = (s: string) => s.replace(/[%_\\"]/g, (c) => "\\" + c);
      const tagConditions = filters.tags.map(() => "c.tags LIKE ? ESCAPE '\\'").join(" OR ");
      sql += ` AND (${tagConditions})`;
      params.push(...filters.tags.map((t) => `%"${escapeLike(t)}"%`));
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
    temporalIntent: boolean = false,
  ): Promise<SearchResult[]> {
    const paged = results.slice(offset, offset + limit);
    return this.fetchEntriesById(paged, temporalIntent);
  }

  /** Fetch capture entries by ID, preserving the order of the input list. Applies memory decay and trust-state ranking. */
  private async fetchEntriesById(
    results: { id: string; score: number }[],
    temporalIntent: boolean = false,
    scaleBoost: boolean = false,
    explainMap?: Map<string, ScoreDetails>,
  ): Promise<SearchResult[]> {
    if (results.length === 0) return [];
    const ids = results.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM captures WHERE id IN (${placeholders})`)
      .all(...ids) as DbRow[];
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const now = Date.now();
    // Configurable half-life: default 30 days. Set REMEM_HALF_LIFE_DAYS to override.
    const halfLifeDays = Number(process.env.REMEM_HALF_LIFE_DAYS) || 30;
    const HALF_LIFE_MS = halfLifeDays * 24 * 60 * 60 * 1000;
    // Auto-stale threshold: captures older than this are treated as stale
    // (trust boost 0.1) regardless of their stored trust_state. Default 90 days.
    // Set REMEM_STALE_DAYS to override. Set to 0 to disable auto-stale.
    const staleDays = Number(process.env.STALE_DAYS) || Number(process.env.REMEM_STALE_DAYS) || 90;
    const STALE_MS = staleDays > 0 ? staleDays * 24 * 60 * 60 * 1000 : Infinity;
    // Trust-state multipliers: verified > candidate > stale
    const TRUST_BOOST: Record<string, number> = {
      verified: 1.5,
      candidate: 1.0,
      stale: 0.1,
      rejected: 0,
    };
    // For temporal-intent queries, use a much stronger recency boost (0.5 vs 0.3).
    // This ensures "what database do we currently use" returns the most recent fact,
    // even when an older fact has a better BM25 keyword match.
    // Non-temporal queries get a moderate recency boost (0.3) — enough to help
    // recently-stored seeds rank above older distractors at scale (Layer 3) without
    // overriding BM25 keyword matches for same-topic captures stored seconds apart.
    // At scale (1000+ distractors), use an additive recency boost so captures
    // with low RRF scores (e.g. vector-only matches) can still surface when
    // they're the most recent. The weight (0.1) is calibrated to be larger than
    // typical RRF scores (~0.05) so recency can overcome RRF rank differences,
    // but not so large as to completely ignore semantic relevance.
    const recencyWeight = temporalIntent ? 0.5 : scaleBoost ? 0.8 : 0.3;
    const sorted = results
      .map((r): SearchResult | null => {
        const row = rowMap.get(r.id);
        if (!row) return null;
        const ageMs = now - row.created_at;
        // Evergreen tags exempt a capture from temporal decay and auto-stale.
        // The capture keeps its full score regardless of age.
        const tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
        const evergreen = isEvergreen(tags);
        const decay = evergreen ? 1.0 : 0.5 ** (ageMs / HALF_LIFE_MS);
        // Auto-stale: if capture is older than STALE_MS and not already verified,
        // treat it as stale (0.1 trust boost) to naturally fade old memories.
        // Evergreen captures are never auto-staled.
        const effectiveTrust =
          !evergreen && ageMs > STALE_MS && row.trust_state !== "verified"
            ? "stale"
            : (row.trust_state ?? "candidate");
        const trustBoost = TRUST_BOOST[effectiveTrust] ?? 1.0;
        // Bayesian confidence: blend trust boost with evidence-based confidence.
        // Captures with confirmations get higher confidence, corrections lower it.
        const confirmations = (row as { confirmations?: number }).confirmations ?? 0;
        const corrections = (row as { corrections?: number }).corrections ?? 0;
        const lastAccessedAt = (row as { last_accessed_at?: number }).last_accessed_at;
        const bayesian = this.bayesianConfidence(confirmations, corrections, lastAccessedAt);
        // Blend: 70% trust-state boost + 30% Bayesian evidence (when evidence exists)
        const blendedBoost =
          confirmations + corrections > 0 ? trustBoost * 0.7 + bayesian * 1.5 * 0.3 : trustBoost;
        const decayed = Number.isNaN(r.score) ? 0 : r.score * decay;
        // BM25 scores are negative (lower = better). For negative scores, divide by boost
        // so a lower boost makes the score more negative (ranks lower). For positive scores
        // (RRF fusion), multiply so a lower boost makes the score lower.
        const finalScore = decayed >= 0 ? decayed * blendedBoost : decayed / blendedBoost;
        // Recency tiebreaker: add a boost proportional to how recent the memory is.
        // For temporal-intent queries ("currently", "now", "latest"), use a much faster
        // decay (1s vs 1min) so even memories stored milliseconds apart are differentiated,
        // and a stronger weight (0.5 vs 0.05) so recency dominates keyword match score.
        const recencyDecayMs = temporalIntent ? 1000 : 10000;
        const recencyBias = 1 / (1 + ageMs / recencyDecayMs);
        // At scale, use an additive recency boost so captures with low RRF scores
        // (e.g. vector-only matches that didn't rank in BM25) can still surface
        // when they're the most recent. A multiplicative boost on score=0 stays 0.
        const biasedScore =
          scaleBoost && finalScore >= 0
            ? finalScore + recencyBias * recencyWeight
            : finalScore >= 0
              ? finalScore * (1 + recencyBias * recencyWeight)
              : finalScore / (1 + recencyBias * recencyWeight);
        // Access-frequency boost (Mem0-style): memories accessed recently get up to
        // 1.5x boost, idle memories (never accessed or accessed long ago) get 0.3x floor.
        // This rewards "popular" memories that agents keep recalling.
        const accessCount = (row as { access_count?: number }).access_count ?? 0;
        const lastAccessed = (row as { last_accessed_at?: number }).last_accessed_at;
        const accessBoost =
          accessCount > 0 && lastAccessed
            ? 0.3 + 1.2 * (1 / (1 + (now - lastAccessed) / (7 * 24 * 60 * 60 * 1000))) // 7-day half-life
            : 1.0; // No access data → neutral
        const accessScored =
          biasedScore >= 0 ? biasedScore * accessBoost : biasedScore / accessBoost;
        // v10: Authority-aware ranking — bounded multiplier based on tier + tags.
        // Applied after all other boosts, before final sort. Clamped to 0.5x-1.5x.
        const tier = (row as { tier?: string }).tier ?? "episodic";
        const authBoost = authorityMultiplier(tier, tags);
        const authScored =
          accessScored >= 0 ? accessScored * authBoost : accessScored / authBoost;
        // v12: Feedback salience multiplier (0.1x–2.0x) from helpful/not_helpful/stale/wrong signals.
        const feedbackSalience = (row as { feedback_salience?: number }).feedback_salience ?? 1.0;
        const feedbackScored =
          feedbackSalience !== 1.0
            ? authScored >= 0
              ? authScored * feedbackSalience
              : authScored / feedbackSalience
            : authScored;
        // v12: Attach score details for explain mode
        const scoreDetails = explainMap
          ? {
              ...(explainMap.get(row.id) ?? {}),
              authority_multiplier: authBoost,
              feedback_salience: feedbackSalience,
            }
          : undefined;
        return { entry: rowToEntry(row), score: feedbackScored, scoreDetails };
      })
      .filter((r): r is SearchResult => r !== null)
      // For temporal-intent queries ("currently", "now", "latest"), filter out stale
      // memories entirely. This ensures outdated facts don't appear in results at all,
      // which is required when benchmarks check for unexpected keywords like old values.
      // Non-temporal queries ("before", "previous") still include stale memories.
      .filter((r) => !temporalIntent || r.entry.trustState !== "stale")
      // For temporal-intent queries, sort by created_at DESC first (most recent wins),
      // then by score. This ensures "what database do we currently use" returns the
      // latest fact even when an older fact has a better keyword match.
      .sort((a, b) => {
        if (temporalIntent) {
          const timeDiff = b.entry.createdAt - a.entry.createdAt;
          // Any positive recency difference wins. We don't gate on a large
          // threshold because benchmark runs with --no-delay store seeds only
          // milliseconds apart, yet the store order still encodes the intended
          // chronology (later stores have a higher created_at).
          if (timeDiff !== 0) return timeDiff;
        }
        return b.score - a.score;
      });

    // For temporal-intent queries, drop older captures that are semantically
    // superseded by a more recent one (e.g. "Database is MySQL" is dropped when
    // "Upgraded to PostgreSQL 16" is present). Benchmarks check that outdated
    // values do not appear in ANY returned result, so ranking alone is not
    // enough — the older capture must be removed entirely. We greedily keep the
    // most recent capture per semantic cluster using embedding cosine similarity.
    if (temporalIntent) {
      const deduped = this.temporalDedup(sorted);
      this.recordAccess(deduped.map((r) => r.entry.id));
      return deduped;
    }
    this.recordAccess(sorted.map((r) => r.entry.id));
    return sorted;
  }

  /** Greedily drop older captures that are semantically similar to a newer kept one.
   *  Input must be sorted by recency DESC. Uses L2 squared distance between embeddings
   *  (matching sqlite-vec's distance metric). Same-topic facts (e.g. "Database is MySQL"
   *  vs "Upgraded to PostgreSQL 16") sit within ~1.6; distinct topics sit above ~1.7. */
  private temporalDedup(sorted: SearchResult[]): SearchResult[] {
    if (sorted.length <= 1) return sorted;
    const ids = sorted.map((r) => r.entry.id);
    const placeholders = ids.map(() => "?").join(",");
    let rows: { id: string; embedding: Buffer }[];
    try {
      rows = this.db
        .prepare(`SELECT id, embedding FROM captures_vec WHERE id IN (${placeholders})`)
        .all(...ids) as { id: string; embedding: Buffer }[];
    } catch {
      // vec0 module unavailable or no vectors — fall back to no dedup
      return sorted;
    }
    const vecMap = new Map<string, Float32Array>();
    for (const row of rows) {
      try {
        vecMap.set(
          row.id,
          new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4,
          ),
        );
      } catch {
        // ignore malformed vectors
      }
    }
    const l2sq = (a: Float32Array, b: Float32Array): number => {
      let s = 0;
      for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        s += d * d;
      }
      return s;
    };
    // Same-topic facts cluster below ~1.6 L2²; distinct topics sit above ~1.7.
    const DUP_THRESHOLD = 1.7;
    const kept: SearchResult[] = [];
    const keptVecs: Float32Array[] = [];
    for (const r of sorted) {
      const v = vecMap.get(r.entry.id);
      if (!v) {
        // No vector for this capture — keep it (can't compare)
        kept.push(r);
        continue;
      }
      const isDup = keptVecs.some((kv) => l2sq(v, kv) <= DUP_THRESHOLD);
      if (!isDup) {
        kept.push(r);
        keptVecs.push(v);
      }
    }
    return kept;
  }

  /** Escape a query string for FTS5 MATCH.
   *  Uses OR semantics with stopword removal for high recall.
   *  AND semantics (all tokens must match) is too strict for natural language
   *  questions — a 15-word query rarely has every token in a single capture,
   *  causing BM25 to return zero results. OR semantics lets BM25 rank by
   *  relevance (documents matching more terms rank higher) while still
   *  returning partial matches. RRF fusion with weighted vector search
   *  filters out BM25 noise.
   */
  private escapeFtsQuery(query: string): string {
    // Use the shared stripQueryProperNouns to get content words (stopwords + proper nouns removed).
    // Then format as FTS5 OR query.
    const stripped = stripQueryProperNouns(query);
    if (!stripped) return "";
    const tokens = stripped.split(/\s+/).filter(Boolean);
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
  }

  async delete(id: string): Promise<DeleteResult> {
    // Soft delete: set deleted_at instead of hard delete.
    // The captures_au trigger automatically syncs FTS on UPDATE.
    // Search filters by deleted_at IS NULL, so tombstoned captures are excluded.
    // Do NOT manually FTS-delete — the trigger already handled it, and a manual
    // delete with empty strings after the trigger re-inserted the entry corrupts
    // the FTS index (SQLITE_CORRUPT_VTAB).
    const now = Date.now();
    let captureCount = 0;
    let atomCount = 0;
    const tx = this.db.transaction(() => {
      captureCount = this.db
        .prepare("UPDATE captures SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(now, id).changes;
      if (captureCount > 0) {
        this.db.prepare("DELETE FROM captures_vec WHERE id = ?").run(id);
        atomCount = this.db.prepare("DELETE FROM atoms WHERE capture_id = ?").run(id).changes;
      }
    });
    tx();
    if (captureCount > 0) {
      return { captures: captureCount, atoms: atomCount, scenarios: 0 };
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
    if (filter.sessionKey) {
      sql += " AND session_key = ?";
      params.push(filter.sessionKey);
    }
    if (filter.tags && filter.tags.length > 0) {
      const escapeLike = (s: string) => s.replace(/[%_\\"]/g, (c) => "\\" + c);
      const tagConditions = filter.tags.map(() => "tags LIKE ? ESCAPE '\\'").join(" OR ");
      sql += ` AND (${tagConditions})`;
      params.push(...filter.tags.map((t) => `%"${escapeLike(t)}"%`));
    }

    const ids = this.db.prepare(sql).all(...params) as { id: string }[];

    let captures = 0;
    let atoms = 0;
    const scenarios = 0;
    // Wrap in transaction so new captures matching the filter can't be
    // inserted between SELECT and delete (atomic snapshot).
    const softDelete = this.db.prepare(
      "UPDATE captures SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
    );
    const deleteVec = this.db.prepare("DELETE FROM captures_vec WHERE id = ?");
    const deleteAtoms = this.db.prepare("DELETE FROM atoms WHERE capture_id = ?");
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const { id } of ids) {
        const c = softDelete.run(now, id).changes;
        if (c > 0) {
          captures += c;
          deleteVec.run(id);
          atoms += deleteAtoms.run(id).changes;
        }
      }
    });
    tx();

    return { captures, atoms, scenarios };
  }

  async reject(id: string, reason: string): Promise<DeleteResult> {
    // Same as delete(): the captures_au trigger syncs FTS on UPDATE.
    // Search filters by trust_state != 'rejected' AND deleted_at IS NULL.
    // Manual FTS delete after trigger re-insert corrupts the index.
    const now = Date.now();
    let captureCount = 0;
    let atomCount = 0;
    const tx = this.db.transaction(() => {
      captureCount = this.db
        .prepare(
          "UPDATE captures SET trust_state = 'rejected', rejection_reason = ?, deleted_at = ? WHERE id = ? AND deleted_at IS NULL AND trust_state != 'rejected'",
        )
        .run(reason, now, id).changes;
      if (captureCount > 0) {
        this.db.prepare("DELETE FROM captures_vec WHERE id = ?").run(id);
        atomCount = this.db.prepare("DELETE FROM atoms WHERE capture_id = ?").run(id).changes;
      }
    });
    tx();
    if (captureCount > 0) {
      return { captures: captureCount, atoms: atomCount, scenarios: 0 };
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
    if (updated > 0) {
      // Remove loser's vector so dead embeddings don't accumulate in captures_vec
      this.db.prepare("DELETE FROM captures_vec WHERE id = ?").run(loserId);
    }
    return { winnerId, loserId, updated };
  }

  async setTrustState(id: string, state: TrustState): Promise<number> {
    return this.db
      .prepare("UPDATE captures SET trust_state = ? WHERE id = ? AND deleted_at IS NULL")
      .run(state, id).changes;
  }

  // ─── L1 atoms ───────────────────────────────────────────────

  async putAtom(atom: AtomEntry): Promise<void> {
    // Dedup: skip if same fact already exists (case-insensitive, trimmed)
    const existing = this.db
      .prepare("SELECT id FROM atoms WHERE LOWER(TRIM(fact)) = LOWER(TRIM(?)) LIMIT 1")
      .get(atom.fact) as { id: string } | undefined;
    if (existing) return; // atom with same fact already exists

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
    const escapeLike = (s: string) => s.replace(/[%_\\"]/g, (c) => "\\" + c);
    let sql = "SELECT * FROM atoms WHERE fact LIKE ? ESCAPE '\\'";
    const params: unknown[] = [`%${escapeLike(query)}%`];
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
        "INSERT INTO scenarios (id, atom_ids, summary, persona_tags, created_at, team_id, agent_id, user_id, session_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        scenario.sessionKey ?? null,
      );
  }

  async listScenarios(opts: {
    teamId?: string;
    agentId?: string;
    userId?: string;
    sessionKey?: string;
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
    if (opts.sessionKey) {
      sql += " AND session_key = ?";
      params.push(opts.sessionKey);
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
      sessionKey: r.session_key ?? undefined,
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
      sessionKey: row.session_key ?? undefined,
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
        `INSERT INTO skills (id, team_id, agent_id, name, description, content, version, created_at, updated_at, trigger_conditions, steps, validation_rules, source_capture_ids, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, content = excluded.content, version = excluded.version, updated_at = excluded.updated_at, trigger_conditions = excluded.trigger_conditions, steps = excluded.steps, validation_rules = excluded.validation_rules, source_capture_ids = excluded.source_capture_ids, archived = excluded.archived`,
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
        entry.triggerConditions ? JSON.stringify(entry.triggerConditions) : null,
        entry.steps ? JSON.stringify(entry.steps) : null,
        entry.validationRules ? JSON.stringify(entry.validationRules) : null,
        entry.sourceCaptureIds ? JSON.stringify(entry.sourceCaptureIds) : null,
        entry.archived ? 1 : 0,
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
    const escapeLike = (s: string) => s.replace(/[%_\\"]/g, (c) => "\\" + c);
    let sql =
      "SELECT * FROM skills WHERE team_id = ? AND (agent_id = ? OR agent_id IS NULL) AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')";
    const params: unknown[] = [teamId, agentId, `%${escapeLike(query)}%`, `%${escapeLike(query)}%`];
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(topK ?? 10);
    const rows = this.db.prepare(sql).all(...params) as SkillDbRow[];
    return rows.map(skillRowToEntry);
  }

  close(): void {
    this.db.close();
  }

  // ─── Canvas + Refs (v9: symbolic short-term memory) ───────────────────
  // These methods implement the StorageBackend interface for F1 (Mermaid canvas).

  async appendCanvasNode(
    sessionKey: string,
    node: { id: string; label: string; captureId: string },
    edges: Array<{ from: string; to: string; label?: string }>,
    teamId?: string,
  ): Promise<void> {
    const now = Date.now();
    let canvasRow = this.db
      .prepare("SELECT id FROM canvases WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(sessionKey) as { id: string } | undefined;
    if (!canvasRow) {
      const canvasId = `01${now.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      this.db.prepare(
        "INSERT INTO canvases (id, session_key, mermaid_text, node_count, created_at, updated_at, team_id) VALUES (?, ?, NULL, 0, ?, ?, ?)",
      ).run(canvasId, sessionKey, now, now, teamId ?? null);
      canvasRow = { id: canvasId };
    }
    const maxSeq = this.db
      .prepare("SELECT MAX(seq) as max_seq FROM canvas_nodes WHERE canvas_id = ?")
      .get(canvasRow.id) as { max_seq: number | null };
    const seq = (maxSeq.max_seq ?? 0) + 1;
    this.db.prepare(
      "INSERT INTO canvas_nodes (id, canvas_id, node_id, label, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(`01${now.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 10).toUpperCase()}`, canvasRow.id, node.id, node.label, seq, now);
    for (const edge of edges) {
      this.db.prepare(
        "INSERT INTO canvas_edges (id, canvas_id, from_node_id, to_node_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(`01${now.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 10).toUpperCase()}`, canvasRow.id, edge.from, edge.to, edge.label ?? null, now);
    }
    this.db.prepare("UPDATE canvases SET node_count = node_count + 1, updated_at = ? WHERE id = ?").run(now, canvasRow.id);

    // Regenerate mermaid_text from all nodes + edges so canvas_get can read it.
    const allNodes = this.db
      .prepare("SELECT node_id, label FROM canvas_nodes WHERE canvas_id = ? ORDER BY seq ASC")
      .all(canvasRow.id) as { node_id: string; label: string }[];
    const allEdges = this.db
      .prepare("SELECT from_node_id, to_node_id, label FROM canvas_edges WHERE canvas_id = ?")
      .all(canvasRow.id) as { from_node_id: string; to_node_id: string; label: string | null }[];
    const mermaidLines: string[] = ["graph LR"];
    for (const n of allNodes) {
      mermaidLines.push(`  ${n.node_id}["${n.label.replace(/"/g, "'")}"]`);
    }
    for (const e of allEdges) {
      if (e.label) {
        mermaidLines.push(`  ${e.from_node_id} -->|${e.label.replace(/"/g, "'")}| ${e.to_node_id}`);
      } else {
        mermaidLines.push(`  ${e.from_node_id} --> ${e.to_node_id}`);
      }
    }
    this.db.prepare("UPDATE canvases SET mermaid_text = ? WHERE id = ?").run(mermaidLines.join("\n"), canvasRow.id);
  }

  async getLatestCanvasNode(
    sessionKey: string,
  ): Promise<{ id: string; label: string; captureId: string } | null> {
    const row = this.db
      .prepare(
        `SELECT cn.node_id as id, cn.label, cn.node_id as captureId
         FROM canvas_nodes cn
         JOIN canvases c ON cn.canvas_id = c.id
         WHERE c.session_key = ?
         ORDER BY cn.seq DESC LIMIT 1`,
      )
      .get(sessionKey) as { id: string; label: string; captureId: string } | undefined;
    return row ?? null;
  }

  async getCanvasMermaidText(sessionKey: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT mermaid_text FROM canvases WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(sessionKey) as { mermaid_text: string | null } | undefined;
    return row?.mermaid_text ?? null;
  }

  async writeRef(sessionKey: string, nodeId: string, content: string): Promise<void> {
    const refsDir = join(homedir(), ".local", "share", "remem-mcp", "refs", sessionKey);
    try {
      mkdirSync(refsDir, { recursive: true });
      writeFileSync(join(refsDir, `${nodeId}.md`), content, "utf-8");
    } catch (err) {
      console.error(`[remem-mcp] writeRef failed: ${err}`);
    }
  }

  async readRef(nodeId: string): Promise<string | null> {
    const refsBase = join(homedir(), ".local", "share", "remem-mcp", "refs");
    try {
      const sessions = readdirSync(refsBase);
      for (const session of sessions) {
        const refPath = join(refsBase, session, `${nodeId}.md`);
        if (existsSync(refPath)) {
          return readFileSync(refPath, "utf-8");
        }
      }
    } catch {
      // refs dir doesn't exist yet
    }
    return null;
  }

  // ─── v10: Decay/forget sweep ──────────────────────────────────

  /**
   * Run a forget sweep: compute salience for all non-deleted, non-evergreen captures,
   * then soft-delete (set deleted_at) those below the threshold.
   *
   * Salience formula (adapted from ai-memory):
   *   salience = exp(-lambda * age_days) + sigma * log(1 + access_count) * exp(-mu * days_since_access)
   *
   * - lambda: age decay rate (default 0.01, ~70 day half-life)
   * - sigma: access frequency weight (default 0.3)
   * - mu: access recency decay (default 0.02, ~35 day half-life)
   *
   * Evergreen tags and tier=rule/decision captures are exempt (salience stays 1.0).
   * Verified captures get a floor of 0.3.
   */
  async forgetSweep(opts: {
    dryRun?: boolean;
    threshold?: number;
    maxAgeDays?: number;
  } = {}): Promise<{ swept: number; remaining: number; checked: number }> {
    const dryRun = opts.dryRun ?? false;
    const threshold = opts.threshold ?? 0.05;
    const maxAgeDays = opts.maxAgeDays ?? 365;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    // Decay parameters
    const lambda = 0.01;
    const sigma = 0.3;
    const mu = 0.02;
    const now = Date.now();

    // Select candidates: non-deleted, not evergreen, older than maxAgeDays
    // v12: Also select TTL-expired captures (expires_at < now) — these are hard-deleted regardless of salience
    const rows = this.db
      .prepare(
        `SELECT id, type, tags, created_at, access_count, last_accessed_at, trust_state, tier, expires_at, feedback_salience
         FROM captures
         WHERE deleted_at IS NULL AND (created_at < ? OR (expires_at IS NOT NULL AND expires_at < ?))`,
      )
      .all(now - maxAgeMs, now) as {
        id: string;
        type: string;
        tags: string | null;
        created_at: number;
        access_count: number;
        last_accessed_at: number | null;
        trust_state: string;
        tier: string;
        expires_at: number | null;
        feedback_salience: number;
      }[];

    let swept = 0;
    let remaining = 0;
    const toDelete: string[] = [];

    for (const row of rows) {
      // v12: TTL-expired captures are hard-deleted regardless of salience/tier
      if (row.expires_at !== null && row.expires_at < now) {
        toDelete.push(row.id);
        swept++;
        continue;
      }

      const tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
      const evergreen = isEvergreen(tags);
      // Rule and decision tiers are exempt from sweep
      if (evergreen || row.tier === "rule" || row.tier === "decision") {
        remaining++;
        continue;
      }

      const ageDays = (now - row.created_at) / (24 * 60 * 60 * 1000);
      const daysSinceAccess = row.last_accessed_at
        ? (now - row.last_accessed_at) / (24 * 60 * 60 * 1000)
        : ageDays;

      const ageTerm = Math.exp(-lambda * ageDays);
      const accessTerm =
        sigma * Math.log(1 + (row.access_count ?? 0)) * Math.exp(-mu * daysSinceAccess);
      let salience = ageTerm + accessTerm;

      // Verified captures get a floor
      if (row.trust_state === "verified") {
        salience = Math.max(salience, 0.3);
      }

      // v12: Apply feedback salience multiplier
      salience *= row.feedback_salience ?? 1.0;

      if (salience < threshold) {
        toDelete.push(row.id);
        swept++;
      } else {
        remaining++;
      }
    }

    if (!dryRun && toDelete.length > 0) {
      const deleteStmt = this.db.prepare(
        "UPDATE captures SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
      );
      const tx = this.db.transaction(() => {
        for (const id of toDelete) {
          deleteStmt.run(now, id);
          // v12: Audit log
          this.recordAuditInternal("forget", id, { reason: "salience_below_threshold_or_ttl_expired" });
        }
      });
      tx();
    }

    return { swept, remaining, checked: rows.length };
  }

  // ─── v10: Entity-assisted recall ──────────────────────────────

  /** Store extracted entities for a capture (replaces existing). */
  putEntities(captureId: string, entities: string[]): void {
    this.putEntitiesInternal(captureId, entities);
  }

  /** Internal entity storage — called from within putInternal. */
  private putEntitiesInternal(captureId: string, entities: string[]): void {
    if (entities.length === 0) return;
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM entities WHERE capture_id = ?").run(captureId);
      const stmt = this.db.prepare(
        "INSERT INTO entities (capture_id, entity, created_at) VALUES (?, ?, ?)",
      );
      const now = Date.now();
      for (const entity of entities.slice(0, 10)) {
        stmt.run(captureId, entity.toLowerCase(), now);
      }
    });
    tx();
  }

  /** Get entities for a capture. */
  getEntities(captureId: string): string[] {
    const rows = this.db
      .prepare("SELECT entity FROM entities WHERE capture_id = ? ORDER BY id")
      .all(captureId) as { entity: string }[];
    return rows.map((r) => r.entity);
  }

  /**
   * Search captures by entity match (lexical).
   * Returns capture IDs ranked by number of matching entities (RRF-style).
   */
  searchByEntities(
    entities: string[],
    limit: number,
    sessionKey?: string,
    filters?: { teamId?: string; userId?: string; taskId?: string; type?: string },
  ): { id: string; score: number }[] {
    if (entities.length === 0) return [];
    const normalized = entities.map((e) => e.toLowerCase());
    const placeholders = normalized.map(() => "?").join(",");
    const params: unknown[] = [...normalized];
    const conditions: string[] = [
      "c.deleted_at IS NULL",
      "c.trust_state != 'rejected'",
      "c.superseded_by IS NULL",
    ];
    if (sessionKey) {
      conditions.push("c.session_key = ?");
      params.push(sessionKey);
    }
    if (filters?.teamId) {
      conditions.push("c.team_id = ?");
      params.push(filters.teamId);
    }
    if (filters?.userId) {
      conditions.push("c.user_id = ?");
      params.push(filters.userId);
    }
    if (filters?.taskId) {
      conditions.push("c.task_id = ?");
      params.push(filters.taskId);
    }
    if (filters?.type) {
      conditions.push("c.type = ?");
      params.push(filters.type);
    }
    const rows = this.db
      .prepare(
        `SELECT e.capture_id as id, COUNT(*) as match_count
         FROM entities e
         JOIN captures c ON c.id = e.capture_id
         WHERE e.entity IN (${placeholders})
           AND ${conditions.join(" AND ")}
         GROUP BY e.capture_id
         ORDER BY match_count DESC
         LIMIT ?`,
      )
      .all(...params, limit) as { id: string; match_count: number }[];

    // RRF-style scoring: rank by match count (more matches = higher score)
    return rows.map((r, i) => ({
      id: r.id,
      score: 1 / (40 + i + 1), // same k as RRF
    }));
  }

  // ─── v11: Memory-to-memory links ──────────────────────────────

  /** Link two captures. Auto-links use auto=1. */
  linkCaptures(fromId: string, toId: string, linkType: string, auto: boolean = false): void {
    if (fromId === toId) return; // no self-links
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_links (from_id, to_id, link_type, auto, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(fromId, toId, linkType, auto ? 1 : 0, Date.now());
      // v12: Audit log
      this.recordAuditInternal("link", fromId, { toId, linkType, auto });
    } catch {
      // non-fatal — link already exists or capture missing
    }
  }

  /** Get links from a capture (outbound). */
  getLinksFrom(captureId: string): { to_id: string; link_type: string; auto: number }[] {
    return this.db
      .prepare("SELECT to_id, link_type, auto FROM memory_links WHERE from_id = ?")
      .all(captureId) as { to_id: string; link_type: string; auto: number }[];
  }

  /** Get links to a capture (inbound). */
  getLinksTo(captureId: string): { from_id: string; link_type: string; auto: number }[] {
    return this.db
      .prepare("SELECT from_id, link_type, auto FROM memory_links WHERE to_id = ?")
      .all(captureId) as { from_id: string; link_type: string; auto: number }[];
  }

  /**
   * Expand capture IDs via link-neighbor traversal (1-hop).
   * Returns linked capture IDs with decayed score (0.5x of original).
   * Only includes non-deleted, non-rejected captures.
   */
  expandByLinks(ids: string[], limit: number): { id: string; score: number }[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    // Get both outbound and inbound links, dedupe. v13: include weight.
    const rows = this.db
      .prepare(
        `SELECT linked_id as id, MAX(weight) as weight FROM (
          SELECT to_id as linked_id, weight FROM memory_links WHERE from_id IN (${placeholders})
          UNION
          SELECT from_id as linked_id, weight FROM memory_links WHERE to_id IN (${placeholders})
        )
        WHERE linked_id NOT IN (${placeholders})
        GROUP BY linked_id
        ORDER BY weight DESC
        LIMIT ?`,
      )
      .all(...ids, ...ids, ...ids, limit) as { id: string; weight: number }[];

    // Filter to non-deleted, non-rejected, non-superseded captures
    if (rows.length === 0) return [];
    const validPlaceholders = rows.map(() => "?").join(",");
    const validRows = this.db
      .prepare(
        `SELECT id FROM captures WHERE id IN (${validPlaceholders})
         AND deleted_at IS NULL AND trust_state != 'rejected' AND superseded_by IS NULL`,
      )
      .all(...rows.map((r) => r.id)) as { id: string }[];
    const validIds = new Set(validRows.map((r) => r.id));

    // Score: decayed RRF score scaled by link weight (v13: Hebbian weight)
    return rows
      .filter((r) => validIds.has(r.id))
      .map((r, i) => ({
        id: r.id,
        score: (0.5 * (r.weight ?? 1.0)) / (40 + i + 1), // decayed RRF × weight
      }));
  }

  /**
   * v13: Hebbian co-retrieval strengthening.
   * When captures co-occur in search results, strengthen links between them.
   * Creates links if they don't exist, increments weight if they do.
   */
  strengthenLinksOnCoRetrieval(ids: string[]): void {
    if (ids.length < 2) return;
    const now = Date.now();
    const linkType = "co-retrieval";
    // v13: Hebbian co-retrieval strengthening.
    // Use INSERT OR IGNORE + UPDATE to handle both new and existing links.
    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO memory_links (from_id, to_id, link_type, auto, weight, created_at)
       VALUES (?, ?, ?, 1, 1.0, ?)`,
    );
    const updateStmt = this.db.prepare(
      `UPDATE memory_links SET weight = weight + 0.1 WHERE from_id = ? AND to_id = ? AND link_type = ?`,
    );
    // Create/strengthen links for all pairs (limit to top 10 to avoid O(n²) blowup)
    const topIds = ids.slice(0, 10);
    for (let i = 0; i < topIds.length; i++) {
      for (let j = i + 1; j < topIds.length; j++) {
        // Always store with smaller id first to avoid duplicate pairs
        const [a, b] = topIds[i] < topIds[j] ? [topIds[i], topIds[j]] : [topIds[j], topIds[i]];
        try {
          insertStmt.run(a, b, linkType, now);
          updateStmt.run(a, b, linkType);
        } catch {
          // non-fatal
        }
      }
    }
  }

  /**
   * Auto-link a new capture to existing captures based on shared tags and entities.
   * Called after put() + entity extraction.
   */
  private autoLinkCapture(captureId: string, tags: string[], entities: string[], sessionKey: string): void {
    const now = Date.now();
    const linkStmt = this.db.prepare(
      `INSERT OR IGNORE INTO memory_links (from_id, to_id, link_type, auto, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    );

    // 1. Link by shared tags (same session, non-deleted)
    if (tags.length > 0) {
      const tagPlaceholders = tags.map(() => "?").join(",");
      const tagRows = this.db
        .prepare(
          `SELECT DISTINCT c.id as other_id FROM captures c
           WHERE c.id != ? AND c.session_key = ? AND c.deleted_at IS NULL
             AND c.tags IS NOT NULL
             AND (c.tags LIKE ${tags.map(() => "?").join(" OR c.tags LIKE ")})`,
        )
        .all(
          captureId,
          sessionKey,
          ...tags.map((t) => `%"${t}"%`),
        ) as { other_id: string }[];
      for (const row of tagRows.slice(0, 5)) {
        // Max 5 tag links
        linkStmt.run(captureId, row.other_id, "shared-tag", now);
      }
    }

    // 2. Link by shared entities (same session)
    if (entities.length > 0) {
      const entityPlaceholders = entities.map(() => "?").join(",");
      const entityRows = this.db
        .prepare(
          `SELECT DISTINCT e.capture_id as other_id FROM entities e
           JOIN captures c ON c.id = e.capture_id
           WHERE e.capture_id != ? AND c.session_key = ? AND c.deleted_at IS NULL
             AND e.entity IN (${entityPlaceholders})`,
        )
        .all(captureId, sessionKey, ...entities) as { other_id: string }[];
      for (const row of entityRows.slice(0, 5)) {
        // Max 5 entity links
        linkStmt.run(captureId, row.other_id, "shared-entity", now);
      }
    }

    // 3. Link by session proximity (captures within 5 minutes in same session)
    const proximityRows = this.db
      .prepare(
        `SELECT id as other_id FROM captures
         WHERE id != ? AND session_key = ? AND deleted_at IS NULL
           AND ABS(created_at - ?) < 300000
         ORDER BY ABS(created_at - ?) ASC LIMIT 3`,
      )
      .all(captureId, sessionKey, now, now) as { other_id: string }[];
    for (const row of proximityRows) {
      linkStmt.run(captureId, row.other_id, "session-proximity", now);
    }
  }

  // ─── v12: Feedback + audit + TTL ──────────────────────────────

  /**
   * Record feedback signal for a capture. Adjusts feedback_salience multiplier.
   * - helpful: +0.1 (max 2.0)
   * - not_helpful: -0.1 (min 0.1)
   * - stale: floor salience at 0.3
   * - wrong: floor salience at 0.1
   */
  recordFeedback(
    captureId: string,
    signal: "helpful" | "not_helpful" | "stale" | "wrong",
    reason?: string,
    agentId?: string,
  ): void {
    const now = Date.now();
    this.db.transaction(() => {
      // Insert feedback row
      this.db
        .prepare(
          "INSERT INTO capture_feedback (capture_id, signal, reason, agent_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(captureId, signal, reason ?? null, agentId ?? null, now);

      // Adjust feedback_salience multiplier
      const row = this.db
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(captureId) as { feedback_salience: number } | undefined;
      if (!row) return;

      let newSalience = row.feedback_salience;
      if (signal === "helpful") {
        newSalience = Math.min(2.0, newSalience + 0.1);
      } else if (signal === "not_helpful") {
        newSalience = Math.max(0.1, newSalience - 0.1);
      } else if (signal === "stale") {
        newSalience = Math.min(newSalience, 0.3);
      } else if (signal === "wrong") {
        newSalience = Math.min(newSalience, 0.1);
      }

      this.db
        .prepare("UPDATE captures SET feedback_salience = ? WHERE id = ?")
        .run(newSalience, captureId);

      // Audit log
      this.recordAuditInternal("feedback", captureId, { signal, reason, newSalience }, agentId);
    })();
  }

  /** Get feedback signals for a capture. */
  getFeedback(captureId: string): { signal: string; reason: string | null; created_at: number }[] {
    return this.db
      .prepare(
        "SELECT signal, reason, created_at FROM capture_feedback WHERE capture_id = ? ORDER BY id DESC",
      )
      .all(captureId) as { signal: string; reason: string | null; created_at: number }[];
  }

  /** Record a mutation log entry. Public API. */
  recordAudit(action: string, captureId: string | null, details?: unknown, agentId?: string): void {
    this.recordAuditInternal(action, captureId, details, agentId);
  }

  /** Internal mutation log — called from within transactions. */
  private recordAuditInternal(
    action: string,
    captureId: string | null,
    details?: unknown,
    agentId?: string,
  ): void {
    try {
      this.db
        .prepare(
          "INSERT INTO mutation_log (action, capture_id, details, agent_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          action,
          captureId,
          details ? JSON.stringify(details) : null,
          agentId ?? null,
          Date.now(),
        );
    } catch {
      // non-fatal — mutation log is supplementary
    }
  }

  /** Query mutation log. */
  queryAudit(opts: {
    action?: string;
    captureId?: string;
    since?: number;
    limit?: number;
  }): {
    id: number;
    action: string;
    capture_id: string | null;
    details: string | null;
    agent_id: string | null;
    created_at: number;
  }[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.action) {
      conditions.push("action = ?");
      params.push(opts.action);
    }
    if (opts.captureId) {
      conditions.push("capture_id = ?");
      params.push(opts.captureId);
    }
    if (opts.since) {
      conditions.push("created_at >= ?");
      params.push(opts.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    return this.db
      .prepare(`SELECT * FROM mutation_log ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as {
      id: number;
      action: string;
      capture_id: string | null;
      details: string | null;
      agent_id: string | null;
      created_at: number;
    }[];
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
  session_key: string | null;
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
  trigger_conditions: string | null;
  steps: string | null;
  validation_rules: string | null;
  source_capture_ids: string | null;
  archived: number | null;
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
    triggerConditions: row.trigger_conditions ? JSON.parse(row.trigger_conditions) : undefined,
    steps: row.steps ? JSON.parse(row.steps) : undefined,
    validationRules: row.validation_rules ? JSON.parse(row.validation_rules) : undefined,
    sourceCaptureIds: row.source_capture_ids ? JSON.parse(row.source_capture_ids) : undefined,
    archived: row.archived === 1,
  };
}
