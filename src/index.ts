#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { exportArtifact, importArtifact } from "./artifact.js";
import { backup } from "./backup.js";
import { atomsCommand } from "./cli/atoms.js";
import { extractCommand } from "./cli/extract.js";
import { knowledgeCommand } from "./cli/knowledge.js";
import { personaCommand } from "./cli/persona.js";
import { scenariosCommand } from "./cli/scenarios.js";
import { skillsCommand } from "./cli/skills.js";
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
import { exportData } from "./export.js";
import {
  hookPostCommit,
  hookPostToolUse,
  hookPreToolUse,
  hookRecall,
  hookSessionEnd,
  hookStop,
  waitAndCapture,
} from "./hook-handlers.js";
import { installHooks, uninstallHooks } from "./hooks.js";
import { importData } from "./import.js";
import { installMcpServer } from "./install-mcp.js";
import { installSkill } from "./install-skill.js";
import { AtomPipeline } from "./pipeline/atom.js";
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
  return (
    process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db")
  );
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
    if (argv[i]?.startsWith("--") && argv[i + 1]) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "install-skill") {
    await installSkill();
    return;
  }
  if (arg === "install-hooks") {
    await installHooks();
    return;
  }
  if (arg === "setup") {
    console.log("tdai-memory-mcp setup\n");
    console.log("This will register the MCP server, install hooks, and run a test capture.\n");
    await installMcpServer();
    console.log("");
    await installHooks();
    console.log("\nTest capture...");
    const { Memory } = await import("./sdk.js");
    const mem = new Memory();
    const id = await mem.capture(
      "tdai-memory-mcp setup completed. This is a test capture.",
      "task",
      ["setup", "test"],
    );
    if (id) {
      console.log(`Test capture saved: ${id}`);
    } else {
      console.log("Test capture already exists (duplicate).");
    }
    console.log("\nSetup complete. Restart your agent to activate hooks.");
    console.log("\nOptional: run `npx tdai-memory-mcp install-skill` to teach your");
    console.log("agent when to recall/capture mid-session (adds ~4K tokens to context).");
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

    console.log("tdai-memory-mcp stats\n");
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
  if (arg === "import") {
    const dbPath = defaultDbPath();
    const input = process.argv[3];
    if (!input) {
      console.error("Error: Provide a file path. Usage: tdai-memory-mcp import <file.json>");
      process.exit(1);
    }
    importData(dbPath, input);
    return;
  }
  if (arg === "stats") {
    stats(defaultDbPath());
    return;
  }
  if (arg === "token-stats") {
    tokenStats(defaultDbPath());
    return;
  }
  if (arg === "viewer") {
    const port = Number(process.argv[4] ?? process.env.TDAI_VIEWER_PORT ?? 7331);
    startViewer(defaultDbPath(), port);
    return;
  }
  if (arg === "backup") {
    const dbPath = defaultDbPath();
    const auditPath = process.env.TDAI_AUDIT_LOG_PATH ?? join(dirname(dbPath), "audit.jsonl");
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
      console.log("No team artifact found. Run 'tdai-memory-mcp sync-export' to create one.");
    }
    return;
  }
  if (arg === "hook-recall") {
    hookRecall(defaultDbPath());
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
    if (!query) {
      console.error("Usage: search-code --query <name> [--limit N]");
      return;
    }
    const db = openDbWithSchema(defaultDbPath());
    const syms = searchSymbols(db, query, { teamId, limit });
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
    const filePath = process.argv[3];
    if (!filePath) {
      console.error("Usage: list-code <file_path>");
      return;
    }
    const db = openDbWithSchema(defaultDbPath());
    const syms = listSymbols(db, filePath);
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
      console.log(`tdai-memory-mcp v${pkg.version}`);
    } catch {
      console.log("tdai-memory-mcp (version unknown)");
    }
    return;
  }
  if (arg === "help" || arg === "--help" || arg === "-h") {
    console.log(`tdai-memory-mcp - Local-first MCP memory server

Usage:
  tdai-memory-mcp                Start the MCP server (stdio)
  tdai-memory-mcp setup          Install skill + hooks + test capture (one command)
  tdai-memory-mcp install-skill  Install the agent skill for Devin CLI
  tdai-memory-mcp install-hooks  Install lifecycle hooks (SessionStart, Stop, SessionEnd)
  tdai-memory-mcp uninstall-hooks  Remove lifecycle hooks
  tdai-memory-mcp hook-post-commit  Auto-index changed files (git post-commit hook)
  tdai-memory-mcp doctor         Check setup health
  tdai-memory-mcp recent [N]     Show N most recent captures (default: 20)
  tdai-memory-mcp stats          Show memory statistics (by type, trust, size)

CodeGraph commands:
  tdai-memory-mcp index [--path src] [--repo .]  Index code symbols (Tree-sitter)
  tdai-memory-mcp search-code --query <name>     Search symbols by name
  tdai-memory-mcp callers <symbol_id>            Find who calls a symbol
  tdai-memory-mcp callees <symbol_id>            Find what a symbol calls
  tdai-memory-mcp impact <symbol_id>             Impact analysis (what breaks if changed)
  tdai-memory-mcp list-code <file_path>          List symbols in a file

Wiki commands:
  tdai-memory-mcp wiki ingest [--path docs]      Index markdown documentation
  tdai-memory-mcp wiki search <query>            Search wiki pages
  tdai-memory-mcp wiki outdated [--repo .]       Find outdated wiki pages

  tdai-memory-mcp export [file]  Export captures to JSON (default: stdout)
  tdai-memory-mcp import <file>  Import captures from JSON
  tdai-memory-mcp stats          Print memory statistics
  tdai-memory-mcp token-stats    Print token savings report
  tdai-memory-mcp viewer [port]  Start web viewer (default port: 7331)
  tdai-memory-mcp backup [dir]   Backup database and audit log
  tdai-memory-mcp sync-export    Export memory to .tdai-memory/ in the project root
  tdai-memory-mcp sync-import    Import memory from .tdai-memory/ (auto on startup)

L1-L3 pipeline commands (require TDAI_LLM_API_KEY for extract):
  tdai-memory-mcp extract        Run L1 atom extraction on existing captures
  tdai-memory-mcp atoms          List or search L1 atoms
  tdai-memory-mcp scenarios      List L2 scenarios
  tdai-memory-mcp persona        Read or write L3 persona

Knowledge and skills commands:
  tdai-memory-mcp knowledge      List knowledge assets for a team
  tdai-memory-mcp skills         List skills for a team

  tdai-memory-mcp version        Print the version
  tdai-memory-mcp help           Print this help

Export options:
  --session-key <key>  Export only captures from this session
  --type <type>        Export only captures of this type

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
  Devin CLI:   devin mcp add tdai-memory -- npx -y tdai-memory-mcp

To install the skill (Devin CLI only):
  npx tdai-memory-mcp install-skill
`);
    return;
  }

  // Load the configuration
  const config = loadConfig();

  // Auto-import team artifact if it exists in the project root
  try {
    importArtifact(config.dbPath, process.cwd());
  } catch (err) {
    console.error(`[tdai-memory] Auto-import failed: ${err}`);
  }

  // Initialize the storage backend
  if (config.storage !== "sqlite") {
    console.error(
      `[tdai-memory] Storage backend "${config.storage}" is not implemented yet. Using sqlite.`,
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
    pipeline = new NoopPipeline();
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
  console.error(`[tdai-memory] Fatal error: ${err}`);
  process.exit(1);
});
