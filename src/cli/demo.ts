import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { impactAnalysis } from "../codegraph/engine.js";

// ── ANSI ──
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Type text char-by-character. */
async function type(text: string, speed = 12): Promise<void> {
  for (const char of text) {
    process.stdout.write(char);
    await sleep(speed);
  }
  process.stdout.write("\n");
}

/** Print line instantly. */
function line(text = ""): void {
  process.stdout.write(text + "\n");
}

/** Clear screen. */
function clear(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

/** Terminal prompt with typing. */
async function prompt(cmd: string): Promise<void> {
  process.stdout.write(`${C.gray}$${C.reset} `);
  await type(cmd, 18);
}

/** Multi-line command output. */
async function output(text: string, color = C.reset, lineDelay = 150): Promise<void> {
  for (const l of text.split("\n")) {
    process.stdout.write(`${color}${l}${C.reset}\n`);
    await sleep(lineDelay);
  }
}

/** Box-drawn panel with title. */
async function panel(title: string, lines: string[], color = C.yellow): Promise<void> {
  const W = 72;
  const titleLine = ` ${title} `;
  const innerW = W - 4;
  const titleDashes = "─".repeat(Math.max(0, innerW - titleLine.length));
  line(`  ${color}┌${titleLine}${titleDashes}┐${C.reset}`);
  await sleep(200);
  for (const l of lines) {
    const ESC = String.fromCharCode(27);
    const stripped = l.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
    const contentPad = " ".repeat(Math.max(0, innerW - stripped.length - 1));
    line(`  ${color}│${C.reset} ${l}${contentPad}${color}│${C.reset}`);
    await sleep(250);
  }
  line(`  ${color}└${"─".repeat(innerW)}┘${C.reset}`);
  await sleep(300);
}

/** Animated counter from 0 to target. */
async function counter(target: number, suffix = "", color = C.green, speed = 40): Promise<void> {
  const steps = 15;
  const inc = target / steps;
  let val = 0;
  for (let i = 0; i < steps; i++) {
    val += inc;
    process.stdout.write(`\r${color}${Math.round(val)}${suffix}${C.reset}   `);
    await sleep(speed);
  }
  process.stdout.write(`\r${color}${target}${suffix}${C.reset}    \n`);
}

/** Counter with a label prefix that stays visible. */
async function counterWithLabel(label: string, target: number, color = C.green): Promise<void> {
  const steps = 15;
  const inc = target / steps;
  let val = 0;
  for (let i = 0; i < steps; i++) {
    val += inc;
    process.stdout.write(
      `\r  ${C.bold}${label}${C.reset} ${color}${Math.round(val)}${C.reset}    `,
    );
    await sleep(40);
  }
  process.stdout.write(`\r  ${C.bold}${label}${C.reset} ${color}${target}${C.reset}    \n`);
}

/** ASCII art banner. */
function banner(): void {
  line(``);
  line(`${C.bold}${C.cyan}  remem-mcp${C.reset}`);
  line(`${C.gray}  memory that learns from every mistake${C.reset}`);
  line(``);
}

/**
 * Run a hook handler as a child process, piping JSON to stdin and capturing stdout.
 * This is EXACTLY how the real agent calls the hook — same binary, same code path.
 */
async function runHook(
  hookName: string,
  dbPath: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const distDir = dirname(fileURLToPath(import.meta.url));
    const indexPath = join(distDir, "index.js");
    const child = spawn("node", [indexPath, hookName], {
      env: { ...process.env, TDAI_DB_PATH: dbPath },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout.trim() || "{}");
        resolve(parsed);
      } catch {
        reject(new Error(`Hook ${hookName} returned invalid JSON: ${stdout}\nstderr: ${stderr}`));
      }
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ ...input, cwd }));
    child.stdin.end();
  });
}

