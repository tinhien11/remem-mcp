import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const BIN = join(process.cwd(), "dist", "index.js");

function runHook(subcommand: string, stdin: string, env?: Record<string, string>): string {
  return execSync(`node ${BIN} ${subcommand}`, {
    input: stdin,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 10000,
  });
}

function makeDb(dbPath: string, captures: Array<{ id: string; type: string; content: string; tags?: string }>): void {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // Create schema manually (no sqlite-vec needed for hook-recall which uses readonly)
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
      metadata TEXT
    );
    INSERT INTO schema_version VALUES (1, ${Date.now()});
  `);

  const stmt = db.prepare(
    "INSERT INTO captures (id, session_key, agent_id, type, content, tags, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );

  for (const c of captures) {
    stmt.run(
      c.id,
      "test-session",
      "test-agent",
      c.type,
      c.content,
      c.tags ?? "[]",
      Date.now(),
      null,
    );
  }

  db.close();
}

describe("Integration: hook-recall", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-hook-test-"));
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

    const output = runHook("hook-recall", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("[tdai-memory]");
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

    const output = runHook("hook-recall", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed).toEqual({});
  });

  it("outputs empty JSON on invalid stdin", () => {
    makeDb(dbPath, []);

    const output = runHook("hook-recall", "not valid json", { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed).toEqual({});
  });

  it("truncates long content to 200 chars", () => {
    const longContent = "A".repeat(500);
    makeDb(dbPath, [
      { id: "1", type: "decision", content: longContent, tags: "[]" },
    ]);

    const stdin = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "test-session-123",
    });

    const output = runHook("hook-recall", stdin, { TDAI_DB_PATH: dbPath });
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

    const output = runHook("hook-recall", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput.additionalContext).toContain("Important decision");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Important learning");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("Should not appear");
  });
});

describe("Integration: hook-stop", () => {
  it("outputs handoff reminder", () => {
    const stdin = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "test-session-123",
    });

    const output = runHook("hook-stop", stdin);
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("handoff");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("task");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("status");
  });

  it("works with empty stdin", () => {
    const output = runHook("hook-stop", "");
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
  });

  it("works with any stdin content", () => {
    const output = runHook("hook-stop", "random text not json");
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain("handoff");
  });
});

describe("Integration: install-hooks", () => {
  let tmpDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-install-hooks-"));
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
    expect(config.hooks.Stop).toBeDefined();
    expect(config.hooks.SessionStart[0].hooks[0].command).toContain("hook-recall");
    expect(config.hooks.Stop[0].hooks[0].command).toContain("hook-stop");
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
    expect(config.hooks.Stop).toBeDefined();
  });

  it("uninstall-hooks removes only SessionStart and Stop", () => {
    const configPath = join(fakeHome, ".config", "devin", "config.json");
    const configWithHooks = {
      agent: { model: "test" },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "test" }] }],
        Stop: [{ hooks: [{ type: "command", command: "test" }] }],
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
    expect(config.hooks.Stop).toBeUndefined();
    expect(config.hooks.PreToolUse).toBeDefined();
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe("keep-me");
  });

  it("removes hooks key entirely when no hooks remain", () => {
    const configPath = join(fakeHome, ".config", "devin", "config.json");
    const configWithOnlyOurHooks = {
      agent: { model: "test" },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "test" }] }],
        Stop: [{ hooks: [{ type: "command", command: "test" }] }],
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
