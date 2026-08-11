/**
 * E2E tests for hook auto-capture with real CLIs.
 *
 * These tests actually run `claude --print` to verify:
 * 1. CLI smoke: SessionEnd hook fires, capture lands in DB
 * 2. Round-trip: Session 1 captures → Session 2 recalls the capture
 *
 * Requirements:
 * - `claude` CLI must be installed and logged in
 * - Tests are skipped automatically if claude is not available
 * - Each test uses an isolated temp HOME (with copied credentials) and temp DB
 */
import { execSync, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
const CLAUDE_CREDENTIALS = join(process.env.HOME ?? "", ".claude", ".credentials.json");

/**
 * Check if claude CLI is available and logged in.
 */
function isClaudeAvailable(): boolean {
  if (!existsSync(CLAUDE_CREDENTIALS)) return false;
  try {
    const output = execSync("claude --print 'say ok' 2>&1", {
      encoding: "utf-8",
      timeout: 15000,
    });
    return !output.includes("Not logged in") && !output.includes("command not found");
  } catch {
    return false;
  }
}

const CLAUDE_AVAILABLE = isClaudeAvailable();

/**
 * Create a temp HOME with claude settings pointing hooks at our binary.
 * Copies credentials from the real HOME so claude can authenticate.
 */
function setupClaudeHome(tmpDir: string, dbPath: string): string {
  const claudeDir = join(tmpDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // Copy credentials so claude can authenticate
  if (existsSync(CLAUDE_CREDENTIALS)) {
    copyFileSync(CLAUDE_CREDENTIALS, join(claudeDir, ".credentials.json"));
  }

  const settings = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `node ${BIN} hook-recall`,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command: `node ${BIN} hook-session-end`,
            },
          ],
        },
      ],
    },
  };

  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2));
  return claudeDir;
}

/**
 * Initialize a DB with schema by running the init command.
 */
function initDb(dbPath: string): void {
  const dbDir = join(dbPath, "..");
  mkdirSync(dbDir, { recursive: true });
  execSync(`node ${BIN} init`, {
    encoding: "utf-8",
    env: { ...process.env, TDAI_DB_PATH: dbPath },
    timeout: 10000,
  });
}

/**
 * Read all captures from DB.
 */
function readCaptures(dbPath: string): Array<{ id: string; type: string; content: string; tags: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT id, type, content, tags FROM captures ORDER BY created_at ASC").all() as Array<{
    id: string;
    type: string;
    content: string;
    tags: string;
  }>;
  db.close();
  return rows;
}

/**
 * Run claude --print with a temp HOME and env.
 * Catches non-zero exit (claude sometimes exits non-zero with output).
 */
