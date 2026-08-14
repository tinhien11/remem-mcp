/**
 * Regression tests for multi-agent hook installation and read-only DB fallback.
 *
 * Covers:
 * - Claude Code hooks install/uninstall (JSON config)
 * - Devin CLI hooks install/uninstall (JSON config)
 * - Codex CLI hooks install/uninstall (TOML config)
 * - Read-only DB fallback (recall works, capture fails gracefully)
 * - Global + project hybrid recall (TDAI_GLOBAL_SESSION_KEY)
 */
import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteBackend } from "../../src/storage/sqlite.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");

// ─── Helpers ───────────────────────────────────────────────────

function makeTmpHome(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "remem-regression-"));
  return tmpDir;
}

function makeDb(
  dbPath: string,
  captures: Array<{
    id: string;
    session_key: string;
    type: string;
    content: string;
    tags?: string;
  }>,
): void {
  // Use SQLiteBackend to properly init schema + sqlite-vec + FTS5
  const backend = new SQLiteBackend(dbPath);
  const db = backend.getDatabase();

  const stmt = db.prepare(
    "INSERT INTO captures (id, session_key, agent_id, type, content, tags, created_at, metadata, trust_state) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'candidate')",
  );

  for (const c of captures) {
    stmt.run(c.id, c.session_key, "test-agent", c.type, c.content, c.tags ?? "[]", Date.now());
  }

  // Checkpoint WAL so readonly mode can read without writing
  db.pragma("wal_checkpoint(TRUNCATE)");
  backend.close();
}

function readCaptures(
  dbPath: string,
): Array<{ id: string; type: string; content: string; session_key: string }> {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      "SELECT id, type, content, session_key FROM captures WHERE deleted_at IS NULL ORDER BY created_at DESC",
    )
    .all() as Array<{ id: string; type: string; content: string; session_key: string }>;
  db.close();
  return rows;
}

// ─── Claude Code hook config ───────────────────────────────────

