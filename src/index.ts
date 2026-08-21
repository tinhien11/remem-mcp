#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { exportArtifact, importArtifact } from "./artifact.js";
import { backup } from "./backup.js";
import { atomsCommand } from "./cli/atoms.js";
import { consolidateCommand } from "./cli/consolidate.js";
import { demo, demoCodegraph } from "./cli/demo.js";
import { extractCommand } from "./cli/extract.js";
import { knowledgeCommand } from "./cli/knowledge.js";
import { personaCommand } from "./cli/persona.js";
import { scenariosCommand } from "./cli/scenarios.js";
import { skillsCommand } from "./cli/skills.js";
import { status } from "./cli/status.js";
import { workerCommand } from "./cli/worker.js";
import {
  findCallees,
  findCallers,
  impactAnalysis,
  indexDirectory,
  listSymbols,
  searchSymbols,
} from "./codegraph/engine.js";
import { loadConfig } from "./config.js";
import { doctor } from "./doctor.js";
import { LocalEmbedder } from "./embedding/local.js";
import {
  decisionsConflicts,
  decisionsDashboard,
  decisionsInherited,
  decisionsRetro,
  errorsActions,
  errorsByGoal,
  errors as errorsCommand,
  errorsContext,
  errorsCorrelations,
  errorsDrift,
  errorsEscalations,
  errorsInherited,
  errorsLineage,
  errorsPersona,
  errorsPlaybooks,
  errorsProvenance,
  errorsRetro,
  errorsSeverity,
  errorsStale,
  errorsTemplates,
  patternsConflicts,
  patternsDashboard,
  patternsInherited,
  patternsRetro,
  patternsTemplates,
} from "./errors.js";
import { exportData } from "./export.js";
import { exportMarkdown } from "./export-md.js";
import {
  hookPostCommit,
  hookPostCompaction,
  hookPostToolUse,
  hookPreCompact,
  hookPreToolUse,
  hookRecall,
  hookSessionEnd,
  hookStop,
  hookUserPromptSubmit,
  waitAndCapture,
} from "./hook-handlers.js";
import { installHooks, uninstallHooks } from "./hooks.js";
import { importData } from "./import.js";
import { installMcpServer } from "./install-mcp.js";
import { installSkill } from "./install-skill.js";
import { AtomPipeline, RuleBasedAtomPipeline } from "./pipeline/atom.js";
import { OpenAILLMClient } from "./pipeline/llm.js";
import { NoopPipeline } from "./pipeline/noop.js";
import type { PipelineStage } from "./pipeline/types.js";
import { AuditLogger } from "./security/audit.js";
import { createServer } from "./server.js";
import { stats } from "./stats.js";
import { SQLiteBackend } from "./storage/sqlite.js";
import { tokenStats } from "./token-stats.js";
import { startViewer } from "./viewer.js";
import { findOutdatedPages, ingestDirectory, searchWiki } from "./wiki/engine.js";

/** Default DB path. */
function defaultDbPath(): string {
  return process.env.REMEM_DB_PATH ?? join(homedir(), ".local", "share", "remem-mcp", "memory.db");
}

/** Open a DB with schema loaded (for CLI commands that need CodeGraph/Wiki tables). */
function openDbWithSchema(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF");
  sqliteVec.load(db);
  // Load schema if tables don't exist
  const hasSymbols = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbols'")
    .get();
  if (!hasSymbols) {
    const distDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(distDir, "storage", "schema.sql"),
      join(distDir, "schema.sql"),
      join(process.cwd(), "src", "storage", "schema.sql"),
    ];
    for (const p of candidates) {
      try {
        db.exec(readFileSync(p, "utf-8"));
        break;
      } catch {
        // try next candidate
      }
    }
  }
  return db;
}

/** Parse --flag value pairs from argv after the subcommand. */
function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith("--")) {
      const key = argv[i].slice(2);
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[i + 1];
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

// ─── Bootstrap detection helpers ──────────────────────────────

/** Detect package manager from lockfiles in cwd. */
function detectPackageManager(): string | null {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "package-lock.json"))) return "npm";
  if (existsSync(join(cwd, "Cargo.toml"))) return "cargo";
  if (existsSync(join(cwd, "go.mod"))) return "go";
  if (existsSync(join(cwd, "pom.xml")) || existsSync(join(cwd, "build.gradle"))) return "maven";
  if (existsSync(join(cwd, "build.gradle.kts"))) return "gradle";
  if (existsSync(join(cwd, "Gemfile"))) return "bundle";
  if (existsSync(join(cwd, "requirements.txt")) || existsSync(join(cwd, "pyproject.toml")))
    return "pip";
  return null;
}

/** Detect key scripts from package.json (limited to important ones). */
function detectPackageScripts(): Record<string, string> {
  const cwd = process.cwd();
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const scripts = pkg.scripts ?? {};
    const important: Record<string, string> = {};
    for (const key of ["build", "test", "lint", "format", "dev", "start", "typecheck", "check"]) {
      if (scripts[key]) important[key] = scripts[key];
    }
    return important;
  } catch {
    return {};
  }
}

/** Detect framework from dependencies or config files. */
function detectFramework(): string | null {
  const cwd = process.cwd();
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    // Non-JS frameworks
    const fw = detectNonJsFramework(cwd);
    if (fw) return fw;
    return null;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps.next) return "Next.js";
    if (deps["react-scripts"]) return "Create React App";
    if (deps.react && deps.vite) return "React + Vite";
    if (deps.react) return "React";
    if (deps.vue) return "Vue";
    if (deps.svelte || deps["@sveltejs/kit"]) return "Svelte";
    if (deps.astro) return "Astro";
    if (deps.nuxt) return "Nuxt";
    if (deps["@angular/core"]) return "Angular";
    if (deps.express) return "Express";
    if (deps.hono) return "Hono";
    if (deps.fastify) return "Fastify";
    if (deps.nestjs || deps["@nestjs/core"]) return "NestJS";
    if (deps.h3) return "h3";
    return null;
  } catch {
    return null;
  }
}

