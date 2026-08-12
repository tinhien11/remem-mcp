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

/**
 * `tdai-memory-mcp errors retro` — Session retrospective.
 * Analyzes error history for failure loops, wasted effort, repeated errors,
 * and stubborn commands. Helps the agent (and user) learn from patterns.
 *
 * (sheal pattern: `sheal retro` analyzes sessions for failure loops)
 */
export function errorsRetro(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors retro — Session Retrospective\n");
  console.log(`${"─".repeat(60)}\n`);

  // Time window: last 7 days by default (configurable via TDAI_RETRO_DAYS)
  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // 1. Failure loops — same error recurring 3+ times (downvoted but not pruned)
  const loops = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.command') as cmd,
         json_extract(metadata, '$.error_type') as etype,
         COUNT(*) as occurrences,
         CAST(json_extract(metadata, '$.downvotes') AS INTEGER) as downvotes,
         CAST(json_extract(metadata, '$.confidence') AS INTEGER) as confidence,
         MIN(created_at) as first_seen,
         MAX(created_at) as last_seen
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.semantic_hash') IS NOT NULL
       GROUP BY json_extract(metadata, '$.semantic_hash')
       HAVING occurrences >= 3
       ORDER BY occurrences DESC LIMIT 10`,
    )
    .all() as {
    title: string;
    cmd: string;
    etype: string;
    occurrences: number;
    downvotes: number;
    confidence: number;
    first_seen: string;
    last_seen: string;
  }[];

  if (loops.length > 0) {
    console.log(`Failure loops (same error recurred 3+ times in last ${days} days):`);
    for (const loop of loops) {
      const title = (loop.title ?? "Untitled").slice(0, 45);
      const cmd = (loop.cmd ?? "unknown").slice(0, 30);
      const conf = loop.confidence ?? 2;
      const dv = loop.downvotes ?? 0;
      const firstDate = new Date(loop.first_seen).toISOString().split("T")[0];
      const lastDate = new Date(loop.last_seen).toISOString().split("T")[0];
      console.log(`  ×${loop.occurrences}  ${title}`);
      console.log(`       cmd: ${cmd}  type: ${loop.etype ?? "unknown"}`);
      console.log(`       ${firstDate} → ${lastDate}  conf=${conf}  downvotes=${dv}`);
      if (conf <= 1) {
        console.log(`       ⚠ This pattern is fading — will be pruned soon.`);
      }
      console.log();
    }
  } else {
    console.log(`No failure loops detected in the last ${days} days. ✓\n`);
  }

  // 2. Wasted effort — errors captured but never resolved (no fix_applied, no resolved)
  const wasted = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.command') as cmd,
         json_extract(metadata, '$.error_type') as etype,
         created_at,
         CAST(json_extract(metadata, '$.confidence') AS INTEGER) as confidence
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.resolved') IS NOT true
       AND json_extract(metadata, '$.fix_applied') IS NULL
       AND json_extract(metadata, '$.confidence') >= 2
       ORDER BY created_at DESC LIMIT 10`,
    )
    .all() as {
    title: string;
    cmd: string;
    etype: string;
    created_at: string;
    confidence: number;
  }[];

  if (wasted.length > 0) {
    console.log(`Wasted effort (errors captured but never resolved in last ${days} days):`);
    for (const w of wasted) {
      const title = (w.title ?? "Untitled").slice(0, 45);
      const cmd = (w.cmd ?? "unknown").slice(0, 30);
      const date = new Date(w.created_at).toISOString().split("T")[0];
      console.log(`  ${date} [conf=${w.confidence}] ${title}`);
      console.log(`       cmd: ${cmd}  type: ${w.etype ?? "unknown"}`);
    }
    console.log(
      `\n  💡 These errors were captured but never resolved. Consider:\n` +
        `     - Capturing the fix with \`capture type=error metadata={resolved:true, fix_applied:"..."}\`\n` +
        `     - Or letting them decay naturally (confidence will reach 0 and prune)\n`,
    );
  } else {
    console.log(
      `No unresolved errors in the last ${days} days. All errors were resolved or pruned. ✓\n`,
    );
  }

  // 3. Recurring resolved errors — resolved errors that recurred (last_recurred > resolved)
  const recurred = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.command') as cmd,
         json_extract(metadata, '$.fix_applied') as fix,
         json_extract(metadata, '$.fix_validated') as validated,
         json_extract(metadata, '$.fix_harm_count') as harm,
         CAST(json_extract(metadata, '$.downvotes') AS INTEGER) as downvotes,
         created_at
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.resolved') = true
       AND CAST(json_extract(metadata, '$.downvotes') AS INTEGER) > 0
       ORDER BY downvotes DESC LIMIT 5`,
    )
    .all() as {
    title: string;
    cmd: string;
    fix: string;
    validated: string;
    harm: number;
    downvotes: number;
    created_at: string;
  }[];

  if (recurred.length > 0) {
    console.log(`Resolved errors that recurred (fix may be wrong or incomplete):`);
    for (const r of recurred) {
      const title = (r.title ?? "Untitled").slice(0, 45);
      const cmd = (r.cmd ?? "unknown").slice(0, 30);
      const fix = (r.fix ?? "(no fix recorded)").slice(0, 50);
      const date = new Date(r.created_at).toISOString().split("T")[0];
      const validatedTag = r.validated === "true" ? "✓validated" : "✗unvalidated";
      const harmTag = r.harm > 0 ? ` ⚠harm=${r.harm}` : "";
      console.log(`  ${date} [downvotes=${r.downvotes}] ${title}`);
      console.log(`       cmd: ${cmd}`);
      console.log(`       fix: ${fix}  ${validatedTag}${harmTag}`);
    }
    console.log(
      `\n  💡 These "resolved" errors recurred. The fix may be:\n` +
        `     - Wrong (unvalidated fix — stdout had error indicators)\n` +
        `     - Harmful (fix_harm_count > 0 — fix caused regression)\n` +
        `     - Incomplete (fix worked once but not in all cases)\n`,
    );
  }

  // 4. Most expensive commands — commands with most error occurrences (cumulative wasted time)
  const expensive = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.command') as cmd,
         COUNT(*) as failures,
         COUNT(DISTINCT json_extract(metadata, '$.semantic_hash')) as unique_errors,
         SUM(CASE WHEN json_extract(metadata, '$.resolved') = true THEN 1 ELSE 0 END) as resolved_count
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.command') IS NOT NULL
       GROUP BY cmd
       HAVING failures >= 2
       ORDER BY failures DESC LIMIT 5`,
    )
    .all() as {
    cmd: string;
    failures: number;
    unique_errors: number;
    resolved_count: number;
  }[];

  if (expensive.length > 0) {
    console.log(`Most expensive commands (by failure count in last ${days} days):`);
    for (const e of expensive) {
      const cmd = (e.cmd ?? "unknown").slice(0, 40);
      const resolveRate = e.failures > 0 ? ((e.resolved_count / e.failures) * 100).toFixed(0) : "0";
      console.log(
        `  ${cmd.padEnd(40)} ${e.failures} failures, ${e.unique_errors} unique errors, ${resolveRate}% resolved`,
      );
    }
    console.log();
  }

  // 5. Harmful fixes — fixes that caused regressions (fix_harm_count > 0)
  const harmful = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.command') as cmd,
         json_extract(metadata, '$.fix_applied') as fix,
         CAST(json_extract(metadata, '$.fix_harm_count') AS INTEGER) as harm,
         created_at
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND CAST(json_extract(metadata, '$.fix_harm_count') AS INTEGER) > 0
       ORDER BY harm DESC LIMIT 5`,
    )
    .all() as {
    title: string;
    cmd: string;
    fix: string;
    harm: number;
    created_at: string;
  }[];

  if (harmful.length > 0) {
    console.log(`Harmful fixes (fix caused regression — blocked from re-injection):`);
    for (const h of harmful) {
      const title = (h.title ?? "Untitled").slice(0, 45);
      const fix = (h.fix ?? "(no fix recorded)").slice(0, 50);
      const date = new Date(h.created_at).toISOString().split("T")[0];
      console.log(`  ${date} [harm=${h.harm}] ${title}`);
      console.log(`       fix: ${fix}`);
    }
    console.log(
      `\n  💡 These fixes were blocked by the harm gate. Do NOT re-apply them.\n` +
        `     Find a different fix for the same error.\n`,
    );
  }

  // 6. Drift violations — errors injected but still occurred
  const driftViolations = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.command') as cmd,
         CAST(json_extract(metadata, '$.drift_count') AS INTEGER) as drift_count,
         json_extract(metadata, '$.last_drift_at') as last_drift
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND CAST(json_extract(metadata, '$.drift_count') AS INTEGER) > 0
       ORDER BY drift_count DESC LIMIT 5`,
    )
    .all() as { title: string; cmd: string; drift_count: number; last_drift: string }[];

  if (driftViolations.length > 0) {
    console.log(`Drift violations (injected errors that still occurred):`);
    for (const d of driftViolations) {
      const title = (d.title ?? "Untitled").slice(0, 45);
      const cmd = (d.cmd ?? "unknown").slice(0, 30);
      const severity = d.drift_count >= 3 ? "●●●" : d.drift_count === 2 ? "●●" : "●";
      console.log(`  ${severity} [drift=${d.drift_count}] ${title}`);
      console.log(`       cmd: ${cmd}`);
    }
    console.log(
      `\n  💡 These errors were injected as warnings but the agent still hit them.\n` +
        `     Run \`tdai-memory-mcp errors drift\` for the full report.\n`,
    );
  }

  // 7. Fix Effectiveness Scoring — measure how long fixes last before recurrence
  // (MTBF pattern from SRE: Mean Time Between Failures applied to agent fixes)
  const durableFixes = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.fix_applied') as fix,
         json_extract(metadata, '$.resolved_at') as resolved_at,
         json_extract(metadata, '$.last_recurred') as last_recurred,
         CAST(
           julianday(json_extract(metadata, '$.last_recurred')) -
           julianday(json_extract(metadata, '$.resolved_at'))
         AS REAL) as fix_duration_days
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.resolved') = true
       AND json_extract(metadata, '$.resolved_at') IS NOT NULL
       AND json_extract(metadata, '$.last_recurred') IS NOT NULL
       ORDER BY fix_duration_days DESC LIMIT 5`,
    )
    .all() as {
    title: string;
    fix: string;
    resolved_at: string;
    last_recurred: string;
    fix_duration_days: number;
  }[];

  const fragileFixes = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.fix_applied') as fix,
         json_extract(metadata, '$.resolved_at') as resolved_at,
         json_extract(metadata, '$.last_recurred') as last_recurred,
         CAST(
           julianday(json_extract(metadata, '$.last_recurred')) -
           julianday(json_extract(metadata, '$.resolved_at'))
         AS REAL) as fix_duration_days
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.resolved') = true
       AND json_extract(metadata, '$.resolved_at') IS NOT NULL
       AND json_extract(metadata, '$.last_recurred') IS NOT NULL
       AND (
         julianday(json_extract(metadata, '$.last_recurred')) -
         julianday(json_extract(metadata, '$.resolved_at'))
       ) < 0.042  -- less than 1 hour = 1/24 day
       ORDER BY fix_duration_days ASC LIMIT 5`,
    )
    .all() as {
    title: string;
    fix: string;
    resolved_at: string;
    last_recurred: string;
    fix_duration_days: number;
  }[];

  if (durableFixes.length > 0 || fragileFixes.length > 0) {
    console.log("Fix effectiveness (MTBF — Mean Time Between Failures):");
    if (durableFixes.length > 0) {
      console.log("  Most durable fixes (lasted longest before recurrence):");
      for (const f of durableFixes) {
        const title = (f.title ?? "Untitled").slice(0, 45);
        const days = f.fix_duration_days.toFixed(1);
        const fix = (f.fix ?? "unknown fix").slice(0, 50);
        console.log(`    ✓ ${days}d  ${title}`);
        console.log(`           fix: ${fix}`);
      }
    }
    if (fragileFixes.length > 0) {
      console.log("  Fragile fixes (recurred within 1 hour):");
      for (const f of fragileFixes) {
        const title = (f.title ?? "Untitled").slice(0, 45);
        const hours = (f.fix_duration_days * 24).toFixed(1);
        const fix = (f.fix ?? "unknown fix").slice(0, 50);
        console.log(`    ⚠ ${hours}h  ${title}`);
        console.log(`           fix: ${fix}`);
      }
      console.log(`\n  💡 Fragile fixes recurred quickly. The fix may be incomplete or wrong.\n`);
    }
    console.log();
  }

  // 8. Summary scorecard
  const totalErrors = db
    .prepare(
      `SELECT COUNT(*) as c FROM captures WHERE type = 'error' AND deleted_at IS NULL AND ${windowClause}`,
    )
    .get() as { c: number };

  const totalResolved = db
    .prepare(
      `SELECT COUNT(*) as c FROM captures WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause} AND json_extract(metadata, '$.resolved') = true`,
    )
    .get() as { c: number };

  const totalPruned = db
    .prepare(
      `SELECT COUNT(*) as c FROM captures WHERE type = 'error' AND deleted_at IS NOT NULL
       AND ${windowClause}`,
    )
    .get() as { c: number };

  console.log(`${"─".repeat(60)}`);
  console.log(`Retrospective scorecard (last ${days} days):`);
  console.log(`  Total errors:        ${totalErrors.c}`);
  console.log(`  Resolved:            ${totalResolved.c}`);
  console.log(`  Pruned (faded):      ${totalPruned.c}`);
  console.log(`  Failure loops:       ${loops.length}`);
  console.log(`  Wasted effort:       ${wasted.length}`);
  console.log(`  Recurred resolved:   ${recurred.length}`);
  console.log(`  Harmful fixes:       ${harmful.length}`);
  console.log(`  Drift violations:    ${driftViolations.length}`);
  console.log(`  Durable fixes:       ${durableFixes.length}`);
  console.log(`  Fragile fixes:       ${fragileFixes.length}`);

  // [Fix Attempt Counter] Show most stubborn errors (high attempt_count)
  const stubborn = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.attempt_count') as attempts,
         json_extract(metadata, '$.error_type') as etype,
         json_extract(metadata, '$.resolved') as resolved
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND CAST(json_extract(metadata, '$.attempt_count') AS INTEGER) >= 3
       ORDER BY CAST(json_extract(metadata, '$.attempt_count') AS INTEGER) DESC LIMIT 5`,
    )
    .all() as { title: string; attempts: string; etype: string; resolved: string }[];

  if (stubborn.length > 0) {
    console.log();
    console.log("Most stubborn errors (3+ attempts):");
    for (const s of stubborn) {
      const title = (s.title ?? "Untitled").slice(0, 45);
      const resolved = s.resolved === "true" ? " ✓" : "";
      console.log(`  ${s.attempts}x  ${title}${resolved}`);
    }
  }
  console.log();

  // Recommendations
  console.log("Recommendations:");
  if (loops.length > 0) {
    console.log(
      `  1. ${loops.length} failure loop(s) detected — review the error and find a different fix.`,
    );
  }
  if (wasted.length > 5) {
    console.log(`  2. ${wasted.length} unresolved errors — capture fixes or let them decay.`);
  }
  if (recurred.length > 0) {
    console.log(
      `  3. ${recurred.length} "resolved" error(s) recurred — the fix is wrong or incomplete.`,
    );
  }
  if (harmful.length > 0) {
    console.log(`  4. ${harmful.length} harmful fix(es) — find alternative approaches.`);
  }
  if (driftViolations.length > 0) {
    console.log(
      `  5. ${driftViolations.length} drift violation(s) — injected warnings were ignored. Review injection format.`,
    );
  }
  if (fragileFixes.length > 0) {
    console.log(
      `  6. ${fragileFixes.length} fragile fix(es) — recurred within 1 hour. Fix may be incomplete.`,
    );
  }
  if (
    loops.length === 0 &&
    wasted.length === 0 &&
    recurred.length === 0 &&
    harmful.length === 0 &&
    driftViolations.length === 0 &&
    fragileFixes.length === 0
  ) {
    console.log("  ✓ No issues detected. Error learning is working well.");
  }
  console.log();
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors drift` — Drift detection report.
 * Shows errors that were injected by PreToolUse but still occurred
 * (the agent was warned but ignored the warning).
 *
 * (sheal pattern: `sheal drift` — detects when stored learnings are not applied)
 */
