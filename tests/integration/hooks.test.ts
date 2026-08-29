import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");

function runHook(subcommand: string, stdin: string, env?: Record<string, string>): string {
  return execSync(`node ${BIN} ${subcommand}`, {
    input: stdin,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 10000,
  });
}

function makeDb(
  dbPath: string,
  captures: Array<{ id: string; type: string; content: string; tags?: string }>,
): void {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // Create schema manually (no sqlite-vec needed for hook-recall which uses readonly)
  // Must include deleted_at and trust_state columns — hook-recall queries them.
  const { createHash } = require("node:crypto");
  const sessionKey = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS captures (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      metadata TEXT,
      deleted_at TEXT,
      trust_state TEXT
    );
    INSERT INTO schema_version VALUES (1, ${Date.now()});
  `);

  const stmt = db.prepare(
    "INSERT INTO captures (id, session_key, agent_id, type, content, tags, created_at, metadata, trust_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate')",
  );

  for (const c of captures) {
    stmt.run(c.id, sessionKey, "test-agent", c.type, c.content, c.tags ?? "[]", Date.now(), null);
  }

  db.close();
}

describe("Integration: hook-recall", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-hook-test-"));
    dbPath = join(tmpDir, "memory.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("outputs additionalContext with recent captures", () => {
    makeDb(dbPath, [
      { id: "1", type: "decision", content: "Use SQLite for storage", tags: '["adr"]' },
      { id: "2", type: "learning", content: "FTS5 supports BM25 ranking", tags: '["search"]' },
    ]);

    const stdin = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "test-session-123",
      source: "startup",
    });

    const output = runHook("hook-recall", stdin, { REMEM_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("[remem-mcp]");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Use SQLite for storage");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("FTS5 supports BM25 ranking");
  });

  it("outputs empty JSON when no captures exist", () => {
    makeDb(dbPath, []);

    const stdin = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "test-session-123",
      source: "startup",
    });

    const output = runHook("hook-recall", stdin, { REMEM_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed).toEqual({});
  });

  it("injects global captures only when the global session key is configured", () => {
    makeDb(dbPath, []);

    const Database = require("better-sqlite3");
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO captures (id, session_key, agent_id, type, content, tags, created_at, metadata, trust_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate')",
    ).run(
      "global-1",
      "global",
      "test-agent",
      "decision",
      "Use shared release checklist",
      "[]",
      Date.now(),
      null,
    );
    db.close();

    const stdin = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "test-session-123",
      cwd: join(tmpDir, "missing-project"),
    });

    const withoutGlobal = JSON.parse(
      runHook("hook-recall", stdin, {
        REMEM_DB_PATH: dbPath,
        REMEM_GLOBAL_SESSION_KEY: "",
      }),
    );
    expect(withoutGlobal).toEqual({});

    const withGlobal = JSON.parse(
      runHook("hook-recall", stdin, {
        REMEM_DB_PATH: dbPath,
        REMEM_GLOBAL_SESSION_KEY: "global",
      }),
    );
    expect(withGlobal.hookSpecificOutput.additionalContext).toContain(
      "Use shared release checklist",
    );
    expect(withGlobal.hookSpecificOutput.additionalContext).toContain(
      "Global memory (read automatically)",
    );
    expect(withGlobal.hookSpecificOutput.additionalContext).toContain(
      "Save to global only when the user explicitly asks",
    );
  });

  it("outputs empty JSON on invalid stdin", () => {
    makeDb(dbPath, []);

    const output = runHook("hook-recall", "not valid json", { REMEM_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed).toEqual({});
  });

  it("truncates long content to 200 chars", () => {
    const longContent = "A".repeat(500);
    makeDb(dbPath, [{ id: "1", type: "decision", content: longContent, tags: "[]" }]);

    const stdin = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "test-session-123",
    });

    const output = runHook("hook-recall", stdin, { REMEM_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    // Content should be truncated
    expect(parsed.hookSpecificOutput.additionalContext).toContain("...");
    // Should not contain the full 500 chars
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("A".repeat(300));
  });

  it("filters only decision, learning, error, and task types", () => {
    makeDb(dbPath, [
      { id: "1", type: "decision", content: "Important decision", tags: "[]" },
      { id: "2", type: "summary", content: "Should not appear", tags: "[]" },
      { id: "3", type: "learning", content: "Important learning", tags: "[]" },
      { id: "4", type: "note", content: "Should not appear either", tags: "[]" },
    ]);

    const stdin = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "test-session-123",
    });

    const output = runHook("hook-recall", stdin, { REMEM_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput.additionalContext).toContain("Important decision");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Important learning");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("Should not appear");
  });
});

describe("Integration: hook-session-end", () => {
  let tmpDir: string;
  let dbPath: string;
  let transcriptDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-session-end-"));
    dbPath = join(tmpDir, "memory.db");
    transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir, { recursive: true });

    // Create a minimal DB with schema
    const Database = require("better-sqlite3");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, session_key TEXT NOT NULL, agent_id TEXT NOT NULL,
        type TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT, tags TEXT,
        created_at INTEGER NOT NULL, metadata TEXT, team_id TEXT, user_id TEXT, task_id TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(
        id UNINDEXED, content, tags, type UNINDEXED
      );
      CREATE TRIGGER IF NOT EXISTS captures_ai AFTER INSERT ON captures BEGIN
        INSERT INTO captures_fts (rowid, id, content, tags, type)
        VALUES (new.rowid, new.id, new.content, new.tags, new.type);
      END;
      INSERT INTO schema_version VALUES (3, ${Date.now()});
    `);
    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures session summary from transcript", () => {
    const sessionId = "test-session-abc";
    const transcript = {
      schema_version: "ATIF-v1.7",
      session_id: sessionId,
      steps: [
        { source: "system", message: "system prompt" },
        { source: "user", message: "Fix the auth bug in login flow" },
        { source: "assistant", message: "I fixed the JWT refresh token rotation." },
      ],
    };
    writeFileSync(join(transcriptDir, `${sessionId}.json`), JSON.stringify(transcript));

    const stdin = JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId });
    runHook("hook-session-end", stdin, {
      REMEM_DB_PATH: dbPath,
      DEVIN_TRANSCRIPTS_DIR: transcriptDir,
    });

    // Verify capture was written to DB
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM captures WHERE type = ?").all("conversation") as any[];
    db.close();

    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain("Fix the auth bug");
    expect(rows[0].content).toContain("JWT refresh token");
    expect(JSON.parse(rows[0].tags)).toContain("auto-capture");
  });

  it("skips trivial sessions", () => {
    const sessionId = "trivial-session";
    const transcript = {
      session_id: sessionId,
      steps: [{ source: "user", message: "hi" }],
    };
    writeFileSync(join(transcriptDir, `${sessionId}.json`), JSON.stringify(transcript));

    const stdin = JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId });
    runHook("hook-session-end", stdin, {
      REMEM_DB_PATH: dbPath,
      DEVIN_TRANSCRIPTS_DIR: transcriptDir,
    });

    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM captures").all() as any[];
    db.close();

    expect(rows.length).toBe(0);
  });

  it("skips when transcript not found", () => {
    const stdin = JSON.stringify({ hook_event_name: "SessionEnd", session_id: "nonexistent" });
    const output = runHook("hook-session-end", stdin, {
      REMEM_DB_PATH: dbPath,
      DEVIN_TRANSCRIPTS_DIR: transcriptDir,
    });

    expect(JSON.parse(output)).toEqual({});
  });

  it("skips duplicate captures", () => {
    const sessionId = "dup-session";
    const transcript = {
      session_id: sessionId,
      steps: [
        { source: "user", message: "Do something" },
        { source: "assistant", message: "Done." },
      ],
    };
    writeFileSync(join(transcriptDir, `${sessionId}.json`), JSON.stringify(transcript));

    const stdin = JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId });

    // Run twice
    runHook("hook-session-end", stdin, {
      REMEM_DB_PATH: dbPath,
      DEVIN_TRANSCRIPTS_DIR: transcriptDir,
    });
    runHook("hook-session-end", stdin, {
      REMEM_DB_PATH: dbPath,
      DEVIN_TRANSCRIPTS_DIR: transcriptDir,
    });

    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM captures WHERE type = ?").all("conversation") as any[];
    db.close();

    expect(rows.length).toBe(1);
  });

  it("captures from Claude Code JSONL transcript via transcript_path", () => {
    const sessionId = "claude-code-session";
    const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);

    // Claude Code stores transcripts as JSONL (one JSON object per line)
    const lines = [
      JSON.stringify({ type: "system", message: { role: "system", content: "system prompt" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Fix the login bug" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I fixed the JWT validation." }],
        },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "thanks" } }),
    ];
    writeFileSync(transcriptPath, lines.join("\n"));

    // Claude Code SessionEnd stdin includes transcript_path directly
    const stdin = JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: "/data/projects/test",
      reason: "other",
    });

    runHook("hook-session-end", stdin, { REMEM_DB_PATH: dbPath });

    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM captures WHERE type = ?").all("conversation") as any[];
    db.close();

    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain("Fix the login bug");
    expect(rows[0].content).toContain("JWT validation");
    expect(JSON.parse(rows[0].tags)).toContain("auto-capture");
  });
});