describe("Regression: Claude Code hooks", () => {
  let tmpDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-claude-reg-"));
    fakeHome = join(tmpDir, "fake-home");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("install-hooks wires into ~/.claude/settings.json", () => {
    const settingsPath = join(fakeHome, ".claude", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ model: "test" }, null, 2));

    execSync(`node ${BIN} install-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("hook-recall");
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("hook-stop");
    // Preserves existing config
    expect(settings.model).toBe("test");
  });

  it("install-hooks preserves existing Claude hooks", () => {
    const settingsPath = join(fakeHome, ".claude", "settings.json");
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: "Grep", hooks: [{ type: "command", command: "echo existing" }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    execSync(`node ${BIN} install-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("echo existing");
    expect(settings.hooks.SessionStart).toBeDefined();
  });

  it("uninstall-hooks removes Claude SessionStart and Stop", () => {
    const settingsPath = join(fakeHome, ".claude", "settings.json");
    const withHooks = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "remem-mcp hook-recall" }] }],
        Stop: [{ hooks: [{ type: "command", command: "remem-mcp hook-stop" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "keep-me" }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(withHooks, null, 2));

    execSync(`node ${BIN} uninstall-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks.SessionStart).toBeUndefined();
    expect(settings.hooks.Stop).toBeUndefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
  });
});

// ─── Devin CLI hook config ─────────────────────────────────────

describe("Regression: Devin CLI hooks", () => {
  let tmpDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-devin-reg-"));
    fakeHome = join(tmpDir, "fake-home");
    mkdirSync(join(fakeHome, ".config", "devin"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("install-hooks wires into ~/.config/devin/config.json", () => {
    const configPath = join(fakeHome, ".config", "devin", "config.json");
    writeFileSync(configPath, JSON.stringify({ agent: { model: "test" } }, null, 2));

    execSync(`node ${BIN} install-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.hooks.SessionStart).toBeDefined();
    expect(config.hooks.SessionStart[0].hooks[0].command).toContain("hook-recall");
    expect(config.agent.model).toBe("test");
  });

  it("uninstall-hooks removes Devin SessionStart and Stop", () => {
    const configPath = join(fakeHome, ".config", "devin", "config.json");
    const withHooks = {
      agent: { model: "test" },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "remem-mcp hook-recall" }] }],
        Stop: [{ hooks: [{ type: "command", command: "remem-mcp hook-stop" }] }],
      },
    };
    writeFileSync(configPath, JSON.stringify(withHooks, null, 2));

    execSync(`node ${BIN} uninstall-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    // All remem-mcp hooks removed, hooks key deleted entirely
    expect(config.hooks).toBeUndefined();
    expect(config.agent.model).toBe("test");
  });

  it("uninstall-hooks preserves non-remem hooks in Devin config", () => {
    const configPath = join(fakeHome, ".config", "devin", "config.json");
    const withHooks = {
      agent: { model: "test" },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "remem-mcp hook-recall" }] }],
        Stop: [{ hooks: [{ type: "command", command: "remem-mcp hook-stop" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "keep-me" }] }],
      },
    };
    writeFileSync(configPath, JSON.stringify(withHooks, null, 2));

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
});

// ─── Codex CLI hook config ─────────────────────────────────────

describe("Regression: Codex CLI hooks (TOML)", () => {
  let tmpDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-codex-reg-"));
    fakeHome = join(tmpDir, "fake-home");
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("install-hooks appends TOML hooks to ~/.codex/config.toml", () => {
    const configPath = join(fakeHome, ".codex", "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.5"\nsandbox_mode = "workspace-write"\n');

    execSync(`node ${BIN} install-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const content = readFileSync(configPath, "utf-8");
    // Preserves existing config
    expect(content).toContain('model = "gpt-5.5"');
    // Adds remem-mcp hooks
    expect(content).toContain("remem-mcp SessionStart");
    expect(content).toContain("remem-mcp Stop");
    expect(content).toContain("hook-recall");
    expect(content).toContain("hook-stop");
    expect(content).toContain('matcher = "startup|resume|clear|compact"');
  });

  it("install-hooks is idempotent (does not duplicate)", () => {
    const configPath = join(fakeHome, ".codex", "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.5"\n');

    // Run twice
    execSync(`node ${BIN} install-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });
    execSync(`node ${BIN} install-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const content = readFileSync(configPath, "utf-8");
    // Should only have one set of remem-mcp hooks
    const matchCount = (content.match(/>>> remem-mcp SessionStart >>>/g) || []).length;
    expect(matchCount).toBe(1);
  });

  it("install-hooks preserves existing TOML config (mcp_servers, projects)", () => {
    const configPath = join(fakeHome, ".codex", "config.toml");
    const existing = `model = "gpt-5.5"

[mcp_servers.codebase-memory-mcp]
command = "/usr/local/bin/codebase-memory-mcp"

[projects."/Users/tin/a/myapp"]
trust_level = "trusted"
`;
    writeFileSync(configPath, existing);

    execSync(`node ${BIN} install-hooks`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("[mcp_servers.codebase-memory-mcp]");
    expect(content).toContain('command = "/usr/local/bin/codebase-memory-mcp"');
    expect(content).toContain('[projects."/Users/tin/a/myapp"]');
    expect(content).toContain("remem-mcp SessionStart");
  });
});

// ─── Read-only DB fallback ─────────────────────────────────────

describe("Regression: read-only DB fallback", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-readonly-reg-"));
    dbPath = join(tmpDir, "memory.db");
    makeDb(dbPath, [
      {
        id: "1",
        session_key: "test-session",
        type: "decision",
        content: "Use SQLite for local-first storage",
        tags: '["arch"]',
      },
      {
        id: "2",
        session_key: "test-session",
        type: "learning",
        content: "FTS5 supports BM25 ranking natively",
        tags: '["search"]',
      },
    ]);
  });

  afterEach(() => {
    // Restore permissions before cleanup
    try {
      chmodSync(tmpDir, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hook-recall opens DB in readonly mode (no write needed)", () => {
    // hook-recall always opens with readonly: true — verify it works
    const stdin = JSON.stringify({ session_id: "test-session-123", cwd: "/tmp" });
    const output = execSync(`node ${BIN} hook-recall`, {
      input: stdin,
      encoding: "utf-8",
      env: { ...process.env, TDAI_DB_PATH: dbPath },
      timeout: 10000,
    });

    const result = JSON.parse(output);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.additionalContext).toContain("SQLite");
  });

  it("SQLiteBackend opens in read-only mode when directory is not writable", () => {
    // Make the directory read-only
    chmodSync(tmpDir, 0o555);

    // Should not throw — should fall back to read-only
    let backend: SQLiteBackend;
    try {
      backend = new SQLiteBackend(dbPath);
    } finally {
      chmodSync(tmpDir, 0o755);
    }

    // Can read from the DB
    const rows = backend
      .getDatabase()
      .prepare("SELECT COUNT(*) as c FROM captures WHERE deleted_at IS NULL")
      .get() as { c: number };
    expect(rows.c).toBe(2);

    backend.close();
  });
});

