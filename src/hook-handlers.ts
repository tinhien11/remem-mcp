import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/**
 * [Drift Detection] Get the temp file path for tracking error injections.
 * Each session gets its own file. Injections are logged here by PreToolUse
 * and checked by PostToolUse.
 */
function driftFilePath(sessionKey: string): string {
  return join(tmpdir(), `tdai-drift-${sessionKey}.jsonl`);
}

/**
 * [Drift Detection] Log an error injection from PreToolUse.
 * Called when an error is injected before a command. PostToolUse will
 * check this file to detect if the agent ignored the warning.
 */
function logDriftInjection(
  sessionKey: string,
  contentHash: string,
  errorId: string,
  command: string,
): void {
  try {
    const path = driftFilePath(sessionKey);
    const record = JSON.stringify({
      content_hash: contentHash,
      error_id: errorId,
      command: command.slice(0, 200),
      injected_at: Date.now(),
    });
    appendFileSync(path, `${record}\n`);
  } catch {
    // Best-effort — drift tracking is supplementary
  }
}

/**
 * [Drift Detection] Check if a content_hash was recently injected.
 * Returns the injection record if found, or null if not.
 * Cleans up entries older than 30 minutes.
 */
function checkDriftInjection(
  sessionKey: string,
  contentHash: string,
): { content_hash: string; error_id: string; command: string; injected_at: number } | null {
  try {
    const path = driftFilePath(sessionKey);
    if (!existsSync(path)) return null;

    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes

    // Filter to recent entries only
    const recent: string[] = [];
    let match: {
      content_hash: string;
      error_id: string;
      command: string;
      injected_at: number;
    } | null = null;

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (now - record.injected_at < maxAge) {
          recent.push(line);
          if (record.content_hash === contentHash && !match) {
            match = record;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Clean up old entries (rewrite file with only recent entries)
    if (recent.length !== lines.length) {
      writeFileSync(path, recent.join("\n") + (recent.length > 0 ? "\n" : ""));
    }

    return match;
  } catch {
    return null;
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
        void captureSessionTranscript(dbPath, sid, tpath).then((capId) => {
          logToFile(`Stop: direct capture for session ${sid}, id=${capId ?? "skipped"}`);
        });
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

    // Check if session is trivial (1-2 user messages, no file edits).
    // Skip reminder for trivial sessions to avoid noise.
    const isTrivial = (() => {
      const tpath = input.transcript_path;
      if (!tpath || !existsSync(tpath)) return false;
      try {
        const lines = readFileSync(tpath, "utf-8").trim().split("\n");
        let userCount = 0;
        let hasEdit = false;
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.role === "user" || entry.type === "user") userCount++;
            if (
              entry.tool_name === "edit" ||
              entry.tool_name === "write" ||
              entry.tool_name === "Edit" ||
              entry.tool_name === "Write"
            )
              hasEdit = true;
          } catch {
            // Not JSON, skip
          }
        }
        return userCount <= 2 && !hasEdit;
      } catch {
        return false;
      }
    })();

    if (isTrivial) {
      logToFile("Stop: trivial session, skipping reminder");
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

      // Process Bash/exec for error + decision capture,
      // Write/Edit/MultiEdit for pattern capture (Moat 3)
      const isBash = toolName === "Bash" || toolName === "exec";
      const isWriteEdit = toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit";

      if (!isBash && !isWriteEdit) {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // [Moat 3: Pattern Learning] Capture code patterns from Write/Edit
      if (isWriteEdit) {
        try {
          const db = new Database(dbPath);
          const pattern = detectPattern(toolName, toolInput);
          if (pattern) {
            const id = `pat-${createHash("sha256")
              .update(pattern.signature + pattern.file_path)
              .digest("hex")
              .slice(0, 12)}`;
            const sessionKey = hashPath(input.cwd ?? process.cwd());
            const content = `Pattern: ${pattern.title} in ${pattern.file_path}`;
            const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);

            // Check if this pattern already exists
            const existing = db.prepare("SELECT id, metadata FROM captures WHERE id = ?").get(id) as
              | { id: string; metadata: string }
              | undefined;

            if (existing) {
              // Upvote existing pattern
              const meta = JSON.parse(existing.metadata);
              meta.confidence = (meta.confidence ?? 1) + 1;
              meta.last_seen = new Date().toISOString();
              meta.seen_count = (meta.seen_count ?? 1) + 1;
              db.prepare("UPDATE captures SET metadata = ? WHERE id = ?").run(
                JSON.stringify(meta),
                existing.id,
              );
            } else {
              db.prepare(
                "INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              ).run(
                id,
                sessionKey,
                "auto",
                "pattern",
                content,
                hash,
                JSON.stringify([pattern.pattern_type, pattern.language]),
                new Date().toISOString().replace("T", " ").replace("Z", ""),
                JSON.stringify({
                  tool: toolName,
                  title: pattern.title,
                  pattern_type: pattern.pattern_type,
                  language: pattern.language,
                  signature: pattern.signature,
                  file_path: pattern.file_path,
                  confidence: 1,
                  seen_count: 1,
                  adopted: false,
                  first_seen: new Date().toISOString(),
                  last_seen: new Date().toISOString(),
                }),
              );
            }
            logToFile(`PostToolUse: captured pattern ${pattern.title}`);
          }
          db.close();
        } catch {
          // non-fatal
        }
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // Claude Code: { exit_code, stderr, stdout }
      // Devin CLI: { success, output, error }
      // PostToolUseFailure (Claude Code): always a failure
      const isFailureEvent = input.hook_event_name === "PostToolUseFailure";
      const exitCode = toolResponse.exit_code ?? toolResponse.status ?? null;
      const devinSuccess = typeof toolResponse.success === "boolean" ? toolResponse.success : null;
      const isError =
        isFailureEvent || devinSuccess === false || (exitCode !== null && exitCode !== 0);
      const stderr = toolResponse.stderr ?? toolResponse.error ?? "";
      const stdout = toolResponse.stdout ?? toolResponse.output ?? "";
      const command = toolInput.command ?? "";
      const cwd = input.cwd ?? process.cwd();
      const sessionKey = hashPath(cwd);

      // Noise filter: skip error capture for obvious test/noise commands
      if (isNoiseCommand(command)) {
        logToFile(`PostToolUse: skipping noise command: ${command.slice(0, 80)}`);
        process.stdout.write(JSON.stringify({}));
        return;
      }

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

          // [Feature 9] Record the fix that worked — extract from stdout (success output)
          // This becomes the "proven fix" injected by PreToolUse for similar future errors
          const successSummary = (stdout || "").trim().slice(0, 200);
          if (successSummary) {
            meta.fix_applied = `Command succeeded. Output: ${successSummary.slice(0, 150)}`;
          } else {
            meta.fix_applied = meta.correct_approach ?? "Command succeeded after fix.";
          }

          // [Recovery Pattern Library] Extract a structured recovery playbook.
          // Combines anti_pattern + correct_approach + fix_applied into step-by-step guidance.
          // (SRE pattern: runbooks / incident playbooks)
          if (meta.attempt_count && meta.attempt_count >= 2) {
            meta.recovery_pattern = {
              steps: [
                `1. Identify: ${meta.title ?? "the error"}`,
                `2. Avoid: ${meta.anti_pattern ?? "the anti-pattern that caused this"}`,
                `3. Apply: ${meta.correct_approach ?? "the correct approach"}`,
                `4. Verify: ${meta.fix_applied?.slice(0, 80) ?? "run the command again"}`,
              ],
              attempt_count: meta.attempt_count,
              error_type: meta.error_type ?? "runtime",
              extracted_at: new Date().toISOString(),
            };
          }

          // [Fix Rollback Plan] Auto-generate a rollback plan for the fix.
          // Safety net: if the fix causes issues, agent knows how to undo it.
          const rollback = generateRollbackPlan(command, meta.fix_applied ?? "");
          if (rollback) {
            meta.rollback_plan = rollback;
          }

          // [Fix Provenance Chain] Mark provenance as auto_captured (system recorded it)
          if (!meta.fix_provenance) {
            meta.fix_provenance = "auto_captured";
          }

          // [Auto-Annotation] Regenerate notes with updated state (resolved, validated)
          meta.auto_notes = generateAutoNotes({
            attempt_count: meta.attempt_count,
            severity: meta.severity,
            escalation_level: meta.escalation_level,
            error_type: meta.error_type,
            resolved: true,
            fix_validated: meta.fix_validated,
            drift_count: meta.drift_count,
          });

          // [P0: A/B validation] Validate the fix — check if stdout contains
          // error indicators (agent-learn pattern: only promote if proven)
          // A "clean" success has no error keywords in stdout.
          const lowerStdout = (stdout || "").toLowerCase();
          const hasErrorIndicators = /\b(errors?|failed|failure|exception|traceback|fatal)\b/.test(
            lowerStdout,
          );
          meta.fix_validated = !hasErrorIndicators;
          if (hasErrorIndicators) {
            logToFile(
              `PostToolUse: fix recorded but UNVALIDATED (stdout contains error indicators) for ${prevError.id}`,
            );
          }

          db.prepare("UPDATE captures SET metadata = ? WHERE id = ?").run(
            JSON.stringify(meta),
            prevError.id,
          );
          logToFile(
            `PostToolUse: success correlation — upvoted error ${prevError.id} (confidence=${confidence}, fix recorded, validated=${meta.fix_validated})`,
          );

          // [Fix Template Extraction] When an error is resolved, check if 2+ similar
          // errors (same error_type) have similar fixes. If so, extract a reusable template.
          // (Moves from specific fixes to generalizable principles)
          if (meta.fix_validated && meta.fix_applied) {
            try {
              const similarFixes = db
                .prepare(
                  `SELECT
                     json_extract(metadata, '$.fix_applied') as fix,
                     json_extract(metadata, '$.title') as title
                   FROM captures
                   WHERE type = 'error' AND deleted_at IS NULL
                   AND session_key = ?
                   AND json_extract(metadata, '$.resolved') = true
                   AND json_extract(metadata, '$.fix_validated') = true
                   AND json_extract(metadata, '$.fix_applied') IS NOT NULL
                   AND json_extract(metadata, '$.error_type') = ?
                   AND id != ?
                   ORDER BY created_at DESC LIMIT 5`,
                )
                .all(sessionKey, meta.error_type ?? "runtime", prevError.id) as {
                fix: string;
                title: string;
              }[];

              if (similarFixes.length >= 2) {
                // Check if fixes share a common pattern (simple word overlap)
                const allFixes = [meta.fix_applied, ...similarFixes.map((s) => s.fix)];
                const words = allFixes[0]
                  .toLowerCase()
                  .split(/\s+/)
                  .filter(
                    (w) => w.length > 3 && !["command", "succeeded", "output", "error"].includes(w),
                  );
                const commonWords = words.filter((w) =>
                  allFixes.slice(1).every((f) => f.toLowerCase().includes(w)),
                );

                if (commonWords.length >= 2) {
                  // Template found — store it on the most recent error as a template marker
                  meta.fix_template = {
                    pattern: commonWords.join(" "),
                    similar_fix_count: allFixes.length,
                    error_type: meta.error_type ?? "runtime",
                    extracted_at: new Date().toISOString(),
                  };
                  db.prepare("UPDATE captures SET metadata = ? WHERE id = ?").run(
                    JSON.stringify(meta),
                    prevError.id,
                  );
                  logToFile(
                    `PostToolUse: FIX TEMPLATE extracted — pattern "${commonWords.join(" ")}" matches ${allFixes.length} fixes for ${meta.error_type ?? "runtime"} errors`,
                  );
                }
              }
            } catch {
              // Non-fatal
            }
          }
        }

        // [P0: Harm gate] Check if a previously resolved error's command
        // is NOW failing again — this means the "proven fix" caused a regression.
        // Mark the original resolved error with harm_count to prevent re-injection.
        // (errlore pattern: withhold harmful lessons)

        // [Moat 2: Decision Learning] Auto-capture decisions from successful commands.
        // Detects dependency choices, config decisions, commit-encoded decisions.
        const decision = detectDecision(command, stdout);
        if (decision) {
          try {
            const decId = `dec-${createHash("sha256")
              .update(decision.choice + sessionKey)
              .digest("hex")
              .slice(0, 12)}`;
            const existingDec = db
              .prepare("SELECT id, metadata FROM captures WHERE id = ?")
              .get(decId) as { id: string; metadata: string } | undefined;

            if (existingDec) {
              // Decision already exists — upvote confidence
              const dMeta = JSON.parse(existingDec.metadata);
              dMeta.confidence = (dMeta.confidence ?? 1) + 1;
              dMeta.last_seen = new Date().toISOString();
              dMeta.seen_count = (dMeta.seen_count ?? 1) + 1;
              db.prepare("UPDATE captures SET metadata = ? WHERE id = ?").run(
                JSON.stringify(dMeta),
                decId,
              );
            } else {
              const decContent = `Decision: ${decision.title}`;
              const decHash = createHash("sha256").update(decContent).digest("hex").slice(0, 16);
              db.prepare(
                "INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              ).run(
                decId,
                sessionKey,
                "auto",
                "decision",
                decContent,
                decHash,
                JSON.stringify([decision.decision_type]),
                new Date().toISOString().replace("T", " ").replace("Z", ""),
                JSON.stringify({
                  title: decision.title,
                  decision_type: decision.decision_type,
                  choice: decision.choice,
                  rationale: decision.rationale,
                  command: command.slice(0, 200),
                  confidence: 1,
                  seen_count: 1,
                  followed: null,
                  drift_count: 0,
                  first_seen: new Date().toISOString(),
                  last_seen: new Date().toISOString(),
                }),
              );
              logToFile(`PostToolUse: captured decision — ${decision.title}`);
            }
          } catch {
            // non-fatal
          }
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
      // [Severity Classification] Classify impact level
      const severity = classifySeverity(command, errorType, truncatedError);

      // [Feature 1] Structured memory (ReasoningBank + MNL pattern)
      const title = generateErrorTitle(command, errorType);
      const antiPattern = extractAntiPattern(command, truncatedError);
      const correctApproach = suggestCorrectApproach(command, errorType, truncatedError);

      // Build content for capture
      const content = `Command failed: ${command}\nError (${errorType}): ${truncatedError}`;

      // [P2: Semantic error matching] Normalize error content before hashing
      // so similar errors (same type, same command, different line numbers/variables)
      // are detected as duplicates/recurrences.
      // Normalization: replace line numbers, variable names, file paths with placeholders.
      const normalizedError = truncatedError
        .replace(/line \d+/g, "line N")
        .replace(/col \d+/g, "col N")
        .replace(/\b\d+\b/g, "N")
        .replace(/'[^']+'/g, "'X'")
        .replace(/"[^"]+"/g, '"X"')
        .replace(/src\/[^\s:]+/g, "src/PATH")
        .replace(/\.\/[^\s:]+/g, "./PATH")
        .replace(/\/[^\s:]+\/[^\s:]+/g, "/PATH");
      const semanticContent = `Command failed: ${command}\nError (${errorType}): ${normalizedError}`;
      const contentHash = createHash("sha256").update(semanticContent).digest("hex").slice(0, 16);
      const id = generateId();
      const now = new Date().toISOString().replace("T", " ").replace("Z", "");

      // Check for duplicate using semantic hash (same normalized error in last hour)
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
          // [Fix Attempt Counter] Track how many times this error occurred before resolution
          meta.attempt_count = (meta.attempt_count ?? 1) + 1;

          // [Error Escalation Policy] Auto-escalate when attempt_count >= threshold.
          // PagerDuty pattern: recurrence → escalation → stronger intervention.
          // Level 0: normal, Level 1: elevated (3+ attempts), Level 2: critical (5+),
          // Level 3: blocker (7+). Bump severity and add escalated_at timestamp.
          const escalationThreshold = Number(process.env.TDAI_ESCALATION_THRESHOLD ?? 3);
          if (meta.attempt_count >= escalationThreshold) {
            const newLevel = meta.attempt_count >= 7 ? 3 : meta.attempt_count >= 5 ? 2 : 1;
            const prevLevel = meta.escalation_level ?? 0;
            if (newLevel > prevLevel) {
              meta.escalation_level = newLevel;
              meta.escalated_at = new Date().toISOString();
              // Bump severity: major→critical (level 1), critical→blocker (level 2+)
              if (newLevel >= 2) {
                meta.severity = "blocker";
              } else if (meta.severity === "major" || !meta.severity) {
                meta.severity = "critical";
              }
              logToFile(
                `PostToolUse: ESCALATION — error ${recent.id} escalated to level ${newLevel} (attempt_count=${meta.attempt_count}, severity=${meta.severity})`,
              );
            }
          }

          // [Drift Detection] Check if this error was injected by PreToolUse
          // recently. If so, the agent was warned but still hit the same error.
          const driftHit = checkDriftInjection(sessionKey, contentHash);
          if (driftHit) {
            meta.drift_count = (meta.drift_count ?? 0) + 1;
            meta.last_drift_at = new Date().toISOString();
            logToFile(
              `PostToolUse: DRIFT detected — error ${recent.id} was injected but agent still failed (drift_count=${meta.drift_count})`,
            );
          }

          // [Auto-Annotation] Regenerate notes with updated recurrence state
          meta.auto_notes = generateAutoNotes({
            attempt_count: meta.attempt_count,
            severity: meta.severity,
            escalation_level: meta.escalation_level,
            error_type: meta.error_type,
            resolved: meta.resolved,
            fix_validated: meta.fix_validated,
            drift_count: meta.drift_count,
          });

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
              new Date().toISOString().replace("T", " ").replace("Z", ""),
              recent.id,
            );
            logToFile(`PostToolUse: pruned error ${recent.id} (confidence reached 0)`);
          }
        }

        // [P0: Harm gate] If this recurring error was previously resolved,
        // the "proven fix" caused a regression. Mark it as harmful.
        // (errlore pattern: withhold harmful lessons)
        const prevResolved = db
          .prepare(
            `SELECT id, metadata FROM captures
             WHERE type = 'error' AND session_key = ?
             AND created_at > datetime('now', '-30 days')
             AND json_extract(metadata, '$.resolved') = 1
             AND json_extract(metadata, '$.fix_applied') IS NOT NULL
             AND json_extract(metadata, '$.command') = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(sessionKey, command.slice(0, 200)) as { id: string; metadata: string } | undefined;
        if (prevResolved) {
          const rMeta = JSON.parse(prevResolved.metadata);
          rMeta.fix_harm_count = (rMeta.fix_harm_count ?? 0) + 1;
          db.prepare("UPDATE captures SET metadata = ? WHERE id = ?").run(
            JSON.stringify(rMeta),
            prevResolved.id,
          );
          logToFile(
            `PostToolUse: HARM GATE — proven fix for ${prevResolved.id} caused regression (harm_count=${rMeta.fix_harm_count})`,
          );
        }

        db.close();
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // [Drift Detection] Check if this error was injected by PreToolUse
      // recently. If so, the agent was warned but still hit the same error.
      const driftHit = checkDriftInjection(sessionKey, contentHash);
      if (driftHit) {
        logToFile(
          `PostToolUse: DRIFT detected — error was injected but agent still failed (content_hash=${contentHash})`,
        );
      }

      // [Fix Lineage] Check if a recently resolved error on the same command
      // exists — if so, this new error might be a regression caused by the fix.
      // Link the new error to the old one via caused_by_error_id.
      // (Different from harm gate: harm gate blocks re-injection. Lineage tracks the chain.)
      let causedByErrorId: string | null = null;
      try {
        const lineagePrev = db
          .prepare(
            `SELECT id FROM captures
             WHERE type = 'error' AND session_key = ?
             AND created_at > datetime('now', '-30 days')
             AND json_extract(metadata, '$.resolved') = 1
             AND json_extract(metadata, '$.fix_applied') IS NOT NULL
             AND json_extract(metadata, '$.command') = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(sessionKey, command.slice(0, 200)) as { id: string } | undefined;
        if (lineagePrev) {
          causedByErrorId = lineagePrev.id;
          logToFile(`PostToolUse: LINEAGE — new error may be caused by fix on ${lineagePrev.id}`);
        }
      } catch {
        // Non-fatal
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
          // [Severity Classification] Impact level: blocker/critical/major/minor
          severity: severity,
          // [Feature 1] Structured fields (ReasoningBank + MNL)
          title: title,
          anti_pattern: antiPattern,
          correct_approach: correctApproach,
          // [P3: Root Cause Analysis] Extract root cause from stack trace (Experia pattern)
          root_cause: extractRootCause(truncatedError),
          // [Feature 5] Confidence/voting (ExpeL + Midas)
          confidence: 2,
          upvotes: 0,
          downvotes: 0,
          // [Feature 4] Success correlation
          resolved: false,
          // [Drift Detection] Track if this error was injected but still occurred
          drift_count: driftHit ? 1 : 0,
          last_drift_at: driftHit ? new Date().toISOString() : undefined,
          // [Fix Lineage] Link to the resolved error whose fix may have caused this
          caused_by_error_id: causedByErrorId ?? undefined,
          // [Goal-Linked Errors] Tag with current goal ID if set via env
          goal_id: process.env.TDAI_GOAL_ID ?? undefined,
          // [Fix Attempt Counter] Track how many attempts to fix (1 = first occurrence)
          attempt_count: 1,
          // [Fix Provenance Chain] Track where this error record came from
          fix_provenance: "auto_captured",
          // [Error Context Enrichment] Git context at error time (branch, commits, changed files)
          context_enrichment: captureGitContext(cwd),
          // [Auto-Annotation] System-generated notes based on initial error state
          auto_notes: generateAutoNotes({
            attempt_count: 1,
            severity,
            error_type: errorType,
          }),
        }),
      );

      db.close();

      logToFile(`PostToolUse: auto-captured ${errorType} error. id=${id}`);

      // [Error Correlation Engine] Check if a different error occurred in the last 10 minutes.
      // If so, record a correlation pair: E1 (previous) → E2 (this error).
      // When E1 recurs in the future, warn that E2 often follows.
      // (SRE pattern: incident correlation / cascading failure detection)
      try {
        const corrDb = new Database(dbPath);
        const recentErrors = corrDb
          .prepare(
            `SELECT id, json_extract(metadata, '$.error_type') as etype, json_extract(metadata, '$.title') as title
             FROM captures
             WHERE type = 'error' AND deleted_at IS NULL
             AND session_key = ?
             AND id != ?
             AND created_at > datetime('now', '-10 minutes')
             AND json_extract(metadata, '$.error_type') != ?
             ORDER BY created_at DESC LIMIT 3`,
          )
          .all(sessionKey, id, errorType) as { id: string; etype: string; title: string }[];

        for (const prev of recentErrors) {
          // Record correlation on the previous error
          const prevRow = corrDb
            .prepare("SELECT metadata FROM captures WHERE id = ?")
            .get(prev.id) as { metadata: string } | undefined;
          if (prevRow) {
            const prevMeta = JSON.parse(prevRow.metadata);
            const correlations = prevMeta.error_correlations ?? [];
            // Check if this correlation pair already exists
            const existing = correlations.find(
              (c: { next_error_type: string }) => c.next_error_type === errorType,
            );
            if (existing) {
              existing.count = (existing.count ?? 1) + 1;
              existing.last_seen = new Date().toISOString();
            } else {
              correlations.push({
                next_error_type: errorType,
                next_error_title: title.slice(0, 60),
                count: 1,
                first_seen: new Date().toISOString(),
                last_seen: new Date().toISOString(),
              });
            }
            prevMeta.error_correlations = correlations;
            corrDb
              .prepare("UPDATE captures SET metadata = ? WHERE id = ?")
              .run(JSON.stringify(prevMeta), prev.id);
          }
        }
        corrDb.close();
      } catch {
        // Non-fatal
      }

      // [Feature 7] Cross-project error pattern detection
      // Check if the same error type + similar command failed in other projects
      const patternAlert = detectCrossProjectPattern(dbPath, sessionKey, errorType, command);

      // [Feature 3] Self-reflection prompt (Reflexion pattern)
      // Inject a prompt asking the agent to reflect on the error
      const reflection = `[tdai-memory] Auto-captured ${errorType} error: ${title}

Anti-pattern: ${antiPattern}
Suggested fix: ${correctApproach}
${patternAlert ? `\n⚠️ CROSS-PROJECT PATTERN: ${patternAlert}` : ""}

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

      // [Pre-action matchers] Warn before dangerous commands
      // (AgentRecall pattern: check_action before publish/push/deploy/DROP TABLE)
      const dangerWarning = checkDangerousCommand(command);
      if (dangerWarning) {
        const output = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: dangerWarning,
          },
        };
        logToFile(`PreToolUse: DANGER warning for: ${command.slice(0, 80)}`);
        process.stdout.write(JSON.stringify(output));
        return;
      }

      // [Error Prediction] When editing a file, check if that file has error history.
      // Inject proactive warnings BEFORE the edit, not after the build fails.
      // (TDAD pattern: predict errors from file change history)
      if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
        const filePath = toolInput.file_path ?? toolInput.path ?? "";
        if (filePath && process.env.TDAI_PREDICTIVE_ERRORS === "1") {
          const cwd = input.cwd ?? process.cwd();
          const sessionKey = hashPath(cwd);
          try {
            const predDb = new Database(dbPath, { readonly: true });
            const basename = filePath.split("/").pop() ?? filePath;
            // Find errors that reference this file path or basename
            const fileErrors = predDb
              .prepare(
                `SELECT
                   json_extract(metadata, '$.title') as title,
                   json_extract(metadata, '$.error_type') as etype,
                   json_extract(metadata, '$.anti_pattern') as anti,
                   json_extract(metadata, '$.correct_approach') as fix,
                   json_extract(metadata, '$.resolved') as resolved,
                   created_at
                 FROM captures
                 WHERE type = 'error' AND deleted_at IS NULL
                 AND session_key = ?
                 AND created_at > datetime('now', '-30 days')
                 AND (content LIKE ? OR content LIKE ?)
                 ORDER BY created_at DESC LIMIT 3`,
              )
              .all(sessionKey, `%${basename}%`, `%${filePath}%`) as {
              title: string;
              etype: string;
              anti: string;
              fix: string;
              resolved: string;
              created_at: string;
            }[];
            predDb.close();

            if (fileErrors.length > 0) {
              const lines: string[] = [
                `[tdai-memory] File has error history — ${fileErrors.length} past error(s) on this file:`,
              ];
              for (const e of fileErrors) {
                const date = new Date(e.created_at).toISOString().split("T")[0];
                const title = (e.title ?? "Untitled").slice(0, 50);
                const resolved = e.resolved === "true" ? " ✓resolved" : "";
                lines.push(`- ${date} [${e.etype ?? "unknown"}]${resolved}: ${title}`);
                if (e.anti) lines.push(`  Anti-pattern: ${e.anti.slice(0, 80)}`);
                if (e.fix) lines.push(`  Correct approach: ${e.fix.slice(0, 80)}`);
              }
              lines.push("");
              lines.push("Avoid repeating these errors when editing this file.");

              const output = {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  additionalContext: lines.join("\n"),
                },
              };
              logToFile(
                `PreToolUse: PREDICTIVE — ${fileErrors.length} error(s) on file ${basename}, injected warning before edit`,
              );
              process.stdout.write(JSON.stringify(output));
              return;
            }
          } catch {
            // Non-fatal — prediction is supplementary
          }
        }

        // [Moat 3: Pattern Learning] Inject relevant code patterns before editing.
        // When editing a file, find patterns from the same project with same language.
        if (filePath) {
          try {
            const cwd = input.cwd ?? process.cwd();
            const sessionKey = hashPath(cwd);
            const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
            const langMap: Record<string, string> = {
              ts: "typescript",
              tsx: "typescript",
              js: "javascript",
              jsx: "javascript",
              py: "python",
              rs: "rust",
              go: "go",
              java: "java",
              rb: "ruby",
            };
            const language = langMap[ext] ?? "";
            if (language) {
              const patDb = new Database(dbPath, { readonly: true });
              const patterns = patDb
                .prepare(
                  `SELECT
                     json_extract(metadata, '$.title') as title,
                     json_extract(metadata, '$.pattern_type') as ptype,
                     json_extract(metadata, '$.signature') as sig,
                     json_extract(metadata, '$.file_path') as fpath,
                     json_extract(metadata, '$.seen_count') as seen,
                     json_extract(metadata, '$.confidence') as conf
                   FROM captures
                   WHERE type = 'pattern' AND deleted_at IS NULL
                   AND session_key = ?
                   AND json_extract(metadata, '$.language') = ?
                   AND json_extract(metadata, '$.file_path') != ?
                   ORDER BY CAST(json_extract(metadata, '$.confidence') AS INTEGER) DESC
                   LIMIT 3`,
                )
                .all(sessionKey, language, filePath) as {
                title: string;
                ptype: string;
                sig: string;
                fpath: string;
                seen: number;
                conf: number;
              }[];
              patDb.close();

              if (patterns.length > 0) {
                const lines: string[] = [
                  `[tdai-memory] ${patterns.length} code pattern(s) from this project (same language):`,
                ];
                for (const p of patterns) {
                  lines.push(`- [${p.ptype}] ${p.title}`);
                  if (p.sig) lines.push(`  signature: ${p.sig.slice(0, 60)}`);
                  if (p.fpath) lines.push(`  from: ${p.fpath}`);
                }
                lines.push("");
                lines.push("Follow these patterns for consistency.");

                const output = {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    additionalContext: lines.join("\n"),
                  },
                };
                logToFile(
                  `PreToolUse: PATTERN — ${patterns.length} pattern(s) injected before editing ${filePath}`,
                );
                process.stdout.write(JSON.stringify(output));
                return;
              }
            }
          } catch {
            // Non-fatal
          }
        }

        // For Write/Edit without patterns or predictive errors, just return
        process.stdout.write(JSON.stringify({}));
        return;
      }

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
      // [Feature 5] Global error injection — query all projects when TDAI_GLOBAL_ERRORS=1
      const globalErrors = process.env.TDAI_GLOBAL_ERRORS === "1";
      const sessionFilter = globalErrors ? "" : `AND session_key = ?`;
      const params = globalErrors ? [] : [sessionKey];

      const errors = db
        .prepare(
          `SELECT id, content, content_hash, tags, created_at, metadata, session_key FROM captures
           WHERE type = 'error' ${sessionFilter}
           AND deleted_at IS NULL
           AND created_at > datetime('now', '-30 days')
           AND json_extract(metadata, '$.resolved') IS NOT true
           ORDER BY
                    CASE json_extract(metadata, '$.severity')
                      WHEN 'blocker' THEN 0
                      WHEN 'critical' THEN 1
                      WHEN 'major' THEN 2
                      WHEN 'minor' THEN 3
                      ELSE 2
                    END,
                    CAST(json_extract(metadata, '$.confidence') AS INTEGER) DESC,
                    created_at DESC LIMIT 5`,
        )
        .all(...params) as {
        id: string;
        content: string;
        content_hash: string | null;
        tags: string | null;
        created_at: string;
        metadata: string;
        session_key: string;
      }[];

      db.close();

      // [Feature 9] Error-to-fix linking — fetch RESOLVED errors with fixes
      // This runs BEFORE the unresolved errors check so proven fixes are
      // injected even when there are no unresolved errors to warn about.
      // [P0: Harm gate] Skip fixes with fix_harm_count > 0 (caused regression)
      // [P0: A/B validation] Skip unvalidated fixes (stdout had error indicators)
      let resolvedFixes: {
        title: string;
        fix: string;
        date: string;
        resolvedAt: string;
        provenance: string;
        inherited: boolean;
        rollbackPlan: string | null;
        autoNotes: string[];
      }[] = [];
      try {
        const rDb = new Database(dbPath, { readonly: true });
        const resolved = rDb
          .prepare(
            `SELECT content, metadata, created_at, session_key FROM captures
             WHERE type = 'error' ${sessionFilter}
             AND deleted_at IS NULL
             AND json_extract(metadata, '$.resolved') = 1
             AND json_extract(metadata, '$.fix_applied') IS NOT NULL
             AND (json_extract(metadata, '$.fix_harm_count') IS NULL
                  OR CAST(json_extract(metadata, '$.fix_harm_count') AS INTEGER) = 0)
             AND (json_extract(metadata, '$.fix_validated') IS NULL
                  OR json_extract(metadata, '$.fix_validated') = 1)
             ORDER BY created_at DESC LIMIT 2`,
          )
          .all(...params) as {
          content: string;
          metadata: string;
          created_at: string;
          session_key: string;
        }[];

        resolvedFixes = resolved.map((r) => {
          const m = JSON.parse(r.metadata);
          return {
            title: m.title ?? "Untitled",
            fix: m.fix_applied ?? m.correct_approach ?? "",
            date: new Date(r.created_at).toISOString().split("T")[0],
            resolvedAt: m.resolved_at ?? r.created_at,
            provenance: m.fix_provenance ?? "auto_captured",
            inherited: r.session_key !== sessionKey,
            rollbackPlan: m.rollback_plan ?? null,
            autoNotes: m.auto_notes ?? [],
          };
        });

        // [Cross-Project Fix Inheritance] If we haven't filled 2 fix slots from
        // the current project, check OTHER projects for validated fixes matching
        // the same error type. Auto-inherit without user action.
        if (resolvedFixes.length < 2) {
          const inherited = rDb
            .prepare(
              `SELECT content, metadata, created_at, session_key FROM captures
               WHERE type = 'error' AND session_key != ?
               AND deleted_at IS NULL
               AND json_extract(metadata, '$.resolved') = 1
               AND json_extract(metadata, '$.fix_applied') IS NOT NULL
               AND (json_extract(metadata, '$.fix_harm_count') IS NULL
                    OR CAST(json_extract(metadata, '$.fix_harm_count') AS INTEGER) = 0)
               AND (json_extract(metadata, '$.fix_validated') IS NULL
                    OR json_extract(metadata, '$.fix_validated') = 1)
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(sessionKey, 2 - resolvedFixes.length) as {
            content: string;
            metadata: string;
            created_at: string;
            session_key: string;
          }[];

          for (const r of inherited) {
            const m = JSON.parse(r.metadata);
            resolvedFixes.push({
              title: m.title ?? "Untitled",
              fix: m.fix_applied ?? m.correct_approach ?? "",
              date: new Date(r.created_at).toISOString().split("T")[0],
              resolvedAt: m.resolved_at ?? r.created_at,
              provenance: "inherited",
              inherited: true,
              rollbackPlan: m.rollback_plan ?? null,
              autoNotes: m.auto_notes ?? [],
            });
          }
        }
        rDb.close();
      } catch {
        // non-fatal — fixes are bonus context
      }

      if (errors.length === 0 && resolvedFixes.length === 0) {
        // [Moat 2: Decision Learning] Even with no errors, inject past decisions
        // for relevant commands (npm install, git commit, etc.)
        try {
          const decDb = new Database(dbPath, { readonly: true });
          const lowerCmd = command.toLowerCase();
          let decQuery = "";
          const decParams: (string | number)[] = [sessionKey];

          if (
            lowerCmd.includes("npm install") ||
            lowerCmd.includes("pip install") ||
            lowerCmd.includes("cargo add")
          ) {
            decQuery = `SELECT json_extract(metadata, '$.title') as title,
                 json_extract(metadata, '$.choice') as choice,
                 json_extract(metadata, '$.rationale') as rationale,
                 created_at
               FROM captures
               WHERE type = 'decision' AND deleted_at IS NULL
               AND session_key = ?
               AND json_extract(metadata, '$.decision_type') = 'dependency'
               AND created_at > datetime('now', '-90 days')
               ORDER BY CAST(json_extract(metadata, '$.confidence') AS INTEGER) DESC LIMIT 3`;
          } else if (lowerCmd.includes("git commit")) {
            decQuery = `SELECT json_extract(metadata, '$.title') as title,
                 json_extract(metadata, '$.choice') as choice,
                 json_extract(metadata, '$.rationale') as rationale,
                 created_at
               FROM captures
               WHERE type = 'decision' AND deleted_at IS NULL
               AND session_key = ?
               AND json_extract(metadata, '$.decision_type') = 'commit'
               AND created_at > datetime('now', '-90 days')
               ORDER BY created_at DESC LIMIT 3`;
          }

          if (decQuery) {
            const decisions = decDb.prepare(decQuery).all(...decParams) as {
              title: string;
              choice: string;
              rationale: string;
              created_at: string;
            }[];

            if (decisions.length > 0) {
              const lines: string[] = [`[tdai-memory] Past decisions for similar commands:`];
              for (const d of decisions) {
                const date = new Date(d.created_at).toISOString().split("T")[0];
                lines.push(`- ${date}: ${d.title}`);
                if (d.rationale) lines.push(`  rationale: ${d.rationale.slice(0, 60)}`);
              }
              lines.push("");
              lines.push("Consider these past decisions before proceeding.");

              const output = {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  additionalContext: lines.join("\n"),
                },
              };
              decDb.close();
              logToFile(
                `PreToolUse: DECISION — ${decisions.length} decision(s) injected (no errors)`,
              );
              process.stdout.write(JSON.stringify(output));
              return;
            }
          }
          decDb.close();
        } catch {
          // non-fatal
        }
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

      if (validErrors.length === 0 && resolvedFixes.length === 0) {
        logToFile("PreToolUse: all past errors are stale and no proven fixes");
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // [Feature 8] Apply confidence decay at read time (Ebbinghaus curve)
      // Re-rank by decayed confidence, then take top 2 (k=2 optimal per ReasoningBank)
      const decayed = validErrors
        .map((err) => {
          const meta = JSON.parse(err.metadata);
          const base = meta.confidence ?? 2;
          const decayed = applyConfidenceDecay(base, err.created_at, meta.last_recurred);
          return { err, meta, decayedConfidence: decayed };
        })
        .sort((a, b) => b.decayedConfidence - a.decayedConfidence)
        .slice(0, 2);

      // Build structured warning context (ReasoningBank format)
      const lines: string[] = [`[tdai-memory] Past error to avoid repeating:`];
      for (const { err, meta, decayedConfidence } of decayed) {
        const date = new Date(err.created_at).toISOString().split("T")[0];
        const title = meta.title ?? "Untitled error";
        const antiPattern = meta.anti_pattern ?? "";
        const correctApproach = meta.correct_approach ?? "";
        const isOtherProject = err.session_key !== sessionKey;
        const escalationLevel = meta.escalation_level ?? 0;

        // [Error Escalation Policy] Stronger warning for escalated errors
        const escalationTag =
          escalationLevel >= 3
            ? " [BLOCKER — recurred 7+ times. Do NOT retry without a fundamentally different approach.]"
            : escalationLevel >= 2
              ? " [CRITICAL — recurred 5+ times. Previous fixes failed. Try a different approach.]"
              : escalationLevel >= 1
                ? " [ELEVATED — recurred 3+ times. Review previous fix attempts.]"
                : "";

        lines.push(
          `- ${date} [confidence=${decayedConfidence.toFixed(1)}]: ${title}${escalationTag}`,
        );
        if (isOtherProject) lines.push(`  (from another project — cross-project pattern)`);
        if (antiPattern) lines.push(`  Anti-pattern: ${antiPattern}`);
        // [P3: Root Cause Analysis] Show root cause if available (Experia pattern)
        if (meta.root_cause) lines.push(`  Root cause: ${meta.root_cause}`);
        if (correctApproach) lines.push(`  Fix: ${correctApproach}`);
        if (meta.resolved) lines.push(`  (Previously resolved — may recur)`);
        // [Error Context Enrichment] Show git context if available
        if (meta.context_enrichment) {
          const ctx = meta.context_enrichment;
          if (ctx.branch) lines.push(`  Context: branch=${ctx.branch}`);
          if (ctx.recent_commits?.[0]) lines.push(`  Last commit: ${ctx.recent_commits[0]}`);
        }
        // [Auto-Annotation] Show system-generated notes
        if (meta.auto_notes && Array.isArray(meta.auto_notes)) {
          for (const note of meta.auto_notes.slice(0, 3)) {
            lines.push(`  Note: ${note}`);
          }
        }
      }

      // [Feature 9] Inject proven fixes from resolved errors
      // [Fix Decay / Staleness] Warn when injecting fixes older than threshold
      // [Cross-Project Fix Inheritance] Show inherited tag for fixes from other projects
      // [Fix Provenance Chain] Show provenance tag
      // [Fix Rollback Plan] Show rollback plan if available
      if (resolvedFixes.length > 0) {
        lines.push("");
        lines.push("Proven fixes from past resolved errors:");
        const stalenessDays = Number(process.env.TDAI_FIX_STALENESS_DAYS ?? 180);
        const stalenessMs = stalenessDays * 86400000;
        for (const fix of resolvedFixes) {
          const fixAgeMs = Date.now() - new Date(fix.resolvedAt).getTime();
          const isStale = fixAgeMs > stalenessMs;
          const staleTag = isStale ? " [STALE — verify before applying]" : "";
          const inheritedTag = fix.inherited ? " [inherited from another project]" : "";
          const provenanceTag = fix.provenance !== "auto_captured" ? ` [${fix.provenance}]` : "";
          lines.push(
            `- ${fix.date}: ${fix.title} → ${fix.fix}${staleTag}${inheritedTag}${provenanceTag}`,
          );
          // [Fix Rollback Plan] Show rollback plan
          if (fix.rollbackPlan) {
            lines.push(`  Rollback: ${fix.rollbackPlan}`);
          }
          // [Auto-Annotation] Show notes for this fix
          if (fix.autoNotes && fix.autoNotes.length > 0) {
            for (const note of fix.autoNotes.slice(0, 2)) {
              lines.push(`  Note: ${note}`);
            }
          }
        }
      }

      lines.push("");
      lines.push("Fix these issues BEFORE running the command.");

      // [Moat 2: Decision Learning] Inject past decisions before relevant commands.
      // E.g., before `npm install`, inject past dependency decisions.
      try {
        const decDb = new Database(dbPath, { readonly: true });
        const lowerCmd = command.toLowerCase();
        let decQuery = "";
        const decParams: (string | number)[] = [sessionKey];

        if (
          lowerCmd.includes("npm install") ||
          lowerCmd.includes("pip install") ||
          lowerCmd.includes("cargo add")
        ) {
          // Inject dependency decisions
          decQuery = `SELECT json_extract(metadata, '$.title') as title,
               json_extract(metadata, '$.choice') as choice,
               json_extract(metadata, '$.rationale') as rationale,
               json_extract(metadata, '$.seen_count') as seen,
               created_at
             FROM captures
             WHERE type = 'decision' AND deleted_at IS NULL
             AND session_key = ?
             AND json_extract(metadata, '$.decision_type') = 'dependency'
             AND created_at > datetime('now', '-90 days')
             ORDER BY CAST(json_extract(metadata, '$.confidence') AS INTEGER) DESC LIMIT 3`;
        } else if (lowerCmd.includes("git commit")) {
          // Inject commit-encoded decisions
          decQuery = `SELECT json_extract(metadata, '$.title') as title,
               json_extract(metadata, '$.choice') as choice,
               json_extract(metadata, '$.rationale') as rationale,
               json_extract(metadata, '$.seen_count') as seen,
               created_at
             FROM captures
             WHERE type = 'decision' AND deleted_at IS NULL
             AND session_key = ?
             AND json_extract(metadata, '$.decision_type') = 'commit'
             AND created_at > datetime('now', '-90 days')
             ORDER BY created_at DESC LIMIT 3`;
        }

        if (decQuery) {
          const decisions = decDb.prepare(decQuery).all(...decParams) as {
            title: string;
            choice: string;
            rationale: string;
            seen: number;
            created_at: string;
          }[];
          decDb.close();

          if (decisions.length > 0) {
            lines.push("");
            lines.push("Past decisions for similar commands:");
            for (const d of decisions) {
              const date = new Date(d.created_at).toISOString().split("T")[0];
              lines.push(`- ${date}: ${d.title}`);
              if (d.rationale) lines.push(`  rationale: ${d.rationale.slice(0, 60)}`);
            }
          }
        }
      } catch {
        // non-fatal
      }

      const context = lines.join("\n");
      const k = decayed.length;
      logToFile(
        `PreToolUse: injected ${k} past error(s) (k=${k}, decayed confidence, ${resolvedFixes.length} fixes) before: ${command.slice(0, 60)}`,
      );

      // [Drift Detection] Log each injected error so PostToolUse can detect
      // if the agent ignored the warning and hit the same error again.
      for (const { err } of decayed) {
        if (err.content_hash) {
          logDriftInjection(sessionKey, err.content_hash, err.id, command);
        }
      }

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

/**
 * Noise filter: detect commands that are not worth capturing as errors.
 * These are typically test commands, intentional failures, or one-off probes.
 */
function isNoiseCommand(command: string): boolean {
  const lower = command.toLowerCase().trim();
  // Nonexistent/test file paths
  if (/\/nonexistent|\/tmp\/test|\/test\/fake|example\.ts|foo\.ts|bar\.ts/.test(lower)) return true;
  // Explicit test markers in the command itself
  if (/^echo\s+/.test(lower)) return true;
  // Very short commands that are just probes (ls <fake>, cat <fake>)
  if (/^ls\s+\/[a-z_]+$/.test(lower) && lower.length < 30) return true;
  return false;
}

/**
 * [Pre-action matchers] Check if a command is dangerous and return a warning.
 * (AgentRecall pattern: check_action before publish/push/deploy/DROP TABLE)
 * Returns a warning string if the command is dangerous, or null if safe.
 */
function checkDangerousCommand(command: string): string | null {
  const lower = command.toLowerCase();

  // git push --force / git push -f (without branch = force push ALL branches)
  if (/git\s+push\s+(--force|-f|--force-with-lease)/.test(lower)) {
    const hasBranch = /git\s+push\s+\S+\s+\S+/.test(command);
    return hasBranch
      ? `[tdai-memory] ⚠ DANGER: git push --force detected.\n` +
          `This rewrites remote history and can destroy others' commits.\n` +
          `Only do this on your own branch. Use --force-with-lease for safer force push.`
      : `[tdai-memory] ⚠ DANGER: git push --force WITHOUT a branch name.\n` +
          `This force-pushes ALL branches. This is almost certainly a mistake.\n` +
          `Specify the branch: git push --force origin <branch>`;
  }

  // rm -rf with broad paths
  if (/rm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r?)\s+/.test(lower)) {
    const target = lower.replace(/.*rm\s+-[a-z]*\s+/, "").trim();
    // Dangerous targets: /, /*, ~, *, ., .., /home, /usr, /var, /etc
    const dangerousTargets = /^(\/|~|\*|\.\.?$|\/home|\/usr|\/var|\/etc|\/bin|\/sbin|\/boot)/;
    if (dangerousTargets.test(target)) {
      return (
        `[tdai-memory] ⚠ DANGER: rm -rf on a critical path: ${target.slice(0, 60)}\n` +
        `This can destroy the filesystem, home directory, or system files.\n` +
        `Verify the path is correct before proceeding.`
      );
    }
  }

  // DROP TABLE / DROP DATABASE / TRUNCATE (SQL)
  if (/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(command)) {
    const match = command.match(
      /\b(drop\s+(?:table|database|schema)\s+\S+|truncate\s+table\s+\S+)/i,
    );
    const target = match ? match[1] : "unknown";
    return (
      `[tdai-memory] ⚠ DANGER: SQL destructive operation detected: ${target.slice(0, 60)}\n` +
      `This permanently deletes data. Ensure you have a backup and are in the right environment.`
    );
  }

  // DELETE FROM without WHERE clause
  if (
    /\bdelete\s+from\s+\S+\s*;?\s*$/i.test(command) ||
    /\bdelete\s+from\s+\S+\s*$/i.test(command)
  ) {
    return (
      `[tdai-memory] ⚠ DANGER: DELETE FROM without a WHERE clause.\n` +
      `This deletes ALL rows in the table. Add a WHERE clause to limit the deletion.`
    );
  }

  // npm publish (production publish)
  if (/^npm\s+publish\b/.test(lower)) {
    return (
      `[tdai-memory] ⚠ CAUTION: npm publish detected.\n` +
      `This publishes a package to the npm registry. Verify:\n` +
      `  - The version number is correct (check package.json)\n` +
      `  - You are publishing the right package\n` +
      `  - The package is not already published at this version`
    );
  }

  // docker system prune / docker volume rm
  if (/docker\s+(system\s+prune|volume\s+rm|container\s+rm\s+-f|image\s+rm\s+-f)/.test(lower)) {
    return (
      `[tdai-memory] ⚠ DANGER: Docker destructive command detected.\n` +
      `This can remove containers, volumes, or images that are in use.\n` +
      `Verify you are not deleting production resources.`
    );
  }

  // kubectl delete namespace / kubectl delete -f (production)
  if (/kubectl\s+delete\s+(namespace|ns)\b/.test(lower)) {
    return (
      `[tdai-memory] ⚠ DANGER: kubectl delete namespace detected.\n` +
      `This deletes ALL resources in the namespace (pods, services, configs).\n` +
      `Verify this is not a production namespace.`
    );
  }

  return null;
}

