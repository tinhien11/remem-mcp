import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Create a test DB with the FULL schema (including sqlite-vec, FTS5, etc.). */
function makeFullErrorDb(dbPath: string): any {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);
  const schema = require("node:fs").readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "storage", "schema.sql"),
    "utf-8",
  );
  db.exec(schema);
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

// =====================================================================
// COMPLICATED TEST CASES — verify the agent gets SMART from mistakes
// =====================================================================

describe("Integration: error learning — agent gets smart from mistakes", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-smart-"));
    dbPath = join(tmpDir, "memory.db");
    // Create a file that errors can reference (passes stale check)
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "index.ts"), "console.log(1);");
    writeFileSync(join(tmpDir, "src", "utils.ts"), "export const x = 1;");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: run PostToolUse with a command + stderr + exit code. */
  function postToolUse(command: string, stderr: string, stdout = "", exitCode = 1): string {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd: tmpDir,
      tool_response: { stdout, stderr, exit_code: exitCode },
    });
    return runHook("hook-post-tool-use", stdin, { TDAI_DB_PATH: dbPath });
  }

  /** Helper: run PreToolUse before a command. */
  function preToolUse(command: string, env: Record<string, string> = {}): string {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd: tmpDir,
    });
    return runHook("hook-pre-tool-use", stdin, { TDAI_DB_PATH: dbPath, ...env });
  }

  /** Helper: get all error captures from DB. */
  function getErrors(): any[] {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT * FROM captures WHERE type = 'error' AND deleted_at IS NULL ORDER BY created_at")
      .all();
    db.close();
    return rows;
  }

  /** Helper: get ALL error captures including deleted ones. */
  function getAllErrors(): any[] {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT * FROM captures WHERE type = 'error' ORDER BY created_at")
      .all();
    db.close();
    return rows;
  }

  // ------------------------------------------------------------------
  // Test 1: Error recurrence chain — same error 3x → downvoted → pruned
  // ------------------------------------------------------------------
  it("SMART: same error recurring 3x gets downvoted to 0 and pruned", () => {
    makeFullErrorDb(dbPath);

    // First failure: captures with confidence=2
    const stderr1 = "src/index.ts: line 1, Error - unused variable eslint";
    postToolUse("npm run lint", stderr1);

    let errors = getErrors();
    expect(errors.length).toBe(1);
    let meta1 = JSON.parse(errors[0].metadata);
    expect(meta1.confidence).toBe(2);

    // Second failure (same command + same stderr within 1 hour = same content_hash = downvote)
    postToolUse("npm run lint", stderr1);

    errors = getErrors();
    // Should still be 1 error (downvoted, not duplicated)
    expect(errors.length).toBe(1);
    let meta2 = JSON.parse(errors[0].metadata);
    expect(meta2.confidence).toBe(1); // 2 - 1 = 1
    expect(meta2.downvotes).toBe(1);

    // Third failure (same again = downvote again → confidence=0 → pruned)
    postToolUse("npm run lint", stderr1);

    // Error should be pruned (deleted_at set)
    const allErrors = getAllErrors();
    expect(allErrors.length).toBe(1);
    let meta3 = JSON.parse(allErrors[0].metadata);
    expect(meta3.confidence).toBe(0);
    expect(allErrors[0].deleted_at).not.toBeNull(); // Pruned!

    // Active errors should be 0 (pruned)
    const activeErrors = getErrors();
    expect(activeErrors.length).toBe(0);
  });

  // ------------------------------------------------------------------
  // Test 2: Different errors on same command → both captured separately
  // ------------------------------------------------------------------
  it("SMART: different errors on same command are captured separately", () => {
    makeFullErrorDb(dbPath);

    // First failure: lint error about unused variable
    postToolUse("npm run lint", "src/index.ts: line 1, Error - unused variable eslint");

    // Second failure: DIFFERENT lint error (different stderr = different content_hash)
    postToolUse("npm run lint", "src/utils.ts: line 5, Error - missing semicolon eslint");

    // Should have 2 separate errors (different content_hash)
    const errors = getErrors();
    expect(errors.length).toBe(2);

    const meta1 = JSON.parse(errors[0].metadata);
    const meta2 = JSON.parse(errors[1].metadata);
    // Both should have confidence=2 (no downvoting — they're different errors)
    expect(meta1.confidence).toBe(2);
    expect(meta2.confidence).toBe(2);
  });

  // ------------------------------------------------------------------
  // Test 3: 30-day window boundary — 31-day-old error NOT injected
  // ------------------------------------------------------------------
  it("SMART: errors older than 30 days are NOT injected", () => {
    const Database = require("better-sqlite3");
    const sqliteVec = require("sqlite-vec");
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec(
      require("node:fs").readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "storage", "schema.sql"),
        "utf-8",
      ),
    );

    const { createHash } = require("node:crypto");
    const hashPath = (p: string) => createHash("sha256").update(p).digest("hex").slice(0, 16);
    const realSessionKey = hashPath(tmpDir);

    // Insert an error 31 days old
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const meta = {
      command: "npm run lint",
      error_type: "lint",
      title: "old error beyond 30-day window",
      confidence: 5,
      resolved: false,
      anti_pattern: "old error",
      correct_approach: "fix it",
    };
    const content = "Command failed: npm run lint\nError: src/index.ts old lint error";
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    db.prepare(
      "INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("old-err", realSessionKey, "auto", "error", content, hash, "[]", oldDate, JSON.stringify(meta));
    db.close();

    // PreToolUse should NOT inject (31 days > 30-day window)
    const output = preToolUse("npm run lint");
    const parsed = JSON.parse(output);

    // Should be empty — error is beyond 30-day window
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // Test 4: Top-k selection — 5 errors, only top 2 by decayed conf injected
  // ------------------------------------------------------------------
  it("SMART: only top 2 errors by decayed confidence are injected (k=2)", () => {
    const Database = require("better-sqlite3");
    const sqliteVec = require("sqlite-vec");
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec(
      require("node:fs").readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "storage", "schema.sql"),
        "utf-8",
      ),
    );

    const { createHash } = require("node:crypto");
    const hashPath = (p: string) => createHash("sha256").update(p).digest("hex").slice(0, 16);
    const realSessionKey = hashPath(tmpDir);

    // Insert 5 errors with different confidence and age
    const insertErr = (id: string, confidence: number, daysAgo: number) => {
      const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
      const meta = {
        command: "npm run lint",
        error_type: "lint",
        title: id,
        confidence,
        resolved: false,
        anti_pattern: "error",
        correct_approach: "fix",
      };
      const content = `Command failed: npm run lint\nError: src/index.ts ${id}`;
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
      db.prepare(
        "INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, realSessionKey, "auto", "error", content, hash, "[]", date, JSON.stringify(meta));
    };

    // 5 errors with varying confidence and age
    insertErr("err-a", 5, 20); // decayed: 5 * 0.95^20 ≈ 1.79
    insertErr("err-b", 4, 15); // decayed: 4 * 0.95^15 ≈ 1.84
    insertErr("err-c", 3, 5); // decayed: 3 * 0.95^5 ≈ 2.31
    insertErr("err-d", 2, 1); // decayed: 2 * 0.95^1 ≈ 1.90
    insertErr("err-e", 4, 0); // decayed: 4 * 0.95^0 = 4.00
    db.close();

    // Expected ranking by decayed confidence:
    // 1. err-e (4.00)
    // 2. err-c (2.31)
    // 3. err-d (1.90)
    // 4. err-b (1.84)
    // 5. err-a (1.79)
    // Only top 2 should be injected

    const output = preToolUse("npm run lint");
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    // err-e and err-c should be present (top 2)
    expect(ctx).toContain("err-e");
    expect(ctx).toContain("err-c");

    // err-a, err-b, err-d should NOT be present (ranked 3-5)
    expect(ctx).not.toContain("err-a");
    expect(ctx).not.toContain("err-b");
    expect(ctx).not.toContain("err-d");
  });

  // ------------------------------------------------------------------
  // Test 5: Noise command filtering — ls /nonexistent NOT captured
  // ------------------------------------------------------------------
  it("SMART: noise commands are NOT captured (ls /nonexistent, echo test)", () => {
    makeFullErrorDb(dbPath);

    // Noise commands that should NOT be captured
    postToolUse("ls /nonexistent_file_xyz", "No such file or directory");
    postToolUse("echo test", "", "", 0); // successful, no error anyway
    postToolUse("cat /tmp/nonexistent_xyz_123", "No such file or directory");

    // Should have 0 errors captured (all filtered as noise)
    const errors = getErrors();
    expect(errors.length).toBe(0);
  });

  // ------------------------------------------------------------------
  // Test 6: Multi-step bug fix chain — agent learns from 3 mistakes
  // ------------------------------------------------------------------
  it("SMART: multi-step bug fix chain — 3 errors, 3 fixes, agent learns pattern", () => {
    makeFullErrorDb(dbPath);

    // === Session 1: Agent hits lint error, fixes it ===
    // Step 1: Lint fails with unused variable
    postToolUse("npm run lint", "src/index.ts: line 1, Error - unused variable 'foo' eslint");
    expect(getErrors().length).toBe(1);

    // Step 2: Agent fixes it, lint passes
    postToolUse("npm run lint", "", "All checks passed.", 0);

    // Verify: error resolved, fix recorded
    const errorsAfterFix1 = getErrors();
    const meta1 = JSON.parse(errorsAfterFix1[0].metadata);
    expect(meta1.resolved).toBe(true);
    expect(meta1.confidence).toBe(3); // upvoted
    expect(meta1.fix_applied).toContain("All checks passed");

    // === Session 2: Agent hits build error, fixes it ===
    // Step 3: Build fails with missing module
    postToolUse("npm run build", "Error: Cannot find module './missing.js' build failed");
    expect(getErrors().length).toBe(2); // lint error + build error

    // Step 4: Agent fixes it, build passes
    postToolUse("npm run build", "", "Build successful.", 0);

    // Verify: build error resolved
    const errorsAfterFix2 = getErrors();
    const buildError = errorsAfterFix2.find((e) => {
      const m = JSON.parse(e.metadata);
      return m.error_type === "build";
    });
    expect(buildError).toBeDefined();
    const buildMeta = JSON.parse(buildError.metadata);
    expect(buildMeta.resolved).toBe(true);
    expect(buildMeta.fix_applied).toContain("Build successful");

    // === Session 3: Agent runs build again — should get BOTH proven fixes ===
    // Step 5: PreToolUse before build — should inject proven fixes
    const preBuildOut = preToolUse("npm run build");
    const preBuildParsed = JSON.parse(preBuildOut);
    const buildCtx = preBuildParsed.hookSpecificOutput?.additionalContext ?? "";

    // Should contain proven fixes from both resolved errors
    expect(buildCtx).toContain("Proven fixes");
    // Both fixes should be mentioned
    expect(buildCtx).toContain("All checks passed");
    expect(buildCtx).toContain("Build successful");

    // === Verify the agent has LEARNED ===
    // The errors dashboard should show 2 resolved errors with 100% resolution rate
    const dashOut = runCli("errors", { TDAI_DB_PATH: dbPath });
    expect(dashOut).toContain("Total errors captured: 2");
    expect(dashOut).toContain("Resolved: 2");
    expect(dashOut).toContain("100.0% resolution rate");
    expect(dashOut).toContain("Proven fixes");
  });

  // ------------------------------------------------------------------
  // Test 7: Resolved error that recurs — should be re-captured
  // ------------------------------------------------------------------
  it("SMART: resolved error that recurs after 1 hour is re-captured (not silently ignored)", () => {
    makeFullErrorDb(dbPath);

    // Step 1: Lint fails
    postToolUse("npm run lint", "src/index.ts: line 1, Error - unused variable eslint");
    expect(getErrors().length).toBe(1);

    // Step 2: Lint passes (error resolved)
    postToolUse("npm run lint", "", "All checks passed.", 0);
    const resolved = getErrors();
    expect(JSON.parse(resolved[0].metadata).resolved).toBe(true);

    // Step 3: Same lint error occurs again after > 1 hour
    // We need to simulate time passing — update the created_at to be > 1 hour ago
    const Database2 = require("better-sqlite3");
    const db2 = new Database2(dbPath);
    const oneHourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    db2.prepare("UPDATE captures SET created_at = ? WHERE type = 'error'").run(oneHourAgo);
    db2.close();

    // Now the same error recurs — content_hash is the same, but it's > 1 hour old
    // So the dedup check (created_at > datetime('now', '-1 hour')) should NOT find it
    // and a NEW error should be captured
    postToolUse("npm run lint", "src/index.ts: line 1, Error - unused variable eslint");

    // Should now have 2 errors: the old resolved one + the new one
    const errors = getErrors();
    expect(errors.length).toBe(2);

    // The new error should be unresolved
    const newError = errors.find((e) => {
      const m = JSON.parse(e.metadata);
      return !m.resolved;
    });
    expect(newError).toBeDefined();
    expect(JSON.parse(newError.metadata).confidence).toBe(2);
  });

  // ------------------------------------------------------------------
  // Test 8: Stale error pruning — error references deleted file
  // ------------------------------------------------------------------
  it("SMART: errors referencing deleted files are filtered out in PreToolUse", () => {
    const Database = require("better-sqlite3");
    const sqliteVec = require("sqlite-vec");
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec(
      require("node:fs").readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "storage", "schema.sql"),
        "utf-8",
      ),
    );

    const { createHash } = require("node:crypto");
    const hashPath = (p: string) => createHash("sha256").update(p).digest("hex").slice(0, 16);
    const realSessionKey = hashPath(tmpDir);

    // Insert an error that references a file that DOES NOT exist
    const meta = {
      command: "npm run lint",
      error_type: "lint",
      title: "stale error referencing deleted file",
      confidence: 5,
      resolved: false,
      anti_pattern: "error in deleted file",
      correct_approach: "fix it",
    };
    const content = "Command failed: npm run lint\nError: src/deleted_file.ts: line 1, Error - something";
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    db.prepare(
      "INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("stale-err", realSessionKey, "auto", "error", content, hash, "[]", new Date().toISOString(), JSON.stringify(meta));
    db.close();

    // src/deleted_file.ts does NOT exist in tmpDir → stale → should be filtered
    const output = preToolUse("npm run lint");
    const parsed = JSON.parse(output);

    // Should be empty — the only error is stale (file doesn't exist)
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });
});
