import Database from "better-sqlite3";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
      const db = new Database(dbPath, { readonly: true });

      // Try with session_key first, then fall back to all captures
      const baseSql = `
        SELECT id, type, content, tags, created_at
        FROM captures
        WHERE type IN ('decision', 'learning', 'error', 'task')
      `;

      let rows: {
        id: string;
        type: string;
        content: string;
        tags: string | null;
        created_at: number;
      }[] = [];

      if (sessionKey) {
        rows = db
          .prepare(`${baseSql} AND session_key = ? ORDER BY created_at DESC LIMIT 10`)
          .all(sessionKey) as typeof rows;
      }

      // If no results with session_key, query all captures
      if (rows.length === 0) {
        rows = db.prepare(`${baseSql} ORDER BY created_at DESC LIMIT 10`).all() as typeof rows;
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
export function hookStop(): void {
  const chunks: Buffer[] = [];
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  process.stdin.on("end", () => {
    let input: { stop_hook_active?: boolean } = {};
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

    // Invalid/empty stdin or second+ fire: let the agent stop silently.
    // This prevents infinite loops on trivial sessions.
    if (!validInput || input.stop_hook_active) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    // First fire: send the handoff reminder.
    const reminder =
      "Before you stop, call the handoff tool to save context for the next session. " +
      "Include: task, status, progress, decisions, files, and next_steps. " +
      "Skip handoff only if the task was trivial.";

    logToFile("Stop: handoff reminder sent to agent");

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

      if (!transcriptPath && !sessionId) {
        logToFile("SessionEnd: no session_id or transcript_path in stdin, skipping");
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // Resolve transcript file path
      let filePath: string | null = null;
      if (transcriptPath) {
        // Claude Code provides the path directly
        filePath = transcriptPath;
      } else {
        // Devin CLI: construct path from session_id
        filePath = join(defaultTranscriptDir(), `${sessionId}.json`);
      }

      if (!existsSync(filePath)) {
        logToFile(`SessionEnd: transcript not found at ${filePath}`);
        process.stdout.write(JSON.stringify({}));
        return;
      }

      const raw = readFileSync(filePath, "utf-8");

      // Extract user and assistant messages
      const userMessages: string[] = [];
      const assistantMessages: string[] = [];

      // Detect format: JSONL (Claude Code) vs single JSON (Devin CLI)
      const trimmed = raw.trim();
      if (trimmed.startsWith("{") && trimmed.includes('"steps"')) {
        // Devin CLI: single JSON object with steps array
        const transcript = JSON.parse(raw);
        const steps: Array<{ source: string; message: string }> = transcript.steps ?? [];
        for (const step of steps) {
          if (step.source === "user" && typeof step.message === "string") {
            if (!step.message.startsWith("[tdai-memory]") && !step.message.startsWith("Code was changed")) {
              userMessages.push(step.message);
            }
          }
          if ((step.source === "assistant" || step.source === "agent") && typeof step.message === "string") {
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
                .filter((c: unknown) => typeof c === "object" && c !== null && (c as { type?: string }).type === "text")
                .map((c: unknown) => (c as { text?: string }).text ?? "")
                .join(" ");
            }

            if (!text.trim()) continue;

            // Skip system-injected messages
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

      // Skip trivial sessions (1 or fewer user messages)
      if (userMessages.length <= 1 && assistantMessages.length === 0) {
        logToFile(`SessionEnd: trivial session (${userMessages.length} user msgs), skipping capture`);
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // Build capture content: first user message (task) + last assistant message (outcome)
      const firstUser = userMessages[0] ?? "";
      const lastAssistant = assistantMessages[assistantMessages.length - 1] ?? "";

      // Truncate to keep capture concise
      const taskText = firstUser.slice(0, 500);
      const outcomeText = lastAssistant.slice(0, 500);

      const content = `Session: ${sessionId}\nTask: ${taskText}\nOutcome: ${outcomeText}`;
      const contentHash = createHash("sha256").update(content).digest("hex");

      // Write directly to SQLite (like hook-recall does)
      const db = new Database(dbPath);
      const sessionKey = sessionId.slice(0, 16);
      const now = Date.now();
      const id = generateId();

      // Check for duplicate
      const existing = db.prepare("SELECT id FROM captures WHERE content_hash = ?").get(contentHash) as
        | { id: string }
        | undefined;

      if (existing) {
        db.close();
        logToFile(`SessionEnd: duplicate capture (hash match), skipping. id=${existing.id}`);
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // Insert capture — FTS5 trigger auto-populates the search index
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
        JSON.stringify(["auto-capture", "session-end"]),
        now,
        JSON.stringify({ session_id: sessionId, user_messages: userMessages.length, assistant_messages: assistantMessages.length }),
      );

      db.close();

      logToFile(`SessionEnd: captured session ${sessionId} (${userMessages.length} user msgs, ${assistantMessages.length} assistant msgs). id=${id}`);
      process.stdout.write(JSON.stringify({}));
    } catch (err) {
      process.stderr.write(`[tdai-memory hook-session-end] Error: ${err}\n`);
      logToFile(`SessionEnd: error - ${err}`);
      process.stdout.write(JSON.stringify({}));
    }
  });
}