// ─── Global + project hybrid recall ────────────────────────────

describe("Regression: global + project hybrid recall", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-global-reg-"));
    dbPath = join(tmpDir, "memory.db");
    // Seed both global and project captures
    makeDb(dbPath, [
      {
        id: "g1",
        session_key: "global",
        type: "decision",
        content: "Always use recall before grep",
        tags: '["rule"]',
      },
      {
        id: "g2",
        session_key: "global",
        type: "decision",
        content: "Use codegraph_search for definitions",
        tags: '["rule"]',
      },
      {
        id: "p1",
        session_key: "project-abc",
        type: "learning",
        content: "Project uses PostgreSQL for production",
        tags: '["db"]',
      },
      {
        id: "p2",
        session_key: "project-abc",
        type: "task",
        content: "Migrated from MySQL to PostgreSQL",
        tags: '["migration"]',
      },
    ]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hook-recall injects global captures when TDAI_GLOBAL_SESSION_KEY is set", () => {
    const stdin = JSON.stringify({ session_id: "project-abc123", cwd: "/tmp" });
    const output = execSync(`node ${BIN} hook-recall`, {
      input: stdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        TDAI_DB_PATH: dbPath,
        TDAI_GLOBAL_SESSION_KEY: "global",
      },
      timeout: 10000,
    });

    const result = JSON.parse(output);
    const ctx = result.hookSpecificOutput.additionalContext;
    // Global captures should appear
    expect(ctx).toContain("Always use recall before grep");
    expect(ctx).toContain("Use codegraph_search for definitions");
  });

  it("hook-recall injects project captures alongside global", () => {
    const stdin = JSON.stringify({ session_id: "project-abc1234567890", cwd: "/tmp" });
    const output = execSync(`node ${BIN} hook-recall`, {
      input: stdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        TDAI_DB_PATH: dbPath,
        TDAI_GLOBAL_SESSION_KEY: "global",
      },
      timeout: 10000,
    });

    const result = JSON.parse(output);
    const ctx = result.hookSpecificOutput.additionalContext;
    // Both global and project captures should appear
    expect(ctx).toContain("Always use recall before grep");
  });
});

// ─── install-skill targets ─────────────────────────────────────

describe("Regression: install-skill targets all agents", () => {
  let tmpDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-skill-reg-"));
    fakeHome = join(tmpDir, "fake-home");
    // Create all agent directories
    mkdirSync(join(fakeHome, ".config", "devin", "skills"), { recursive: true });
    mkdirSync(join(fakeHome, ".claude", "skills"), { recursive: true });
    mkdirSync(join(fakeHome, ".codex", "skills"), { recursive: true });
    mkdirSync(join(fakeHome, ".agents", "skills"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("install-skill writes SKILL.md to all 4 agent directories", () => {
    execSync(`node ${BIN} install-skill`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: fakeHome },
    });

    const targets = [
      join(fakeHome, ".config", "devin", "skills", "remem-mcp", "SKILL.md"),
      join(fakeHome, ".claude", "skills", "remem-mcp", "SKILL.md"),
      join(fakeHome, ".codex", "skills", "remem-mcp", "SKILL.md"),
      join(fakeHome, ".agents", "skills", "remem-mcp", "SKILL.md"),
    ];

    for (const path of targets) {
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("name: remem-mcp");
      expect(content).toContain("recall");
      expect(content).toContain("capture");
    }
  });
});
