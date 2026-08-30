import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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

/** hash(cwd) — same derivation used by hooks and the MCP server. */
function hashPath(p: string): string {
  return createHash("sha256").update(p).digest("hex").slice(0, 16);
}

interface ScenarioSeed {
  id: string;
  summary: string;
  sessionKey: string | null;
}

/**
 * Create a minimal DB with a captures table (so hook-recall doesn't bail early)
 * plus a scenarios table matching the canonical schema, and seed scenarios.
 * A capture is seeded for every distinct non-null scenario session_key so that
 * hook-recall reaches the scenarios injection block for each project.
 */
function makeDbWithScenarios(dbPath: string, scenarios: ScenarioSeed[]): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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
      created_at INTEGER NOT NULL,
      metadata TEXT,
      deleted_at TEXT,
      trust_state TEXT
    );
    CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY,
      atom_ids TEXT NOT NULL,
      summary TEXT,
      persona_tags TEXT,
      created_at INTEGER NOT NULL,
      team_id TEXT,
      agent_id TEXT,
      user_id TEXT,
      session_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scenarios_session ON scenarios(session_key, created_at DESC);
    INSERT INTO schema_version VALUES (14, ${Date.now()});
  `);

  // Seed one capture per distinct non-null scenario session_key so hook-recall
  // produces a non-empty additionalContext (otherwise it returns {} before
  // reaching the scenarios block).
  const capStmt = db.prepare(
    "INSERT INTO captures (id, session_key, agent_id, type, content, tags, created_at, metadata, trust_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate')",
  );
  const seeded = new Set<string>();
  let capIdx = 0;
  for (const s of scenarios) {
    if (s.sessionKey && !seeded.has(s.sessionKey)) {
      seeded.add(s.sessionKey);
      capStmt.run(
        `cap-${capIdx++}`,
        s.sessionKey,
        "test-agent",
        "decision",
        `Seed decision for session ${s.sessionKey}`,
        "[]",
        Date.now(),
        null,
      );
    }
  }

  const stmt = db.prepare(
    "INSERT INTO scenarios (id, atom_ids, summary, persona_tags, created_at, team_id, agent_id, user_id, session_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const s of scenarios) {
    stmt.run(s.id, "[]", s.summary, null, Date.now(), null, null, null, s.sessionKey);
  }
  db.close();
}

describe("Integration: scenario session_key scoping (L2 leak fix)", () => {
  let tmpDir: string;
  let dbPath: string;
  let projectA: string;
  let projectB: string;
  let keyA: string;
  let keyB: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-scenario-scope-"));
    dbPath = join(tmpDir, "memory.db");
    projectA = join(tmpDir, "project-a");
    projectB = join(tmpDir, "project-b");
    keyA = hashPath(projectA);
    keyB = hashPath(projectB);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does NOT inject a scenario from session_key A into a hook run with session_key B", () => {
    // Seed a projectB scenario too, so projectB gets a capture and hook-recall
    // reaches the scenarios injection block — proving the filter excludes A's
    // scenario rather than just early-returning on empty captures.
    makeDbWithScenarios(dbPath, [
      { id: "scn-a", summary: "Project A scenario summary", sessionKey: keyA },
      { id: "scn-b", summary: "Project B scenario summary", sessionKey: keyB },
    ]);

    const stdin = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-b",
      cwd: projectB,
    });

    const output = runHook("hook-recall", stdin, { REMEM_DB_PATH: dbPath });
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    expect(ctx).toContain("Project B scenario summary");
    expect(ctx).not.toContain("Project A scenario summary");
  });

  it("injects a scenario from session_key A into a hook run with session_key A (SessionStart)", () => {
    makeDbWithScenarios(dbPath, [
      { id: "scn-a", summary: "Project A scenario summary", sessionKey: keyA },
    ]);

    const stdin = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-a",
      cwd: projectA,
    });

    const output = runHook("hook-recall", stdin, { REMEM_DB_PATH: dbPath });
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    expect(ctx).toContain("Scenarios (L2)");
    expect(ctx).toContain("Project A scenario summary");
  });

  it("injects a scenario from session_key A into a hook run with session_key A (UserPromptSubmit)", () => {
    makeDbWithScenarios(dbPath, [
      { id: "scn-a", summary: "Project A scenario summary", sessionKey: keyA },
    ]);

    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-a",
      cwd: projectA,
      prompt: "tell me about project a",
    });

    const output = runHook("hook-user-prompt", stdin, { REMEM_DB_PATH: dbPath });
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    expect(ctx).toContain("Project A scenario summary");
  });

  it("never injects a legacy NULL-session_key scenario (any project)", () => {
    makeDbWithScenarios(dbPath, [
      { id: "scn-legacy", summary: "Legacy NULL scenario summary", sessionKey: null },
      { id: "scn-a", summary: "Project A scenario summary", sessionKey: keyA },
      { id: "scn-b", summary: "Project B scenario summary", sessionKey: keyB },
    ]);

    // Run for project A — the legacy scenario must NOT appear, only the scoped one.
    const stdinA = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-a",
      cwd: projectA,
    });
    const outA = runHook("hook-recall", stdinA, { REMEM_DB_PATH: dbPath });
    const ctxA = JSON.parse(outA).hookSpecificOutput?.additionalContext ?? "";
    expect(ctxA).not.toContain("Legacy NULL scenario summary");
    expect(ctxA).toContain("Project A scenario summary");

    // Run for project B — neither the legacy nor project A's scenario appears.
    const stdinB = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-b",
      cwd: projectB,
    });
    const outB = runHook("hook-recall", stdinB, { REMEM_DB_PATH: dbPath });
    const ctxB = JSON.parse(outB).hookSpecificOutput?.additionalContext ?? "";
    expect(ctxB).not.toContain("Legacy NULL scenario summary");
    expect(ctxB).not.toContain("Project A scenario summary");
    expect(ctxB).toContain("Project B scenario summary");
  });
});
