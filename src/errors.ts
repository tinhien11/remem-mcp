import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

/** Default DB path (matches index.ts). */
function defaultDbPath(): string {
  return (
    process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db")
  );
}

/**
 * `tdai-memory-mcp errors` — Error learning dashboard.
 * Shows: top recurring error patterns, resolution rate, cross-project patterns,
 * confidence distribution, and recent errors.
 *
 * This is the user-facing surface for the error learning moat.
 */
export function errors(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors — Error Learning Dashboard\n");
  console.log(`${"─".repeat(60)}\n`);

  // 1. Summary stats
  const total = db
    .prepare(`SELECT COUNT(*) as c FROM captures WHERE type = 'error' AND deleted_at IS NULL`)
    .get() as { c: number };
  const resolved = db
    .prepare(
      `SELECT COUNT(*) as c FROM captures WHERE type = 'error' AND deleted_at IS NULL
       AND json_extract(metadata, '$.resolved') = true`,
    )
    .get() as { c: number };
  const last30 = db
    .prepare(
      `SELECT COUNT(*) as c FROM captures WHERE type = 'error' AND deleted_at IS NULL
       AND created_at > datetime('now', '-30 days')`,
    )
    .get() as { c: number };

  const resolutionRate = total.c > 0 ? ((resolved.c / total.c) * 100).toFixed(1) : "0.0";
  console.log("Summary:");
  console.log(`  Total errors captured: ${total.c}`);
  console.log(`  Last 30 days: ${last30.c}`);
  console.log(`  Resolved: ${resolved.c} (${resolutionRate}% resolution rate)`);
  console.log();

  // 2. Top recurring error types
  const byType = db
    .prepare(
      `SELECT json_extract(metadata, '$.error_type') as etype, COUNT(*) as c
       FROM captures WHERE type = 'error' AND deleted_at IS NULL
       AND created_at > datetime('now', '-30 days')
       GROUP BY etype ORDER BY c DESC LIMIT 5`,
    )
    .all() as { etype: string; c: number }[];

  if (byType.length > 0) {
    console.log("Top error types (last 30 days):");
    for (const row of byType) {
      const bar = "█".repeat(Math.min(row.c, 30));
      console.log(`  ${(row.etype ?? "unknown").padEnd(15)} ${bar} ${row.c}`);
    }
    console.log();
  }

  // 3. Top recurring commands (cross-project patterns)
  const byCommand = db
    .prepare(
      `SELECT json_extract(metadata, '$.command') as cmd, COUNT(*) as c,
              COUNT(DISTINCT session_key) as projects
       FROM captures WHERE type = 'error' AND deleted_at IS NULL
       AND created_at > datetime('now', '-30 days')
       GROUP BY cmd HAVING c >= 2
       ORDER BY c DESC LIMIT 5`,
    )
    .all() as { cmd: string; c: number; projects: number }[];

  if (byCommand.length > 0) {
    console.log("Recurring error patterns (cross-project):");
    for (const row of byCommand) {
      const cmd = (row.cmd ?? "unknown").slice(0, 40);
      const projectTag = row.projects > 1 ? ` [${row.projects} projects]` : "";
      console.log(`  ${cmd.padEnd(40)} ×${row.c}${projectTag}`);
    }
    console.log();
  }

  // 4. Confidence distribution
  const confBuckets = db
    .prepare(
      `SELECT
         SUM(CASE WHEN CAST(json_extract(metadata, '$.confidence') AS INTEGER) >= 4 THEN 1 ELSE 0 END) as high,
         SUM(CASE WHEN CAST(json_extract(metadata, '$.confidence') AS INTEGER) BETWEEN 2 AND 3 THEN 1 ELSE 0 END) as mid,
         SUM(CASE WHEN CAST(json_extract(metadata, '$.confidence') AS INTEGER) <= 1 THEN 1 ELSE 0 END) as low
       FROM captures WHERE type = 'error' AND deleted_at IS NULL
       AND created_at > datetime('now', '-30 days')`,
    )
    .get() as { high: number; mid: number; low: number };

  console.log("Confidence distribution (last 30 days):");
  console.log(`  High (4+):   ${confBuckets.high ?? 0}  (well-established patterns)`);
  console.log(`  Medium (2-3): ${confBuckets.mid ?? 0}  (recent, unconfirmed)`);
  console.log(`  Low (0-1):   ${confBuckets.low ?? 0}  (fading, will be pruned)`);
  console.log();

  // 5. Recent errors (last 5)
  const recent = db
    .prepare(
      `SELECT id, content, created_at, metadata FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 5`,
    )
    .all() as { id: string; content: string; created_at: string; metadata: string }[];

  if (recent.length > 0) {
    console.log("Recent errors:");
    for (const err of recent) {
      const meta = JSON.parse(err.metadata);
      const date = new Date(err.created_at).toISOString().split("T")[0];
      const title = meta.title ?? "Untitled";
      const conf = meta.confidence ?? 2;
      const resolved = meta.resolved ? "✓" : "○";
      console.log(`  ${resolved} ${date} [conf=${conf}] ${title.slice(0, 50)}`);
    }
    console.log();
  }

  // 6. Proven fixes (resolved errors with fix_applied)
  const fixes = db
    .prepare(
      `SELECT content, metadata, created_at FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND json_extract(metadata, '$.resolved') = true
       AND json_extract(metadata, '$.fix_applied') IS NOT NULL
       ORDER BY created_at DESC LIMIT 3`,
    )
    .all() as { content: string; metadata: string; created_at: string }[];

  if (fixes.length > 0) {
    console.log("Proven fixes (resolved errors with recorded fixes):");
    for (const fix of fixes) {
      const m = JSON.parse(fix.metadata);
      const date = new Date(fix.created_at).toISOString().split("T")[0];
      const title = m.title ?? "Untitled";
      const fixText = (m.fix_applied ?? "").slice(0, 60);
      console.log(`  ${date} ${title.slice(0, 30)} → ${fixText}`);
    }
    console.log();
  }

  console.log(`${"─".repeat(60)}`);
  console.log("Legend: ✓ = resolved, ○ = open, conf = confidence score");
  console.log();
  console.log("How errors are learned:");
  console.log("  1. PostToolUse hook auto-captures failed commands");
  console.log("  2. PreToolUse hook injects past errors before risky commands");
  console.log("  3. Success after failure → upvotes + records proven fix");
  console.log("  4. Recurring errors → downvoted, pruned at confidence=0");
  console.log("  5. Old errors decay via Ebbinghaus curve (0.95^days)");
  console.log("  6. Cross-project patterns detected and alerted");
  console.log();
  console.log("Set TDAI_GLOBAL_ERRORS=1 to inject errors from ALL projects.");

  db.close();
}
