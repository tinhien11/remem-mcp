import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

/**
 * Hook handler for SessionStart event.
 * Reads JSON from stdin (Devin CLI hook payload), queries the memory DB
 * for recent captures, and outputs additionalContext JSON on stdout.
 *
 * This is called by the agent's hook system, not by the MCP server.
 *
 * In addition to the JSON output on stdout, the handler appends a short
 * summary to a log file so the user can inspect which memories were
 * loaded without the output interfering with the terminal prompt.
 */

/** Default log path: ~/.local/share/tdai-memory-mcp/session.log */
function defaultLogPath(): string {
  return (
    process.env.TDAI_HOOK_LOG_PATH ??
    join(homedir(), ".local", "share", "tdai-memory-mcp", "session.log")
  );
}

/** Append a timestamped line to the hook log file. */
function logToFile(text: string): void {
  try {
    const logPath = defaultLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(logPath, `[${ts}] ${text}\n`);
  } catch {
    // Logging is best-effort. Do not block the hook on log errors.
  }
}

export function hookRecall(dbPath: string): void {
  // Read stdin
  const chunks: Buffer[] = [];
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const sessionKey = input.session_id ? input.session_id.slice(0, 16) : undefined;

      // Query recent captures from the DB
      // Try immutable mode first (no WAL writes needed), fall back to readonly
      let db: Database.Database;
      try {
        db = new Database(dbPath, { readonly: true, immutable: true });
      } catch {
        db = new Database(dbPath, { readonly: true });
      }

      // Try with session_key first, then fall back to all captures
      // Prioritize errors first (ExpeL pattern: failed trajectories are most valuable)
      const errorSql = `
        SELECT id, type, content, tags, created_at
        FROM captures
        WHERE type = 'error'
      `;
      const otherSql = `
        SELECT id, type, content, tags, created_at
        FROM captures
        WHERE type IN ('decision', 'learning', 'task')
      `;

      const rows: {
        id: string;
        type: string;
        content: string;
        tags: string | null;
        created_at: number;
      }[] = [];

      // If TDAI_GLOBAL_SESSION_KEY is set, include global memory first
      const globalKey = process.env.TDAI_GLOBAL_SESSION_KEY;
      if (globalKey) {
        const globalErrors = db
          .prepare(`${errorSql} AND session_key = ? ORDER BY created_at DESC LIMIT 3`)
          .all(globalKey) as typeof rows;
        rows.push(...globalErrors);
        const globalOthers = db
          .prepare(`${otherSql} AND session_key = ? ORDER BY created_at DESC LIMIT 3`)
          .all(globalKey) as typeof rows;
        rows.push(...globalOthers);
      }

      if (sessionKey) {
        const sessionErrors = db
          .prepare(`${errorSql} AND session_key = ? ORDER BY created_at DESC LIMIT 5`)
          .all(sessionKey) as typeof rows;
        const seen = new Set(rows.map((r) => r.id));
        rows.push(...sessionErrors.filter((r) => !seen.has(r.id)));
        const sessionOthers = db
          .prepare(`${otherSql} AND session_key = ? ORDER BY created_at DESC LIMIT 5`)
          .all(sessionKey) as typeof rows;
        rows.push(...sessionOthers.filter((r) => !seen.has(r.id)));
      }

      // If no results with session_key, query all captures
      if (rows.length === 0) {
        const allErrors = db
          .prepare(`${errorSql} ORDER BY created_at DESC LIMIT 5`)
          .all() as typeof rows;
        rows.push(...allErrors);
        const allOthers = db
          .prepare(`${otherSql} ORDER BY created_at DESC LIMIT 5`)
          .all() as typeof rows;
        rows.push(...allOthers);
      }

      db.close();

      if (rows.length === 0) {
        // No memory — output empty context
        logToFile("SessionStart: no recent memory found");
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // Build context text
      const lines: string[] = ["[tdai-memory] Recent project memory:"];
      for (const row of rows) {
        const date = new Date(row.created_at).toISOString().split("T")[0];
        const tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
        const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
        // Truncate content to 200 chars for context injection
        const content = row.content.length > 200 ? `${row.content.slice(0, 200)}...` : row.content;
        lines.push(`- (${row.type}${tagStr}) ${date}: ${content}`);
      }

      lines.push("");
      lines.push("Use these memories to inform your work. Call recall() for more details.");
      lines.push(
        "After completing non-trivial work, call capture() to save a 1-3 sentence summary.",
      );

      const context = lines.join("\n");

      // Append the summary to the log file so the user can inspect it
      // without the output interfering with the terminal prompt.
      logToFile(`SessionStart: loaded ${rows.length} capture(s)\n${context}`);

      // Output hook JSON with additionalContext
      const output = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context,
        },
      };

      process.stdout.write(JSON.stringify(output));
    } catch (err) {
      // On any error, output empty JSON (don't block the session)
      process.stderr.write(`[tdai-memory hook-recall] Error: ${err}\n`);
      logToFile(`SessionStart: error - ${err}`);
      process.stdout.write(JSON.stringify({}));
    }
  });
}