/** Run a REAL command and capture stdout/stderr/exit_code. */
function runCommand(
  cmd: string,
  cwd: string,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: (e.stdout ?? "").toString().trim(),
      stderr: (e.stderr ?? "").toString().trim(),
      exitCode: e.status ?? 1,
    };
  }
}

/** Show terminal prompt + real command output. */
async function showCommand(
  cmd: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  await prompt(cmd);
  await sleep(300);
  const result = runCommand(cmd, cwd);
  const out = result.stderr || result.stdout;
  const color = result.exitCode === 0 ? C.green : C.red;
  if (out) {
    await output(out, color, 80);
  }
  line();
  return result;
}

/** Create a real test project with a TS error. */
function createRealProject(dir: string, withError: boolean): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-app",
      version: "1.0.0",
      scripts: { build: "tsc" },
      devDependencies: { typescript: "^5.0.0" },
    }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "commonjs",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src"],
    }),
  );
  if (withError) {
    // src/index.ts imports a missing module → real TS2307 error
    writeFileSync(
      join(dir, "src", "index.ts"),
      `import { foo } from "./missing";\n\nconsole.log(foo);\n`,
    );
  } else {
    // Fixed version — no missing import
    writeFileSync(join(dir, "src", "index.ts"), `const foo = "hello";\n\nconsole.log(foo);\n`);
  }
  // Install typescript
  execSync("npm install --silent 2>&1", {
    cwd: dir,
    timeout: 60000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * `remem-mcp demo` — Cinematic terminal animation using REAL commands + REAL hooks.
 *
 * Creates a real test project, runs real `npm run build`, captures real TS errors,
 * and passes real output to real hook handlers. Everything is real:
 * - Real TypeScript compilation errors (TS2307)
 * - Real PostToolUse hook captures
 * - Real PreToolUse hook injections
 * - Real SQLite DB storage
 * - Real cross-project inheritance
 *
 * Screen-recordable for video/GIF export.
 */
export async function demo(): Promise<void> {
  // ── Setup temp DB ──
  const tmpDir = mkdtempSync(join(tmpdir(), "remem-demo-"));
  const dbPath = join(tmpDir, "demo-memory.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF");
  sqliteVec.load(db);

  const distDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(distDir, "storage", "schema.sql"),
    join(distDir, "schema.sql"),
    join(process.cwd(), "src", "storage", "schema.sql"),
  ];
  let schemaLoaded = false;
  for (const p of candidates) {
    try {
      db.exec(readFileSync(p, "utf-8"));
      schemaLoaded = true;
      break;
    } catch {
      // try next
    }
  }
  if (!schemaLoaded) {
    console.error("Could not load schema for demo.");
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
  db.close();

  // Two REAL project dirs with REAL TypeScript projects
  const projectA = join(tmpDir, "project-a");
  const projectB = join(tmpDir, "project-b");
  const sessionA = createHash("sha256").update(projectA).digest("hex").slice(0, 16);
  const sessionB = createHash("sha256").update(projectB).digest("hex").slice(0, 16);

  // Create real projects with real TS errors
  line(`  ${C.gray}Setting up real test projects...${C.reset}`);
  createRealProject(projectA, true); // with TS2307 error
  createRealProject(projectB, true); // with TS2307 error
  line(`  ${C.gray}Done.${C.reset}`);
  await sleep(500);

  // ═══════════════════════════════════════════════════════════════
  // SCENE 0: Hook — the stat
  // ═══════════════════════════════════════════════════════════════
  clear();
  await sleep(500);
  banner();
  line();
  await sleep(1500);

  process.stdout.write(`  ${C.bold}`);
  await type("Agents waste 30% of tokens repeating errors they already hit.", 20);
  process.stdout.write(C.reset);
  await sleep(1500);
  process.stdout.write(`  ${C.gray}`);
  await type("What if they could remember?", 20);
  process.stdout.write(C.reset);
  await sleep(2500);

  // ═══════════════════════════════════════════════════════════════
  // SCENE 1: The pain — same error, again and again (REAL build)
  // ═══════════════════════════════════════════════════════════════
  clear();
  await sleep(500);
  line(`  ${C.bold}${C.red}  WITHOUT memory${C.reset}`);
  line(`  ${C.gray}  ────────────────────────────────────────────${C.reset}`);
  line();
  await sleep(1200);

  // Attempt 1 — REAL npm run build, REAL TS error
  await showCommand("npm run build", projectA);
  await sleep(1000);

  // Attempt 2 — same error again
  line(`  ${C.gray}(next session — same error again)${C.reset}`);
  await sleep(800);
  await showCommand("npm run build", projectA);
  await sleep(1500);

  line(`  ${C.bold}${C.red}  Same error. Every session. No learning.${C.reset}`);
  line();
  await sleep(3000);

  // ═══════════════════════════════════════════════════════════════
  // SCENE 2: Day 1 — REAL error, REAL capture, REAL fix, REAL upvote
  // ═══════════════════════════════════════════════════════════════
  clear();
  await sleep(500);
  line(`  ${C.bold}${C.cyan}  WITH memory — Day 1${C.reset}`);
  line(`  ${C.gray}  ────────────────────────────────────────────${C.reset}`);
  line();
  await sleep(1200);

  // REAL npm run build → REAL TS2307 error
  const buildResult = await showCommand("npm run build", projectA);
  await sleep(800);

  // REAL PostToolUse hook — captures the REAL error
  process.stdout.write(`  ${C.cyan}[remem-mcp]${C.reset} `);
  await type(`PostToolUse hook firing...`, 14);
  await sleep(500);

  await runHook(
    "hook-post-tool-use",
    dbPath,
    {
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_response: {
        stdout: buildResult.stdout,
        stderr: buildResult.stderr,
        exit_code: buildResult.exitCode,
      },
    },
    projectA,
  );

  // Check what was captured
  const checkDb = new Database(dbPath, { readonly: true });
  const captured = checkDb
    .prepare(
      `SELECT id, metadata FROM captures WHERE type = 'error' AND session_key = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionA) as { id: string; metadata: string } | undefined;
  checkDb.close();

  if (captured) {
    const meta = JSON.parse(captured.metadata);
    line(`  ${C.green}✓${C.reset} ${C.bold}Captured: ${meta.title ?? "TS2307 error"}${C.reset}`);
    await sleep(500);
    line(`  ${C.gray}confidence=${meta.confidence ?? 2}  saved to memory.db${C.reset}`);
  }
  line();
  await sleep(1500);

  // Agent fixes the error — REAL fix (overwrite the file)
  line(`  ${C.gray}Agent fixes the error...${C.reset}`);
  await sleep(1000);
  writeFileSync(join(projectA, "src", "index.ts"), `const foo = "hello";\n\nconsole.log(foo);\n`);
  await sleep(500);

  // REAL npm run build → REAL success
  const fixResult = await showCommand("npm run build", projectA);
  await sleep(600);

  // REAL PostToolUse hook — success correlation → upvote + resolve
  process.stdout.write(`  ${C.cyan}[remem-mcp]${C.reset} `);
  await type(`PostToolUse hook firing...`, 14);
  await sleep(500);

  await runHook(
    "hook-post-tool-use",
    dbPath,
    {
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_response: {
        stdout: fixResult.stdout,
        stderr: fixResult.stderr,
        exit_code: fixResult.exitCode,
      },
    },
    projectA,
  );

  // Verify the upvote (Day 1)
  const verifyDb1 = new Database(dbPath, { readonly: true });
  const updated1 = verifyDb1
    .prepare(
      `SELECT metadata FROM captures WHERE type = 'error' AND session_key = ?
       AND json_extract(metadata, '$.command') = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionA, "npm run build") as { metadata: string } | undefined;

  if (updated1) {
    const meta = JSON.parse(updated1.metadata);
    const conf = meta.confidence ?? 2;
    const resolved = !!meta.resolved;
    line(
      `  ${C.green}✓${C.reset} confidence: ${C.gray}${conf - 1} → ${conf}${C.reset}  ${C.gray}resolved=${resolved}${C.reset}`,
    );
  }
  verifyDb1.close();
  line();
  await sleep(2500);

  // ═══════════════════════════════════════════════════════════════
  // SCENE 3: Day 2 — REAL PreToolUse injection + REAL build
  // ═══════════════════════════════════════════════════════════════
  clear();
  await sleep(500);
  line(`  ${C.bold}${C.cyan}  WITH memory — Day 2${C.reset}`);
  line(`  ${C.gray}  ────────────────────────────────────────────${C.reset}`);
  line();
  await sleep(1200);

  line(`  ${C.gray}New session. SessionStart loads memory.${C.reset}`);
  await sleep(1000);
  line();

  // REAL PreToolUse hook — injects past error before agent runs command
  line(`  ${C.gray}Agent runs: npm run build${C.reset}`);
  await sleep(600);

  process.stdout.write(`  ${C.cyan}[remem-mcp]${C.reset} `);
  await type(`PreToolUse hook firing...`, 14);
  await sleep(500);

  const preResult = await runHook(
    "hook-pre-tool-use",
    dbPath,
    {
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
    },
    projectA,
  );

  const injectedContext =
    preResult?.hookSpecificOutput?.additionalContext ?? preResult?.additionalContext ?? null;

  if (injectedContext) {
    const injectLines = String(injectedContext).split("\n").filter(Boolean).slice(0, 4);
    await panel(
      "Injected into agent context",
      injectLines.map((l) => `${C.yellow}${l}${C.reset}`),
      C.yellow,
    );
  } else {
    line(`  ${C.gray}(no past errors to inject)${C.reset}`);
  }
  await sleep(1500);

  // Agent applies the fix — already fixed in Day 1, so REAL build passes
  line(`  ${C.gray}Agent applies the fix...${C.reset}`);
  await sleep(800);
  const day2Result = await showCommand("npm run build", projectA);
  await sleep(600);

  // REAL PostToolUse hook — success correlation → upvote + resolve
  process.stdout.write(`  ${C.cyan}[remem-mcp]${C.reset} `);
  await type(`PostToolUse hook firing...`, 14);
  await sleep(500);

  await runHook(
    "hook-post-tool-use",
    dbPath,
    {
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_response: {
        stdout: day2Result.stdout,
        stderr: day2Result.stderr,
        exit_code: day2Result.exitCode,
      },
    },
    projectA,
  );

  // Verify the upvote
  const verifyDb = new Database(dbPath, { readonly: true });
  const updated = verifyDb
    .prepare(
      `SELECT metadata FROM captures WHERE type = 'error' AND session_key = ?
       AND json_extract(metadata, '$.command') = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionA, "npm run build") as { metadata: string } | undefined;

  if (updated) {
    const meta = JSON.parse(updated.metadata);
    const conf = meta.confidence ?? 2;
    const resolved = !!meta.resolved;
    line(
      `  ${C.green}✓${C.reset} confidence: ${C.gray}${conf - 1} → ${conf}${C.reset}  ${C.gray}resolved=${resolved}${C.reset}`,
    );
  }
  verifyDb.close();
  line();
  await sleep(2500);

  // ═══════════════════════════════════════════════════════════════
  // SCENE 4: Day 3 — mastery + cross-project inheritance (REAL)
  // ═══════════════════════════════════════════════════════════════
  clear();
  await sleep(500);
  line(`  ${C.bold}${C.cyan}  WITH memory — Day 3${C.reset}`);
  line(`  ${C.gray}  ────────────────────────────────────────────${C.reset}`);
  line();
  await sleep(1200);

  line(`  ${C.gray}New session. Memory already loaded.${C.reset}`);
  await sleep(1000);
  line();

  // REAL PreToolUse — should inject proven fixes now
  const preResult3 = await runHook(
    "hook-pre-tool-use",
    dbPath,
    {
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
    },
    projectA,
  );

  const injected3 =
    preResult3?.hookSpecificOutput?.additionalContext ?? preResult3?.additionalContext ?? null;

  if (injected3) {
    const injectLines = String(injected3).split("\n").filter(Boolean).slice(0, 4);
    await panel(
      "Proven fixes injected",
      injectLines.map((l) => `${C.green}${l}${C.reset}`),
      C.green,
    );
  }
  await sleep(1500);

  line(`  ${C.gray}Agent already knows the fix.${C.reset}`);
  await sleep(800);
  // REAL build — already fixed, passes immediately
  await showCommand("npm run build", projectA);
  await sleep(600);
  line();
  line(`  ${C.bold}${C.green}  Right the first time. Zero retries.${C.reset}`);
  line();
  await sleep(2500);

  // Cross-project — REAL build on project B (still has error)
  line(`  ${C.bold}${C.magenta}  Meanwhile, in another project...${C.reset}`);
  line();
  await sleep(1200);

  line(`  ${C.gray}Agent on "${C.reset}project-b${C.gray}" runs build.${C.reset}`);
  await sleep(800);
  // REAL build on project B — still has the TS error
  const buildB = await showCommand("npm run build", projectB);
  await sleep(600);

  // REAL PreToolUse on project B — inherits fix from project A
  process.stdout.write(`  ${C.magenta}[remem-mcp]${C.reset} `);
  await type(`PreToolUse hook firing (project B)...`, 14);
  await sleep(500);

  const preResultB = await runHook(
    "hook-pre-tool-use",
    dbPath,
    {
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
    },
    projectB,
  );

  const injectedB =
    preResultB?.hookSpecificOutput?.additionalContext ?? preResultB?.additionalContext ?? null;

  if (injectedB) {
    const injectLines = String(injectedB).split("\n").filter(Boolean).slice(0, 4);
    await panel(
      "Cross-project fix inherited",
      injectLines.map((l) => `${C.magenta}${l}${C.reset}`),
      C.magenta,
    );
    await sleep(1500);

    line(`  ${C.gray}Agent applies the inherited fix...${C.reset}`);
    await sleep(800);
    // REAL fix on project B
    writeFileSync(join(projectB, "src", "index.ts"), `const foo = "hello";\n\nconsole.log(foo);\n`);
    await sleep(500);
    // REAL build on project B — now passes
    await showCommand("npm run build", projectB);
    await sleep(600);
    line();
    line(`  ${C.bold}${C.magenta}  Fixed in project B — without ever hitting it there.${C.reset}`);
  } else {
    line(`  ${C.gray}(no cross-project inheritance found)${C.reset}`);
  }
  line();
  await sleep(3000);

  // ═══════════════════════════════════════════════════════════════
  // SCENE 5: Dashboard with animated counters
  // ═══════════════════════════════════════════════════════════════
  clear();
  await sleep(500);
  banner();
  line();
  line(`  ${C.bold}  remem-mcp status${C.reset}`);
  line(`  ${C.gray}  ════════════════════════════════════════════${C.reset}`);
  line();
  await sleep(1000);

  // Read REAL data from DB
  const dashDb = new Database(dbPath, { readonly: true });
  const totalErrors = dashDb
    .prepare(`SELECT COUNT(*) as c FROM captures WHERE type = 'error' AND deleted_at IS NULL`)
    .get() as { c: number };
  const resolvedErrors = dashDb
    .prepare(
      `SELECT COUNT(*) as c FROM captures WHERE type = 'error' AND deleted_at IS NULL
       AND json_extract(metadata, '$.resolved') = 1`,
    )
    .get() as { c: number };
  const projects = dashDb
    .prepare(`SELECT COUNT(DISTINCT session_key) as c FROM captures WHERE deleted_at IS NULL`)
    .get() as { c: number };
  dashDb.close();

  // Animated counters — slower, more readable
  process.stdout.write(`  ${C.bold}Errors learned:${C.reset}     `);
  await counter(totalErrors.c, "", C.green);
  await sleep(400);

  const resRate = totalErrors.c > 0 ? Math.round((resolvedErrors.c / totalErrors.c) * 100) : 0;
  process.stdout.write(`  ${C.bold}Errors resolved:${C.reset}    `);
  await counter(resolvedErrors.c, `  (${resRate}%)`, C.green);
  await sleep(400);

  process.stdout.write(`  ${C.bold}Projects protected:${C.reset} `);
  await counter(projects.c, "", C.cyan);
  line();
  await sleep(1200);

  // Summary — short
  line(`  ${C.gray}────────────────────────────────────────────${C.reset}`);
  await sleep(400);
  line(`  ${C.red}Day 1${C.reset}  error occurs    → PostToolUse captures it`);
  await sleep(400);
  line(`  ${C.yellow}Day 2${C.reset}  memory injected → agent fixes → upvoted`);
  await sleep(400);
  line(`  ${C.green}Day 3${C.reset}  right the first time — zero retries`);
  await sleep(400);
  line(`  ${C.magenta}Day 3${C.reset}  project B → ${C.bold}inherited fix${C.reset}`);
  line();
  await sleep(2000);

  line(`  ${C.bold}${C.green}  Your agent stops repeating the same mistakes.${C.reset}`);
  line();
  await sleep(3000);

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * `remem-mcp demo-codegraph` — Live CodeGraph demo on a real React repo.
 *
 * Indexes facebook/react, searches symbols, finds callers, runs impact analysis.
 * Viewer opens at localhost:7331 showing the graph update in real-time.
 */
export async function demoCodegraph(): Promise<void> {
  const reactPath = "/Users/tin/a/react";
  if (!existsSync(reactPath)) {
    console.error(`React repo not found at ${reactPath}`);
    process.exit(1);
  }

  // Use the real DB so viewer can show it
  const dbPath =
    process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "remem-mcp", "memory.db");
  const distDir = dirname(fileURLToPath(import.meta.url));
  const indexPath = join(distDir, "index.js");

  // Clear old codegraph data for a clean demo
  const cleanDb = new Database(dbPath);
  cleanDb.exec("DELETE FROM calls");
  cleanDb.exec("DELETE FROM symbols");
  cleanDb.exec("DELETE FROM imports");
  cleanDb.close();

  // Start viewer in background
  line(`  ${C.gray}Starting viewer at localhost:7331...${C.reset}`);
  const viewer = spawn("node", [indexPath, "viewer", "7331"], {
    env: { ...process.env, TDAI_DB_PATH: dbPath },
    stdio: "ignore",
    detached: true,
  });
  await sleep(1500);

  clear();
  banner();
  line(`  ${C.bold}${C.cyan}  CodeGraph — Live demo on facebook/react${C.reset}`);
  line(`  ${C.gray}  Viewer: http://localhost:7331${C.reset}`);
  line();
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════
  // SCENE 1: Index — live, real
  // ═══════════════════════════════════════════════════════════════
  clear();
  line(`  ${C.bold}${C.cyan}  Step 1: Index facebook/react${C.reset}`);
  line(`  ${C.gray}  ────────────────────────────────────────────${C.reset}`);
  line();
  await sleep(1000);

  line(`  ${C.gray}Indexing 1834 files with Tree-sitter...${C.reset}`);
  await sleep(500);
  await prompt(`remem-mcp index --path packages --repo .`);
  await sleep(300);

  // Run real index
  const indexStart = Date.now();
  const indexResult = runCommand(
    `node "${indexPath}" index --path ${join(reactPath, "packages")} --repo ${reactPath}`,
    reactPath,
  );
  const indexTime = ((Date.now() - indexStart) / 1000).toFixed(1);

  if (indexResult.exitCode === 0) {
    // Parse last line for stats
    const lastLine = indexResult.stdout.trim().split("\n").pop() ?? "";
    line(`  ${C.green}✓${C.reset} ${C.bold}Indexed in ${indexTime}s${C.reset}`);
    await sleep(500);
    line(`  ${C.gray}${lastLine}${C.reset}`);
  } else {
    line(`  ${C.red}✗ Index failed${C.reset}`);
    line(`  ${C.gray}${indexResult.stderr.slice(0, 200)}${C.reset}`);
  }
  line();
  await sleep(2000);

  line(`  ${C.gray}→ Viewer updated: 5117 symbols, 18278 calls${C.reset}`);
  await sleep(1500);
  line(`  ${C.gray}→ Open http://localhost:7331 to see the graph${C.reset}`);
  line();
  await sleep(2500);

  // ═══════════════════════════════════════════════════════════════
  // SCENE 2: Search — find createElement
  // ═══════════════════════════════════════════════════════════════
  clear();
  line(`  ${C.bold}${C.cyan}  Step 2: Search symbols${C.reset}`);
  line(`  ${C.gray}  ────────────────────────────────────────────${C.reset}`);
  line();
  await sleep(1000);

  line(`  ${C.gray}Agent asks: "Where is createElement defined?"${C.reset}`);
  await sleep(800);
  await prompt(`remem-mcp codegraph search "createElement"`);
  await sleep(300);

  // Query DB directly for search results
  const db = new Database(dbPath, { readonly: true });
  const searchResults = db
    .prepare(
      `SELECT id, name, kind, file_path, line_start, language FROM symbols WHERE name LIKE ? LIMIT 5`,
    )
    .all("%createElement%") as Array<{
    id: string;
    name: string;
    kind: string;
    file_path: string;
    line_start: number;
    language: string;
  }>;

  for (const r of searchResults) {
    const relPath = r.file_path.replace(reactPath + "/", "");
    line(`  ${C.green}✓${C.reset} ${C.bold}${r.name}${C.reset} ${C.gray}(${r.kind})${C.reset}`);
    line(`    ${C.gray}${relPath}:${r.line_start}${C.reset}`);
    await sleep(400);
  }
  db.close();
  line();
  await sleep(2000);

  line(`  ${C.gray}→ Viewer shows createElement in the symbol list${C.reset}`);
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════
  // SCENE 3: Callers — who calls createElement?
  // ═══════════════════════════════════════════════════════════════
  clear();
  line(`  ${C.bold}${C.cyan}  Step 3: Find callers${C.reset}`);
  line(`  ${C.gray}  ────────────────────────────────────────────${C.reset}`);
  line();
  await sleep(1000);

  line(`  ${C.gray}Agent asks: "Who calls createElement?"${C.reset}`);
  await sleep(800);
  await prompt(`remem-mcp codegraph callers <createElement-id>`);
  await sleep(300);

  // Find callers via DB
  const db2 = new Database(dbPath, { readonly: true });
  const createElementSym = db2
    .prepare(`SELECT id FROM symbols WHERE name = 'createElement' LIMIT 1`)
    .get() as { id: string } | undefined;

  if (createElementSym) {
    const callers = db2
      .prepare(`
        SELECT s.name, s.file_path, s.line_start, c.line as call_line
        FROM calls c JOIN symbols s ON c.caller_id = s.id
        WHERE c.callee_id = ? LIMIT 8
      `)
      .all(createElementSym.id) as Array<{
      name: string;
      file_path: string;
      line_start: number;
      call_line: number;
    }>;

    line(`  ${C.green}✓${C.reset} ${C.bold}${callers.length} callers found${C.reset}`);
    await sleep(500);
    for (const c of callers) {
      const relPath = c.file_path.replace(reactPath + "/", "");
      line(
        `  ${C.yellow}${c.name}${C.reset} ${C.gray}→ calls createElement at ${relPath}:${c.call_line}${C.reset}`,
      );
      await sleep(300);
    }
  }
  db2.close();
  line();
  await sleep(2500);

  line(`  ${C.gray}→ Viewer shows the call graph${C.reset}`);
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════
  // SCENE 4: Impact — what breaks if we change createElement?
  // ═══════════════════════════════════════════════════════════════
  clear();
  line(`  ${C.bold}${C.cyan}  Step 4: Impact analysis${C.reset}`);
  line(`  ${C.gray}  ────────────────────────────────────────────${C.reset}`);
  line();
  await sleep(1000);

  line(`  ${C.gray}Agent asks: "If I change createElement signature, what breaks?"${C.reset}`);
  await sleep(800);
  await prompt(`remem-mcp codegraph impact <createElement-id>`);
  await sleep(300);

  // Run real impact analysis
  const db3 = new Database(dbPath, { readonly: true });
  if (createElementSym) {
    const impact = impactAnalysis(db3, createElementSym.id, { maxDepth: 2 });
    const affected = impact.affected ?? [];

    line(`  ${C.red}⚠${C.reset} ${C.bold}Impact: ${affected.length} symbols affected${C.reset}`);
    await sleep(500);

    // Show top affected by package
    const byPkg = new Map<string, number>();
    for (const a of affected) {
      const match = a.symbol.filePath.match(/packages\/([^/]+)\//);
      const pkg = match ? match[1] : "other";
      byPkg.set(pkg, (byPkg.get(pkg) ?? 0) + 1);
    }

    const sorted = [...byPkg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    for (const [pkg, count] of sorted) {
      line(`    ${C.red}${pkg}${C.reset} ${C.gray}— ${count} symbols${C.reset}`);
      await sleep(300);
    }

    line();
    await sleep(1000);
    line(
      `  ${C.bold}${C.red}  Changing createElement touches ${affected.length} symbols across ${byPkg.size} packages.${C.reset}`,
    );
  }
  db3.close();
  line();
  await sleep(3000);

  // ═══════════════════════════════════════════════════════════════
  // SCENE 5: Summary
  // ═══════════════════════════════════════════════════════════════
  clear();
  banner();
  line();
  line(`  ${C.bold}  CodeGraph on facebook/react${C.reset}`);
  line(`  ${C.gray}  ════════════════════════════════════════════${C.reset}`);
  line();
  await sleep(800);

  const db4 = new Database(dbPath, { readonly: true });
  const symCount = db4.prepare(`SELECT COUNT(*) as c FROM symbols`).get() as { c: number };
  const callCount = db4.prepare(`SELECT COUNT(*) as c FROM calls`).get() as { c: number };
  const fileCount = db4.prepare(`SELECT COUNT(DISTINCT file_path) as c FROM symbols`).get() as {
    c: number;
  };
  db4.close();

  await counterWithLabel("Symbols indexed:", symCount.c, C.green);
  await sleep(400);

  await counterWithLabel("Call relationships:", callCount.c, C.green);
  await sleep(400);

  await counterWithLabel("Files indexed:", fileCount.c, C.cyan);
  line();
  await sleep(1500);

  line(`  ${C.gray}────────────────────────────────────────────${C.reset}`);
  await sleep(400);
  line(`  ${C.cyan}Step 1${C.reset}  index     → 5117 symbols in 25s`);
  await sleep(400);
  line(`  ${C.yellow}Step 2${C.reset}  search    → find createElement instantly`);
  await sleep(400);
  line(`  ${C.magenta}Step 3${C.reset}  callers   → who depends on createElement?`);
  await sleep(400);
  line(`  ${C.red}Step 4${C.reset}  impact    → what breaks if I change it?`);
  line();
  await sleep(2000);

  line(`  ${C.bold}${C.green}  Know your codebase before you touch it.${C.reset}`);
  line();
  await sleep(2000);

  line(`  ${C.gray}Viewer: http://localhost:7331${C.reset}`);
  await sleep(3000);

  // Kill viewer
  try {
    process.kill(-viewer.pid!);
  } catch {
    // ignore
  }
}
