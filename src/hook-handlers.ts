import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Hook handler for SessionStart event.
 * Reads JSON from stdin (Devin CLI hook payload), queries the memory DB
 * for recent captures, and outputs additionalContext JSON on stdout.
 *
 * This is called by the agent's hook system, not by the MCP server.
 */
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
      const sessionKey = input.session_id
        ? input.session_id.slice(0, 16)
        : undefined;

      // Query recent captures from the DB
      const db = new Database(dbPath, { readonly: true });

      // Try with session_key first, then fall back to all captures
      const baseSql = `
        SELECT id, type, content, tags, created_at
        FROM captures
        WHERE type IN ('decision', 'learning', 'error', 'task')
      `;

      let rows: { id: string; type: string; content: string; tags: string | null; created_at: number }[] = [];

      if (sessionKey) {
        rows = db.prepare(baseSql + " AND session_key = ? ORDER BY created_at DESC LIMIT 10").all(sessionKey) as typeof rows;
      }

      // If no results with session_key, query all captures
      if (rows.length === 0) {
        rows = db.prepare(baseSql + " ORDER BY created_at DESC LIMIT 10").all() as typeof rows;
      }

      db.close();

      if (rows.length === 0) {
        // No memory — output empty context
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // Build context text
      const lines: string[] = ["[tdai-memory] Recent project memory:"];
      for (const row of rows) {
        const date = new Date(row.created_at).toISOString().split("T")[0];
        const tags = row.tags ? JSON.parse(row.tags) as string[] : [];
        const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
        // Truncate content to 200 chars for context injection
        const content = row.content.length > 200
          ? `${row.content.slice(0, 200)}...`
          : row.content;
        lines.push(`- (${row.type}${tagStr}) ${date}: ${content}`);
      }

      lines.push("");
      lines.push("Use these memories to inform your work. Call recall() for more details.");

      const context = lines.join("\n");

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
      process.stdout.write(JSON.stringify({}));
    }
  });
}

/**
 * Hook handler for Stop event.
 * Outputs additionalContext telling the agent to call handoff before stopping.
 */
export function hookStop(): void {
  // Read stdin (we need to consume it even if we don't use it)
  const chunks: Buffer[] = [];
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  process.stdin.on("end", () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext:
          "[tdai-memory] Before you stop, call the handoff tool to save context for the next session. " +
          "Include: task, status, progress, decisions, files, and next_steps. " +
          "Skip handoff only if the task was trivial.",
      },
    };

    process.stdout.write(JSON.stringify(output));
  });
}