export function errorsDrift(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors drift — Drift Detection Report\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // 1. Drift violations — errors with drift_count > 0
  const violations = db
    .prepare(
      `SELECT
         id,
         content,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.command') as cmd,
         json_extract(metadata, '$.error_type') as etype,
         CAST(json_extract(metadata, '$.drift_count') AS INTEGER) as drift_count,
         json_extract(metadata, '$.last_drift_at') as last_drift,
         CAST(json_extract(metadata, '$.confidence') AS INTEGER) as confidence,
         CAST(json_extract(metadata, '$.downvotes') AS INTEGER) as downvotes,
         json_extract(metadata, '$.resolved') as resolved,
         created_at
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND CAST(json_extract(metadata, '$.drift_count') AS INTEGER) > 0
       ORDER BY drift_count DESC, created_at DESC LIMIT 20`,
    )
    .all() as {
    id: string;
    content: string;
    title: string;
    cmd: string;
    etype: string;
    drift_count: number;
    last_drift: string;
    confidence: number;
    downvotes: number;
    resolved: string;
    created_at: string;
  }[];

  if (violations.length > 0) {
    console.log(`Drift violations (errors injected but still occurred in last ${days} days):`);
    console.log();
    for (const v of violations) {
      const title = (v.title ?? "Untitled").slice(0, 50);
      const cmd = (v.cmd ?? "unknown").slice(0, 35);
      const date = new Date(v.created_at).toISOString().split("T")[0];
      const severity = v.drift_count >= 3 ? "●●●" : v.drift_count === 2 ? "●●" : "●";
      const resolvedTag = v.resolved === "true" ? " ✓resolved" : "";
      const driftDate = v.last_drift ? new Date(v.last_drift).toISOString().split("T")[0] : "?";

      console.log(`  ${severity} [drift=${v.drift_count}] ${title}`);
      console.log(`       cmd: ${cmd}  type: ${v.etype ?? "unknown"}`);
      console.log(
        `       captured: ${date}  last_drift: ${driftDate}  conf=${v.confidence}  downvotes=${v.downvotes}${resolvedTag}`,
      );
      console.log();
    }
  } else {
    console.log(`No drift violations in the last ${days} days. ✓`);
    console.log("All injected errors were heeded by the agent.\n");
  }

  // 2. Summary stats
  const totalDrift = db
    .prepare(
      `SELECT COUNT(*) as c, SUM(CAST(json_extract(metadata, '$.drift_count') AS INTEGER)) as total_drifts
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND CAST(json_extract(metadata, '$.drift_count') AS INTEGER) > 0`,
    )
    .get() as { c: number; total_drifts: number };

  const totalErrors = db
    .prepare(
      `SELECT COUNT(*) as c FROM captures WHERE type = 'error' AND deleted_at IS NULL AND ${windowClause}`,
    )
    .get() as { c: number };

  const totalInjections = db
    .prepare(
      `SELECT COUNT(*) as c FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.downvotes') IS NOT NULL`,
    )
    .get() as { c: number };

  console.log(`${"─".repeat(60)}`);
  console.log("Drift scorecard:");
  console.log(`  Total errors:          ${totalErrors.c}`);
  console.log(`  Errors with drift:     ${totalDrift.c}`);
  console.log(`  Total drift events:    ${totalDrift.total_drifts ?? 0}`);
  if (totalErrors.c > 0) {
    const driftRate = ((totalDrift.c / totalErrors.c) * 100).toFixed(1);
    console.log(`  Drift rate:            ${driftRate}%`);
  }
  console.log();

  // 3. Effectiveness assessment
  console.log("Effectiveness assessment:");
  if (totalDrift.c === 0) {
    console.log("  ✓ Error injection is effective — no drift detected.");
  } else if (totalErrors.c > 0) {
    const rate = (totalDrift.c / totalErrors.c) * 100;
    if (rate <= 10) {
      console.log("  ✓ Low drift rate — injection is mostly effective.");
    } else if (rate < 30) {
      console.log("  ⚠ Moderate drift rate — some errors are not being heeded.");
      console.log("    Consider improving the anti-pattern or correct_approach text.");
    } else {
      console.log("  ⚠ High drift rate — many injected errors are still occurring.");
      console.log("    The agent may be ignoring warnings. Review the injection format.");
    }
  }
  console.log();

  // 4. Severity breakdown
  if (violations.length > 0) {
    const high = violations.filter((v) => v.drift_count >= 3).length;
    const mid = violations.filter((v) => v.drift_count === 2).length;
    const low = violations.filter((v) => v.drift_count === 1).length;
    console.log("Severity breakdown:");
    console.log(`  ●●● High (3+ drifts):   ${high}  (agent repeatedly ignored warning)`);
    console.log(`  ●●  Medium (2 drifts):  ${mid}  (warning ignored twice)`);
    console.log(`  ●   Low (1 drift):      ${low}  (first drift event)`);
    console.log();
  }

  console.log("Legend: ● = 1 drift, ●● = 2 drifts, ●●● = 3+ drifts");
  console.log("Drift = error was injected by PreToolUse but agent still failed.");
  console.log();
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors lineage` — Fix lineage chain report.
 * Shows chains of errors linked by caused_by_error_id:
 *   E1 → F1 → E2 → F2 → E3
 * where each fix caused the next error (regression chain).
 */
export function errorsLineage(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors lineage — Fix Lineage Chains\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // Find all errors that have a caused_by_error_id (they're the "child" in a chain)
  const children = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.command') as cmd,
         json_extract(metadata, '$.error_type') as etype,
         json_extract(metadata, '$.caused_by_error_id') as parent_id,
         json_extract(metadata, '$.fix_applied') as fix,
         json_extract(metadata, '$.resolved') as resolved,
         created_at
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.caused_by_error_id') IS NOT NULL
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all() as {
    id: string;
    title: string;
    cmd: string;
    etype: string;
    parent_id: string;
    fix: string;
    resolved: string;
    created_at: string;
  }[];

  if (children.length === 0) {
    console.log(`No fix lineage chains in the last ${days} days. ✓`);
    console.log("No errors were caused by previous fixes.\n");
    db.close();
    return;
  }

  // Build chains by looking up parents
  const allErrors = new Map<
    string,
    { id: string; title: string; cmd: string; fix: string; resolved: string }
  >();
  for (const c of children) {
    allErrors.set(c.id, {
      id: c.id,
      title: c.title ?? "Untitled",
      cmd: c.cmd ?? "unknown",
      fix: c.fix ?? "",
      resolved: c.resolved ?? "false",
    });
  }

  // Also fetch parent errors
  const parentIds = [...new Set(children.map((c) => c.parent_id))];
  for (const pid of parentIds) {
    if (allErrors.has(pid)) continue;
    const parent = db
      .prepare(
        `SELECT
           id,
           json_extract(metadata, '$.title') as title,
           json_extract(metadata, '$.command') as cmd,
           json_extract(metadata, '$.fix_applied') as fix,
           json_extract(metadata, '$.resolved') as resolved
         FROM captures WHERE id = ?`,
      )
      .get(pid) as
      | {
          id: string;
          title: string;
          cmd: string;
          fix: string;
          resolved: string;
        }
      | undefined;
    if (parent) {
      allErrors.set(parent.id, {
        id: parent.id,
        title: parent.title ?? "Untitled",
        cmd: parent.cmd ?? "unknown",
        fix: parent.fix ?? "",
        resolved: parent.resolved ?? "false",
      });
    }
  }

  // Build and display chains
  console.log(`Fix lineage chains (last ${days} days):`);
  console.log();

  const displayed = new Set<string>();
  for (const child of children) {
    if (displayed.has(child.id)) continue;
    displayed.add(child.id);

    // Walk up the chain to find the root
    const chain: string[] = [];
    let currentId: string | null = child.id;
    while (currentId && allErrors.has(currentId)) {
      if (chain.includes(currentId)) break; // prevent cycles
      chain.unshift(currentId);
      // Find this error's parent
      const c = children.find((x) => x.id === currentId);
      currentId = c?.parent_id ?? null;
    }

    // Display the chain
    for (let i = 0; i < chain.length; i++) {
      const err = allErrors.get(chain[i])!;
      const indent = "  ".repeat(i);
      const resolved = err.resolved === "true" ? " ✓" : "";
      const shortId = err.id.slice(0, 8);

      if (i === 0) {
        console.log(`${indent}E${i + 1}: [${shortId}] ${err.title.slice(0, 45)}${resolved}`);
        console.log(`${indent}     cmd: ${err.cmd.slice(0, 35)}`);
      } else {
        const parentErr = allErrors.get(chain[i - 1])!;
        const fixText = parentErr.fix ? parentErr.fix.slice(0, 50) : "unknown fix";
        console.log(`${indent}    ↓ fix: ${fixText}`);
        console.log(`${indent}E${i + 1}: [${shortId}] ${err.title.slice(0, 45)}${resolved}`);
        console.log(`${indent}     cmd: ${err.cmd.slice(0, 35)}`);
      }
    }
    console.log();
  }

  // Summary
  console.log(`${"─".repeat(60)}`);
  console.log("Lineage scorecard:");
  console.log(`  Total chained errors:  ${children.length}`);
  let maxDepth = 1;
  for (const c of children) {
    let depth = 1;
    let currentId: string | null = c.id;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const ch = children.find((x) => x.id === currentId);
      if (ch) {
        depth++;
        currentId = ch.parent_id;
      } else {
        break;
      }
    }
    if (depth > maxDepth) maxDepth = depth;
  }
  console.log(`  Max chain depth:       ${maxDepth}`);
  console.log();

  // Assessment
  console.log("Assessment:");
  if (children.length >= 5) {
    console.log("  ⚠ High fix cascade — many fixes are causing new errors.");
    console.log("    Review the root causes, not just the symptoms.");
  } else if (children.length >= 2) {
    console.log("  ⚠ Some fix cascades detected — check if fixes address root causes.");
  } else {
    console.log("  ✓ Low fix cascade — most fixes don't cause new errors.");
  }
  console.log();

  console.log("Legend: E1 = original error, ↓ fix = fix applied, E2 = new error caused by fix");
  console.log();

  // [Mermaid Canvas] Render lineage as Mermaid graph for visual inspection.
  // (TencentDB symbolic memory pattern: maximum semantics in minimum symbols)
  if (children.length > 0) {
    console.log("Mermaid canvas (paste into any Mermaid renderer):");
    console.log();
    console.log("```mermaid");
    console.log("graph LR");
    const rendered = new Set<string>();
    for (const child of children) {
      if (rendered.has(child.id)) continue;
      rendered.add(child.id);

      // Walk chain
      const chain: string[] = [];
      let cur: string | null = child.id;
      while (cur && allErrors.has(cur) && !chain.includes(cur)) {
        chain.unshift(cur);
        const c = children.find((x) => x.id === cur);
        cur = c?.parent_id ?? null;
      }

      // Emit nodes + edges
      for (let i = 0; i < chain.length; i++) {
        const err = allErrors.get(chain[i])!;
        const nodeId = `E${chain[i].slice(0, 6)}`;
        const label = (err.title ?? "Untitled").replace(/["\\]/g, "").slice(0, 30);
        const status = err.resolved === "true" ? " ✓" : "";
        console.log(`  ${nodeId}["${label}${status}"]`);

        if (i > 0) {
          const parentNodeId = `E${chain[i - 1].slice(0, 6)}`;
          const parentErr = allErrors.get(chain[i - 1])!;
          const fixLabel = parentErr.fix ? parentErr.fix.replace(/["\\]/g, "").slice(0, 25) : "fix";
          console.log(`  ${parentNodeId} -->|fix: ${fixLabel}| ${nodeId}`);
        }
      }
    }
    console.log("```");
    console.log();
  }

  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors by-goal` — Goal-linked error report.
 * Shows error distribution by goal_id (set via TDAI_GOAL_ID env var).
 * (LoopX-inspired: link errors to the goals they block)
 */
export function errorsByGoal(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors by-goal — Goal-Linked Error Report\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // Group errors by goal_id
  const byGoal = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.goal_id') as goal_id,
         COUNT(*) as error_count,
         SUM(CASE WHEN json_extract(metadata, '$.resolved') = true THEN 1 ELSE 0 END) as resolved_count,
         GROUP_CONCAT(DISTINCT json_extract(metadata, '$.error_type')) as error_types
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.goal_id') IS NOT NULL
       GROUP BY goal_id
       ORDER BY error_count DESC`,
    )
    .all() as {
    goal_id: string;
    error_count: number;
    resolved_count: number;
    error_types: string;
  }[];

  if (byGoal.length === 0) {
    console.log(`No goal-linked errors in the last ${days} days.`);
    console.log("Set TDAI_GOAL_ID=<goal-id> to tag errors with a goal.\n");
    db.close();
    return;
  }

  console.log(`Error distribution by goal (last ${days} days):`);
  console.log();
  for (const g of byGoal) {
    const resolveRate =
      g.error_count > 0 ? ((g.resolved_count / g.error_count) * 100).toFixed(0) : "0";
    const types = (g.error_types ?? "").split(",").filter(Boolean).slice(0, 5).join(", ");
    console.log(`  Goal: ${g.goal_id}`);
    console.log(`    Errors: ${g.error_count}  Resolved: ${g.resolved_count} (${resolveRate}%)`);
    console.log(`    Types: ${types}`);
    console.log();
  }

  // Summary
  const totalGoalErrors = byGoal.reduce((sum, g) => sum + g.error_count, 0);
  const totalResolved = byGoal.reduce((sum, g) => sum + g.resolved_count, 0);
  console.log(`${"─".repeat(60)}`);
  console.log("Goal scorecard:");
  console.log(`  Goals with errors:     ${byGoal.length}`);
  console.log(`  Total goal errors:     ${totalGoalErrors}`);
  console.log(`  Total resolved:        ${totalResolved}`);
  console.log();

  // Most error-prone goal
  const worst = byGoal[0];
  console.log(`Most error-prone goal: ${worst.goal_id} (${worst.error_count} errors)`);
  console.log();
  console.log("Set TDAI_GOAL_ID=<goal-id> to tag new errors with a goal.");
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors actions` — Error action item tracker.
 * Shows postmortem action items generated from resolved errors.
 * (SRE pattern: track preventive actions from incident postmortems)
 */
export function errorsActions(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors actions — Action Item Tracker\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // Resolved errors with fixes = potential action items
  // (The fix was applied, but was a systemic prevention action taken?)
  const resolved = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.fix_applied') as fix,
         json_extract(metadata, '$.error_type') as etype,
         json_extract(metadata, '$.fix_validated') as validated,
         json_extract(metadata, '$.fix_harm_count') as harm,
         json_extract(metadata, '$.drift_count') as drift,
         json_extract(metadata, '$.downvotes') as downvotes,
         json_extract(metadata, '$.resolved_at') as resolved_at,
         json_extract(metadata, '$.last_recurred') as last_recurred
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.resolved') = true
       AND json_extract(metadata, '$.fix_applied') IS NOT NULL
       ORDER BY resolved_at DESC LIMIT 20`,
    )
    .all() as {
    id: string;
    title: string;
    fix: string;
    etype: string;
    validated: string;
    harm: string;
    drift: string;
    downvotes: string;
    resolved_at: string;
    last_recurred: string;
  }[];

  if (resolved.length === 0) {
    console.log(`No resolved errors with fixes in the last ${days} days.`);
    console.log("Action items are generated from resolved errors.\n");
    db.close();
    return;
  }

  // Categorize action items
  const open: typeof resolved = [];
  const verified: typeof resolved = [];
  const recurring: typeof resolved = [];

  for (const r of resolved) {
    const driftCount = Number(r.drift ?? 0);
    const downvotes = Number(r.downvotes ?? 0);
    const harmCount = Number(r.harm ?? 0);
    const validated =
      r.validated === "true" || r.validated === "1" || r.validated === 1 || r.validated === true;

    if (harmCount > 0 || downvotes > 0 || driftCount > 0) {
      recurring.push(r);
    } else if (validated) {
      verified.push(r);
    } else {
      open.push(r);
    }
  }

  console.log(`Action items from resolved errors (last ${days} days):`);
  console.log();

  if (verified.length > 0) {
    console.log("Verified fixes (clean success, no recurrence):");
    for (const r of verified.slice(0, 5)) {
      const title = (r.title ?? "Untitled").slice(0, 45);
      const fix = (r.fix ?? "").slice(0, 50);
      const date = r.resolved_at ? new Date(r.resolved_at).toISOString().split("T")[0] : "?";
      console.log(`  ✓ ${date}  ${title}`);
      console.log(`         fix: ${fix}`);
    }
    console.log();
  }

  if (open.length > 0) {
    console.log("Open action items (fix not yet validated):");
    for (const r of open.slice(0, 5)) {
      const title = (r.title ?? "Untitled").slice(0, 45);
      const fix = (r.fix ?? "").slice(0, 50);
      const date = r.resolved_at ? new Date(r.resolved_at).toISOString().split("T")[0] : "?";
      console.log(`  ⚠ ${date}  ${title}`);
      console.log(`         fix: ${fix}`);
      console.log(`         → Verify the fix with a clean test run`);
    }
    console.log();
  }

  if (recurring.length > 0) {
    console.log("Recurring action items (fix recurred — needs stronger fix):");
    for (const r of recurring.slice(0, 5)) {
      const title = (r.title ?? "Untitled").slice(0, 45);
      const fix = (r.fix ?? "").slice(0, 50);
      const date = r.resolved_at ? new Date(r.resolved_at).toISOString().split("T")[0] : "?";
      const harmCount = Number(r.harm ?? 0);
      const driftCount = Number(r.drift ?? 0);
      const downvotes = Number(r.downvotes ?? 0);
      const flags: string[] = [];
      if (harmCount > 0) flags.push(`harm=${harmCount}`);
      if (driftCount > 0) flags.push(`drift=${driftCount}`);
      if (downvotes > 0) flags.push(`downvotes=${downvotes}`);
      console.log(`  ✗ ${date}  ${title}  [${flags.join(", ")}]`);
      console.log(`         fix: ${fix}`);
      console.log(`         → Find a different, stronger fix`);
    }
    console.log();
  }

  // Summary
  console.log(`${"─".repeat(60)}`);
  console.log("Action item scorecard:");
  console.log(`  Total resolved:       ${resolved.length}`);
  console.log(`  Verified fixes:       ${verified.length}`);
  console.log(`  Open (unvalidated):   ${open.length}`);
  console.log(`  Recurring (failed):   ${recurring.length}`);
  console.log();

  // Recommendations
  console.log("Recommendations:");
  if (open.length > 0) {
    console.log(`  1. ${open.length} unvalidated fix(es) — run a clean test to verify.`);
  }
  if (recurring.length > 0) {
    console.log(
      `  2. ${recurring.length} recurring fix(es) — the fix is wrong. Find a different approach.`,
    );
  }
  if (open.length === 0 && recurring.length === 0) {
    console.log("  ✓ All fixes are verified and stable.");
  }
  console.log();
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors severity` — Error severity distribution.
 * Shows errors classified as blocker/critical/major/minor.
 * (SRE pattern: prioritize by business impact, not just frequency)
 */
export function errorsSeverity(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors severity — Impact Classification\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // Count by severity
  const bySeverity = db
    .prepare(
      `SELECT
         COALESCE(json_extract(metadata, '$.severity'), 'major') as severity,
         COUNT(*) as count,
         SUM(CASE WHEN json_extract(metadata, '$.resolved') = true THEN 1 ELSE 0 END) as resolved
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       GROUP BY severity
       ORDER BY CASE severity
         WHEN 'blocker' THEN 0
         WHEN 'critical' THEN 1
         WHEN 'major' THEN 2
         WHEN 'minor' THEN 3
         ELSE 2
       END`,
    )
    .all() as { severity: string; count: number; resolved: number }[];

  if (bySeverity.length === 0) {
    console.log(`No errors in the last ${days} days.\n`);
    db.close();
    return;
  }

  const icons: Record<string, string> = {
    blocker: "🔴",
    critical: "🟠",
    major: "🟡",
    minor: "🟢",
  };

  console.log(`Severity distribution (last ${days} days):`);
  console.log();
  for (const s of bySeverity) {
    const icon = icons[s.severity] ?? "🟡";
    const resolveRate = s.count > 0 ? ((s.resolved / s.count) * 100).toFixed(0) : "0";
    console.log(
      `  ${icon} ${s.severity.padEnd(10)} ${String(s.count).padStart(4)} errors  (${resolveRate}% resolved)`,
    );
  }
  console.log();

  // Show top blocker/critical errors
  const blockers = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.command') as cmd,
         json_extract(metadata, '$.severity') as severity,
         json_extract(metadata, '$.resolved') as resolved,
         created_at
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.severity') IN ('blocker', 'critical')
       ORDER BY created_at DESC LIMIT 10`,
    )
    .all() as {
    title: string;
    cmd: string;
    severity: string;
    resolved: string;
    created_at: string;
  }[];

  if (blockers.length > 0) {
    console.log("Top blocker/critical errors:");
    for (const b of blockers) {
      const icon = icons[b.severity] ?? "🟡";
      const title = (b.title ?? "Untitled").slice(0, 45);
      const cmd = (b.cmd ?? "").slice(0, 30);
      const resolved = b.resolved === "true" ? " ✓" : "";
      const date = new Date(b.created_at).toISOString().split("T")[0];
      console.log(`  ${icon} ${date} ${title}${resolved}`);
      console.log(`         cmd: ${cmd}`);
    }
    console.log();
  }

  // Summary
  const total = bySeverity.reduce((sum, s) => sum + s.count, 0);
  const blockerCount = bySeverity.find((s) => s.severity === "blocker")?.count ?? 0;
  const criticalCount = bySeverity.find((s) => s.severity === "critical")?.count ?? 0;
  const majorCount = bySeverity.find((s) => s.severity === "major")?.count ?? 0;
  const minorCount = bySeverity.find((s) => s.severity === "minor")?.count ?? 0;

  console.log(`${"─".repeat(60)}`);
  console.log("Severity scorecard:");
  console.log(`  Total errors:    ${total}`);
  console.log(`  Blockers:       ${blockerCount}`);
  console.log(`  Critical:       ${criticalCount}`);
  console.log(`  Major:          ${majorCount}`);
  console.log(`  Minor:          ${minorCount}`);
  console.log();

  // Assessment
  console.log("Assessment:");
  if (blockerCount > 0) {
    console.log(`  ${blockerCount} blocker(s) — these block all work. Fix first.`);
  }
  if (criticalCount > total * 0.3) {
    console.log(`  High critical rate — config/security issues are common.`);
  }
  if (minorCount > total * 0.5) {
    console.log(`  High minor rate — most errors are non-blocking. Consider filtering.`);
  }
  if (blockerCount === 0 && criticalCount === 0) {
    console.log("  No blockers or critical errors. Development is not blocked.");
  }
  console.log();
  console.log("Severity: blocker > critical > major > minor");
  console.log("PreToolUse injects blockers first, then critical, then major.");
  console.log();
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors templates` — Fix template extraction report.
 * Shows reusable fix patterns extracted from 3+ similar resolved errors.
 * (Moves from specific fixes to generalizable principles)
 */
export function errorsTemplates(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors templates — Fix Template Extraction\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // Find errors that have a fix_template extracted
  const templates = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.error_type') as etype,
         json_extract(metadata, '$.fix_applied') as fix,
         json_extract(metadata, '$.fix_template') as template,
         created_at
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.fix_template') IS NOT NULL
       ORDER BY json_extract(metadata, '$.fix_template.similar_fix_count') DESC LIMIT 20`,
    )
    .all() as {
    id: string;
    title: string;
    etype: string;
    fix: string;
    template: string;
    created_at: string;
  }[];

  if (templates.length === 0) {
    console.log(`No fix templates extracted in the last ${days} days.`);
    console.log(
      "Templates are auto-extracted when 3+ similar errors share the same fix pattern.\n",
    );
    db.close();
    return;
  }

  console.log(`Extracted fix templates (last ${days} days):`);
  console.log();

  // Deduplicate by pattern
  const seen = new Map<string, typeof templates>();
  for (const t of templates) {
    try {
      const tmpl = JSON.parse(t.template);
      const key = tmpl.pattern ?? "unknown";
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key)!.push(t);
    } catch {
      // skip
    }
  }

  for (const [pattern, matches] of seen) {
    const first = matches[0];
    const tmpl = JSON.parse(first.template);
    console.log(`  Pattern: "${pattern}"`);
    console.log(`    Error type:  ${tmpl.error_type ?? "unknown"}`);
    console.log(`    Matches:     ${tmpl.similar_fix_count} similar fixes`);
    console.log(`    Example fix: ${(first.fix ?? "").slice(0, 60)}`);
    console.log();
  }

  // Summary
  console.log(`${"─".repeat(60)}`);
  console.log("Template scorecard:");
  console.log(`  Total templates:      ${seen.size}`);
  console.log(`  Total template hits:  ${templates.length}`);
  console.log();

  // Assessment
  console.log("Assessment:");
  if (seen.size >= 3) {
    console.log("  Multiple fix patterns detected — agent is learning general principles.");
  } else if (seen.size >= 1) {
    console.log("  Some patterns detected — agent is starting to generalize fixes.");
  }
  console.log();
  console.log("Templates are auto-extracted when 3+ similar errors share the same fix pattern.");
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors correlations` — Error correlation report.
 * Shows sequential error patterns: when E1 occurs, E2 often follows.
 * (SRE pattern: incident correlation / cascading failure detection)
 */
export function errorsCorrelations(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors correlations — Sequential Error Patterns\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // Find errors that have error_correlations recorded
  const correlated = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.error_type') as etype,
         json_extract(metadata, '$.error_correlations') as correlations,
         created_at
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.error_correlations') IS NOT NULL
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all() as {
    id: string;
    title: string;
    etype: string;
    correlations: string;
    created_at: string;
  }[];

  if (correlated.length === 0) {
    console.log(`No error correlations detected in the last ${days} days.`);
    console.log("Correlations are detected when different error types occur within 10 minutes.\n");
    db.close();
    return;
  }

  // Aggregate correlation pairs across all errors
  const pairMap = new Map<string, { count: number; examples: string[] }>();

  for (const c of correlated) {
    try {
      const corrs = JSON.parse(c.correlations) as {
        next_error_type: string;
        next_error_title: string;
        count: number;
      }[];
      for (const corr of corrs) {
        const key = `${c.etype ?? "unknown"} → ${corr.next_error_type}`;
        if (!pairMap.has(key)) {
          pairMap.set(key, { count: 0, examples: [] });
        }
        const entry = pairMap.get(key)!;
        entry.count += corr.count;
        if (entry.examples.length < 2) {
          entry.examples.push(
            `${(c.title ?? "").slice(0, 30)} → ${corr.next_error_title?.slice(0, 30) ?? ""}`,
          );
        }
      }
    } catch {
      // skip
    }
  }

  // Sort by count descending
  const sorted = [...pairMap.entries()].sort((a, b) => b[1].count - a[1].count);

  console.log(`Sequential error patterns (last ${days} days):`);
  console.log();
  for (const [pattern, data] of sorted.slice(0, 10)) {
    console.log(`  ${pattern}  (${data.count} occurrences)`);
    for (const ex of data.examples) {
      console.log(`    e.g. ${ex}`);
    }
  }
  console.log();

  // Summary
  console.log(`${"─".repeat(60)}`);
  console.log("Correlation scorecard:");
  console.log(`  Total correlated errors:  ${correlated.length}`);
  console.log(`  Unique patterns:          ${pairMap.size}`);
  const totalPairs = [...pairMap.values()].reduce((sum, p) => sum + p.count, 0);
  console.log(`  Total pair occurrences:   ${totalPairs}`);
  console.log();

  // Assessment
  console.log("Assessment:");
  if (pairMap.size >= 3) {
    console.log("  Multiple correlation patterns — errors tend to cascade.");
    console.log("  When E1 occurs, proactively check for E2 conditions.");
  } else if (pairMap.size >= 1) {
    console.log("  Some correlations detected — watch for cascading failures.");
  }
  console.log();
  console.log("Correlations are detected when different error types occur within 10 minutes.");
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors playbooks` — Recovery pattern library.
 * Shows structured recovery playbooks extracted from resolved errors.
 * (SRE pattern: runbooks / incident playbooks for agents)
 */
