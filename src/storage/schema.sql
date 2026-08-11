-- Schema for tdai-memory-mcp
-- Version: 6
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
  deleted_at   INTEGER,
  trust_state      TEXT NOT NULL DEFAULT 'candidate',
  rejection_reason TEXT,
  superseded_by    TEXT REFERENCES captures(id)
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

-- ─────────────────────────────────────────────
-- CodeGraph: code symbols, call relationships, impact analysis
-- ─────────────────────────────────────────────

-- Symbols: functions, classes, methods, interfaces, etc.
CREATE TABLE IF NOT EXISTS symbols (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- function, class, method, interface, type, variable, import
  file_path    TEXT NOT NULL,
  line_start   INTEGER NOT NULL,
  line_end     INTEGER NOT NULL,
  language     TEXT NOT NULL,          -- typescript, javascript, python, go, rust, java, c, cpp, csharp
  signature    TEXT,                   -- function signature or type declaration
  docstring    TEXT,                   -- JSDoc, docstring, or comment above symbol
  parent_id    TEXT REFERENCES symbols(id), -- enclosing class or module
  team_id      TEXT,
  repo_path    TEXT,                   -- root path of the indexed repo
  content_hash TEXT,                   -- hash of the symbol body for change detection
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Call relationships: who calls whom
CREATE TABLE IF NOT EXISTS calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id    TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  callee_name  TEXT NOT NULL,          -- name of the called symbol (resolved later)
  callee_id    TEXT REFERENCES symbols(id), -- resolved callee (null if unresolved)
  line         INTEGER NOT NULL,       -- line where the call occurs
  kind         TEXT NOT NULL DEFAULT 'call', -- call, import, reference
  team_id      TEXT
);

-- Import relationships: what a file imports
CREATE TABLE IF NOT EXISTS imports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path    TEXT NOT NULL,
  symbol_name  TEXT NOT NULL,          -- imported symbol name
  source_path  TEXT,                   -- source module/path
  line         INTEGER NOT NULL,
  language     TEXT NOT NULL,
  team_id      TEXT,
  repo_path    TEXT
);

-- ─────────────────────────────────────────────
-- Wiki: structured documentation pages with link graph
-- ─────────────────────────────────────────────

-- Wiki pages: parsed from markdown/docs
CREATE TABLE IF NOT EXISTS wiki_pages (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,          -- full page content (markdown)
  source_file  TEXT NOT NULL,          -- original file path
  section      TEXT,                   -- heading path (e.g., "Getting Started > Install")
  tags         TEXT,                   -- comma-separated tags from frontmatter
  frontmatter  TEXT,                   -- JSON of frontmatter metadata
  content_hash TEXT,                   -- hash for change detection
  team_id      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Wiki links: adjacency list for the link graph
CREATE TABLE IF NOT EXISTS wiki_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  to_page_id   TEXT REFERENCES wiki_pages(id), -- null if link target not found
  to_title     TEXT,                   -- target title (for unresolved links)
  link_text    TEXT,                   -- display text of the link
  link_type    TEXT NOT NULL DEFAULT 'wikilink', -- wikilink, markdown, heading
  line         INTEGER NOT NULL
);

-- FTS5 for wiki pages
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  id UNINDEXED,
  title,
  content,
  tags,
  content='wiki_pages',
  content_rowid='rowid'
);

-- Triggers: keep wiki FTS5 in sync
CREATE TRIGGER IF NOT EXISTS wiki_ai AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_fts (rowid, id, title, content, tags)
  VALUES (new.rowid, new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS wiki_au AFTER UPDATE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO wiki_fts (rowid, id, title, content, tags)
  VALUES (new.rowid, new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS wiki_ad AFTER DELETE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_captures_session ON captures (session_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_agent ON captures (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_hash ON captures (content_hash);
CREATE INDEX IF NOT EXISTS idx_captures_team ON captures (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_user ON captures (team_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_task ON captures (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_trust ON captures (trust_state);
CREATE INDEX IF NOT EXISTS idx_captures_rejected_hash ON captures (content_hash) WHERE trust_state = 'rejected';
CREATE INDEX IF NOT EXISTS idx_atoms_capture ON atoms (capture_id);
CREATE INDEX IF NOT EXISTS idx_atoms_team ON atoms (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_capture ON messages (capture_id, seq);
CREATE INDEX IF NOT EXISTS idx_scenarios_team ON scenarios (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_team ON knowledge (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skills_team ON skills (team_id, updated_at DESC);

-- CodeGraph indexes
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols (name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols (file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols (kind);
CREATE INDEX IF NOT EXISTS idx_symbols_team ON symbols (team_id);
CREATE INDEX IF NOT EXISTS idx_symbols_repo ON symbols (repo_path);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols (parent_id);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls (caller_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls (callee_name);
CREATE INDEX IF NOT EXISTS idx_calls_callee_id ON calls (callee_id);
CREATE INDEX IF NOT EXISTS idx_calls_team ON calls (team_id);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports (file_path);
CREATE INDEX IF NOT EXISTS idx_imports_symbol ON imports (symbol_name);
CREATE INDEX IF NOT EXISTS idx_imports_team ON imports (team_id);

-- Wiki indexes
CREATE INDEX IF NOT EXISTS idx_wiki_pages_source ON wiki_pages (source_file);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_team ON wiki_pages (team_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_hash ON wiki_pages (content_hash);
CREATE INDEX IF NOT EXISTS idx_wiki_links_from ON wiki_links (from_page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_links_to ON wiki_links (to_page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_links_title ON wiki_links (to_title);
