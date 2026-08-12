import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");

function runHook(subcommand: string, stdin: string, env?: Record<string, string>): string {
  try {
    return execSync(`node ${BIN} ${subcommand}`, {
      input: stdin,
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: 10000,
    });
  } catch (e: any) {
    return e.stdout ?? "";
  }
}

function runCli(args: string, env?: Record<string, string>): string {
  return execSync(`node ${BIN} ${args}`, {
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 10000,
  });
}

/**
 * Create a test DB with the full schema needed for error learning tests.
 * Includes: captures table with deleted_at, metadata columns.
 */
function makeErrorDb(dbPath: string): any {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

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
      created_at TEXT NOT NULL,
      metadata TEXT,
      deleted_at TEXT,
      trust_state TEXT,
      rejection_reason TEXT,
      superseded_by TEXT
    );
    INSERT INTO schema_version VALUES (6, ${Date.now()});
  `);

  return db;
}

/** Insert an error capture with structured metadata. */
function insertError(
  db: any,
  opts: {
    id: string;
    sessionKey: string;
    errorType: string;
    command: string;
    title?: string;
    confidence?: number;
    resolved?: boolean;
    fixApplied?: string;
    antiPattern?: string;
    correctApproach?: string;
    createdAt?: string;
    content?: string;
  },
): void {
  const meta = {
    tool: "Bash",
    command: opts.command.slice(0, 200),
    exit_code: 1,
    error_type: opts.errorType,
    title: opts.title ?? `${opts.errorType} error in: ${opts.command.slice(0, 40)}`,
    anti_pattern: opts.antiPattern ?? "Error occurred",
    correct_approach: opts.correctApproach ?? "Fix the issue",
    confidence: opts.confidence ?? 2,
    upvotes: 0,
    downvotes: 0,
    resolved: opts.resolved ?? false,
    ...(opts.fixApplied ? { fix_applied: opts.fixApplied } : {}),
  };

  const content = opts.content ?? `Command failed: ${opts.command}\nError (${opts.errorType}): something went wrong`;
  const hash = require("node:crypto").createHash("sha256").update(content).digest("hex").slice(0, 16);

  db.prepare(
    "INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    opts.id,
    opts.sessionKey,
    "auto",
    "error",
    content,
    hash,
    JSON.stringify(["auto-capture", "error", opts.errorType]),
    opts.createdAt ?? new Date().toISOString(),
    JSON.stringify(meta),
  );
}

describe("Integration: error learning — PostToolUse capture", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-error-test-"));
    dbPath = join(tmpDir, "memory.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("PostToolUse captures a failed lint command with structured metadata", () => {
    makeErrorDb(dbPath);

    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm run lint" },
      tool_response: {
        stdout: "",
        stderr: "src/index.ts: line 42, col 5, Error - 'foo' is not defined (no-undef) eslint",
        exit_code: 1,
      },
    });

    const output = runHook("hook-post-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    // Should inject reflection prompt
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Auto-captured lint error");

    // Verify DB has the error
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM captures WHERE type = 'error'").all() as any[];
    db.close();

    expect(rows.length).toBe(1);
    const meta = JSON.parse(rows[0].metadata);
    expect(meta.error_type).toBe("lint");
    expect(meta.confidence).toBe(2);
    expect(meta.resolved).toBe(false);
    expect(meta.anti_pattern).toContain("no-undef");
  });

  it("PostToolUse does NOT capture successful commands (no error)", () => {
    makeErrorDb(dbPath);

    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm run lint" },
      tool_response: {
        stdout: "All checks passed",
        stderr: "",
        exit_code: 0,
      },
    });

    const output = runHook("hook-post-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    // No additionalContext for successful commands
    expect(parsed.hookSpecificOutput).toBeUndefined();

    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM captures WHERE type = 'error'").all() as any[];
    db.close();

    expect(rows.length).toBe(0);
  });

  it("PostToolUse success correlation: upvotes previous error and records fix", () => {
    const db = makeErrorDb(dbPath);

    const { createHash } = require("node:crypto");
    const hashPath = (p: string) => createHash("sha256").update(p).digest("hex").slice(0, 16);
    const realSessionKey = hashPath(tmpDir);

    // Insert a previous error for "npm run build"
    insertError(db, {
      id: "err-1",
      sessionKey: realSessionKey,
      errorType: "build",
      command: "npm run build",
      confidence: 2,
      resolved: false,
    });
    db.close();

    // Now simulate the same command succeeding
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      cwd: tmpDir,
      tool_response: {
        stdout: "Build successful. Output in dist/",
        stderr: "",
        exit_code: 0,
      },
    });

    runHook("hook-post-tool-use", stdin, { TDAI_DB_PATH: dbPath });

    // Verify the previous error was upvoted and fix recorded
    const Database = require("better-sqlite3");
    const db2 = new Database(dbPath, { readonly: true });
    const row = db2.prepare("SELECT metadata FROM captures WHERE id = 'err-1'").get() as any;
    db2.close();

    const meta = JSON.parse(row.metadata);
    expect(meta.resolved).toBe(true);
    expect(meta.confidence).toBe(3); // 2 + 1 = 3
    expect(meta.fix_applied).toBeDefined();
    expect(meta.fix_applied).toContain("Build successful");
  });
});

describe("Integration: error learning — PreToolUse injection", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-pretool-test-"));
    dbPath = join(tmpDir, "memory.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("PreToolUse injects past errors before risky commands", () => {
    const db = makeErrorDb(dbPath);

    insertError(db, {
      id: "err-1",
      sessionKey: "test-session",
      errorType: "lint",
      command: "npm run lint",
      title: "lint error in: npm run lint",
      antiPattern: "'foo' is not defined",
      correctApproach: "Fix the lint violation",
      confidence: 3,
    });
    db.close();

    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm run lint" },
      cwd: tmpDir,
    });

    // Need to set TDAI_DB_PATH and the session key must match
    // session_key = hashPath(cwd), so we need to use the same cwd
    // But we inserted with "test-session" — let's use TDAI_DB_PATH directly
    // The hook uses hashPath(cwd) for session_key, so we need to match
    // Let's just set the session key in the DB to match hashPath(tmpDir)
    const Database = require("better-sqlite3");
    const db2 = new Database(dbPath);
    const { createHash } = require("node:crypto");
    const hashPath = (p: string) => createHash("sha256").update(p).digest("hex").slice(0, 16);
    const realSessionKey = hashPath(tmpDir);
    db2.prepare("UPDATE captures SET session_key = ? WHERE id = 'err-1'").run(realSessionKey);
    db2.close();

    const output = runHook("hook-pre-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Past error to avoid repeating");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("lint error");
  });

  it("PreToolUse injects proven fixes from resolved errors", () => {
    const db = makeErrorDb(dbPath);

    const { createHash } = require("node:crypto");
    const hashPath = (p: string) => createHash("sha256").update(p).digest("hex").slice(0, 16);
    const realSessionKey = hashPath(tmpDir);

    // Insert a resolved error with fix_applied
    insertError(db, {
      id: "err-resolved",
      sessionKey: realSessionKey,
      errorType: "build",
      command: "npm run build",
      title: "build error in: npm run build",
      confidence: 4,
      resolved: true,
      fixApplied: "Added missing import in src/index.ts",
    });
    db.close();

    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      cwd: tmpDir,
    });

    const output = runHook("hook-pre-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeDefined();
    const ctx = parsed.hookSpecificOutput.additionalContext;
    // Should contain proven fixes section
    expect(ctx).toContain("Proven fixes");
    expect(ctx).toContain("Added missing import");
  });

  it("PreToolUse applies confidence decay — old errors rank lower", () => {
    const db = makeErrorDb(dbPath);

    const { createHash } = require("node:crypto");
    const hashPath = (p: string) => createHash("sha256").update(p).digest("hex").slice(0, 16);
    const realSessionKey = hashPath(tmpDir);

    // Insert an old error with high confidence (20 days ago)
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    insertError(db, {
      id: "err-old",
      sessionKey: realSessionKey,
      errorType: "lint",
      command: "npm run lint",
      title: "old lint error",
      confidence: 5,
      createdAt: oldDate,
    });

    // Insert a fresh error with lower confidence (today)
    insertError(db, {
      id: "err-fresh",
      sessionKey: realSessionKey,
      errorType: "lint",
      command: "npm run lint",
      title: "fresh lint error",
      confidence: 2,
    });
    db.close();

    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm run lint" },
      cwd: tmpDir,
    });

    const output = runHook("hook-pre-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeDefined();
    const ctx = parsed.hookSpecificOutput.additionalContext;

    // Fresh error (confidence 2, no decay) should rank higher than
    // old error (confidence 5, 20 days decay → 5 * 0.95^20 ≈ 1.8)
    // So fresh should appear first
    const freshIdx = ctx.indexOf("fresh lint error");
    const oldIdx = ctx.indexOf("old lint error");
    expect(freshIdx).toBeGreaterThan(-1);
    // Old error may or may not appear (only top 2), but if both appear, fresh should be first
    if (oldIdx > -1) {
      expect(freshIdx).toBeLessThan(oldIdx);
    }
  });

  it("PreToolUse does NOT inject for non-relevant commands", () => {
    makeErrorDb(dbPath);

    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      cwd: tmpDir,
    });

    const output = runHook("hook-pre-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  it("PreToolUse injects cross-project errors when TDAI_GLOBAL_ERRORS=1", () => {
    const db = makeErrorDb(dbPath);

    // Insert error in a DIFFERENT session key (another project)
    insertError(db, {
      id: "err-other-project",
      sessionKey: "different-project-hash",
      errorType: "build",
      command: "npm run build",
      title: "build error from another project",
      confidence: 3,
    });
    db.close();

    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      cwd: tmpDir,
    });

    // With global errors enabled, should inject even though session key doesn't match
    const output = runHook("hook-pre-tool-use", stdin, {
      TDAI_DB_PATH: dbPath,
      TDAI_GLOBAL_ERRORS: "1",
    });
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain("from another project");
  });
});

describe("Integration: error learning — errors CLI dashboard", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-dashboard-test-"));
    dbPath = join(tmpDir, "memory.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("errors dashboard shows summary, patterns, and recent errors", () => {
    const db = makeErrorDb(dbPath);

    // Insert various errors
    insertError(db, {
      id: "e1",
      sessionKey: "proj-a",
      errorType: "lint",
      command: "npm run lint",
      title: "lint error 1",
      confidence: 3,
    });
    insertError(db, {
      id: "e2",
      sessionKey: "proj-a",
      errorType: "lint",
      command: "npm run lint",
      title: "lint error 2",
      confidence: 2,
    });
    insertError(db, {
      id: "e3",
      sessionKey: "proj-b",
      errorType: "build",
      command: "npm run build",
      title: "build error 1",
      confidence: 4,
      resolved: true,
      fixApplied: "Fixed missing import",
    });
    db.close();

    const output = runCli(`errors`, { TDAI_DB_PATH: dbPath });

    expect(output).toContain("Error Learning Dashboard");
    expect(output).toContain("Total errors captured: 3");
    expect(output).toContain("Resolved: 1");
    expect(output).toContain("lint");
    expect(output).toContain("build");
    expect(output).toContain("Proven fixes");
    expect(output).toContain("Fixed missing import");
  });

  it("errors dashboard handles empty database gracefully", () => {
    makeErrorDb(dbPath);

    const output = runCli(`errors`, { TDAI_DB_PATH: dbPath });

    expect(output).toContain("Error Learning Dashboard");
    expect(output).toContain("Total errors captured: 0");
    expect(output).toContain("0.0% resolution rate");
  });

  it("errors dashboard shows cross-project patterns", () => {
    const db = makeErrorDb(dbPath);

    // Same command failing in 2 different projects
    insertError(db, {
      id: "e1",
      sessionKey: "proj-a",
      errorType: "build",
      command: "npm run build",
      title: "build error in project A",
      confidence: 2,
    });
    insertError(db, {
      id: "e2",
      sessionKey: "proj-b",
      errorType: "build",
      command: "npm run build",
      title: "build error in project B",
      confidence: 2,
    });
    db.close();

    const output = runCli(`errors`, { TDAI_DB_PATH: dbPath });

    expect(output).toContain("Recurring error patterns");
    expect(output).toContain("npm run build");
    expect(output).toContain("2 projects");
  });
});

describe("Integration: error learning — cross-project pattern detection", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-xproject-test-"));
    dbPath = join(tmpDir, "memory.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("PostToolUse alerts when same error type occurs in 2+ other projects", () => {
    const db = makeErrorDb(dbPath);

    // Insert errors from 2 other projects
    insertError(db, {
      id: "e1",
      sessionKey: "proj-a-hash",
      errorType: "lint",
      command: "npm run lint",
      title: "lint error in proj A",
      confidence: 2,
    });
    insertError(db, {
      id: "e2",
      sessionKey: "proj-b-hash",
      errorType: "lint",
      command: "npm run lint",
      title: "lint error in proj B",
      confidence: 2,
    });
    db.close();

    // Now trigger a lint error in the current project
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm run lint" },
      tool_response: {
        stdout: "",
        stderr: "src/foo.ts: line 1, Error - unused variable eslint",
        exit_code: 1,
      },
    });

    const output = runHook("hook-post-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput).toBeDefined();
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("CROSS-PROJECT PATTERN");
    expect(ctx).toContain("lint");
  });
});