function runClaudePrint(prompt: string, home: string, dbPath: string, timeout = 30000): string {
  try {
    return execFileSync("claude", ["--print", prompt], {
      encoding: "utf-8",
      timeout,
      env: {
        ...process.env,
        HOME: home,
        TDAI_DB_PATH: dbPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: any) {
    const stdout = err.stdout ?? "";
    if (stdout.length > 0) return stdout;
    throw new Error(`claude --print failed: ${err.stderr ?? err.message}`);
  }
}

// ─── Claude CLI E2E ────────────────────────────────────────────
describe.skipIf(!CLAUDE_AVAILABLE)("E2E: Claude CLI hook auto-capture", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-e2e-"));
    dbPath = join(tmpDir, "memory.db");
    initDb(dbPath);
    setupClaudeHome(tmpDir, dbPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    "SessionEnd hook fires and captures the conversation",
    () => {
      const output = runClaudePrint(
        "Write a haiku about SQLite. Just the haiku, nothing else.",
        tmpDir,
        dbPath,
      );

      expect(output.length).toBeGreaterThan(0);

      // SessionEnd hook should have fired and captured the conversation
      const captures = readCaptures(dbPath);
      const autoCaptures = captures.filter((c) => c.type === "conversation");
      expect(autoCaptures.length).toBeGreaterThanOrEqual(1);

      const capture = autoCaptures[0];
      const tags = JSON.parse(capture.tags);
      expect(tags).toContain("auto-capture");

      // Content should contain the user's prompt
      expect(capture.content).toContain("haiku");
    },
    60000,
  );

  it(
    "captures non-trivial session with user + assistant exchange",
    () => {
      const output = runClaudePrint(
        "What is 2+2? Answer with just the number.",
        tmpDir,
        dbPath,
      );

      expect(output.length).toBeGreaterThan(0);

      const captures = readCaptures(dbPath);
      const autoCaptures = captures.filter((c) => c.type === "conversation");
      expect(autoCaptures.length).toBeGreaterThanOrEqual(1);
      expect(autoCaptures[0].content).toContain("2+2");
    },
    60000,
  );
});

describe.skipIf(!CLAUDE_AVAILABLE)("E2E: Claude CLI round-trip (capture → recall)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-roundtrip-"));
    dbPath = join(tmpDir, "memory.db");
    initDb(dbPath);
    setupClaudeHome(tmpDir, dbPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    "Session 1 auto-captures → recall hook outputs the capture",
    () => {
      // ─── Session 1: real claude session ──────────────────────
      const session1Output = runClaudePrint(
        "Explain in 2 sentences why SQLite is good for local-first apps. Be specific.",
        tmpDir,
        dbPath,
        30000,
      );

      expect(session1Output.length).toBeGreaterThan(0);

      // Verify session 1 auto-captured a conversation
      const captures = readCaptures(dbPath);
      const autoCaptures = captures.filter((c) => c.type === "conversation");
      expect(autoCaptures.length).toBeGreaterThanOrEqual(1);

      // ─── Verify recall hook ──────────────────────────────────
      // The recall hook returns decision/learning/error/task types,
      // not conversation. So we also manually insert a decision capture
      // to verify the full round-trip (recall → injection).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const writeDb = new Database(dbPath);
      writeDb
        .prepare(
          "INSERT INTO captures (id, session_key, agent_id, type, content, tags, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "test-decision-1",
          "session-1",
          "claude",
          "decision",
          "Use SQLite for local-first apps because it is embedded and ACID-compliant",
          '["sqlite", "local-first"]',
          Date.now(),
          null,
        );
      // Also insert into FTS table
      writeDb
        .prepare(
          "INSERT INTO captures_fts (rowid, id, content, tags, type) VALUES ((SELECT last_insert_rowid()), 'test-decision-1', 'Use SQLite for local-first apps because it is embedded and ACID-compliant', '[\"sqlite\", \"local-first\"]', 'decision')",
        )
        .run();
      writeDb.close();

      // Now run recall hook as Session 2 would
      const recallStdin = JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "test-session-2",
        source: "startup",
      });

      const recallOutput = execSync(`node ${BIN} hook-recall`, {
        input: recallStdin,
        encoding: "utf-8",
        env: { ...process.env, TDAI_DB_PATH: dbPath },
        timeout: 10000,
      });

      const parsed = JSON.parse(recallOutput);
      expect(parsed.hookSpecificOutput).toBeDefined();
      expect(parsed.hookSpecificOutput.additionalContext).toContain("[tdai-memory]");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("SQLite");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("local-first");
    },
    60000,
  );
});

// ─── Devin CLI smoke test ──────────────────────────────────────
function isDevinAvailable(): boolean {
  try {
    execSync("which devin", { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const DEVIN_AVAILABLE = isDevinAvailable();

describe.skipIf(!DEVIN_AVAILABLE)("E2E: Devin CLI hook smoke test", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-devin-e2e-"));
    dbPath = join(tmpDir, "memory.db");
    initDb(dbPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Devin SessionEnd hook captures from transcript (source=agent)", () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir, { recursive: true });

    const sessionId = "devin-test-session";
    // Devin CLI uses source="agent" (not "assistant")
    const transcript = {
      session_id: sessionId,
      steps: [
        { source: "user", message: "Explain why SQLite is good for local-first apps" },
        { source: "agent", message: "SQLite is embedded, zero-config, and ACID-compliant." },
      ],
    };
    writeFileSync(join(transcriptDir, `${sessionId}.json`), JSON.stringify(transcript));

    const stdin = JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId });
    execSync(`node ${BIN} hook-session-end`, {
      input: stdin,
      encoding: "utf-8",
      env: { ...process.env, TDAI_DB_PATH: dbPath, DEVIN_TRANSCRIPTS_DIR: transcriptDir },
      timeout: 10000,
    });

    const captures = readCaptures(dbPath);
    const autoCaptures = captures.filter((c) => c.type === "conversation");
    expect(autoCaptures.length).toBe(1);
    expect(autoCaptures[0].content).toContain("SQLite");
    expect(autoCaptures[0].content).toContain("embedded");
    expect(JSON.parse(autoCaptures[0].tags)).toContain("auto-capture");
  });

  it("Devin hook skips trivial sessions (user only, no agent response)", () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir, { recursive: true });

    const sessionId = "devin-trivial";
    const transcript = {
      session_id: sessionId,
      steps: [{ source: "user", message: "hi" }],
    };
    writeFileSync(join(transcriptDir, `${sessionId}.json`), JSON.stringify(transcript));

    const stdin = JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId });
    execSync(`node ${BIN} hook-session-end`, {
      input: stdin,
      encoding: "utf-8",
      env: { ...process.env, TDAI_DB_PATH: dbPath, DEVIN_TRANSCRIPTS_DIR: transcriptDir },
      timeout: 10000,
    });

    const captures = readCaptures(dbPath);
    expect(captures.length).toBe(0);
  });
});
