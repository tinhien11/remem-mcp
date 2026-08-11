#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exportArtifact, importArtifact } from "./artifact.js";
import { backup } from "./backup.js";
import { atomsCommand } from "./cli/atoms.js";
import { extractCommand } from "./cli/extract.js";
import { knowledgeCommand } from "./cli/knowledge.js";
import { personaCommand } from "./cli/persona.js";
import { scenariosCommand } from "./cli/scenarios.js";
import { skillsCommand } from "./cli/skills.js";
import { loadConfig } from "./config.js";
import { LocalEmbedder } from "./embedding/local.js";
import { exportData } from "./export.js";
import { hookRecall, hookSessionEnd, hookStop } from "./hook-handlers.js";
import { installHooks, uninstallHooks } from "./hooks.js";
import { importData } from "./import.js";
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

/** Default DB path. */
function defaultDbPath(): string {
  return (
    process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db")
  );
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
  if (arg === "uninstall-hooks") {
    await uninstallHooks();
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
    hookStop();
    return;
  }
  if (arg === "hook-session-end") {
    hookSessionEnd(defaultDbPath());
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
  tdai-memory-mcp install-skill  Install the agent skill for Devin CLI
  tdai-memory-mcp install-hooks  Install lifecycle hooks (SessionStart, SessionEnd)
  tdai-memory-mcp uninstall-hooks  Remove lifecycle hooks
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