export function errorsPlaybooks(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors playbooks — Recovery Pattern Library\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // Find errors that have a recovery_pattern extracted
  const playbooks = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.error_type') as etype,
         json_extract(metadata, '$.recovery_pattern') as pattern,
         json_extract(metadata, '$.attempt_count') as attempts,
         json_extract(metadata, '$.severity') as severity
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.recovery_pattern') IS NOT NULL
       ORDER BY CAST(json_extract(metadata, '$.attempt_count') AS INTEGER) DESC LIMIT 10`,
    )
    .all() as {
    id: string;
    title: string;
    etype: string;
    pattern: string;
    attempts: string;
    severity: string;
  }[];

  if (playbooks.length === 0) {
    console.log(`No recovery playbooks in the last ${days} days.`);
    console.log("Playbooks are auto-extracted when errors with 2+ attempts are resolved.\n");
    db.close();
    return;
  }

  console.log(`Recovery playbooks (last ${days} days):`);
  console.log();
  for (const p of playbooks) {
    try {
      const pat = JSON.parse(p.pattern);
      console.log(
        `  ${p.title ?? "Untitled"}  [${p.etype ?? "unknown"}, ${p.attempts ?? "?"} attempts, ${p.severity ?? "major"}]`,
      );
      for (const step of pat.steps ?? []) {
        console.log(`    ${step}`);
      }
      console.log();
    } catch {
      // skip
    }
  }

  // Summary
  console.log(`${"─".repeat(60)}`);
  console.log("Playbook scorecard:");
  console.log(`  Total playbooks:       ${playbooks.length}`);
  const totalAttempts = playbooks.reduce((sum, p) => sum + (Number(p.attempts) ?? 0), 0);
  const avgAttempts = playbooks.length > 0 ? (totalAttempts / playbooks.length).toFixed(1) : "0";
  console.log(`  Avg attempts:          ${avgAttempts}`);
  console.log();

  // Assessment
  console.log("Assessment:");
  if (playbooks.length >= 5) {
    console.log(
      "  Rich playbook library — agent has structured recovery guidance for many errors.",
    );
  } else if (playbooks.length >= 1) {
    console.log("  Some playbooks available — agent is building recovery guidance.");
  }
  console.log();
  console.log("Playbooks are auto-extracted when errors with 2+ attempts are resolved.");
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors stale` — Fix staleness report.
 * Shows resolved fixes that are older than the staleness threshold.
 * (Knowledge freshness: fixes can become invalid as codebase evolves)
 */
export function errorsStale(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors stale — Fix Staleness Report\n");
  console.log(`${"─".repeat(60)}\n`);

  const stalenessDays = Number(process.env.TDAI_FIX_STALENESS_DAYS ?? 180);
  const stalenessClause = `datetime('now', '-${stalenessDays} days')`;

  // Find resolved fixes older than threshold
  const stale = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.fix_applied') as fix,
         json_extract(metadata, '$.resolved_at') as resolved_at,
         json_extract(metadata, '$.error_type') as etype,
         json_extract(metadata, '$.severity') as severity
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND json_extract(metadata, '$.resolved') = true
       AND json_extract(metadata, '$.fix_applied') IS NOT NULL
       AND json_extract(metadata, '$.resolved_at') IS NOT NULL
       AND json_extract(metadata, '$.resolved_at') < ${stalenessClause}
       ORDER BY json_extract(metadata, '$.resolved_at') ASC LIMIT 20`,
    )
    .all() as {
    id: string;
    title: string;
    fix: string;
    resolved_at: string;
    etype: string;
    severity: string;
  }[];

  // Also count fresh fixes (for comparison)
  const fresh = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND json_extract(metadata, '$.resolved') = true
       AND json_extract(metadata, '$.fix_applied') IS NOT NULL
       AND json_extract(metadata, '$.resolved_at') IS NOT NULL
       AND json_extract(metadata, '$.resolved_at') >= ${stalenessClause}`,
    )
    .get() as { count: number };

  console.log(`Staleness threshold: ${stalenessDays} days (TDAI_FIX_STALENESS_DAYS)`);
  console.log();

  if (stale.length === 0) {
    console.log(
      `No stale fixes found. All ${fresh.count} resolved fix(es) are within ${stalenessDays} days.\n`,
    );
    db.close();
    return;
  }

  console.log(`Stale fixes (older than ${stalenessDays} days):`);
  console.log();
  for (const s of stale) {
    const ageDays = Math.floor((Date.now() - new Date(s.resolved_at).getTime()) / 86400000);
    const title = (s.title ?? "Untitled").slice(0, 40);
    const fix = (s.fix ?? "").slice(0, 50);
    const date = new Date(s.resolved_at).toISOString().split("T")[0];
    console.log(`  ${date} (${ageDays}d old)  ${title}`);
    console.log(`    fix: ${fix}`);
  }
  console.log();

  // Summary
  console.log(`${"─".repeat(60)}`);
  console.log("Staleness scorecard:");
  console.log(`  Stale fixes:    ${stale.length}  (older than ${stalenessDays} days)`);
  console.log(`  Fresh fixes:    ${fresh.count}  (within ${stalenessDays} days)`);
  const total = stale.length + fresh.count;
  const staleRate = total > 0 ? ((stale.length / total) * 100).toFixed(0) : "0";
  console.log(`  Stale rate:     ${staleRate}%`);
  console.log();

  // Assessment
  console.log("Assessment:");
  if (stale.length > fresh.count && total > 0) {
    console.log("  More stale than fresh fixes — consider pruning or re-validating old fixes.");
  } else if (stale.length > 0) {
    console.log("  Some stale fixes detected — PreToolUse will warn [STALE] when injecting them.");
  }
  console.log();
  console.log("Stale fixes are still injected but with a [STALE — verify before applying] tag.");
  console.log("Set TDAI_FIX_STALENESS_DAYS=N to change the threshold (default: 180).");

  db.close();
}

