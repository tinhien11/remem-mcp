-- Schema for tdai-memory-mcp
-- Version: 2
--
-- This file runs on the first start. It creates all tables, triggers, and indexes.
-- It uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS.
-- The migration is idempotent. You can run it more than once without side effects.

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);

-- L0: Raw captures (always populated)
CREATE TABLE IF NOT EXISTS captures (
  id           TEXT PRIMARY KEY,
  session_key  TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT,
  tags         TEXT,
  created_at   INTEGER NOT NULL,
  metadata     TEXT
);

-- L1: Atomic facts (populated by atom-extract pipeline, phase 2)
CREATE TABLE IF NOT EXISTS atoms (
  id          TEXT PRIMARY KEY,
  capture_id  TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  fact        TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  created_at  INTEGER NOT NULL
);

-- L2: Scenario blocks (populated by scenario pipeline, phase 2)
CREATE TABLE IF NOT EXISTS scenarios (
  id           TEXT PRIMARY KEY,
  atom_ids     TEXT NOT NULL,
  summary      TEXT NOT NULL,
  persona_tags TEXT,
  created_at   INTEGER NOT NULL
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  tool       TEXT NOT NULL,
  args_hash  TEXT NOT NULL,
  result_len INTEGER,
  quota_hit  INTEGER NOT NULL DEFAULT 0,
  redacted   INTEGER NOT NULL DEFAULT 0
);

-- Full-text search (BM25 via FTS5)
-- External content table: the FTS5 index links to the captures table by rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(
  id UNINDEXED,
  content,
  tags,
  type UNINDEXED,
  content='captures',
  content_rowid='rowid'
);

-- Vector search (sqlite-vec)
-- Dimension 384 for all-MiniLM-L6-v2. Change to 1536 for OpenAI text-embedding-3-small.
CREATE VIRTUAL TABLE IF NOT EXISTS captures_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[384]
);

-- Triggers: keep FTS5 index in sync with captures table
CREATE TRIGGER IF NOT EXISTS captures_ai AFTER INSERT ON captures BEGIN
  INSERT INTO captures_fts (rowid, id, content, tags, type)
  VALUES (new.rowid, new.id, new.content, new.tags, new.type);
END;

CREATE TRIGGER IF NOT EXISTS captures_au AFTER UPDATE ON captures BEGIN
  UPDATE captures_fts
  SET content = new.content, tags = new.tags, type = new.type
  WHERE rowid = new.rowid;
END;

CREATE TRIGGER IF NOT EXISTS captures_ad AFTER DELETE ON captures BEGIN
  DELETE FROM captures_fts WHERE rowid = old.rowid;
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_captures_session ON captures (session_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_agent ON captures (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_hash ON captures (content_hash);
CREATE INDEX IF NOT EXISTS idx_atoms_capture ON atoms (capture_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