/**
 * Hook handler for Stop event.
 * Reminds the agent to call handoff before stopping — but only on the first fire.
 * On subsequent fires (stop_hook_active=true), lets the agent stop silently.
 * This prevents infinite loops where the agent has nothing to hand off but keeps
 * getting reminded.
 */
export function hookStop(dbPath?: string): void {
  const chunks: Buffer[] = [];
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  process.stdin.on("end", () => {
    let input: { stop_hook_active?: boolean; session_id?: string; transcript_path?: string } = {};
    let validInput = true;
    try {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.trim()) {
        input = JSON.parse(raw);
      } else {
        validInput = false;
      }
    } catch {
      validInput = false;
    }

    // Invalid/empty stdin: let the agent stop silently.
    if (!validInput) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    // Auto-capture the transcript directly — don't rely on the agent to call handoff.
    // Claude Code provides transcript_path in stdin (available immediately).
    // Devin CLI writes transcript AFTER Stop hook fires, so we fork a
    // background process that waits for the transcript file to appear.
    if (dbPath && input.session_id) {
      const sid = input.session_id;
      const tpath = input.transcript_path ?? null;

      if (tpath && existsSync(tpath)) {
        // Claude Code: transcript is already available — capture now
        const capId = captureSessionTranscript(dbPath, sid, tpath);
        logToFile(`Stop: direct capture for session ${sid}, id=${capId ?? "skipped"}`);
      } else {
        // Devin CLI: transcript not yet written — spawn background waiter
        const scriptPath = process.argv[1];
        const child = spawn(
          process.execPath,
          [scriptPath, "--wait-and-capture", dbPath, sid, tpath ?? ""],
          { detached: true, stdio: "ignore" },
        );
        child.unref();
        logToFile(`Stop: spawned background capture for session ${sid}`);
      }
    }

    // Second+ fire (stop_hook_active): agent already got the reminder, let it stop.
    if (input.stop_hook_active) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    // First fire: send a brief reminder (capture already happened above).
    const reminder =
      "Session transcript auto-captured. If you made important decisions or " +
      "found non-obvious solutions, call capture() to save a concise summary. " +
      "Skip if the task was trivial.";

    logToFile("Stop: reminder sent to agent");

    const output = {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: reminder,
      },
    };

    process.stdout.write(JSON.stringify(output));
  });
}

/**
 * Hook handler for PostToolUse event.
 * When a Bash command fails (non-zero exit), automatically captures the error
 * to memory with structured fields (ReasoningBank + MNL pattern).
 *
 * Based on:
 * - Reflexion (Shinn et al., NeurIPS 2023): self-reflection on errors
 * - ReasoningBank (ICLR 2026): structured memory from failures
 * - ExpeL (AAAI 2024): voting/confidence system
 * - Headroom: success correlation
 *
 * Claude Code PostToolUse stdin: { tool_name, tool_input, tool_response }
 * tool_response for Bash includes: { stdout, stderr, exit_code, interrupted }
 */
