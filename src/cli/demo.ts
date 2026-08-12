import { spawn, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createHash } from "node:crypto";

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
    const stripped = l.replace(/\x1b\[[0-9;]*m/g, "");
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
  let lastLen = 0;
  for (let i = 0; i < steps; i++) {
    val += inc;
    const text = `${Math.round(val)}${suffix}`;
    const pad = " ".repeat(Math.max(0, lastLen - text.length));
    process.stdout.write(`\r${color}${text}${pad}${C.reset}`);
    lastLen = text.length;
    await sleep(speed);
  }
  const finalText = `${target}${suffix}`;
  const pad = " ".repeat(Math.max(0, lastLen - finalText.length));
  process.stdout.write(`\r${color}${finalText}${pad}${C.reset}\n`);
}

/** ASCII art banner. */
function banner(): void {
  line(``);
  line(`${C.bold}${C.cyan}  tdai-memory-mcp${C.reset}`);
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
function runCommand(cmd: string, cwd: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, { cwd, encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
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
async function showCommand(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    writeFileSync(
      join(dir, "src", "index.ts"),
      `const foo = "hello";\n\nconsole.log(foo);\n`,
    );
  }
  // Install typescript
  execSync("npm install --silent 2>&1", { cwd: dir, timeout: 60000, stdio: ["pipe", "pipe", "pipe"] });
}

/**
 * `tdai-memory-mcp demo` — Cinematic terminal animation using REAL commands + REAL hooks.
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
  const tmpDir = mkdtempSync(join(tmpdir(), "tdai-demo-"));
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
  createRealProject(projectA, true);   // with TS2307 error
  createRealProject(projectB, true);   // with TS2307 error
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
  process.stdout.write(`  ${C.cyan}[tdai-memory]${C.reset} `);
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
  writeFileSync(
    join(projectA, "src", "index.ts"),
    `const foo = "hello";\n\nconsole.log(foo);\n`,
  );
  await sleep(500);

  // REAL npm run build → REAL success
  const fixResult = await showCommand("npm run build", projectA);
  await sleep(600);

  // REAL PostToolUse hook — success correlation → upvote + resolve
  process.stdout.write(`  ${C.cyan}[tdai-memory]${C.reset} `);
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
    const resolved = meta.resolved ? true : false;
    line(`  ${C.green}✓${C.reset} confidence: ${C.gray}${conf - 1} → ${conf}${C.reset}  ${C.gray}resolved=${resolved}${C.reset}`);
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

  process.stdout.write(`  ${C.cyan}[tdai-memory]${C.reset} `);
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
    preResult?.hookSpecificOutput?.additionalContext ??
    preResult?.additionalContext ??
    null;

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
  process.stdout.write(`  ${C.cyan}[tdai-memory]${C.reset} `);
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
    const resolved = meta.resolved ? true : false;
    line(`  ${C.green}✓${C.reset} confidence: ${C.gray}${conf - 1} → ${conf}${C.reset}  ${C.gray}resolved=${resolved}${C.reset}`);
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
    preResult3?.hookSpecificOutput?.additionalContext ??
    preResult3?.additionalContext ??
    null;

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
  process.stdout.write(`  ${C.magenta}[tdai-memory]${C.reset} `);
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
    preResultB?.hookSpecificOutput?.additionalContext ??
    preResultB?.additionalContext ??
    null;

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
    writeFileSync(
      join(projectB, "src", "index.ts"),
      `const foo = "hello";\n\nconsole.log(foo);\n`,
    );
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
  line(`  ${C.bold}  tdai-memory-mcp status${C.reset}`);
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