/** Detect non-JS frameworks from config files and dependencies. */
function detectNonJsFramework(cwd: string): string | null {
  // Python
  const pyPath = join(cwd, "pyproject.toml");
  if (existsSync(pyPath)) {
    try {
      const content = readFileSync(pyPath, "utf-8");
      if (/\bdjango\b/i.test(content)) return "Django";
      if (/\bfastapi\b/i.test(content)) return "FastAPI";
      if (/\bflask\b/i.test(content)) return "Flask";
      if (/\bstarlette\b/i.test(content)) return "Starlette";
      if (/\baiohttp\b/i.test(content)) return "aiohttp";
      if (/\btornado\b/i.test(content)) return "Tornado";
      if (/\bsanic\b/i.test(content)) return "Sanic";
      if (/\bpyramid\b/i.test(content)) return "Pyramid";
      if (/\bbottle\b/i.test(content)) return "Bottle";
      if (/\brye\b/i.test(content)) return "Rye";
      if (/\bpoetry\b/i.test(content)) return "Poetry";
      if (/\buv\b/i.test(content)) return "uv";
    } catch {
      // fall through
    }
  }
  if (existsSync(join(cwd, "requirements.txt"))) {
    try {
      const content = readFileSync(join(cwd, "requirements.txt"), "utf-8");
      if (/^\s*django\b/im.test(content)) return "Django";
      if (/^\s*fastapi\b/im.test(content)) return "FastAPI";
      if (/^\s*flask\b/im.test(content)) return "Flask";
    } catch {
      // fall through
    }
  }
  if (existsSync(join(cwd, "manage.py")) && existsSync(join(cwd, "wsgi.py"))) return "Django";

  // Rust
  const cargoPath = join(cwd, "Cargo.toml");
  if (existsSync(cargoPath)) {
    try {
      const content = readFileSync(cargoPath, "utf-8");
      if (/\baxum\b/i.test(content)) return "Axum";
      if (/\bactix-web\b/i.test(content)) return "Actix Web";
      if (/\bwarp\b/i.test(content)) return "Warp";
      if (/\brocket\b/i.test(content)) return "Rocket";
      if (/\btower\b/i.test(content)) return "Tower";
      if (/\btauri\b/i.test(content)) return "Tauri";
      if (/\biced\b/i.test(content)) return "Iced";
      if (/\bdioxus\b/i.test(content)) return "Dioxus";
      if (/\bleptos\b/i.test(content)) return "Leptos";
      if (/\byew\b/i.test(content)) return "Yew";
      return "Rust";
    } catch {
      // fall through
    }
  }

  // Go
  const goModPath = join(cwd, "go.mod");
  if (existsSync(goModPath)) {
    try {
      const content = readFileSync(goModPath, "utf-8");
      if (/\bgin-gin\b/i.test(content)) return "Gin";
      if (/\becho\b/i.test(content)) return "Echo";
      if (/\bfiber\b/i.test(content)) return "Fiber";
      if (/\bchi\b/i.test(content)) return "Chi";
      if (/\bgorilla\b/i.test(content)) return "Gorilla";
      if (/\bfasthttp\b/i.test(content)) return "FastHTTP";
      return "Go";
    } catch {
      // fall through
    }
  }

  // Ruby
  const gemfilePath = join(cwd, "Gemfile");
  if (existsSync(gemfilePath)) {
    try {
      const content = readFileSync(gemfilePath, "utf-8");
      if (/\brails\b/i.test(content)) return "Rails";
      if (/\bsinatra\b/i.test(content)) return "Sinatra";
      if (/\bhanami\b/i.test(content)) return "Hanami";
      if (/\broda\b/i.test(content)) return "Roda";
      if (/\bjekyll\b/i.test(content)) return "Jekyll";
      return "Ruby";
    } catch {
      // fall through
    }
  }

  // Java
  if (existsSync(join(cwd, "pom.xml"))) {
    try {
      const content = readFileSync(join(cwd, "pom.xml"), "utf-8");
      if (/\bspring-boot\b/i.test(content)) return "Spring Boot";
      if (/\bspring-webflux\b/i.test(content)) return "Spring WebFlux";
      if (/\bquarkus\b/i.test(content)) return "Quarkus";
      if (/\bmicronaut\b/i.test(content)) return "Micronaut";
      if (/\bjavalin\b/i.test(content)) return "Javalin";
      if (/\bdropwizard\b/i.test(content)) return "Dropwizard";
      if (/\bvertx\b/i.test(content)) return "Vert.x";
      if (/\bsparkjava\b/i.test(content)) return "Spark Java";
      return "Java/Maven";
    } catch {
      // fall through
    }
  }
  if (existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"))) {
    try {
      const content = readFileSync(
        existsSync(join(cwd, "build.gradle.kts"))
          ? join(cwd, "build.gradle.kts")
          : join(cwd, "build.gradle"),
        "utf-8",
      );
      if (/\bspring-boot\b/i.test(content)) return "Spring Boot";
      if (/\bquarkus\b/i.test(content)) return "Quarkus";
      if (/\bmicronaut\b/i.test(content)) return "Micronaut";
      return "Java/Gradle";
    } catch {
      // fall through
    }
  }

  // C# / .NET
  try {
    const dotnetFiles = readdirSync(cwd).filter((f) => f.endsWith(".csproj") || f.endsWith(".sln"));
    if (dotnetFiles.length > 0) {
      const content = readFileSync(join(cwd, dotnetFiles[0]), "utf-8");
      if (/\bMicrosoft\.NET\.Sdk\.Web\b/i.test(content)) return "ASP.NET Core";
      if (/\bMicrosoft\.NET\.Sdk\b/i.test(content)) return ".NET";
      return ".NET";
    }
  } catch {
    // fall through
  }

  return null;
}

/** Detect lint/format tool from dependencies or config files. */
function detectLintTool(): string | null {
  const cwd = process.cwd();
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps.biome) return "Biome";
      if (deps.eslint) return "ESLint";
      if (deps.dprint) return "dprint";
      if (deps.prettier) return "Prettier";
      if (deps["@biomejs/biome"]) return "Biome";
    } catch {
      // fall through
    }
  }
  if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) return "Biome";
  if (
    existsSync(join(cwd, ".eslintrc")) ||
    existsSync(join(cwd, ".eslintrc.js")) ||
    existsSync(join(cwd, ".eslintrc.json")) ||
    existsSync(join(cwd, "eslint.config.js")) ||
    existsSync(join(cwd, "eslint.config.mjs"))
  )
    return "ESLint";
  if (existsSync(join(cwd, ".prettierrc")) || existsSync(join(cwd, ".prettierrc.json")))
    return "Prettier";
  // Rust
  if (existsSync(join(cwd, "rustfmt.toml"))) return "rustfmt";
  if (existsSync(join(cwd, ".rustfmt.toml"))) return "rustfmt";
  // Go
  if (existsSync(join(cwd, ".gofmt"))) return "gofmt";
  if (existsSync(join(cwd, ".golangci.yml")) || existsSync(join(cwd, ".golangci.yaml")))
    return "golangci-lint";
  // Python
  if (existsSync(join(cwd, ".ruff.toml")) || existsSync(join(cwd, "ruff.toml"))) return "Ruff";
  if (
    existsSync(join(cwd, ".flake8")) ||
    existsSync(join(cwd, "setup.cfg")) ||
    existsSync(join(cwd, "tox.ini"))
  )
    return "Flake8";
  if (existsSync(join(cwd, ".pylintrc")) || existsSync(join(cwd, "pyproject.toml"))) {
    try {
      if (existsSync(join(cwd, "pyproject.toml"))) {
        const content = readFileSync(join(cwd, "pyproject.toml"), "utf-8");
        if (/\bruff\b/i.test(content)) return "Ruff";
        if (/\bblack\b/i.test(content)) return "Black";
        if (/\bflake8\b/i.test(content)) return "Flake8";
        if (/\bpylint\b/i.test(content)) return "Pylint";
        if (/\bisort\b/i.test(content)) return "isort";
      }
    } catch {
      // fall through
    }
  }
  if (existsSync(join(cwd, ".black")) || existsSync(join(cwd, "black-config.toml"))) return "Black";
  // Ruby
  if (existsSync(join(cwd, ".rubocop.yml")) || existsSync(join(cwd, ".rubocop.yaml")))
    return "RuboCop";
  if (existsSync(join(cwd, ".standard.yml")) || existsSync(join(cwd, ".standard.yaml")))
    return "Standard";
  // Java
  if (existsSync(join(cwd, ".checkstyle"))) return "Checkstyle";
  if (existsSync(join(cwd, "spotbugs-exclude.xml"))) return "SpotBugs";
  // .NET
  try {
    const dotnetFiles = readdirSync(cwd).filter((f) => f.endsWith(".editorconfig"));
    if (dotnetFiles.length > 0) return "EditorConfig";
  } catch {
    // fall through
  }
  return null;
}

