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

  // 7. Summary scorecard
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
  if (
    loops.length === 0 &&
    wasted.length === 0 &&
    recurred.length === 0 &&
    harmful.length === 0 &&
    driftViolations.length === 0
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