export function hookPostToolUse(dbPath: string): void {
  const chunks: Buffer[] = [];
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  process.stdin.on("end", () => {
    try {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw.trim()) {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      const input = JSON.parse(raw);
      const toolName = input.tool_name ?? "";
      const toolInput = input.tool_input ?? {};
      const toolResponse = input.tool_response ?? {};

      // Only process Bash/exec commands
      if (toolName !== "Bash" && toolName !== "exec") {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      const exitCode = toolResponse.exit_code ?? toolResponse.status ?? null;
      const isError = exitCode !== null && exitCode !== 0;
      const stderr = toolResponse.stderr ?? "";
      const stdout = toolResponse.stdout ?? "";
      const command = toolInput.command ?? "";
      const cwd = input.cwd ?? process.cwd();
      const sessionKey = hashPath(cwd);

      let db: Database.Database;
      try {
        db = new Database(dbPath);
      } catch {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // [Feature 4] Success correlation: if command succeeds and previously failed,
      // link the success to the previous error and upvote it
      if (!isError) {
        const prevError = db
          .prepare(
            `SELECT id, metadata FROM captures
             WHERE type = 'error' AND session_key = ?
             AND created_at > datetime('now', '-7 days')
             AND json_extract(metadata, '$.command') = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(sessionKey, command.slice(0, 200)) as { id: string; metadata: string } | undefined;

        if (prevError) {
          // Upvote the previous error (it was resolved)
          const meta = JSON.parse(prevError.metadata);
          const confidence = (meta.confidence ?? 2) + 1;
          meta.resolved = true;
          meta.resolved_at = new Date().toISOString();
          meta.resolution = "Command succeeded after previous failure";
          meta.confidence = confidence;
          db.prepare("UPDATE captures SET metadata = ? WHERE id = ?").run(
            JSON.stringify(meta),
            prevError.id,
          );
          logToFile(
            `PostToolUse: success correlation — upvoted error ${prevError.id} (confidence=${confidence})`,
          );
        }

        db.close();
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // --- Error capture path ---

      // Build error summary
      const errorOutput = (stderr || stdout || "").trim();
      const truncatedError =
        errorOutput.length > 500 ? `${errorOutput.slice(0, 500)}...` : errorOutput;

      // [Feature 1] Classify error type
      const errorType = classifyError(command, truncatedError);

      // [Feature 1] Structured memory (ReasoningBank + MNL pattern)
      const title = generateErrorTitle(command, errorType);
      const antiPattern = extractAntiPattern(command, truncatedError);
      const correctApproach = suggestCorrectApproach(command, errorType, truncatedError);

      // Build content for capture
      const content = `Command failed: ${command}\nError (${errorType}): ${truncatedError}`;

      // Check for duplicate (same command + error in last hour)
      const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
      const id = generateId();
      const now = new Date().toISOString();

      const recent = db
        .prepare(
          "SELECT id FROM captures WHERE content_hash = ? AND created_at > datetime('now', '-1 hour') LIMIT 1",
        )
        .get(contentHash) as { id: string } | undefined;

      if (recent) {
        // [Feature 5] Downvote the existing error — it recurred (ExpeL + Midas pattern)
        const existingMeta = db
          .prepare("SELECT metadata FROM captures WHERE id = ?")
          .get(recent.id) as { metadata: string } | undefined;
        if (existingMeta) {
          const meta = JSON.parse(existingMeta.metadata);
          meta.downvotes = (meta.downvotes ?? 0) + 1;
          meta.confidence = Math.max(0, (meta.confidence ?? 2) - 1);
          meta.last_recurred = new Date().toISOString();
          db.prepare("UPDATE captures SET metadata = ? WHERE id = ?").run(
            JSON.stringify(meta),
            recent.id,
          );
          logToFile(
            `PostToolUse: error recurred — downvoted ${recent.id} (confidence=${meta.confidence})`,
          );

          // [Feature 5] Prune if confidence reaches 0 (ExpeL removal threshold)
          if (meta.confidence <= 0) {
            db.prepare("UPDATE captures SET deleted_at = ? WHERE id = ?").run(
              new Date().toISOString(),
              recent.id,
            );
            logToFile(`PostToolUse: pruned error ${recent.id} (confidence reached 0)`);
          }
        }
        db.close();
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // [Feature 1] Capture with structured metadata
      db.prepare(`
        INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        sessionKey,
        "auto",
        "error",
        content,
        contentHash,
        JSON.stringify(["auto-capture", "error", errorType]),
        now,
        JSON.stringify({
          tool: toolName,
          command: command.slice(0, 200),
          exit_code: exitCode,
          error_type: errorType,
          // [Feature 1] Structured fields (ReasoningBank + MNL)
          title: title,
          anti_pattern: antiPattern,
          correct_approach: correctApproach,
          // [Feature 5] Confidence/voting (ExpeL + Midas)
          confidence: 2,
          upvotes: 0,
          downvotes: 0,
          // [Feature 4] Success correlation
          resolved: false,
        }),
      );

      db.close();

      logToFile(`PostToolUse: auto-captured ${errorType} error. id=${id}`);

      // [Feature 3] Self-reflection prompt (Reflexion pattern)
      // Inject a prompt asking the agent to reflect on the error
      const reflection = `[tdai-memory] Auto-captured ${errorType} error: ${title}

Anti-pattern: ${antiPattern}
Suggested fix: ${correctApproach}

Before retrying, reflect on WHY this failed and what you should do differently. Call capture() with type="learning" to save your reflection.`;

      const output = {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: reflection,
        },
      };

      process.stdout.write(JSON.stringify(output));
    } catch (err) {
      process.stderr.write(`[tdai-memory hook-post-tool-use] Error: ${err}\n`);
      logToFile(`PostToolUse: error - ${err}`);
      process.stdout.write(JSON.stringify({}));
    }
  });
}

/**
 * Hook handler for PreToolUse event.
 * Before running lint/build/test commands, inject the BEST matching past error
 * from memory so the agent can avoid repeating it.
 *
 * Based on:
 * - ReasoningBank (ICLR 2026): k=1 retrieval is optimal (k=2+ degrades performance)
 * - SWE-Exp: "Precisely ONE well-selected experience per issue is optimal"
 * - ExpeL (AAAI 2024): confidence-based ranking
 * - memcite: stale memory detection
 */
export function hookPreToolUse(dbPath: string): void {
  const chunks: Buffer[] = [];
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  process.stdin.on("end", () => {
    try {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw.trim()) {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      const input = JSON.parse(raw);
      const toolName = input.tool_name ?? "";
      const toolInput = input.tool_input ?? {};
      const command = toolInput.command ?? "";

      // Only inject for lint/build/test/typecheck commands
      const isRelevantCommand =
        /^(npm|npx|yarn|pnpm|biome|eslint|tsc|cargo|make|pytest|vitest|jest)\b/.test(command) ||
        /\b(lint|test|build|typecheck|check|format)\b/.test(command);

      if (!isRelevantCommand) {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      const cwd = input.cwd ?? process.cwd();
      const sessionKey = hashPath(cwd);

      let db: Database.Database;
      try {
        db = new Database(dbPath, { readonly: true });
      } catch {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // [Feature 2] k=1-2 optimal retrieval (ReasoningBank finding)
      // Get top 2 errors by confidence, filtered by relevance to current command
      const errors = db
        .prepare(
          `SELECT id, content, tags, created_at, metadata FROM captures
           WHERE type = 'error' AND session_key = ?
           AND created_at > datetime('now', '-30 days')
           AND json_extract(metadata, '$.resolved') IS NOT true
           ORDER BY CAST(json_extract(metadata, '$.confidence') AS INTEGER) DESC,
                    created_at DESC LIMIT 2`,
        )
        .all(sessionKey) as {
        id: string;
        content: string;
        tags: string | null;
        created_at: string;
        metadata: string;
      }[];

      db.close();

      if (errors.length === 0) {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // [Feature 6] Stale detection: check if file paths in error still exist
      const validErrors = errors.filter((err) => {
        const meta = JSON.parse(err.metadata);
        const filesInError = extractFilePaths(err.content);
        if (filesInError.length === 0) return true; // No file refs = still valid
        // Valid if at least one referenced file still exists
        return filesInError.some((f) => existsSync(join(cwd, f)));
      });

      if (validErrors.length === 0) {
        logToFile("PreToolUse: all past errors are stale (files no longer exist)");
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // Build structured warning context (ReasoningBank format)
      const lines: string[] = [`[tdai-memory] Past error to avoid repeating:`];
      for (const err of validErrors) {
        const meta = JSON.parse(err.metadata);
        const date = new Date(err.created_at).toISOString().split("T")[0];
        const title = meta.title ?? "Untitled error";
        const antiPattern = meta.anti_pattern ?? "";
        const correctApproach = meta.correct_approach ?? "";
        const confidence = meta.confidence ?? 2;

        lines.push(`- ${date} [confidence=${confidence}]: ${title}`);
        if (antiPattern) lines.push(`  Anti-pattern: ${antiPattern}`);
        if (correctApproach) lines.push(`  Fix: ${correctApproach}`);
        if (meta.resolved) lines.push(`  (Previously resolved — may recur)`);
      }
      lines.push("");
      lines.push("Fix these issues BEFORE running the command.");

      const context = lines.join("\n");
      logToFile(
        `PreToolUse: injected ${validErrors.length} past error(s) (k=${validErrors.length}) before: ${command.slice(0, 60)}`,
      );

      const output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: context,
        },
      };

      process.stdout.write(JSON.stringify(output));
    } catch (err) {
      process.stderr.write(`[tdai-memory hook-pre-tool-use] Error: ${err}\n`);
      logToFile(`PreToolUse: error - ${err}`);
      process.stdout.write(JSON.stringify({}));
    }
  });
}

/** Classify error type from command and error output. */
function classifyError(command: string, errorOutput: string): string {
  const lower = errorOutput.toLowerCase();
  if (lower.includes("lint") || lower.includes("biome") || lower.includes("eslint")) return "lint";
  if (
    lower.includes("test") ||
    lower.includes("vitest") ||
    lower.includes("jest") ||
    lower.includes("pytest")
  )
    return "test";
  if (lower.includes("type") && (lower.includes("error") || lower.includes("tsc")))
    return "typecheck";
  if (lower.includes("build") || lower.includes("compile") || lower.includes("webpack"))
    return "build";
  if (lower.includes("module not found") || lower.includes("cannot find")) return "import";
  if (lower.includes("permission") || lower.includes("eacces")) return "permission";
  if (lower.includes("enoent") || lower.includes("no such file")) return "file-not-found";
  return "runtime";
}

/**
 * [Feature 1] Generate a concise title for the error (ReasoningBank pattern).
 * Title = short identifier summarizing the core issue.
 */
function generateErrorTitle(command: string, errorType: string): string {
  // Extract the most relevant part of the command
  const cmdParts = command.trim().split(/\s+/);
  const tool = cmdParts[0] ?? "command";
  const subCmd = cmdParts.slice(0, 3).join(" ");
  return `${errorType} error in: ${subCmd.slice(0, 80)}`;
}

/**
 * [Feature 1] Extract anti-pattern from error output (MNL pattern).
 * Anti-pattern = what NOT to do.
 */
function extractAntiPattern(command: string, errorOutput: string): string {
  // Extract the first meaningful error line
  const lines = errorOutput.split("\n").filter((l) => l.trim());
  const errorLine =
    lines.find((l) => /error|fail|cannot|missing|invalid/i.test(l)) ?? lines[0] ?? "";
  // Truncate and clean
  const cleaned = errorLine.replace(/\s+/g, " ").trim();
  return cleaned.length > 150 ? `${cleaned.slice(0, 150)}...` : cleaned;
}

/**
 * [Feature 1] Suggest correct approach based on error type (MNL pattern).
 * Correct approach = what TO do instead.
 */
function suggestCorrectApproach(command: string, errorType: string, errorOutput: string): string {
  const suggestions: Record<string, string> = {
    lint: "Fix the lint violation in the referenced file before re-running.",
    test: "Fix the failing test case or the code it tests. Check the assertion error details.",
    typecheck: "Fix the type error. Check the type signatures and imports.",
    build:
      "Fix the build error. Check for missing dependencies, syntax errors, or configuration issues.",
    import: "Check that the module exists and the import path is correct.",
    permission: "Check file permissions or run with appropriate access level.",
    "file-not-found": "Check that the file path is correct and the file exists.",
    runtime: "Check the error message and stack trace for the root cause.",
  };
  return suggestions[errorType] ?? "Analyze the error output and fix the root cause.";
}

/**
 * [Feature 6] Extract file paths from error content (memcite pattern).
 * Used for stale detection — if referenced files no longer exist, memory is stale.
 */
function extractFilePaths(content: string): string[] {
  const paths: string[] = [];
  // Match common file path patterns: src/foo.ts, ./bar.js, /abs/path.py
  const pathRegex = /(?:^|\s|[(:[])((?:\.\/|\.\.\/|\/)?[\w-]+(?:\/[\w-]+)+\.\w{1,5})/g;
  let match;
  while ((match = pathRegex.exec(content)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/** Hash a file path to a session key (same as storage layer). */
function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/**
 * Default transcript directory: ~/.local/share/devin/cli/transcripts/
 */
function defaultTranscriptDir(): string {
  return (
    process.env.DEVIN_TRANSCRIPTS_DIR ??
    join(homedir(), ".local", "share", "devin", "cli", "transcripts")
  );
}

/** Generate a ULID-like ID (timestamp + random). */
function generateId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 12).toUpperCase();
  return `01${ts}${rand}`;
}

/**
 * Extract user/assistant messages from a transcript file and capture a summary.
 * Supports Devin CLI (single JSON with steps) and Claude Code (JSONL) formats.
 * Returns the capture ID, or null if skipped (trivial, duplicate, or no transcript).
 */
function captureSessionTranscript(
  dbPath: string,
  sessionId?: string,
  transcriptPath?: string | null,
): string | null {
  const sid = sessionId ?? "unknown";

  if (!transcriptPath && !sessionId) {
    logToFile("Stop: no session_id or transcript_path, skipping auto-capture");
    return null;
  }

  // Resolve transcript file path
  let filePath: string | null = null;
  if (transcriptPath) {
    filePath = transcriptPath;
  } else {
    filePath = join(defaultTranscriptDir(), `${sid}.json`);
  }

  if (!existsSync(filePath)) {
    logToFile(`Stop: transcript not found at ${filePath}`);
    return null;
  }

  const raw = readFileSync(filePath, "utf-8");
  const userMessages: string[] = [];
  const assistantMessages: string[] = [];

  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.includes('"steps"')) {
    // Devin CLI: single JSON object with steps array
    const transcript = JSON.parse(raw);
    const steps: Array<{ source: string; message: string }> = transcript.steps ?? [];
    for (const step of steps) {
      if (step.source === "user" && typeof step.message === "string") {
        if (
          !step.message.startsWith("[tdai-memory]") &&
          !step.message.startsWith("Code was changed")
        ) {
          userMessages.push(step.message);
        }
      }
      if (
        (step.source === "assistant" || step.source === "agent") &&
        typeof step.message === "string"
      ) {
        assistantMessages.push(step.message);
      }
    }
  } else {
    // Claude Code: JSONL format (one JSON object per line)
    const lines = raw.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== "user" && obj.type !== "assistant") continue;

        const msg = obj.message;
        if (!msg || typeof msg !== "object") continue;

        const role = msg.role ?? obj.type;
        const content = msg.content;

        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter(
              (c: unknown) =>
                typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
            )
            .map((c: unknown) => (c as { text?: string }).text ?? "")
            .join(" ");
        }

        if (!text.trim()) continue;
        if (text.startsWith("[tdai-memory]") || text.startsWith("Code was changed")) continue;

        if (role === "user") {
          userMessages.push(text);
        } else if (role === "assistant") {
          assistantMessages.push(text);
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  // Skip trivial sessions
  if (userMessages.length <= 1 && assistantMessages.length === 0) {
    logToFile(`Stop: trivial session (${userMessages.length} user msgs), skipping auto-capture`);
    return null;
  }

  // Build capture content: first user message (task) + last assistant message (outcome)
  const firstUser = userMessages[0] ?? "";
  const lastAssistant = assistantMessages[assistantMessages.length - 1] ?? "";
  const taskText = firstUser.slice(0, 500);
  const outcomeText = lastAssistant.slice(0, 500);

  const content = `Session: ${sid}\nTask: ${taskText}\nOutcome: ${outcomeText}`;
  const contentHash = createHash("sha256").update(content).digest("hex");

  const db = new Database(dbPath);
  const sessionKey = sid.slice(0, 16);
  const now = Date.now();
  const id = generateId();

  // Check for duplicate
  const existing = db.prepare("SELECT id FROM captures WHERE content_hash = ?").get(contentHash) as
    | { id: string }
    | undefined;

  if (existing) {
    db.close();
    logToFile(`Stop: duplicate capture (hash match), skipping. id=${existing.id}`);
    return null;
  }

  // Delete previous auto-captures for the same session (only keep the latest).
  // This prevents N captures when the user stops/resumes N times.
  const stale = db
    .prepare(
      "SELECT id FROM captures WHERE session_key = ? AND type = 'conversation' AND json_extract(metadata, '$.session_id') = ?",
    )
    .all(sessionKey, sid) as { id: string }[];
  if (stale.length > 0) {
    const delStmt = db.prepare("DELETE FROM captures WHERE id = ?");
    for (const row of stale) {
      delStmt.run(row.id);
    }
    logToFile(`Stop: removed ${stale.length} previous capture(s) for session ${sid}`);
  }

  db.prepare(`
    INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sessionKey,
    "devin-cli",
    "conversation",
    content,
    contentHash,
    JSON.stringify(["auto-capture", "stop"]),
    now,
    JSON.stringify({
      session_id: sid,
      user_messages: userMessages.length,
      assistant_messages: assistantMessages.length,
    }),
  );

  db.close();

  logToFile(
    `Stop: auto-captured session ${sid} (${userMessages.length} user msgs, ${assistantMessages.length} assistant msgs). id=${id}`,
  );
  return id;
}

/**
 * Hook handler for SessionEnd event.
 * Reads the session transcript, extracts user/assistant messages,
 * and captures a summary directly to the memory DB.
 * Runs silently — no agent involvement needed.
 *
 * Supports two transcript formats:
 * - Claude Code: stdin includes `transcript_path`, file is JSONL (one JSON per line)
 * - Devin CLI: stdin includes `session_id`, file is at ~/.local/share/devin/cli/transcripts/<id>.json (single JSON with `steps` array)
 */
export function hookSessionEnd(dbPath: string): void {
  const chunks: Buffer[] = [];
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const sessionId = input.session_id ?? "unknown";
      const transcriptPath = input.transcript_path ?? null;

      const id = captureSessionTranscript(dbPath, sessionId, transcriptPath);
      if (id) {
        logToFile(`SessionEnd: captured via shared function. id=${id}`);
      }
      process.stdout.write(JSON.stringify({}));
    } catch (err) {
      process.stderr.write(`[tdai-memory hook-session-end] Error: ${err}\n`);
      logToFile(`SessionEnd: error - ${err}`);
      process.stdout.write(JSON.stringify({}));
    }
  });
}

/**
 * Wait for transcript file to appear, then capture it.
 * Spawned as a detached background process by hookStop, because Devin CLI
 * writes the transcript file AFTER the Stop hook fires.
 *
 * Waits up to 10 seconds (polling every 500ms), then captures or gives up.
 */
export async function waitAndCapture(
  dbPath: string,
  sessionId: string,
  transcriptPath: string | null,
): Promise<void> {
  let filePath: string | null = null;
  if (transcriptPath) {
    filePath = transcriptPath;
  } else {
    filePath = join(defaultTranscriptDir(), `${sessionId}.json`);
  }

  // Wait up to 10 seconds for transcript file to appear
  const maxWait = 10000;
  const interval = 500;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    if (existsSync(filePath)) {
      // Wait a bit more for the file to be fully written
      await sleep(500);
      break;
    }
    await sleep(interval);
  }

  if (!existsSync(filePath)) {
    logToFile(`Stop: transcript never appeared at ${filePath} after 10s`);
    return;
  }

  try {
    const id = captureSessionTranscript(dbPath, sessionId, transcriptPath);
    if (id) {
      logToFile(`Stop: background capture succeeded. id=${id}`);
    }
  } catch (err) {
    logToFile(`Stop: background capture error - ${err}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Post-commit hook: auto-index changed files into the CodeGraph.
 *
 * Reads the list of changed files from `git diff-tree` and indexes them
 * into the memory database. This keeps the code graph up to date without
 * manual `codegraph_index` calls.
 *
 * Usage in .git/hooks/post-commit:
 *   node /path/to/dist/index.js --hook=post-commit --db-path=/path/to/memory.db
 */
export async function hookPostCommit(dbPath: string): Promise<void> {
  try {
    const { execSync } = await import("node:child_process");
    // Get list of changed files in this commit
    const output = execSync("git diff-tree --no-commit-id --name-only -r HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const files = output.trim().split("\n").filter(Boolean);

    if (files.length === 0) {
      logToFile("PostCommit: no changed files");
      process.stdout.write(JSON.stringify({}));
      return;
    }

    // Load schema and CodeGraph engine
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const sqliteVec = await import("sqlite-vec");
    const { indexFile } = await import("./codegraph/engine.js");

    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    sqliteVec.load(db);

    // Ensure schema exists (create tables if missing)
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
    try {
      const schema = readFileSync(schemaPath, "utf-8");
      db.exec(schema);
    } catch {
      // Schema file not found — tables may already exist
    }

    // Index supported code files
    const SUPPORTED_EXT = [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".py",
      ".go",
      ".rs",
      ".java",
      ".c",
      ".h",
      ".cpp",
      ".cc",
      ".hpp",
      ".cs",
    ];
    let indexed = 0;
    let skipped = 0;
    const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();

    for (const file of files) {
      const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
      if (!SUPPORTED_EXT.includes(ext)) {
        skipped++;
        continue;
      }
      try {
        const fullPath = join(repoRoot, file);
        await indexFile(db, fullPath, repoRoot, null);
        indexed++;
      } catch {
        // Skip on error (file may not exist, parse error, etc.)
        skipped++;
      }
    }

    db.close();
    logToFile(`PostCommit: indexed ${indexed} file(s), skipped ${skipped}`);
    process.stdout.write(JSON.stringify({}));
  } catch (err) {
    process.stderr.write(`[tdai-memory hook-post-commit] Error: ${err}\n`);
    logToFile(`PostCommit: error - ${err}`);
    process.stdout.write(JSON.stringify({}));
  }
}