/**
 * [Error Context Enrichment] Capture git context at error time.
 * Records branch, recent commits, and changed files to help diagnose
 * WHY an error occurred (regression? branch-specific? recent commit?).
 * All automatic — no user action needed.
 */
function captureGitContext(cwd: string): {
  branch: string;
  recent_commits: string[];
  changed_files: string[];
} | null {
  try {
    const branch = execSync("git branch --show-current", {
      cwd,
      timeout: 2000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const commits = execSync("git log -3 --oneline", {
      cwd,
      timeout: 2000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split("\n")
      .filter(Boolean);

    const changed = execSync("git diff --name-only HEAD~1", {
      cwd,
      timeout: 2000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(0, 10);

    return { branch, recent_commits: commits, changed_files: changed };
  } catch {
    return null; // Not a git repo or git not available — non-fatal
  }
}

/**
 * [Fix Rollback Plan] Auto-generate a rollback plan when a fix is recorded.
 * Uses simple heuristics based on the fix text and command.
 * All automatic — no user action needed.
 */
function generateRollbackPlan(command: string, fixApplied: string): string | null {
  const lowerFix = (fixApplied || "").toLowerCase();
  const lowerCmd = (command || "").toLowerCase();

  // If fix involves file edit
  if (lowerFix.includes("import") || lowerFix.includes("added") || lowerFix.includes("modified")) {
    return "git checkout <file> to revert the edit, then re-run the command";
  }
  // If fix involves config change
  if (lowerFix.includes("config") || lowerFix.includes(".env") || lowerFix.includes("setting")) {
    return "git revert <commit> to undo the config change";
  }
  // If fix involves dependency
  if (
    lowerFix.includes("install") ||
    lowerFix.includes("package") ||
    lowerCmd.includes("npm install")
  ) {
    return "git checkout package.json package-lock.json && npm install to revert dependency change";
  }
  // If fix involves migration
  if (lowerFix.includes("migration") || lowerFix.includes("migrate")) {
    return "Run the down migration or git revert <commit> to undo schema change";
  }
  // Default
  return null;
}

/**
 * [Auto-Annotation] Generate system notes based on error state.
 * All automatic — no user action needed. Notes are derived from:
 * recurrence count, severity, escalation level, correlations, context.
 */
function generateAutoNotes(meta: {
  attempt_count?: number;
  severity?: string;
  escalation_level?: number;
  error_type?: string;
  resolved?: boolean;
  fix_validated?: boolean;
  drift_count?: number;
}): string[] {
  const notes: string[] = [];

  if ((meta.attempt_count ?? 0) >= 5) {
    notes.push(
      `Stubborn error: ${meta.attempt_count} attempts — needs fundamentally different approach`,
    );
  } else if ((meta.attempt_count ?? 0) >= 3) {
    notes.push(
      `Recurring error: ${meta.attempt_count} attempts — previous fixes may be insufficient`,
    );
  }

  if (meta.severity === "blocker") {
    notes.push("Blocker severity — this error blocks all work");
  } else if (meta.severity === "critical") {
    notes.push("Critical severity — config/security/data involved");
  }

  if ((meta.escalation_level ?? 0) >= 2) {
    notes.push(
      `Escalated to level ${meta.escalation_level} — auto-bumped severity due to recurrence`,
    );
  }

  if (meta.resolved && meta.fix_validated) {
    notes.push("Fix validated — proven to work with clean stdout");
  } else if (meta.resolved && !meta.fix_validated) {
    notes.push("Fix applied but NOT validated — stdout contained error indicators");
  }

  if ((meta.drift_count ?? 0) >= 2) {
    notes.push(`Drift detected: agent ignored warning ${meta.drift_count} times`);
  }

  return notes;
}

/**
 * [Moat 2: Decision Learning] Detect decisions from successful commands.
 * Captures dependency choices, config decisions, and commit-encoded decisions.
 * All automatic — no user action needed.
 */
function detectDecision(
  command: string,
  stdout: string,
): { title: string; decision_type: string; choice: string; rationale: string } | null {
  const lower = command.toLowerCase();

  // Dependency install decisions
  const npmMatch = command.match(/npm\s+install\s+(?:-S\s+|--save\s+)?(@?[a-z0-9][\w@./-]*)/i);
  if (npmMatch) {
    const pkg = npmMatch[1];
    return {
      title: `Chose to use ${pkg}`,
      decision_type: "dependency",
      choice: pkg,
      rationale: `Installed ${pkg} as a dependency`,
    };
  }

  const pipMatch = command.match(/pip\s+install\s+([a-z0-9][\w.-]*)/i);
  if (pipMatch) {
    const pkg = pipMatch[1];
    return {
      title: `Chose to use ${pkg}`,
      decision_type: "dependency",
      choice: pkg,
      rationale: `Installed ${pkg} via pip`,
    };
  }

  const cargoMatch = command.match(/cargo\s+add\s+([a-z0-9][\w-]*)/i);
  if (cargoMatch) {
    const pkg = cargoMatch[1];
    return {
      title: `Chose to use ${pkg}`,
      decision_type: "dependency",
      choice: pkg,
      rationale: `Added ${pkg} to Cargo.toml`,
    };
  }

  // Git commit decisions (extract from commit message)
  const commitMatch = command.match(/git\s+commit\s+.*-m\s+["'](.+?)["']/i);
  if (commitMatch) {
    const msg = commitMatch[1].slice(0, 100);
    // Only capture if message looks like a decision
    if (/chose|selected|decided|switched|replaced|migrated|refactored|adopted/i.test(msg)) {
      return {
        title: `Decision: ${msg.slice(0, 60)}`,
        decision_type: "commit",
        choice: msg,
        rationale: "Encoded in git commit",
      };
    }
  }

  // Config file creation (implies architecture decision)
  if (
    /touch\s+.*\.(env|config|yaml|yml|toml|ini)$/i.test(command) ||
    /echo.*>.*\.(env|config|yaml|yml|toml)$/i.test(command)
  ) {
    const fileMatch = command.match(/([\w.-]+\.(?:env|config|yaml|yml|toml|ini))/i);
    if (fileMatch) {
      return {
        title: `Created config: ${fileMatch[1]}`,
        decision_type: "config",
        choice: fileMatch[1],
        rationale: "Config file creation implies architecture decision",
      };
    }
  }

  return null;
}

/**
 * [Moat 3: Pattern Learning] Detect code patterns from Write/Edit tools.
 * Captures function signatures, import structures, and component patterns.
 * All automatic — no user action needed.
 */
function detectPattern(
  toolName: string,
  toolInput: { content?: string; old_string?: string; new_string?: string; file_path?: string },
): {
  title: string;
  pattern_type: string;
  language: string;
  signature: string;
  file_path: string;
} | null {
  const filePath = toolInput.file_path ?? "";
  const content = toolInput.content ?? toolInput.new_string ?? "";
  if (!content || !filePath) return null;

  // Detect language from file extension
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    rb: "ruby",
  };
  const language = langMap[ext] ?? "unknown";
  if (language === "unknown") return null;

  // Extract function/method signatures
  const fnMatch = content.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
  if (fnMatch) {
    return {
      title: `Function pattern: ${fnMatch[1]}(${fnMatch[2].slice(0, 40)})`,
      pattern_type: "function",
      language,
      signature: `${fnMatch[1]}(${fnMatch[2].slice(0, 60)})`,
      file_path: filePath,
    };
  }

  // Extract React component patterns
  const compMatch = content.match(
    /(?:export\s+)?(?:const|function)\s+(\w+)\s*[=:]\s*(?:\([^)]*\)|function)\s*=>?\s*[{<]/,
  );
  if (compMatch && ext === "tsx") {
    return {
      title: `Component pattern: ${compMatch[1]}`,
      pattern_type: "component",
      language,
      signature: compMatch[1],
      file_path: filePath,
    };
  }

  // Extract class patterns
  const classMatch = content.match(/(?:export\s+)?class\s+(\w+)/);
  if (classMatch) {
    return {
      title: `Class pattern: ${classMatch[1]}`,
      pattern_type: "class",
      language,
      signature: classMatch[1],
      file_path: filePath,
    };
  }

  // Extract import patterns (only if significant)
  const importMatches = content.match(/^import\s+.*$/gm);
  if (importMatches && importMatches.length >= 3) {
    const imports = importMatches.slice(0, 5).join("; ").slice(0, 80);
    return {
      title: `Import pattern (${importMatches.length} imports)`,
      pattern_type: "imports",
      language,
      signature: imports,
      file_path: filePath,
    };
  }

  return null;
}

/**
 * [Feature 7] Cross-project error pattern detection.
 * Checks if the same error type + similar command root failed in other projects.
 * Returns an alert string if a pattern is found, or null if not.
 */
function detectCrossProjectPattern(
  dbPath: string,
  currentSessionKey: string,
  errorType: string,
  command: string,
): string | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    // Extract command root (e.g. "npm run build" → "npm build", "npx tsc" → "tsc")
    const cmdRoot = extractCommandRoot(command);

    // Find same error_type in OTHER session keys (last 30 days)
    const others = db
      .prepare(
        `SELECT session_key, content, metadata, created_at FROM captures
         WHERE type = 'error' AND session_key != ?
         AND deleted_at IS NULL
         AND created_at > datetime('now', '-30 days')
         AND json_extract(metadata, '$.error_type') = ?
         ORDER BY created_at DESC LIMIT 10`,
      )
      .all(currentSessionKey, errorType) as {
      session_key: string;
      content: string;
      metadata: string;
      created_at: string;
    }[];

    db.close();

    if (others.length < 2) return null;

    // Check if any have a similar command root
    const matching = others.filter((o) => {
      try {
        const meta = JSON.parse(o.metadata);
        return extractCommandRoot(meta.command ?? "") === cmdRoot;
      } catch {
        return false;
      }
    });

    if (matching.length >= 2) {
      const projects = new Set(matching.map((m) => m.session_key.slice(0, 8)));
      return `This ${errorType} error on "${cmdRoot}" also occurred in ${matching.length} other session(s) across ${projects.size} project(s). This is a recurring pattern — check if there's a systemic cause.`;
    }

    // Same error type in 3+ different projects (even if different command)
    if (others.length >= 3) {
      const projects = new Set(others.map((o) => o.session_key.slice(0, 8)));
      if (projects.size >= 3) {
        return `${errorType} errors are appearing across ${projects.size} projects (${others.length} total). Consider reviewing common dependencies or shared configurations.`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Extract the command root for pattern matching (e.g. "npm run build" → "npm build"). */
function extractCommandRoot(command: string): string {
  const parts = command.trim().split(/\s+/);
  // Skip "run" and "exec" subcommands
  const filtered = parts.filter((p) => p !== "run" && p !== "exec" && p !== "--");
  return filtered.slice(0, 3).join(" ").toLowerCase();
}

/**
 * [Feature 8] Error confidence decay (Ebbinghaus forgetting curve).
 * Errors that haven't recurred in a while should decay, making room for fresh ones.
 * Decay formula: confidence *= 0.95^(days_since_last_seen)
 * Applied at read time (PreToolUse) to avoid write overhead.
 */
function applyConfidenceDecay(
  baseConfidence: number,
  createdAt: string,
  lastRecurred?: string,
): number {
  const referenceDate = lastRecurred ? new Date(lastRecurred) : new Date(createdAt);
  const daysSince = (Date.now() - referenceDate.getTime()) / (1000 * 60 * 60 * 24);
  // Decay: 0.95^days. After 14 days → 0.49x. After 30 days → 0.21x.
  const decayFactor = 0.95 ** daysSince;
  return Math.round(baseConfidence * decayFactor * 100) / 100;
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
  // Check for JS runtime errors first (TypeError, ReferenceError, etc.)
  // before typecheck to avoid misclassification
  if (
    lower.includes("typeerror") ||
    lower.includes("referenceerror") ||
    lower.includes("syntaxerror") ||
    lower.includes("rangeerror")
  )
    return "runtime";
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
 * [Severity Classification] Classify error severity based on impact signals.
 * blocker:  data destruction, security, agent cannot proceed (deploy/publish failures)
 * critical: core config files, env files, database operations
 * major:    build/test/typecheck failures (blocks development)
 * minor:    lint/format warnings (non-blocking)
 */
function classifySeverity(command: string, errorType: string, errorOutput: string): string {
  const lowerCmd = command.toLowerCase();
  const lowerErr = errorOutput.toLowerCase();

  // Blocker: deploy/publish/release failures, data destruction
  if (
    lowerCmd.includes("deploy") ||
    lowerCmd.includes("publish") ||
    lowerCmd.includes("release") ||
    lowerErr.includes("fatal") ||
    lowerErr.includes("panic") ||
    lowerErr.includes("segfault") ||
    lowerErr.includes("out of memory") ||
    lowerErr.includes("disk full")
  ) {
    return "blocker";
  }

  // Critical: config/env/database/security errors
  if (
    lowerErr.includes(".env") ||
    lowerErr.includes("config") ||
    lowerErr.includes("permission denied") ||
    lowerErr.includes("eacces") ||
    lowerErr.includes("database") ||
    lowerErr.includes("migration") ||
    lowerErr.includes("authentication") ||
    lowerErr.includes("unauthorized") ||
    lowerErr.includes("certificate")
  ) {
    return "critical";
  }

  // Major: build/test/typecheck/runtime failures (blocks development)
  if (
    errorType === "build" ||
    errorType === "test" ||
    errorType === "typecheck" ||
    errorType === "runtime" ||
    errorType === "import" ||
    errorType === "permission"
  ) {
    return "major";
  }

  // Minor: lint/format warnings (non-blocking)
  if (errorType === "lint" || errorType === "format" || errorType === "file-not-found") {
    return "minor";
  }

  return "major";
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
 * [P3: Root Cause Analysis] Extract root cause from error stack trace.
 * (Experia pattern: Root Cause Analysis)
 * Looks for the most specific error line in a stack trace.
 */
function extractRootCause(errorOutput: string): string {
  const lines = errorOutput.split("\n").filter((l) => l.trim());

  // Pattern 1: "Error: <message>" or "TypeError: <message>"
  const errorLine = lines.find((l) => /^\s*(\w+Error|Error):/.test(l));
  if (errorLine) return errorLine.trim().slice(0, 200);

  // Pattern 2: "at <function> (<file>:<line>:<col>)" — last frame is usually the root
  const stackFrame = lines.find((l) => /^\s*at\s/.test(l));
  if (stackFrame) return stackFrame.trim().slice(0, 200);

  // Pattern 3: First non-empty line with "error" or "fail"
  const genericLine = lines.find((l) => /error|fail|cannot|missing/i.test(l));
  if (genericLine) return genericLine.trim().slice(0, 200);

  // Fallback: first non-empty line
  return (lines[0] ?? "").trim().slice(0, 200);
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
export function hashPath(path: string): string {
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
async function captureSessionTranscript(
  dbPath: string,
  sessionId?: string,
  transcriptPath?: string | null,
): Promise<string | null> {
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
          !step.message.startsWith("Code was changed") &&
          !step.message.startsWith("<!-- ") &&
          !step.message.startsWith("# LoopX") &&
          !step.message.includes("loopx-managed-slash-command")
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
        // Skip skill/system injections (LoopX, agent rules, etc.)
        if (
          text.startsWith("<!-- ") ||
          text.startsWith("# LoopX") ||
          text.includes("loopx-managed-slash-command")
        )
          continue;

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

  // Skip trivial sessions: no assistant response, or very short probe messages
  const totalUserChars = userMessages.reduce((sum, m) => sum + m.length, 0);
  const totalAssistantChars = assistantMessages.reduce((sum, m) => sum + m.length, 0);
  const totalChars = totalUserChars + totalAssistantChars;
  const isTrivial =
    (userMessages.length <= 2 && assistantMessages.length === 0) ||
    (userMessages.length <= 2 && totalChars < 10);
  if (isTrivial) {
    logToFile(
      `Stop: trivial session (${userMessages.length} user msgs, ${totalChars} chars total), skipping auto-capture`,
    );
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

  // Generate embedding for vector search (best-effort, non-blocking)
  try {
    sqliteVec.load(db);
    const { LocalEmbedder } =
      require("./embedding/local.js") as typeof import("./embedding/local.js");
    const embedder = new LocalEmbedder();
    const embedding = await embedder.embed(content);
    if (embedding) {
      const buffer = new Float32Array(embedding);
      db.prepare("INSERT INTO captures_vec (id, embedding) VALUES (?, ?)").run(
        id,
        Buffer.from(buffer.buffer),
      );
    }
  } catch (embedErr) {
    logToFile(`Stop: embedding failed for ${id}: ${embedErr}`);
  }

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

      captureSessionTranscript(dbPath, sessionId, transcriptPath)
        .then((id) => {
          if (id) {
            logToFile(`SessionEnd: captured via shared function. id=${id}`);
          }
        })
        .catch((err) => {
          logToFile(`SessionEnd: capture error - ${err}`);
        })
        .finally(() => {
          process.stdout.write(JSON.stringify({}));
        });
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
    const id = await captureSessionTranscript(dbPath, sessionId, transcriptPath);
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
