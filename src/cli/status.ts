import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

function defaultDbPath(): string {
  return (
    process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db")
  );
}

/**
 * `tdai-memory-mcp status` — One unified dashboard.
 *
 * Replaces running `stats` + `errors` + `decisions` + `patterns` + `doctor` separately.
 * Shows: health, all 3 learning loops, recent activity — in one screen.
 *
 * This is the daily check-in command for users who don't want to remember 40 subcommands.
 */
export function status(dbPath: string = defaultDbPath()): void {
  const bar = "═".repeat(60);
  console.log("\n" + bar);
  console.log("  tdai-memory-mcp status");
  console.log(bar + "\n");

  // 1. Health check
  const dbExists = existsSync(dbPath);
  const dbSize = dbExists ? statSync(dbPath).size : 0;

  console.log("Health:");
  console.log(`  Database:  ${dbExists ? "✓ exists" : "✗ not found"}`);
  if (dbExists) {
    console.log(`  Size:      ${(dbSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  Path:      ${dbPath}`);
  } else {
    console.log("\n  No database yet. Run `tdai-memory-mcp setup` to get started.");
    console.log(bar + "\n");
    return;
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("  ✗ Could not open database.");
    console.log(bar + "\n");
    return;
  }

  // 2. Overall totals
  const total = db.prepare("SELECT COUNT(*) as c FROM captures WHERE deleted_at IS NULL").get() as {
    c: number;
  };
  const sessions = db
    .prepare("SELECT COUNT(DISTINCT session_key) as c FROM captures WHERE deleted_at IS NULL")
    .get() as { c: number };
  const newest = db
    .prepare("SELECT MAX(created_at) as ts FROM captures WHERE deleted_at IS NULL")
    .get() as { ts: number | null };

  console.log(`\nMemory:  ${total.c} captures across ${sessions.c} project(s)`);
  if (newest.ts) {
    const date = new Date(newest.ts).toISOString().split("T")[0];
    console.log(`         last activity: ${date}`);
  }

  // 3. Three learning loops — one line each
  const errorCount = db
    .prepare(`SELECT COUNT(*) as c FROM captures WHERE type = 'error' AND deleted_at IS NULL`)
    .get() as { c: number };
  const errorResolved = db
    .prepare(
      `SELECT COUNT(*) as c FROM captures WHERE type = 'error' AND deleted_at IS NULL
       AND json_extract(metadata, '$.resolved') = 1`,
    )
    .get() as { c: number };
  const decisionCount = db
    .prepare(`SELECT COUNT(*) as c FROM captures WHERE type = 'decision' AND deleted_at IS NULL`)
    .get() as { c: number };
  const patternCount = db
    .prepare(`SELECT COUNT(*) as c FROM captures WHERE type = 'pattern' AND deleted_at IS NULL`)
    .get() as { c: number };

  console.log("\nLearning loops:");
  const errRate = errorCount.c > 0 ? Math.round((errorResolved.c / errorCount.c) * 100) : 0;
  console.log(`  Errors     ${String(errorCount.c).padStart(4)}  (${errRate}% resolved)`);
  console.log(`  Decisions  ${String(decisionCount.c).padStart(4)}`);
  console.log(`  Patterns   ${String(patternCount.c).padStart(4)}`);

  // 4. Recent activity (last 5 captures of any type)
  const recent = db
    .prepare(
      `SELECT id, type, content, tags, created_at, metadata FROM captures
       WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 5`,
    )
    .all() as {
    id: string;
    type: string;
    content: string;
    tags: string;
    created_at: number;
    metadata: string;
  }[];

  if (recent.length > 0) {
    console.log("\nRecent activity:");
    for (const r of recent) {
      const date = new Date(r.created_at).toISOString().split("T")[0];
      let title = r.content.slice(0, 50).replace(/\n/g, " ");
      // Try to extract a cleaner title from metadata
      try {
        const meta = JSON.parse(r.metadata);
        if (meta.title) title = String(meta.title).slice(0, 50);
      } catch {
        // keep raw content
      }
      const typeTag = r.type.padEnd(10);
      console.log(`  ${date}  ${typeTag}  ${title}${r.content.length > 50 ? "..." : ""}`);
    }
  } else {
    console.log("\nNo captures yet. Use your agent normally — memory builds up automatically.");
  }

  // 5. Top error types (if any)
  if (errorCount.c > 0) {
    const topErrors = db
      .prepare(
        `SELECT json_extract(metadata, '$.error_type') as etype, COUNT(*) as c
         FROM captures WHERE type = 'error' AND deleted_at IS NULL
         AND created_at > datetime('now', '-30 days')
         GROUP BY etype ORDER BY c DESC LIMIT 3`,
      )
      .all() as { etype: string; c: number }[];

    if (topErrors.length > 0) {
      console.log("\nTop error types (last 30 days):");
      for (const row of topErrors) {
        const ebar = "█".repeat(Math.min(row.c, 20));
        console.log(`  ${(row.etype ?? "unknown").padEnd(14)} ${ebar} ${row.c}`);
      }
    }
  }

  // 6. Next steps
  console.log("\n" + "─".repeat(60));
  if (total.c === 0) {
    console.log("  Get started: use your agent normally. Memory builds up automatically.");
  } else if (errorCount.c > 0) {
    console.log("  Drill down:  tdai-memory-mcp errors    (full error dashboard)");
  }
  if (decisionCount.c > 0) {
    console.log("  Drill down:  tdai-memory-mcp decisions (decision dashboard)");
  }
  if (patternCount.c > 0) {
    console.log("  Drill down:  tdai-memory-mcp patterns  (pattern dashboard)");
  }
  console.log("  Full list:   tdai-memory-mcp help all");
  console.log(bar + "\n");

  db.close();
}
