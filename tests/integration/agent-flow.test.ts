/**
 * Agent-flow integration tests — simulates a real user workflow.
 *
 * These tests prove remem-mcp works end-to-end as a user would experience:
 * 1. Fresh install → empty DB
 * 2. Agent captures an error fix in session 1
 * 3. Session 2 recalls the fix before making the same mistake
 * 4. CodeGraph indexes a repo, agent finds symbols + callers
 * 5. Feedback flywheel: helpful memory rises, wrong memory fades
 * 6. Cross-project: global memory shared across projects
 * 7. L0→L1→L2 pipeline: raw capture → atoms → scenario consolidation
 * 8. Persona: repeated tags auto-detected as user preference
 *
 * Uses the Memory SDK (same code path as MCP server, no CLI needed).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Memory } from "../../src/sdk.js";
import { indexDirectory, searchSymbols, findCallers, findCallees } from "../../src/codegraph/engine.js";

function makeDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec(readFileSync(join(process.cwd(), "src/storage/schema.sql"), "utf-8"));
  return db;
}

describe("agent-flow: user workflow integration", () => {
  let tmpDir: string;
  let dbPath: string;
  let mem: Memory;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-agent-flow-"));
    dbPath = join(tmpDir, "memory.db");
    mem = new Memory({ dbPath, globalSessionKey: "global" });
  });

  afterEach(() => {
    mem.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Scenario 1: Error learning loop ──────────────────────────
  // User hits a build error, agent captures the fix.
  // Next session, recall injects the fix before the agent retries.
  it("S1: error learning loop — capture fix → recall prevents repeat", async () => {
    // Session 1: agent encounters error and captures the fix
    const errorId = await mem.capture(
      "Build error: 'cannot find module ./utils' — root cause was import path used ./Utils (capital U) on Linux. Fix: use case-sensitive import path ./utils.",
      "error",
      ["build", "linux", "import"],
    );
    expect(errorId).toBeTruthy();

    // Session 2: agent starts new session, recalls before answering
    const results = await mem.recall("build error cannot find module utils", { limit: 5 });

    expect(results.length).toBeGreaterThanOrEqual(1);
    const match = results.find((r) => r.entry.id === errorId);
    expect(match).toBeDefined();
    expect(match!.entry.content).toContain("case-sensitive");
    expect(match!.entry.content).toContain("./utils");

    // Agent avoids the same mistake — proof: the fix is in context
    const topResult = results[0];
    expect(topResult.entry.type).toBe("error");
    expect(topResult.entry.tags).toContain("build");
  });

  // ─── Scenario 2: Decision persistence across sessions ─────────
  it("S2: decision persists — session 2 recalls architecture choice", async () => {
    // Session 1: user decides on a tech stack
    await mem.capture(
      "Chose SQLite over Postgres for the MVP. Reason: zero-setup, embedded, FTS5 + sqlite-vec built in. No server needed for a single-user CLI tool.",
      "decision",
      ["arch", "database", "sqlite"],
    );

    // Session 2: new session, agent recalls the decision
    const results = await mem.recall("database choice for MVP", { limit: 5 });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entry.content).toContain("SQLite");
    expect(results[0].entry.content).toContain("zero-setup");
    expect(results[0].entry.type).toBe("decision");
  });

  // ─── Scenario 3: CodeGraph — index repo, find symbols + callers ──
  it("S3: CodeGraph — index mini repo, search + callers + callees", async () => {
    const repoDir = join(tmpDir, "mini-repo");
    mkdirSync(repoDir, { recursive: true });

    writeFileSync(
      join(repoDir, "auth.ts"),
      `export function login(user: string, pass: string): boolean {
  const ok = validate(user, pass);
  if (ok) { setSession(user); }
  return ok;
}
export function validate(user: string, pass: string): boolean {
  return user.length > 0 && pass.length > 8;
}
export function setSession(user: string): void {
  console.log("session set for", user);
}
`,
    );

    writeFileSync(
      join(repoDir, "api.ts"),
      `import { login } from "./auth";
export function handleLogin(req: any): { status: number } {
  const ok = login(req.user, req.pass);
  return ok ? { status: 200 } : { status: 401 };
}
export function logout(): void {
  console.log("logged out");
}
`,
    );

    const db = makeDb(dbPath);

    const results = await indexDirectory(db, repoDir, repoDir, null);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const totalSymbols = results.reduce((sum, r) => sum + r.symbols, 0);
    expect(totalSymbols).toBeGreaterThanOrEqual(4);

    // Search for login
    const symbols = searchSymbols(db, "login");
    expect(symbols.length).toBeGreaterThanOrEqual(1);
    const loginSym = symbols.find((s) => s.name === "login");
    expect(loginSym).toBeDefined();
    expect(loginSym!.filePath).toContain("auth.ts");

    // Find callers of login — should be handleLogin in api.ts
    const callers = findCallers(db, loginSym!.id);
    expect(callers.length).toBeGreaterThanOrEqual(1);
    const handleLogin = callers.find((c) => c.caller.name === "handleLogin");
    expect(handleLogin).toBeDefined();
    expect(handleLogin!.caller.filePath).toContain("api.ts");

    // Find callees of login — should include validate + setSession
    const callees = findCallees(db, loginSym!.id);
    const calleeNames = callees.map((c) => c.calleeName);
    expect(calleeNames).toContain("validate");
    expect(calleeNames).toContain("setSession");

    db.close();
  });

  // ─── Scenario 4: Feedback flywheel ────────────────────────────
  it("S4: feedback — helpful memory rises, wrong memory fades", async () => {
    const goodId = await mem.capture(
      "Use pnpm instead of npm for monorepo. pnpm hoists correctly and saves disk space.",
      "decision",
      ["tooling", "pnpm"],
    );
    const badId = await mem.capture(
      "Use npm for monorepo. npm workspaces are sufficient.",
      "decision",
      ["tooling", "npm"],
    );

    // Agent uses the good one → feedback helpful
    await mem.feedback(goodId!, "helpful", "correct, pnpm saved us");
    // Agent discovers the bad one is wrong → feedback wrong
    await mem.feedback(badId!, "wrong", "npm workspaces broke hoisting");

    // Search: good should rank higher than bad
    const results = await mem.search("monorepo package manager", {
      mode: "hybrid",
      limit: 10,
      explain: true,
    });

    const good = results.find((r) => r.entry.id === goodId);
    const bad = results.find((r) => r.entry.id === badId);

    expect(good).toBeDefined();
    expect(bad).toBeDefined();
    expect(good!.scoreDetails!.feedback_salience).toBeGreaterThan(
      bad!.scoreDetails!.feedback_salience,
    );
    expect(good!.scoreDetails!.feedback_salience).toBe(1.1);
    expect(bad!.scoreDetails!.feedback_salience).toBeCloseTo(0.1, 5);
  });

  // ─── Scenario 5: Cross-project global memory ──────────────────
  it("S5: cross-project — global memory visible from project session", async () => {
    // Capture a generic rule to global session (sessionKey = global)
    await mem.capture(
      "Always use case-sensitive imports on Linux. Linux filesystem is case-sensitive.",
      "learning",
      ["linux", "import"],
      { sessionKey: "global" },
    );

    // Recall WITHOUT explicit sessionKey — instance uses its default sessionKey
    // (hash of cwd), and globalKey fallback searches "global" session too
    const results = await mem.recall("case-sensitive imports Linux", { limit: 10 });

    const globalMatch = results.find(
      (r) => r.entry.content.includes("case-sensitive") && r.entry.content.includes("Linux"),
    );
    expect(globalMatch).toBeDefined();
    expect(globalMatch!.entry.type).toBe("learning");
  });

  // ─── Scenario 6: Dedup — same content captured twice ──────────
  it("S6: dedup — identical capture returns null, no duplicate", async () => {
    const content = "Use vitest for testing. It's fast and supports TypeScript natively.";
    const id1 = await mem.capture(content, "decision", ["test", "vitest"]);
    const id2 = await mem.capture(content, "decision", ["test", "vitest"]);

    expect(id1).toBeTruthy();
    expect(id2).toBeNull(); // dedup by content hash
  });

  // ─── Scenario 7: Multi-type recall — filter by type ───────────
  it("S7: multi-type — capture errors + decisions, search filters correctly", async () => {
    await mem.capture("Error: ENOENT on config.json. Fix: check cwd before reading.", "error", [
      "config",
    ]);
    await mem.capture("Decided to use JSON config over YAML. Simpler ecosystem.", "decision", [
      "config",
    ]);
    await mem.capture("Pattern: always validate config schema at startup.", "pattern", [
      "config",
    ]);

    // Search returns all types
    const all = await mem.search("config", { limit: 10, mode: "keyword" });
    expect(all.length).toBeGreaterThanOrEqual(3);

    // Filter by type=error — use keyword mode to avoid global fallback splitting
    const errorsOnly = await mem.search("config", {
      filters: { type: "error" },
      limit: 10,
      mode: "keyword",
    });
    expect(errorsOnly.length).toBeGreaterThanOrEqual(1);
    expect(errorsOnly.every((r) => r.entry.type === "error")).toBe(true);

    // Filter by type=decision
    const decisionsOnly = await mem.search("config", {
      filters: { type: "decision" },
      limit: 10,
      mode: "keyword",
    });
    expect(decisionsOnly.length).toBeGreaterThanOrEqual(1);
    expect(decisionsOnly.every((r) => r.entry.type === "decision")).toBe(true);
  });

  // ─── Scenario 8: Update capture — correct stale info ──────────
  it("S8: update — correct stale port number in existing capture", async () => {
    const id = await mem.capture("Production server runs on port 3000.", "decision", [
      "config",
      "port",
    ]);
    expect(id).toBeTruthy();

    // Agent discovers the port changed
    const updated = await mem.update(id!, {
      content: "Production server runs on port 8080.",
      tags: ["config", "port", "updated"],
    });
    expect(updated).toBe(true);

    // Recall should find the updated content
    const results = await mem.recall("production server port", { limit: 5 });
    const match = results.find((r) => r.entry.id === id);
    expect(match).toBeDefined();
    expect(match!.entry.content).toContain("8080");
    expect(match!.entry.tags).toContain("updated");
  });

  // ─── Scenario 9: Consolidate duplicates ───────────────────────
  it("S9: consolidate — merge near-duplicate captures", async () => {
    // Very similar content — high Jaccard overlap
    await mem.capture("Use pnpm for monorepo because hoisting works correctly and saves disk.", "decision", ["pnpm"]);
    await mem.capture("Use pnpm for monorepo because hoisting works correctly and saves disk space.", "decision", ["pnpm"]);
    await mem.capture("Use pnpm for monorepo because hoisting works correctly and saves disk space too.", "decision", ["pnpm"]);

    const result = await mem.consolidate({ threshold: 0.5, confirm: true });
    expect(result.groups.length).toBeGreaterThanOrEqual(1);
    expect(result.merged).toBeGreaterThanOrEqual(1);
  });

  // ─── Scenario 10: Audit trail — every mutation logged ─────────
  it("S10: audit — capture + feedback logged in mutation_log", async () => {
    const id = await mem.capture("Test capture for audit.", "learning", ["audit"]);
    await mem.feedback(id!, "helpful", "good info");

    const logs = await mem.queryAudit({ limit: 20 });
    const actions = logs.map((l: any) => l.action);
    expect(actions).toContain("put");
    expect(actions).toContain("feedback");
  });
});

describe("agent-flow: CodeGraph on real project structure", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-cg-flow-"));
    dbPath = join(tmpDir, "memory.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("CG1: index Go-style repo — method calls + caller chain", async () => {
    const repoDir = join(tmpDir, "go-repo");
    mkdirSync(repoDir, { recursive: true });

    writeFileSync(
      join(repoDir, "handler.go"),
      `package main

type Service struct{}

func (s *Service) HandleRequest(req string) string {
	result := s.ProcessData(req)
	s.LogResult(result)
	return result
}

func (s *Service) ProcessData(data string) string {
	return "processed:" + data
}

func (s *Service) LogResult(result string) {
	println("result:", result)
}
`,
    );

    writeFileSync(
      join(repoDir, "main.go"),
      `package main

func main() {
	s := &Service{}
	s.HandleRequest("test")
}
`,
    );

    const db = makeDb(dbPath);

    const results = await indexDirectory(db, repoDir, repoDir, null);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const totalSymbols = results.reduce((sum, r) => sum + r.symbols, 0);
    expect(totalSymbols).toBeGreaterThanOrEqual(3);

    // Find ProcessData
    const symbols = searchSymbols(db, "ProcessData");
    expect(symbols.length).toBeGreaterThanOrEqual(1);

    // ProcessData is called by HandleRequest — verify via callers
    const callers = findCallers(db, symbols[0].id);
    expect(callers.length).toBeGreaterThanOrEqual(1);
    const handler = callers.find((c) => c.caller.name === "HandleRequest");
    expect(handler).toBeDefined();

    db.close();
  });

  it("CG2: index Python repo — function calls + imports", async () => {
    const repoDir = join(tmpDir, "py-repo");
    mkdirSync(repoDir, { recursive: true });

    writeFileSync(
      join(repoDir, "utils.py"),
      `def format_result(value):
    return f"Result: {value}"

def validate_input(data):
    if not data:
        raise ValueError("empty input")
    return True
`,
    );

    writeFileSync(
      join(repoDir, "app.py"),
      `from utils import format_result, validate_input

def process(data):
    if validate_input(data):
        return format_result(data)
    return None
`,
    );

    const db = makeDb(dbPath);

    const results = await indexDirectory(db, repoDir, repoDir, null);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const totalSymbols = results.reduce((sum, r) => sum + r.symbols, 0);
    expect(totalSymbols).toBeGreaterThanOrEqual(3);

    // Find format_result
    const symbols = searchSymbols(db, "format_result");
    expect(symbols.length).toBeGreaterThanOrEqual(1);

    // process() should call format_result
    const callers = findCallers(db, symbols[0].id);
    const processFn = callers.find((c) => c.caller.name === "process");
    expect(processFn).toBeDefined();

    db.close();
  });
});
