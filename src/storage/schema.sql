-- Schema for tdai-memory-mcp
-- Version: 4
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
  metadata     TEXT,
  team_id      TEXT,
  user_id      TEXT,
  task_id      TEXT,
  deleted_at   INTEGER
);

-- L0 messages: role-based conversation messages linked to a capture.
-- Populated when capture is called with messages: [{role, content}].
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  capture_id  TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- L1: Atomic facts (populated by atom-extract pipeline, or CLI extract command)
CREATE TABLE IF NOT EXISTS atoms (
  id          TEXT PRIMARY KEY,
  capture_id  TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  fact        TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  created_at  INTEGER NOT NULL,
  team_id     TEXT,
  agent_id    TEXT,
  user_id     TEXT
);

-- L2: Scenario blocks (populated by scenario pipeline)
CREATE TABLE IF NOT EXISTS scenarios (
  id           TEXT PRIMARY KEY,
  atom_ids     TEXT NOT NULL,
  summary      TEXT NOT NULL,
  persona_tags TEXT,
  created_at   INTEGER NOT NULL,
  team_id      TEXT,
  agent_id     TEXT,
  user_id     TEXT
);

-- L3: Persona (long-term user profile, one per team/agent/user)
CREATE TABLE IF NOT EXISTS persona (
  team_id    TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, agent_id, user_id)
);

-- Knowledge assets (wiki, code-graph) registered by the team
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

-- Skills: reusable workflows extracted from conversations
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
-- FTS5 external content tables require the special 'delete' command syntax
-- to remove entries from the index.
CREATE TRIGGER IF NOT EXISTS captures_ai AFTER INSERT ON captures BEGIN
  INSERT INTO captures_fts (rowid, id, content, tags, type)
  VALUES (new.rowid, new.id, new.content, new.tags, new.type);
END;

CREATE TRIGGER IF NOT EXISTS captures_au AFTER UPDATE ON captures BEGIN
  INSERT INTO captures_fts(captures_fts, rowid, content, tags, type) VALUES('delete', old.rowid, old.content, old.tags, old.type);
  INSERT INTO captures_fts (rowid, id, content, tags, type)
  VALUES (new.rowid, new.id, new.content, new.tags, new.type);
END;

CREATE TRIGGER IF NOT EXISTS captures_ad AFTER DELETE ON captures BEGIN
  INSERT INTO captures_fts(captures_fts, rowid, content, tags, type) VALUES('delete', old.rowid, old.content, old.tags, old.type);
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_captures_session ON captures (session_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_agent ON captures (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_hash ON captures (content_hash);
CREATE INDEX IF NOT EXISTS idx_captures_team ON captures (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_user ON captures (team_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_task ON captures (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_atoms_capture ON atoms (capture_id);
CREATE INDEX IF NOT EXISTS idx_atoms_team ON atoms (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_capture ON messages (capture_id, seq);
CREATE INDEX IF NOT EXISTS idx_scenarios_team ON scenarios (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_team ON knowledge (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skills_team ON skills (team_id, updated_at DESC);