/**
 * `tdai-memory-mcp errors escalations` — Escalation policy report.
 * Shows errors that have been auto-escalated due to high recurrence.
 * (PagerDuty pattern: recurrence → escalation → stronger intervention)
 */
export function errorsEscalations(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors escalations — Escalation Policy Report\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;
  const threshold = Number(process.env.TDAI_ESCALATION_THRESHOLD ?? 3);

  // Find escalated errors
  const escalated = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.error_type') as etype,
         json_extract(metadata, '$.escalation_level') as level,
         json_extract(metadata, '$.escalated_at') as escalated_at,
         json_extract(metadata, '$.attempt_count') as attempts,
         json_extract(metadata, '$.severity') as severity,
         json_extract(metadata, '$.resolved') as resolved
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND CAST(json_extract(metadata, '$.escalation_level') AS INTEGER) > 0
       ORDER BY CAST(json_extract(metadata, '$.escalation_level') AS INTEGER) DESC,
                CAST(json_extract(metadata, '$.attempt_count') AS INTEGER) DESC LIMIT 20`,
    )
    .all() as {
    id: string;
    title: string;
    etype: string;
    level: string;
    escalated_at: string;
    attempts: string;
    severity: string;
    resolved: string;
  }[];

  console.log(`Escalation threshold: ${threshold} attempts (TDAI_ESCALATION_THRESHOLD)`);
  console.log(`Analysis window: last ${days} days (TDAI_RETRO_DAYS)`);
  console.log();

  if (escalated.length === 0) {
    console.log(`No escalated errors in the last ${days} days.\n`);
    console.log("Errors auto-escalate when they recur 3+ times:");
    console.log("  Level 1 (ELEVATED): 3+ attempts — severity bumped to critical");
    console.log("  Level 2 (CRITICAL): 5+ attempts — severity bumped to blocker");
    console.log("  Level 3 (BLOCKER):  7+ attempts — strongest warning injected");
    console.log();
    db.close();
    return;
  }

  const levelLabels: Record<number, string> = {
    1: "ELEVATED",
    2: "CRITICAL",
    3: "BLOCKER",
  };

  console.log("Escalated errors:");
  console.log();
  for (const e of escalated) {
    const level = Number(e.level);
    const label = levelLabels[level] ?? `L${level}`;
    const title = (e.title ?? "Untitled").slice(0, 40);
    const resolved = e.resolved === "true" ? " ✓" : "";
    const escDate = e.escalated_at ? new Date(e.escalated_at).toISOString().split("T")[0] : "?";
    console.log(`  [${label}] ${title}${resolved}`);
    console.log(
      `    attempts: ${e.attempts ?? "?"}, severity: ${e.severity ?? "major"}, escalated: ${escDate}`,
    );
  }
  console.log();

  // Summary by level
  const byLevel: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  for (const e of escalated) {
    const lvl = Number(e.level);
    byLevel[lvl] = (byLevel[lvl] ?? 0) + 1;
  }

  console.log(`${"─".repeat(60)}`);
  console.log("Escalation scorecard:");
  console.log(`  Total escalated:   ${escalated.length}`);
  console.log(`  Level 1 (ELEVATED): ${byLevel[1]}  (3+ attempts)`);
  console.log(`  Level 2 (CRITICAL): ${byLevel[2]}  (5+ attempts)`);
  console.log(`  Level 3 (BLOCKER):  ${byLevel[3]}  (7+ attempts)`);
  console.log();

  // Assessment
  console.log("Assessment:");
  if (byLevel[3] > 0) {
    console.log(
      `  ${byLevel[3]} BLOCKER-level error(s) — these need a fundamentally different approach.`,
    );
  }
  if (byLevel[2] > 0) {
    console.log(`  ${byLevel[2]} CRITICAL-level error(s) — previous fixes have failed repeatedly.`);
  }
  if (byLevel[1] > 0 && byLevel[2] === 0 && byLevel[3] === 0) {
    console.log(`  ${byLevel[1]} ELEVATED error(s) — monitor for further recurrence.`);
  }
  console.log();
  console.log("Escalated errors get stronger warning text in PreToolUse injections.");
  console.log("Set TDAI_ESCALATION_THRESHOLD=N to change the trigger (default: 3).");
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors context` — Error context enrichment report.
 * Shows git context (branch, commits, changed files) captured at error time.
 * (LoopX evidence logs pattern: record context during failure)
 */
export function errorsContext(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors context — Error Context Enrichment\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // Find errors with context_enrichment
  const enriched = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.error_type') as etype,
         json_extract(metadata, '$.context_enrichment') as ctx,
         json_extract(metadata, '$.severity') as severity,
         created_at
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.context_enrichment') IS NOT NULL
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all() as {
    id: string;
    title: string;
    etype: string;
    ctx: string;
    severity: string;
    created_at: string;
  }[];

  if (enriched.length === 0) {
    console.log(`No errors with git context in the last ${days} days.`);
    console.log("Context is auto-captured when errors occur in a git repository.\n");
    db.close();
    return;
  }

  console.log(`Errors with git context (last ${days} days):`);
  console.log();
  for (const e of enriched) {
    try {
      const ctx = JSON.parse(e.ctx);
      const title = (e.title ?? "Untitled").slice(0, 40);
      const date = new Date(e.created_at).toISOString().split("T")[0];
      console.log(`  ${date} ${title}  [${e.severity ?? "major"}]`);
      console.log(`    branch: ${ctx.branch ?? "unknown"}`);
      if (ctx.recent_commits?.[0]) console.log(`    last commit: ${ctx.recent_commits[0]}`);
      if (ctx.changed_files?.length > 0) {
        console.log(
          `    changed files: ${ctx.changed_files.slice(0, 3).join(", ")}${ctx.changed_files.length > 3 ? "..." : ""}`,
        );
      }
      console.log();
    } catch {
      // skip
    }
  }

  // Summary
  console.log(`${"─".repeat(60)}`);
  console.log("Context scorecard:");
  console.log(`  Errors with context:  ${enriched.length}`);

  // Branch distribution
  const branchMap = new Map<string, number>();
  for (const e of enriched) {
    try {
      const ctx = JSON.parse(e.ctx);
      const b = ctx.branch ?? "unknown";
      branchMap.set(b, (branchMap.get(b) ?? 0) + 1);
    } catch {
      // skip
    }
  }
  console.log(`  Unique branches:      ${branchMap.size}`);
  const topBranch = [...branchMap.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topBranch) {
    console.log(`  Most error-prone:     ${topBranch[0]} (${topBranch[1]} errors)`);
  }
  console.log();
  console.log("Context is auto-captured when errors occur in a git repository.");
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors inherited` — Cross-project fix inheritance report.
 * Shows fixes that were auto-inherited from other projects.
 * (LoopX capability routes pattern: learn once, apply everywhere)
 */
export function errorsInherited(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors inherited — Cross-Project Fix Inheritance\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // Find resolved fixes with provenance = inherited
  const inherited = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.fix_applied') as fix,
         json_extract(metadata, '$.fix_provenance') as provenance,
         json_extract(metadata, '$.error_type') as etype,
         session_key,
         created_at
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.resolved') = true
       AND json_extract(metadata, '$.fix_applied') IS NOT NULL
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all() as {
    id: string;
    title: string;
    fix: string;
    provenance: string;
    etype: string;
    session_key: string;
    created_at: string;
  }[];

  // Group by session_key (project)
  const byProject = new Map<string, typeof inherited>();
  for (const f of inherited) {
    if (!byProject.has(f.session_key)) byProject.set(f.session_key, []);
    byProject.get(f.session_key)!.push(f);
  }

  if (inherited.length === 0) {
    console.log(`No resolved fixes in the last ${days} days.`);
    console.log(
      "Fixes are auto-inherited when PreToolUse finds validated fixes from other projects.\n",
    );
    db.close();
    return;
  }

  console.log(`Resolved fixes by project (last ${days} days):`);
  console.log();
  for (const [project, fixes] of byProject) {
    console.log(`  Project: ${project.slice(0, 20)}...  (${fixes.length} fixes)`);
    for (const f of fixes.slice(0, 3)) {
      const title = (f.title ?? "Untitled").slice(0, 35);
      const prov = f.provenance ?? "auto_captured";
      console.log(`    [${prov}] ${title}`);
    }
    if (fixes.length > 3) console.log(`    ... and ${fixes.length - 3} more`);
    console.log();
  }

  // Summary
  const provenanceCounts = new Map<string, number>();
  for (const f of inherited) {
    const p = f.provenance ?? "auto_captured";
    provenanceCounts.set(p, (provenanceCounts.get(p) ?? 0) + 1);
  }

  console.log(`${"─".repeat(60)}`);
  console.log("Inheritance scorecard:");
  console.log(`  Total resolved fixes:  ${inherited.length}`);
  console.log(`  Projects with fixes:   ${byProject.size}`);
  for (const [prov, count] of provenanceCounts) {
    console.log(`  ${prov}: ${count}`);
  }
  console.log();
  console.log(
    "Fixes are auto-inherited when PreToolUse finds validated fixes from other projects.",
  );
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors provenance` — Fix provenance chain report.
 * Shows where fixes came from: auto_captured, inherited, template_extracted.
 * (Midas source-traceable recall pattern: provenance affects trust)
 */
export function errorsProvenance(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors provenance — Fix Provenance Chain\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // Count by provenance
  const byProvenance = db
    .prepare(
      `SELECT
         COALESCE(json_extract(metadata, '$.fix_provenance'), 'auto_captured') as provenance,
         COUNT(*) as count,
         SUM(CASE WHEN json_extract(metadata, '$.fix_validated') = true THEN 1 ELSE 0 END) as validated
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.fix_applied') IS NOT NULL
       GROUP BY provenance
       ORDER BY count DESC`,
    )
    .all() as { provenance: string; count: number; validated: number }[];

  if (byProvenance.length === 0) {
    console.log(`No fixes with provenance data in the last ${days} days.`);
    console.log("Provenance is auto-tagged when fixes are recorded.\n");
    db.close();
    return;
  }

  console.log(`Fix provenance distribution (last ${days} days):`);
  console.log();
  for (const p of byProvenance) {
    const validateRate = p.count > 0 ? ((p.validated / p.count) * 100).toFixed(0) : "0";
    console.log(
      `  ${p.provenance.padEnd(20)} ${String(p.count).padStart(4)} fixes  (${validateRate}% validated)`,
    );
  }
  console.log();

  // Show examples of each provenance type
  const examples = db
    .prepare(
      `SELECT
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.fix_provenance') as provenance,
         json_extract(metadata, '$.fix_applied') as fix,
         json_extract(metadata, '$.rollback_plan') as rollback
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       AND json_extract(metadata, '$.fix_applied') IS NOT NULL
       ORDER BY created_at DESC LIMIT 10`,
    )
    .all() as { title: string; provenance: string; fix: string; rollback: string }[];

  if (examples.length > 0) {
    console.log("Recent fixes with provenance and rollback plans:");
    for (const e of examples.slice(0, 10)) {
      const title = (e.title ?? "Untitled").slice(0, 35);
      const prov = e.provenance ?? "auto_captured";
      console.log(`  [${prov}] ${title}`);
      if (e.rollback) {
        console.log(`    rollback: ${e.rollback.slice(0, 60)}`);
      }
    }
  }
  console.log();

  // Summary
  const total = byProvenance.reduce((sum, p) => sum + p.count, 0);
  console.log(`${"─".repeat(60)}`);
  console.log("Provenance scorecard:");
  console.log(`  Total fixes:          ${total}`);
  for (const p of byProvenance) {
    console.log(`  ${p.provenance}: ${p.count}`);
  }
  console.log();
  console.log("Provenance is auto-tagged: auto_captured > inherited > template_extracted.");
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp errors persona` — Error persona per project.
 * Auto-builds an error profile: most common types, branches, severity,
 * resolution rate, top anti-patterns. (TencentDB L3 Persona layer pattern)
 */
export function errorsPersona(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp errors persona — Error Profile per Project\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  // Group by session_key (project)
  const byProject = db
    .prepare(
      `SELECT
         session_key,
         COUNT(*) as total,
         SUM(CASE WHEN json_extract(metadata, '$.resolved') = true THEN 1 ELSE 0 END) as resolved_count,
         SUM(CASE WHEN json_extract(metadata, '$.severity') = 'blocker' THEN 1 ELSE 0 END) as blockers,
         SUM(CASE WHEN json_extract(metadata, '$.severity') = 'critical' THEN 1 ELSE 0 END) as critical,
         SUM(CASE WHEN json_extract(metadata, '$.severity') = 'major' THEN 1 ELSE 0 END) as major,
         SUM(CASE WHEN json_extract(metadata, '$.severity') = 'minor' THEN 1 ELSE 0 END) as minor,
         SUM(CASE WHEN json_extract(metadata, '$.drift_count') > 0 THEN 1 ELSE 0 END) as drifted
       FROM captures
       WHERE type = 'error' AND deleted_at IS NULL
       AND ${windowClause}
       GROUP BY session_key
       ORDER BY total DESC`,
    )
    .all() as {
    session_key: string;
    total: number;
    resolved_count: number;
    blockers: number;
    critical: number;
    major: number;
    minor: number;
    drifted: number;
  }[];

  if (byProject.length === 0) {
    console.log(`No errors in the last ${days} days.`);
    console.log("Error personas are auto-built from captured errors.\n");
    db.close();
    return;
  }

  for (const proj of byProject) {
    const resolveRate =
      proj.total > 0 ? ((proj.resolved_count / proj.total) * 100).toFixed(0) : "0";
    const driftRate = proj.total > 0 ? ((proj.drifted / proj.total) * 100).toFixed(0) : "0";
    const projLabel = proj.session_key.slice(0, 16);

    console.log(`Project: ${projLabel}...`);
    console.log(`  Total errors:     ${proj.total}`);
    console.log(`  Resolved:         ${proj.resolved_count} (${resolveRate}%)`);
    console.log(
      `  Severity:         ${proj.blockers} blocker, ${proj.critical} critical, ${proj.major} major, ${proj.minor} minor`,
    );
    console.log(`  Drift rate:       ${driftRate}%`);

    // Top error types for this project
    const topTypes = db
      .prepare(
        `SELECT
           json_extract(metadata, '$.error_type') as etype,
           COUNT(*) as count
         FROM captures
         WHERE type = 'error' AND deleted_at IS NULL
         AND ${windowClause}
         AND session_key = ?
         GROUP BY etype
         ORDER BY count DESC LIMIT 3`,
      )
      .all(proj.session_key) as { etype: string; count: number }[];

    if (topTypes.length > 0) {
      console.log(
        `  Top error types:  ${topTypes.map((t) => `${t.etype ?? "unknown"} (${t.count})`).join(", ")}`,
      );
    }

    // Top branches (from context_enrichment)
    const topBranches = db
      .prepare(
        `SELECT
           json_extract(metadata, '$.context_enrichment.branch') as branch,
           COUNT(*) as count
         FROM captures
         WHERE type = 'error' AND deleted_at IS NULL
         AND ${windowClause}
         AND session_key = ?
         AND json_extract(metadata, '$.context_enrichment.branch') IS NOT NULL
         GROUP BY branch
         ORDER BY count DESC LIMIT 3`,
      )
      .all(proj.session_key) as { branch: string; count: number }[];

    if (topBranches.length > 0) {
      console.log(
        `  Top branches:     ${topBranches.map((b) => `${b.branch} (${b.count})`).join(", ")}`,
      );
    }

    // Top anti-patterns
    const topAnti = db
      .prepare(
        `SELECT
           json_extract(metadata, '$.anti_pattern') as anti,
           COUNT(*) as count
         FROM captures
         WHERE type = 'error' AND deleted_at IS NULL
         AND ${windowClause}
         AND session_key = ?
         AND json_extract(metadata, '$.anti_pattern') IS NOT NULL
         GROUP BY anti
         ORDER BY count DESC LIMIT 2`,
      )
      .all(proj.session_key) as { anti: string; count: number }[];

    if (topAnti.length > 0) {
      console.log("  Anti-patterns:");
      for (const a of topAnti) {
        console.log(`    - ${(a.anti ?? "").slice(0, 50)} (${a.count}x)`);
      }
    }

    // Persona summary (auto-generated)
    console.log();
    const personaParts: string[] = [];
    if (proj.blockers > 0) personaParts.push("has blocker-level errors");
    if (proj.critical > proj.major) personaParts.push("critical-heavy");
    if (Number(driftRate) > 30) personaParts.push("high drift (agent ignores warnings)");
    if (Number(resolveRate) > 80) personaParts.push("high resolve rate");
    else if (Number(resolveRate) < 30) personaParts.push("low resolve rate (many unresolved)");
    if (topTypes[0]?.etype) personaParts.push(`${topTypes[0].etype}-heavy`);

    console.log(`  Persona: This project ${personaParts.join(", ")}.`);
    console.log();
  }

  // Summary scorecard
  console.log(`${"─".repeat(60)}`);
  console.log("Persona scorecard:");
  console.log(`  Projects tracked:     ${byProject.length}`);
  const totalErrors = byProject.reduce((s, p) => s + p.total, 0);
  const totalResolved = byProject.reduce((s, p) => s + p.resolved_count, 0);
  console.log(`  Total errors:         ${totalErrors}`);
  console.log(`  Total resolved:       ${totalResolved}`);
  console.log();
  console.log("Error personas are auto-built from captured errors.");
  console.log("Set TDAI_RETRO_DAYS=N to change the analysis window (default: 7).");

  db.close();
}

// ==================================================================
// Moat 2: Decision Learning Loop
// ==================================================================

/**
 * `tdai-memory-mcp decisions` — Decision dashboard.
 * Shows captured decisions, follow rate, top choices.
 */
export function decisionsDashboard(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp decisions — Decision Learning Dashboard\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  const decisions = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.decision_type') as dtype,
         json_extract(metadata, '$.choice') as choice,
         json_extract(metadata, '$.rationale') as rationale,
         json_extract(metadata, '$.confidence') as confidence,
         json_extract(metadata, '$.seen_count') as seen,
         json_extract(metadata, '$.followed') as followed,
         created_at
       FROM captures
       WHERE type = 'decision' AND deleted_at IS NULL
       AND ${windowClause}
       ORDER BY CAST(json_extract(metadata, '$.confidence') AS INTEGER) DESC
       LIMIT 20`,
    )
    .all() as {
    id: string;
    title: string;
    dtype: string;
    choice: string;
    rationale: string;
    confidence: number;
    seen: number;
    followed: string;
    created_at: string;
  }[];

  if (decisions.length === 0) {
    console.log(`No decisions captured in the last ${days} days.`);
    console.log(
      "Decisions are auto-captured when you install dependencies, create configs, or commit decisions.\n",
    );
    db.close();
    return;
  }

  console.log(`Recent decisions (last ${days} days):`);
  console.log();
  for (const d of decisions) {
    const date = new Date(d.created_at).toISOString().split("T")[0];
    const conf = d.confidence ?? 1;
    const seen = d.seen ?? 1;
    console.log(`  ${date} [${d.dtype}] ${d.title}  (confidence=${conf}, seen=${seen}x)`);
    if (d.rationale) console.log(`    rationale: ${d.rationale.slice(0, 60)}`);
  }

  // Scorecard
  console.log(`\n${"─".repeat(60)}`);
  console.log("Decision scorecard:");
  console.log(`  Total decisions:    ${decisions.length}`);

  const byType = new Map<string, number>();
  for (const d of decisions) {
    byType.set(d.dtype ?? "unknown", (byType.get(d.dtype ?? "unknown") ?? 0) + 1);
  }
  for (const [type, count] of byType) {
    console.log(`  ${type}: ${count}`);
  }

  const highConf = decisions.filter((d) => (d.confidence ?? 0) >= 3).length;
  console.log(`  High confidence:    ${highConf} (seen 3+ times)`);
  console.log();
  console.log(
    "Decisions are auto-captured from dependency installs, config creation, and commit messages.",
  );
  console.log("Set TDAI_RETRO_DAYS=N to change the window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp decisions retro` — Decision retrospective.
 * Shows follow rate, ignored decisions, repeated decisions.
 */
export function decisionsRetro(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp decisions retro — Decision Retrospective\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  const decisions = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.decision_type') as dtype,
         json_extract(metadata, '$.choice') as choice,
         json_extract(metadata, '$.confidence') as confidence,
         json_extract(metadata, '$.seen_count') as seen,
         json_extract(metadata, '$.drift_count') as drift,
         created_at
       FROM captures
       WHERE type = 'decision' AND deleted_at IS NULL
       AND ${windowClause}
       ORDER BY created_at DESC`,
    )
    .all() as {
    id: string;
    title: string;
    dtype: string;
    choice: string;
    confidence: number;
    seen: number;
    drift: number;
    created_at: string;
  }[];

  if (decisions.length === 0) {
    console.log(`No decisions in the last ${days} days.\n`);
    db.close();
    return;
  }

  // Repeated decisions (same choice seen 2+ times = agent re-deciding)
  const repeated = decisions.filter((d) => (d.seen ?? 1) >= 2);
  if (repeated.length > 0) {
    console.log("Repeated decisions (seen 2+ times — agent re-chose):");
    for (const d of repeated) {
      console.log(`  [${d.dtype}] ${d.title}  (seen ${d.seen}x)`);
    }
    console.log();
  }

  // Drifted decisions (ignored)
  const drifted = decisions.filter((d) => (d.drift ?? 0) > 0);
  if (drifted.length > 0) {
    console.log("Drifted decisions (injected but ignored):");
    for (const d of drifted) {
      console.log(`  [${d.dtype}] ${d.title}  (drift=${d.drift})`);
    }
    console.log();
  }

  // Scorecard
  console.log(`${"─".repeat(60)}`);
  console.log("Decision retro scorecard:");
  console.log(`  Total decisions:     ${decisions.length}`);
  console.log(`  Repeated:            ${repeated.length}`);
  console.log(`  Drifted:             ${drifted.length}`);
  const followRate =
    decisions.length > 0
      ? (((decisions.length - drifted.length) / decisions.length) * 100).toFixed(0)
      : "0";
  console.log(`  Follow rate:         ${followRate}%`);
  console.log();
  console.log("Set TDAI_RETRO_DAYS=N to change the window (default: 7).");

  db.close();
}

// ==================================================================
// Moat 3: Pattern Learning Loop
// ==================================================================

/**
 * `tdai-memory-mcp patterns` — Pattern dashboard.
 * Shows captured code patterns, adoption rate, top patterns.
 */
export function patternsDashboard(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp patterns — Pattern Learning Dashboard\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  const patterns = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.pattern_type') as ptype,
         json_extract(metadata, '$.language') as language,
         json_extract(metadata, '$.signature') as sig,
         json_extract(metadata, '$.file_path') as fpath,
         json_extract(metadata, '$.confidence') as confidence,
         json_extract(metadata, '$.seen_count') as seen,
         json_extract(metadata, '$.adopted') as adopted,
         created_at
       FROM captures
       WHERE type = 'pattern' AND deleted_at IS NULL
       AND ${windowClause}
       ORDER BY CAST(json_extract(metadata, '$.confidence') AS INTEGER) DESC
       LIMIT 20`,
    )
    .all() as {
    id: string;
    title: string;
    ptype: string;
    language: string;
    sig: string;
    fpath: string;
    confidence: number;
    seen: number;
    adopted: string;
    created_at: string;
  }[];

  if (patterns.length === 0) {
    console.log(`No patterns captured in the last ${days} days.`);
    console.log(
      "Patterns are auto-captured when you write/edit code (functions, components, classes, imports).\n",
    );
    db.close();
    return;
  }

  console.log(`Recent patterns (last ${days} days):`);
  console.log();
  for (const p of patterns) {
    const date = new Date(p.created_at).toISOString().split("T")[0];
    const conf = p.confidence ?? 1;
    const seen = p.seen ?? 1;
    console.log(
      `  ${date} [${p.ptype}] [${p.language}] ${p.title}  (confidence=${conf}, seen=${seen}x)`,
    );
    if (p.fpath) console.log(`    file: ${p.fpath}`);
  }

  // Scorecard
  console.log(`\n${"─".repeat(60)}`);
  console.log("Pattern scorecard:");
  console.log(`  Total patterns:     ${patterns.length}`);

  const byType = new Map<string, number>();
  const byLang = new Map<string, number>();
  for (const p of patterns) {
    byType.set(p.ptype ?? "unknown", (byType.get(p.ptype ?? "unknown") ?? 0) + 1);
    byLang.set(p.language ?? "unknown", (byLang.get(p.language ?? "unknown") ?? 0) + 1);
  }
  console.log("  By type:");
  for (const [type, count] of byType) {
    console.log(`    ${type}: ${count}`);
  }
  console.log("  By language:");
  for (const [lang, count] of byLang) {
    console.log(`    ${lang}: ${count}`);
  }

  const highConf = patterns.filter((p) => (p.confidence ?? 0) >= 3).length;
  console.log(`  High confidence:    ${highConf} (seen 3+ times)`);
  console.log();
  console.log("Patterns are auto-captured from Write/Edit tools.");
  console.log("Set TDAI_RETRO_DAYS=N to change the window (default: 7).");

  db.close();
}

/**
 * `tdai-memory-mcp patterns retro` — Pattern retrospective.
 * Shows adoption rate, ignored patterns, most/least followed.
 */
export function patternsRetro(dbPath: string = defaultDbPath()): void {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error("Error: Could not open database at", dbPath);
    process.exit(1);
  }

  console.log("tdai-memory-mcp patterns retro — Pattern Retrospective\n");
  console.log(`${"─".repeat(60)}\n`);

  const days = Number(process.env.TDAI_RETRO_DAYS ?? 7);
  const windowClause = `created_at > datetime('now', '-${days} days')`;

  const patterns = db
    .prepare(
      `SELECT
         id,
         json_extract(metadata, '$.title') as title,
         json_extract(metadata, '$.pattern_type') as ptype,
         json_extract(metadata, '$.language') as language,
         json_extract(metadata, '$.confidence') as confidence,
         json_extract(metadata, '$.seen_count') as seen,
         json_extract(metadata, '$.adopted') as adopted,
         created_at
       FROM captures
       WHERE type = 'pattern' AND deleted_at IS NULL
       AND ${windowClause}
       ORDER BY CAST(json_extract(metadata, '$.confidence') AS INTEGER) DESC`,
    )
    .all() as {
    id: string;
    title: string;
    ptype: string;
    language: string;
    confidence: number;
    seen: number;
    adopted: string;
    created_at: string;
  }[];

  if (patterns.length === 0) {
    console.log(`No patterns in the last ${days} days.\n`);
    db.close();
    return;
  }

  // Most seen patterns (adopted multiple times)
  const topPatterns = patterns.filter((p) => (p.seen ?? 1) >= 3);
  if (topPatterns.length > 0) {
    console.log("Most seen patterns (seen 3+ times — widely used):");
    for (const p of topPatterns.slice(0, 10)) {
      console.log(`  [${p.ptype}] [${p.language}] ${p.title}  (seen ${p.seen}x)`);
    }
    console.log();
  }

  // Scorecard
  console.log(`${"─".repeat(60)}`);
  console.log("Pattern retro scorecard:");
  console.log(`  Total patterns:     ${patterns.length}`);
  console.log(`  Widely used (3+):   ${topPatterns.length}`);
  const adoptedCount = patterns.filter((p) => p.adopted === "true").length;
  console.log(`  Adopted:            ${adoptedCount}`);
  const adoptionRate =
    patterns.length > 0 ? ((adoptedCount / patterns.length) * 100).toFixed(0) : "0";
  console.log(`  Adoption rate:      ${adoptionRate}%`);
  console.log();
  console.log("Set TDAI_RETRO_DAYS=N to change the window (default: 7).");

  db.close();
}