/** Detect test command. */
function detectTestCommand(pkgManager: string | null): string | null {
  const cwd = process.cwd();
  const pm = pkgManager ?? "npm";

  // JS: check package.json scripts
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
        return `${pm} run test`;
      }
      if (scripts.vitest) return `${pm} run vitest`;
      if (scripts.jest) return `${pm} run jest`;
      // vitest/jest in deps but no script
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps.vitest) return `${pm} exec vitest run`;
      if (deps.jest) return `${pm} exec jest`;
    } catch {
      // fall through
    }
  }

  // Other ecosystems
  if (existsSync(join(cwd, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(cwd, "go.mod"))) return "go test ./...";
  // Python
  if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "conftest.py"))) return "pytest";
  if (existsSync(join(cwd, "pyproject.toml"))) {
    try {
      const content = readFileSync(join(cwd, "pyproject.toml"), "utf-8");
      if (/\bpytest\b/i.test(content)) return "pytest";
      if (/\bunittest\b/i.test(content)) return "python -m unittest";
    } catch {
      // fall through
    }
  }
  if (existsSync(join(cwd, "tox.ini"))) return "tox";
  if (existsSync(join(cwd, "Gemfile"))) {
    try {
      const content = readFileSync(join(cwd, "Gemfile"), "utf-8");
      if (/\brspec\b/i.test(content)) return "bundle exec rspec";
      if (/\bminitest\b/i.test(content)) return "bundle exec rake test";
    } catch {
      // fall through
    }
    return "bundle exec rspec";
  }
  // Java
  if (existsSync(join(cwd, "pom.xml"))) return "mvn test";
  if (existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts")))
    return "gradle test";
  // .NET
  try {
    const dotnetFiles = readdirSync(cwd).filter(
      (f) => f.endsWith(".csproj") || f.endsWith(".fsproj"),
    );
    if (dotnetFiles.length > 0) return "dotnet test";
  } catch {
    // fall through
  }
  return null;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "install-skill") {
    await installSkill();
    return;
  }
  if (arg === "init") {
    console.log(`remem-mcp init

This command tells your agent to activate long-term memory for this session.

→ In your agent chat, type:

  invoke skill remem-mcp

The skill will teach the agent to:
  1. Call recall() with your current task as query
  2. Index code with codegraph_search (first use auto-indexes src/)
  3. Capture decisions/learnings after completing work
  4. Use search instead of grep for symbol lookup

Hooks are already active (installed during setup):
  - SessionStart: recent memory auto-injected
  - UserPromptSubmit: memory matching your prompt auto-injected
  - PostToolUse: failed commands auto-captured
  - Stop: session transcript auto-captured

You only need to invoke the skill once per session.
After that, the agent follows the rules automatically.`);
    return;
  }
  if (arg === "install-hooks") {
    await installHooks();
    return;
  }
  if (arg === "setup") {
    console.log("remem-mcp setup\n");
    await installMcpServer();
    console.log("");
    await installHooks();
    console.log("");
    await installSkill();
    console.log("\nCapturing project basics...");
    const { Memory } = await import("./sdk.js");
    const mem = new Memory();
    // SDK constructor already hashes process.cwd() as the default sessionKey.
    // Don't pass raw cwd — that would store under a different key than recall() uses.
    let captured = 0;

    // Detect package manager
    const pkgManager = detectPackageManager();
    if (pkgManager) {
      const id = await mem.capture(
        `This project uses ${pkgManager}. Use ${pkgManager} for all package operations (install, run, etc.).`,
        "decision",
        ["bootstrap", "package-manager", pkgManager],
        {},
      );
      if (id) captured++;
    }

    // Detect scripts from package.json
    const scripts = detectPackageScripts();
    for (const [name, cmd] of Object.entries(scripts)) {
      const id = await mem.capture(
        `Project script: \`${pkgManager ? pkgManager + " run " : "npm run "}${name}\` runs: ${cmd}`,
        "decision",
        ["bootstrap", "script", name],
        {},
      );
      if (id) captured++;
    }

    // Detect framework
    const framework = detectFramework();
    if (framework) {
      const id = await mem.capture(
        `This project uses ${framework}. Follow ${framework} conventions and patterns.`,
        "decision",
        ["bootstrap", "framework", framework.toLowerCase()],
        {},
      );
      if (id) captured++;
    }

    // Detect lint/format tool
    const lintTool = detectLintTool();
    if (lintTool) {
      const id = await mem.capture(
        `This project uses ${lintTool} for linting/formatting. Run it before committing.`,
        "decision",
        ["bootstrap", "lint", lintTool.toLowerCase()],
        {},
      );
      if (id) captured++;
    }

    // Test command
    const testCmd = detectTestCommand(pkgManager);
    if (testCmd) {
      const id = await mem.capture(
        `Run tests with: \`${testCmd}\``,
        "decision",
        ["bootstrap", "test"],
        {},
      );
      if (id) captured++;
    }

    if (captured > 0) {
      console.log(`  Captured ${captured} project basics.`);
    } else {
      // Check if project files exist but captures were deduped (already captured before)
      const hasProjectFiles =
        existsSync(join(process.cwd(), "package.json")) ||
        existsSync(join(process.cwd(), "Cargo.toml")) ||
        existsSync(join(process.cwd(), "go.mod")) ||
        existsSync(join(process.cwd(), "pyproject.toml"));
      if (hasProjectFiles) {
        console.log("  Project basics already captured (no changes since last setup).");
      } else {
        console.log("  No project files detected. Skipping bootstrap.");
      }
    }

    console.log("\n✓ Done. Restart your agent.");
    console.log("  Hooks auto-recall on start, auto-capture errors, auto-save on exit.");
    console.log("  Skill teaches agent to use codegraph_search instead of grep.");
    console.log("  `npx remem-mcp status` to see memory.");
    return;
  }
  if (arg === "uninstall-hooks") {
    await uninstallHooks();
    return;
  }
  if (arg === "doctor") {
    await doctor();
    return;
  }
  if (arg === "demo") {
    await demo();
    return;
  }
  if (arg === "demo-codegraph") {
    await demoCodegraph();
    return;
  }
  if (arg === "status") {
    status(defaultDbPath());
    return;
  }
  if (arg === "recent" || arg === "list") {
    const limit = parseInt(process.argv[3] ?? "20", 10);
    const db = new Database(defaultDbPath(), { readonly: true });
    const rows = db
      .prepare(
        `SELECT id, type, content, tags, created_at FROM captures WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      type: string;
      content: string;
      tags: string;
      created_at: number;
    }[];
    if (rows.length === 0) {
      console.log("No captures found.");
    } else {
      for (const r of rows) {
        const date = new Date(r.created_at).toISOString().split("T")[0];
        const tags = r.tags ? ` [${JSON.parse(r.tags).join(", ")}]` : "";
        const preview = r.content.slice(0, 80).replace(/\n/g, " ");
        console.log(
          `${date}  ${r.id}  ${r.type}${tags}  ${preview}${r.content.length > 80 ? "..." : ""}`,
        );
      }
      console.log(`\n${rows.length} capture(s).`);
    }
    db.close();
    return;
  }
  if (arg === "sessions") {
    const db = new Database(defaultDbPath(), { readonly: true });
    const rows = db
      .prepare(
        `SELECT session_key, COUNT(*) as cnt, MIN(created_at) as oldest, MAX(created_at) as newest
         FROM captures WHERE deleted_at IS NULL
         GROUP BY session_key ORDER BY cnt DESC`,
      )
      .all() as { session_key: string; cnt: number; oldest: number; newest: number }[];

    // Try to resolve session keys to project paths
    const cwdHash = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
    const globalKey = process.env.REMEM_GLOBAL_SESSION_KEY ?? "global";

    if (rows.length === 0) {
      console.log("No sessions found.");
    } else {
      console.log("Sessions (by capture count):\n");
      for (const r of rows) {
        const oldestDate = new Date(r.oldest).toISOString().split("T")[0];
        const newestDate = new Date(r.newest).toISOString().split("T")[0];
        const isCurrent = r.session_key === cwdHash ? " ← current" : "";
        const isGlobal = r.session_key === globalKey ? " (global)" : "";
        console.log(
          `  ${r.session_key}  ${String(r.cnt).padStart(4)} captures  ${oldestDate}→${newestDate}${isGlobal}${isCurrent}`,
        );
      }
      console.log(`\n${rows.length} session(s). Current: ${cwdHash}`);
    }
    db.close();
    return;
  }
  if (arg === "tags") {
    const db = new Database(defaultDbPath(), { readonly: true });
    const rows = db
      .prepare(
        "SELECT tags FROM captures WHERE deleted_at IS NULL AND tags IS NOT NULL AND tags != '[]'",
      )
      .all() as { tags: string }[];
    const tagCounts: Record<string, number> = {};
    for (const row of rows) {
      try {
        const tags = JSON.parse(row.tags) as string[];
        for (const t of tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
      } catch {
        // skip
      }
    }
    const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) {
      console.log("No tags found.");
    } else {
      console.log("Tags (by frequency):\n");
      for (const [tag, count] of sorted) {
        console.log(`  ${String(count).padStart(4)}  ${tag}`);
      }
      console.log(`\n${sorted.length} unique tag(s).`);
    }
    db.close();
    return;
  }
  if (arg === "stats") {
    const db = openDbWithSchema(defaultDbPath());
    const byType = db
      .prepare(
        "SELECT type, COUNT(*) as cnt FROM captures WHERE deleted_at IS NULL GROUP BY type ORDER BY cnt DESC",
      )
      .all() as { type: string; cnt: number }[];
    const total = byType.reduce((s, r) => s + r.cnt, 0);
    const byTrust = db
      .prepare(
        "SELECT trust_state, COUNT(*) as cnt FROM captures WHERE deleted_at IS NULL GROUP BY trust_state",
      )
      .all() as { trust_state: string; cnt: number }[];
    const withVectors = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM captures_vec WHERE id IN (SELECT id FROM captures WHERE deleted_at IS NULL)",
      )
      .get() as { cnt: number };
    const oldest = db
      .prepare("SELECT MIN(created_at) as ts FROM captures WHERE deleted_at IS NULL")
      .get() as { ts: number | null };
    const newest = db
      .prepare("SELECT MAX(created_at) as ts FROM captures WHERE deleted_at IS NULL")
      .get() as { ts: number | null };
    const dbSize = statSync(defaultDbPath()).size;

    console.log("remem-mcp stats\n");
    console.log(`  Total captures: ${total}`);
    console.log(
      `  With vectors:   ${withVectors.cnt} (${total > 0 ? Math.round((withVectors.cnt / total) * 100) : 0}%)`,
    );
    console.log(`  DB size:        ${(dbSize / 1024 / 1024).toFixed(1)} MB`);
    if (oldest.ts)
      console.log(`  Oldest:         ${new Date(oldest.ts).toISOString().split("T")[0]}`);
    if (newest.ts)
      console.log(`  Newest:         ${new Date(newest.ts).toISOString().split("T")[0]}`);
    console.log("\n  By type:");
    for (const r of byType) {
      console.log(`    ${r.type.padEnd(15)} ${r.cnt}`);
    }
    console.log("\n  By trust state:");
    for (const r of byTrust) {
      console.log(`    ${r.trust_state.padEnd(15)} ${r.cnt}`);
    }
    db.close();
    return;
  }
  if (arg === "export") {
    const dbPath = defaultDbPath();
    const output = process.argv[3] ?? "-";

    const filters: { sessionKey?: string; type?: string } = {};
    for (let i = 3; i < process.argv.length; i++) {
      if (process.argv[i] === "--session-key" && process.argv[i + 1]) {
        filters.sessionKey = process.argv[i + 1];
        i++;
      }
      if (process.argv[i] === "--type" && process.argv[i + 1]) {
        filters.type = process.argv[i + 1];
        i++;
      }
    }

    exportData(dbPath, output, Object.keys(filters).length > 0 ? filters : undefined);
    return;
  }
  if (arg === "export-md") {
    const dbPath = defaultDbPath();
    const rest = process.argv.slice(3);
    // Find the first positional (non-flag, non-flag-value) arg as the output
    // file. Flags are --flag value pairs; everything else is positional.
    const knownFlags = new Set(["--session-key", "--type", "--tag"]);
    let output: string | null = null;
    const flagArgs: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].startsWith("--") && knownFlags.has(rest[i]) && rest[i + 1]) {
        flagArgs.push(rest[i], rest[i + 1]);
        i++;
      } else if (!rest[i].startsWith("--") && !output) {
        output = rest[i];
      } else {
        flagArgs.push(rest[i]);
      }
    }
    const outputFile =
      output ?? `remem-mcp-export-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    const flags = parseFlags(flagArgs);
    const filters: { sessionKey?: string; type?: string; tag?: string } = {};
    if (flags["session-key"]) filters.sessionKey = flags["session-key"];
    if (flags.type) filters.type = flags.type;
    if (flags.tag) filters.tag = flags.tag;
    exportMarkdown(dbPath, outputFile, Object.keys(filters).length > 0 ? filters : undefined);
    return;
  }
  if (arg === "import") {
    const dbPath = defaultDbPath();
    const input = process.argv[3];
    if (!input) {
      console.error("Error: Provide a file path. Usage: remem-mcp import <file.json>");
      process.exit(1);
    }
    importData(dbPath, input);
    return;
  }
  if (arg === "stats") {
    stats(defaultDbPath());
    return;
  }
  if (arg === "errors") {
    const sub = process.argv[3];
    if (sub === "retro") {
      errorsRetro(defaultDbPath());
      return;
    }
    if (sub === "drift") {
      errorsDrift(defaultDbPath());
      return;
    }
    if (sub === "lineage") {
      errorsLineage(defaultDbPath());
      return;
    }
    if (sub === "by-goal") {
      errorsByGoal(defaultDbPath());
      return;
    }
    if (sub === "actions") {
      errorsActions(defaultDbPath());
      return;
    }
    if (sub === "severity") {
      errorsSeverity(defaultDbPath());
      return;
    }
    if (sub === "templates") {
      errorsTemplates(defaultDbPath());
      return;
    }
    if (sub === "correlations") {
      errorsCorrelations(defaultDbPath());
      return;
    }
    if (sub === "playbooks") {
      errorsPlaybooks(defaultDbPath());
      return;
    }
    if (sub === "stale") {
      errorsStale(defaultDbPath());
      return;
    }
    if (sub === "escalations") {
      errorsEscalations(defaultDbPath());
      return;
    }
    if (sub === "context") {
      errorsContext(defaultDbPath());
      return;
    }
    if (sub === "inherited") {
      errorsInherited(defaultDbPath());
      return;
    }
    if (sub === "provenance") {
      errorsProvenance(defaultDbPath());
      return;
    }
    if (sub === "persona") {
      errorsPersona(defaultDbPath());
      return;
    }
    errorsCommand(defaultDbPath());
    return;
  }
  if (arg === "decisions") {
    const sub = process.argv[3] ?? "";
    if (sub === "retro") {
      decisionsRetro(defaultDbPath());
      return;
    }
    if (sub === "conflicts") {
      decisionsConflicts(defaultDbPath());
      return;
    }
    if (sub === "inherited") {
      decisionsInherited(defaultDbPath());
      return;
    }
    decisionsDashboard(defaultDbPath());
    return;
  }
  if (arg === "patterns") {
    const sub = process.argv[3] ?? "";
    if (sub === "retro") {
      patternsRetro(defaultDbPath());
      return;
    }
    if (sub === "conflicts") {
      patternsConflicts(defaultDbPath());
      return;
    }
    if (sub === "templates") {
      patternsTemplates(defaultDbPath());
      return;
    }
    if (sub === "inherited") {
      patternsInherited(defaultDbPath());
      return;
    }
    patternsDashboard(defaultDbPath());
    return;
  }
  if (arg === "token-stats") {
    tokenStats(defaultDbPath());
    return;
  }
  if (arg === "verify") {
    const query = process.argv.slice(3).join(" ") || "project setup conventions";
    await verifyMemory(defaultDbPath(), query);
    return;
  }
  if (arg === "viewer") {
    const port = Number(process.argv[4] ?? process.env.REMEM_VIEWER_PORT ?? 7331);
    startViewer(defaultDbPath(), port);
    return;
  }
  if (arg === "backup") {
    const dbPath = defaultDbPath();
    const auditPath = process.env.REMEM_AUDIT_LOG_PATH ?? join(dirname(dbPath), "audit.jsonl");
    const outputDir = process.argv[3] ?? "-";
    backup(dbPath, auditPath, outputDir);
    return;
  }
  if (arg === "sync-export") {
    const dbPath = defaultDbPath();
    const projectRoot = process.cwd();
    const sessionKey = process.argv[4] ?? undefined;
    exportArtifact(dbPath, projectRoot, sessionKey);
    return;
  }
  if (arg === "sync-import") {
    const dbPath = defaultDbPath();
    const projectRoot = process.cwd();
    const count = importArtifact(dbPath, projectRoot);
    if (count === 0) {
      console.log("No team artifact found. Run 'remem-mcp sync-export' to create one.");
    }
    return;
  }
  if (arg === "hook-recall") {
    hookRecall(defaultDbPath());
    return;
  }
  if (arg === "hook-user-prompt") {
    hookUserPromptSubmit(defaultDbPath());
    return;
  }
  if (arg === "hook-stop") {
    hookStop(defaultDbPath());
    return;
  }
  if (arg === "--wait-and-capture") {
    // Internal: spawned by hook-stop to capture transcript after Devin CLI writes it.
    // Args: node dist/index.js --wait-and-capture <dbPath> <sessionId> [transcriptPath]
    const dbPath = process.argv[3] ?? defaultDbPath();
    const sessionId = process.argv[4] ?? "unknown";
    const transcriptPath = process.argv[5] || null;
    await waitAndCapture(dbPath, sessionId, transcriptPath);
    return;
  }
  if (arg === "hook-session-end") {
    hookSessionEnd(defaultDbPath());
    return;
  }
  if (arg === "hook-post-commit") {
    await hookPostCommit(defaultDbPath());
    return;
  }
  if (arg === "hook-post-tool-use") {
    hookPostToolUse(defaultDbPath());
    return;
  }
  if (arg === "hook-pre-tool-use") {
    hookPreToolUse(defaultDbPath());
    return;
  }
  if (arg === "hook-pre-compact") {
    hookPreCompact(defaultDbPath());
    return;
  }
  if (arg === "hook-post-compaction") {
    hookPostCompaction(defaultDbPath());
    return;
  }

  // ─── CodeGraph CLI commands ──────────────────────────────────
  if (arg === "index") {
    const flags = parseFlags(process.argv.slice(3));
    const path = flags.path ?? flags.p ?? process.cwd();
    const repoPath = flags.repo ?? flags.r ?? path;
    const teamId = flags.team ?? flags.t ?? null;
    const maxFiles = Number(flags["max-files"] ?? 10000);
    const db = openDbWithSchema(defaultDbPath());
    console.log(`Indexing ${path} ...`);
    const results = await indexDirectory(db, path, repoPath, teamId, maxFiles);
    const indexed = results.filter((r) => !r.skipped);
    const totalSyms = indexed.reduce((s, r) => s + r.symbols, 0);
    const totalCalls = indexed.reduce((s, r) => s + r.calls, 0);
    console.log(`Done: ${indexed.length} files, ${totalSyms} symbols, ${totalCalls} calls`);
    for (const r of indexed.slice(0, 20)) {
      console.log(`  ${r.language.padEnd(12)} ${r.symbols} sym  ${r.calls} calls  ${r.file}`);
    }
    if (indexed.length > 20) console.log(`  ... and ${indexed.length - 20} more`);
    db.close();
    return;
  }
  if (arg === "search-code") {
    const flags = parseFlags(process.argv.slice(3));
    const query = flags.query ?? flags.q ?? process.argv[3];
    const teamId = flags.team ?? flags.t ?? undefined;
    const limit = Number(flags.limit ?? 20);
    const repoPath = flags.repo ?? flags.r ?? process.cwd();
    if (!query) {
      console.error("Usage: search-code --query <name> [--limit N] [--repo .]");
      return;
    }
    const db = openDbWithSchema(defaultDbPath());
    // Try with repoPath filter first; if no results, retry without (repo_path may be relative)
    let syms = searchSymbols(db, query, { teamId, limit, repoPath });
    if (syms.length === 0) {
      syms = searchSymbols(db, query, { teamId, limit });
    }
    if (syms.length === 0) {
      console.log("No symbols found.");
      db.close();
      return;
    }
    for (const s of syms) {
      console.log(`${s.id}  ${s.kind.padEnd(10)}  ${s.name}  at  ${s.filePath}:${s.lineStart}`);
    }
    db.close();
    return;
  }
  if (arg === "callers") {
    const symbolId = process.argv[3];
    if (!symbolId) {
      console.error("Usage: callers <symbol_id>");
      return;
    }
    const db = openDbWithSchema(defaultDbPath());
    const callers = findCallers(db, symbolId);
    if (callers.length === 0) {
      console.log("No callers found.");
      db.close();
      return;
    }
    for (const c of callers) {
      console.log(`${c.caller.kind} ${c.caller.name}  at  ${c.caller.filePath}:${c.line}`);
    }
    db.close();
    return;
  }
  if (arg === "callees") {
    const symbolId = process.argv[3];
    if (!symbolId) {
      console.error("Usage: callees <symbol_id>");
      return;
    }
    const db = openDbWithSchema(defaultDbPath());
    const callees = findCallees(db, symbolId);
    if (callees.length === 0) {
      console.log("No callees found.");
      db.close();
      return;
    }
    for (const c of callees) {
      if (c.callee) {
        console.log(
          `${c.callee.kind} ${c.callee.name}  at  ${c.callee.filePath}:${c.callee.lineStart}`,
        );
      } else {
        console.log(`${c.calleeName}  (unresolved)`);
      }
    }
    db.close();
    return;
  }
  if (arg === "impact") {
    const symbolId = process.argv[3];
    if (!symbolId) {
      console.error("Usage: impact <symbol_id> [--max-depth N]");
      return;
    }
    const flags = parseFlags(process.argv.slice(4));
    const maxDepth = Number(flags["max-depth"] ?? 5);
    const db = openDbWithSchema(defaultDbPath());
    const impact = impactAnalysis(db, symbolId, { maxDepth });
    console.log(
      `Root: ${impact.rootSymbol.kind} ${impact.rootSymbol.name}  at  ${impact.rootSymbol.filePath}:${impact.rootSymbol.lineStart}`,
    );
    console.log(`Affected: ${impact.affected.length} symbol(s)`);
    for (const a of impact.affected) {
      console.log(
        `${"  ".repeat(a.depth)}-> ${a.symbol.kind} ${a.symbol.name}  at  ${a.symbol.filePath}:${a.symbol.lineStart}  (depth ${a.depth})`,
      );
    }
    db.close();
    return;
  }
  if (arg === "list-code") {
    const flags = parseFlags(process.argv.slice(3));
    const filePath = flags.file ?? flags.f ?? process.argv[3];
    const repoPath = flags.repo ?? flags.r ?? process.cwd();
    if (!filePath) {
      console.error("Usage: list-code <file_path> [--repo .]");
      return;
    }
    const db = openDbWithSchema(defaultDbPath());
    let syms = listSymbols(db, filePath, { repoPath });
    if (syms.length === 0) {
      syms = listSymbols(db, filePath, {});
    }
    if (syms.length === 0) {
      console.log("No symbols found.");
      db.close();
      return;
    }
    for (const s of syms) {
      console.log(`${s.kind.padEnd(10)}  L${s.lineStart}-${s.lineEnd}  ${s.name}`);
    }
    db.close();
    return;
  }

  // ─── Wiki CLI commands ───────────────────────────────────────
  if (arg === "wiki") {
    const sub = process.argv[3];
    if (sub === "ingest") {
      const flags = parseFlags(process.argv.slice(4));
      const path = flags.path ?? flags.p ?? process.cwd();
      const repoPath = flags.repo ?? flags.r ?? path;
      const teamId = flags.team ?? flags.t ?? null;
      const db = openDbWithSchema(defaultDbPath());
      console.log(`Ingesting markdown from ${path} ...`);
      const results = ingestDirectory(db, path, repoPath, teamId, 200);
      const ingested = results.filter((r) => !r.skipped);
      const totalPages = ingested.reduce((s, r) => s + r.pages, 0);
      const totalLinks = ingested.reduce((s, r) => s + r.links, 0);
      console.log(`Done: ${totalPages} pages, ${totalLinks} links from ${ingested.length} files`);
      for (const r of ingested.slice(0, 20)) {
        console.log(`  ${r.pages} page  ${r.links} links  ${r.file}`);
      }
      db.close();
      return;
    }
    if (sub === "search") {
      const query = process.argv[4];
      if (!query) {
        console.error("Usage: wiki search <query>");
        return;
      }
      const db = openDbWithSchema(defaultDbPath());
      const results = searchWiki(db, query);
      if (results.length === 0) {
        console.log("No pages found.");
        db.close();
        return;
      }
      for (const r of results) {
        console.log(`${r.id}  ${r.title}  (${r.sourceFile})`);
        console.log(`  ${r.snippet}`);
      }
      db.close();
      return;
    }
    if (sub === "outdated") {
      const repoPath = process.argv[4] ?? process.cwd();
      const db = openDbWithSchema(defaultDbPath());
      const outdated = findOutdatedPages(db, repoPath, {});
      if (outdated.length === 0) {
        console.log("All pages up to date.");
        db.close();
        return;
      }
      for (const o of outdated) {
        console.log(`${o.title}  (${o.sourceFile})  — ${o.reason}`);
      }
      db.close();
      return;
    }
    console.error("Usage: wiki <ingest|search|outdated> [args]");
    return;
  }

  // ─── L1-L3 CLI commands ──────────────────────────────────────
  if (arg === "atoms") {
    const flags = parseFlags(process.argv.slice(3));
    await atomsCommand(defaultDbPath(), flags);
    return;
  }
  if (arg === "scenarios") {
    const flags = parseFlags(process.argv.slice(3));
    await scenariosCommand(defaultDbPath(), flags);
    return;
  }
  if (arg === "persona") {
    const flags = parseFlags(process.argv.slice(3));
    await personaCommand(defaultDbPath(), flags);
    return;
  }
  if (arg === "extract") {
    const flags = parseFlags(process.argv.slice(3));
    await extractCommand(defaultDbPath(), flags);
    return;
  }
  if (arg === "consolidate") {
    const flags = parseFlags(process.argv.slice(3));
    await consolidateCommand(defaultDbPath(), flags);
    return;
  }
  if (arg === "worker-run") {
    const flags = parseFlags(process.argv.slice(3));
    await workerCommand(defaultDbPath(), flags);
    return;
  }
  if (arg === "knowledge") {
    const flags = parseFlags(process.argv.slice(3));
    await knowledgeCommand(defaultDbPath(), flags);
    return;
  }
  if (arg === "skills") {
    const flags = parseFlags(process.argv.slice(3));
    await skillsCommand(defaultDbPath(), flags);
    return;
  }

  if (arg === "version" || arg === "--version" || arg === "-v") {
    try {
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      console.log(`remem-mcp v${pkg.version}`);
    } catch {
      console.log("remem-mcp (version unknown)");
    }
    return;
  }
  if (arg === "help" || arg === "--help" || arg === "-h") {
    const showAll = process.argv[3] === "all";
    console.log(`remem-mcp - Local-first MCP memory server

Getting started:
  remem-mcp setup          One-command install (MCP + hooks + skill)
  remem-mcp demo           Error learning loop demo (15s)
  remem-mcp demo-codegraph Live CodeGraph demo on facebook/react
  remem-mcp status         One dashboard: health + all 3 loops + recent
  remem-mcp viewer         Web UI at localhost:7331
  remem-mcp doctor         Check setup health
  remem-mcp version        Print version

Daily use:
  remem-mcp errors         Error learning dashboard
  remem-mcp decisions      Decision learning dashboard
  remem-mcp patterns       Pattern learning dashboard
  remem-mcp recent [N]     Show N most recent captures

  Run \`remem-mcp help all\` for the full list of 40+ subcommands.
`);
    if (!showAll) {
      console.log(`The server runs as a stdio process. Add it to your MCP client:
  Claude Code: ~/.claude.json
  Cursor:      ~/.cursor/mcp.json
  Devin CLI:   devin mcp add remem-mcp -- npx -y remem-mcp
`);
      return;
    }

    // Full help (only with `help all`)
    console.log(`Full command list:
${"─".repeat(60)}

Setup & maintenance:
  remem-mcp                Start the MCP server (stdio)
  remem-mcp setup          Install MCP + hooks + skill (one command)
  remem-mcp init           Show how to activate memory in your agent session
  remem-mcp install-skill  Install the agent skill for Devin CLI
  remem-mcp install-hooks  Install lifecycle hooks (SessionStart, Stop, SessionEnd)
  remem-mcp uninstall-hooks  Remove lifecycle hooks
  remem-mcp hook-post-commit  Auto-index changed files (git post-commit hook)
  remem-mcp doctor         Check setup health
  remem-mcp demo           Run end-to-end learning loop demo (30s)
  remem-mcp status         Unified dashboard (health + 3 loops + recent)

Error learning (deep loop, 41 features):
  remem-mcp errors              Error dashboard (patterns, fixes, resolution rate)
  remem-mcp errors retro        Session retrospective (failure loops, wasted effort)
  remem-mcp errors drift        Drift: injected warnings that were ignored
  remem-mcp errors lineage      Fix lineage chains: E1→F1→E2→F2
  remem-mcp errors by-goal      Error distribution by goal (set REMEM_GOAL_ID)
  remem-mcp errors actions      Action items from resolved errors
  remem-mcp errors severity     Severity distribution (blocker/critical/major/minor)
  remem-mcp errors templates    Fix templates from 3+ similar resolved errors
  remem-mcp errors correlations Sequential error patterns (E1→E2 within 10 min)
  remem-mcp errors playbooks    Recovery playbooks (step-by-step)
  remem-mcp errors stale        Fix staleness (older than REMEM_FIX_STALENESS_DAYS)
  remem-mcp errors escalations  Auto-escalated errors (3+ recurrences)
  remem-mcp errors context      Error context (git branch, commits, changed files)
  remem-mcp errors inherited    Cross-project fix inheritance
  remem-mcp errors provenance   Fix provenance chain
  remem-mcp errors persona      Error profile per project

Decision learning (foundational loop):
  remem-mcp decisions           Decision dashboard
  remem-mcp decisions retro     Decision retrospective (follow rate, drift)
  remem-mcp decisions conflicts Contradictory dependency choices
  remem-mcp decisions inherited Cross-project decision inheritance

Pattern learning (foundational loop):
  remem-mcp patterns            Pattern dashboard
  remem-mcp patterns retro      Pattern retrospective (adoption rate)
  remem-mcp patterns conflicts  Inconsistent style conflicts (CommonJS vs ESM)
  remem-mcp patterns templates  Reusable templates from 3+ similar patterns
  remem-mcp patterns inherited  Cross-project pattern inheritance

CodeGraph:
  remem-mcp index [--path src] [--repo .]  Index code symbols (Tree-sitter)
  remem-mcp search-code --query <name>     Search symbols by name
  remem-mcp callers <symbol_id>            Find who calls a symbol
  remem-mcp callees <symbol_id>            Find what a symbol calls
  remem-mcp impact <symbol_id>             Impact analysis (what breaks)
  remem-mcp list-code <file_path>          List symbols in a file

Wiki:
  remem-mcp wiki ingest [--path docs]      Index markdown documentation
  remem-mcp wiki search <query>            Search wiki pages
  remem-mcp wiki outdated [--repo .]       Find outdated wiki pages

Data:
  remem-mcp stats          Memory statistics (by type, trust, size)
  remem-mcp sessions       List all project sessions (by capture count)
  remem-mcp tags           List all tags (by frequency)
  remem-mcp token-stats    Token savings report
  remem-mcp verify [query] A/B proof: shows what memory injects vs re-reading files
  remem-mcp recent [N]     Show N most recent captures (default: 20)
  remem-mcp export [file]  Export captures to JSON (default: stdout)
  remem-mcp import <file>  Import captures from JSON
  remem-mcp backup [dir]   Backup database and audit log
  remem-mcp viewer [port]  Start web viewer (default port: 7331)
  remem-mcp sync-export    Export memory to .remem-mcp/ in project root
  remem-mcp sync-import    Import memory from .remem-mcp/ (auto on startup)

L1-L3 pipeline:
  remem-mcp extract        Run L1 atom extraction (rule-based, no LLM needed)
  remem-mcp extract --llm  Run L1 atom extraction with LLM (needs REMEM_LLM_API_KEY)
  remem-mcp atoms          List or search L1 atoms (--query <text> for search)
  remem-mcp consolidate    Create L2 scenario from atoms (--atom-ids, --summary, --auto)
  remem-mcp scenarios      List L2 scenarios
  remem-mcp persona        Read or write L3 persona (--set "trait: value")

Knowledge & skills:
  remem-mcp knowledge      List knowledge assets for a team
  remem-mcp skills         List skills for a team

  remem-mcp version        Print the version
  remem-mcp help           Print short help
  remem-mcp help all       Print this full list

Export options:
  --session-key <key>  Export only captures from this session
  --type <type>        Export only captures of this type
  --tag <tag>          (export-md only) Export only captures with this tag

Common flags for L1-L3 and knowledge/skills commands:
  --team-id <id>       Team ID (required for persona, knowledge, skills)
  --agent-id <id>      Agent ID
  --user-id <id>       User ID
  --query <text>       Search query (for atoms, skills)
  --limit <n>          Max results (default 20)
  --write <content>    Write persona content (for persona command)
  --type <type>        Filter by type (for knowledge: wiki, code-graph)

The server runs as a stdio process. Add it to your MCP client configuration:
  Claude Code: ~/.claude.json
  Cursor:      ~/.cursor/mcp.json
  Devin CLI:   devin mcp add remem-mcp -- npx -y remem-mcp

To install the skill (Devin CLI only):
  npx remem-mcp install-skill
`);
    return;
  }

  // Load the configuration
  const config = loadConfig();

  // Auto-import team artifact if it exists in the project root
  try {
    importArtifact(config.dbPath, process.cwd());
  } catch (err) {
    console.error(`[remem-mcp] Auto-import failed: ${err}`);
  }

  // Initialize the storage backend
  if (config.storage !== "sqlite") {
    console.error(
      `[remem-mcp] Storage backend "${config.storage}" is not implemented yet. Using sqlite.`,
    );
  }
  const storage = new SQLiteBackend(config.dbPath);

  // Initialize the embedder
  const embedder = new LocalEmbedder();

  // Initialize the pipeline
  let pipeline: PipelineStage;
  if (config.pipeline === "atom" && config.llm) {
    const llmClient = new OpenAILLMClient({
      apiKey: config.llm.apiKey,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
    });
    pipeline = new AtomPipeline();
    (pipeline as unknown as { _llmClient: unknown })._llmClient = llmClient;
  } else {
    // Default: rule-based atom extraction (no LLM needed).
    // Extracts facts from decision/learning/error/conversation captures
    // using regex patterns. Zero-cost, runs automatically after capture.
    pipeline = new RuleBasedAtomPipeline();
  }

  // Initialize the audit logger
  const audit = new AuditLogger(config.auditLogPath, config.security.auditLog);

  // Build pipeline context
  const pipelineCtx = {
    llmClient: config.llm
      ? new OpenAILLMClient({
          apiKey: config.llm.apiKey,
          baseUrl: config.llm.baseUrl,
          model: config.llm.model,
        })
      : undefined,
    storage,
    embedder,
  };

  // Create the MCP server
  const server = createServer({
    storage,
    embedder,
    pipeline,
    pipelineCtx,
    audit,
    redactSecrets: config.security.redactSecrets,
    maxContentLength: config.security.maxContentLength,
    maxTokensRecall: config.security.maxTokensRecall,
    maxTokensSearch: config.security.maxTokensSearch,
  });

  // Start the stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handle shutdown
  const shutdown = () => {
    storage.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(`[remem-mcp] Fatal error: ${err}`);
  process.exit(1);
});