describe("Integration: install-hooks", () => {
  let tmpDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-install-hooks-"));
    fakeHome = join(tmpDir, "fake-home");
    mkdirSync(join(fakeHome, ".config", "devin"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wires hooks into Devin CLI config.json", () => {
    const configPath = join(fakeHome, ".config", "devin", "config.json");
    writeFileSync(configPath, JSON.stringify({ agent: { model: "test" } }, null, 2));

    // Run install-hooks with fake HOME
    execSync(`node ${BIN} install-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.hooks).toBeDefined();
    expect(config.hooks.SessionStart).toBeDefined();
    expect(config.hooks.SessionEnd).toBeDefined();
    expect(config.hooks.SessionStart[0].hooks[0].command).toContain("hook-recall");
    expect(config.hooks.SessionEnd[0].hooks[0].command).toContain("hook-session-end");
    // Preserves existing config
    expect(config.agent.model).toBe("test");
  });

  it("preserves existing hooks when adding new ones", () => {
    const configPath = join(fakeHome, ".config", "devin", "config.json");
    const existingConfig = {
      agent: { model: "test" },
      hooks: {
        PreToolUse: [
          {
            matcher: "exec",
            hooks: [{ type: "command", command: "echo existing" }],
          },
        ],
      },
    };
    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));

    execSync(`node ${BIN} install-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.hooks.PreToolUse).toBeDefined();
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe("echo existing");
    expect(config.hooks.SessionStart).toBeDefined();
    expect(config.hooks.SessionEnd).toBeDefined();
  });

  it("uninstall-hooks removes remem-mcp hooks but preserves user hooks", () => {
    const configPath = join(fakeHome, ".config", "devin", "config.json");
    const configWithHooks = {
      agent: { model: "test" },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "remem-mcp hook-recall" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "remem-mcp hook-session-end" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "keep-me" }] }],
      },
    };
    writeFileSync(configPath, JSON.stringify(configWithHooks, null, 2));

    execSync(`node ${BIN} uninstall-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.hooks.SessionStart).toBeUndefined();
    expect(config.hooks.SessionEnd).toBeUndefined();
    expect(config.hooks.PreToolUse).toBeDefined();
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe("keep-me");
  });

  it("removes hooks key entirely when no hooks remain", () => {
    const configPath = join(fakeHome, ".config", "devin", "config.json");
    const configWithOnlyOurHooks = {
      agent: { model: "test" },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "remem-mcp hook-recall" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "remem-mcp hook-session-end" }] }],
      },
    };
    writeFileSync(configPath, JSON.stringify(configWithOnlyOurHooks, null, 2));

    execSync(`node ${BIN} uninstall-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.hooks).toBeUndefined();
    expect(config.agent.model).toBe("test");
  });
});

describe("Integration: hook-pre-compact", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-precompact-test-"));
    dbPath = join(tmpDir, "memory.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves a compaction checkpoint to the DB", () => {
    const stdin = JSON.stringify({
      trigger: "auto",
      session_id: "test-compact-session",
    });

    const output = runHook("hook-pre-compact", stdin, { REMEM_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    // Should return PreCompact hook output with recovery context
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreCompact");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("[remem-mcp]");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("compaction");

    // Should have saved a checkpoint capture to the DB
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM captures WHERE tags LIKE '%checkpoint%'").all();
    db.close();

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].type).toBe("task");
    expect(rows[0].content).toContain("compaction");
    expect(rows[0].agent_id).toBe("remem-mcp-hook");
  });

  it("handles empty stdin gracefully", () => {
    const output = runHook("hook-pre-compact", "", { REMEM_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreCompact");
  });

  it("handles invalid JSON without crashing", () => {
    const output = runHook("hook-pre-compact", "not valid json", { REMEM_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    // Should return empty JSON (not crash)
    expect(parsed).toBeDefined();
  });
});