// ─── verify: A/B proof that memory saves tokens ───────────────

/** Count tokens using a simple heuristic (4 chars ≈ 1 token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Run a real recall query and show what memory injects vs what the agent
 *  would have to re-read without memory. Inspired by Mnemos's verifier
 *  that runs Claude twice (with/without memory) to prove value. */
async function verifyMemory(dbPath: string, query: string): Promise<void> {
  console.log("remem-mcp verify — A/B proof of value\n");
  console.log(`Query: "${query}"\n`);

  const storage = new SQLiteBackend(dbPath);
  const results = await storage.search(query, null, {
    mode: "hybrid",
    limit: 10,
    offset: 0,
  });

  if (results.length === 0) {
    console.log("  No memories found for this query.");
    console.log("  Run `npx remem-mcp setup` to bootstrap project basics,");
    console.log("  or work on the project — hooks will auto-capture learnings.");
    storage.close();
    return;
  }

  // Measure real re-read cost: scan cwd for source files, estimate tokens
  const { statSync, readdirSync } = await import("node:fs");
  const { join, extname } = await import("node:path");
  const codeExts = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
  ];
  let totalFileBytes = 0;
  let fileCount = 0;
  try {
    const scanDir = (dir: string, depth: number) => {
      if (depth > 2 || fileCount > 50) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name.startsWith(".") || name === "node_modules" || name === "dist" || name === "build")
          continue;
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            scanDir(full, depth + 1);
          } else if (codeExts.includes(extname(name))) {
            totalFileBytes += stat.size;
            fileCount++;
          }
        } catch {
          // skip
        }
      }
    };
    scanDir(process.cwd(), 0);
  } catch {
    // fallback to estimate
  }

  // Estimate: agent would read ~5 most relevant files (not all files)
  const avgFileTokens = fileCount > 0 ? Math.ceil(totalFileBytes / fileCount / 4) : 2000;
  const estimatedReReadTokens = Math.min(avgFileTokens * 5, 15000);

  console.log("─ WITHOUT memory ──────────────────────────────────");
  console.log("  Agent would need to:");
  console.log("    1. Search the codebase for relevant context");
  console.log(
    `    2. Read ~5 files (${fileCount} source files found, avg ${avgFileTokens} tok each)`,
  );
  console.log("    3. Re-derive decisions from code structure");
  console.log("    4. Potentially repeat past errors");
  console.log("");
  console.log(`  Estimated re-read cost: ~${estimatedReReadTokens} tokens`);
  console.log("");

  console.log("─ WITH memory ─────────────────────────────────────");
  let totalMemoryTokens = 0;
  for (const r of results) {
    const entry = r.entry;
    const tokens = estimateTokens(entry.content);
    totalMemoryTokens += tokens;
    const type = entry.type ?? "memory";
    const tags = entry.tags && entry.tags.length > 0 ? `[${entry.tags.join(",")}]` : "";
    const preview = entry.content.slice(0, 80).replace(/\n/g, " ");
    console.log(`  [${type}] ${tokens} tok ${tags} ${preview}...`);
  }
  console.log(`\n  Memory injected: ${totalMemoryTokens} tokens`);
  console.log("");

  const saved = estimatedReReadTokens - totalMemoryTokens;
  const roi = estimatedReReadTokens / Math.max(totalMemoryTokens, 1);
  const costSaved = ((Math.max(saved, 0) / 1000) * 0.003).toFixed(2);

  console.log("─ Verdict ──────────────────────────────────────────");
  console.log(`  Re-reads avoided:  ~${estimatedReReadTokens} tokens`);
  console.log(`  Memory cost:       ${totalMemoryTokens} tokens`);
  console.log(`  Net saved:         ${saved > 0 ? saved : 0} tokens`);
  console.log(`  ROI:               ${roi.toFixed(1)}x`);
  console.log(`  Cost saved:        $${costSaved} (at $0.003/1K tokens)`);
  console.log("");
  if (saved > 0) {
    console.log("  Memory is working. The agent gets this context without re-reading files.");
  } else {
    console.log("  Memory cost exceeds re-read estimate. Consider forgetting stale memories.");
  }
  storage.close();
}
