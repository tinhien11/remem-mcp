#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { SQLiteBackend } from "./storage/sqlite.js";
import { LocalEmbedder } from "./embedding/local.js";
import { NoopPipeline } from "./pipeline/noop.js";
import { AuditLogger } from "./security/audit.js";
import { createServer } from "./server.js";
import { installSkill } from "./install-skill.js";
import { exportData } from "./export.js";
import { importData } from "./import.js";
import { stats } from "./stats.js";
import { startViewer } from "./viewer.js";
import { backup } from "./backup.js";
import { installHooks, uninstallHooks } from "./hooks.js";
import { exportArtifact, importArtifact, hasArtifact } from "./artifact.js";
import { hookRecall, hookStop } from "./hook-handlers.js";

async function main(): Promise<void> {
  // Check for CLI subcommands
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
    const dbPath = process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db");
    const output = process.argv[3] ?? "-";

    // Parse optional filters: --session-key <key> --type <type>
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
    const dbPath = process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db");
    const input = process.argv[3];
    if (!input) {
      console.error("Error: Provide a file path. Usage: tdai-memory-mcp import <file.json>");
      process.exit(1);
    }
    importData(dbPath, input);
    return;
  }
  if (arg === "stats") {
    const dbPath = process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db");
    stats(dbPath);
    return;
  }
  if (arg === "viewer") {
    const dbPath = process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db");
    const port = Number(process.argv[4] ?? process.env.TDAI_VIEWER_PORT ?? 7331);
    startViewer(dbPath, port);
    return;
  }
  if (arg === "backup") {
    const dbPath = process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db");
    const auditPath = process.env.TDAI_AUDIT_LOG_PATH ?? join(dirname(dbPath), "audit.jsonl");
    const outputDir = process.argv[3] ?? "-";
    backup(dbPath, auditPath, outputDir);
    return;
  }
  if (arg === "sync-export") {
    const dbPath = process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db");
    const projectRoot = process.cwd();
    const sessionKey = process.argv[4] ?? undefined;
    exportArtifact(dbPath, projectRoot, sessionKey);
    return;
  }
  if (arg === "sync-import") {
    const dbPath = process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db");
    const projectRoot = process.cwd();
    const count = importArtifact(dbPath, projectRoot);
    if (count === 0) {
      console.log("No team artifact found. Run 'tdai-memory-mcp sync-export' to create one.");
    }
    return;
  }
  if (arg === "hook-recall") {
    const dbPath = process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db");
    hookRecall(dbPath);
    return;
  }
  if (arg === "hook-stop") {
    hookStop();
    return;
  }
  if (arg === "version" || arg === "--version" || arg === "-v") {
    console.log("tdai-memory-mcp v0.1.2");
    return;
  }
  if (arg === "help" || arg === "--help" || arg === "-h") {
    console.log(`tdai-memory-mcp - Local-first MCP memory server

Usage:
  tdai-memory-mcp                Start the MCP server (stdio)
  tdai-memory-mcp install-skill  Install the agent skill for Devin CLI
  tdai-memory-mcp install-hooks  Install lifecycle hooks (SessionStart, Stop)
  tdai-memory-mcp uninstall-hooks  Remove lifecycle hooks
  tdai-memory-mcp export [file]  Export captures to JSON (default: stdout)
  tdai-memory-mcp import <file>  Import captures from JSON
  tdai-memory-mcp stats          Print memory statistics
  tdai-memory-mcp viewer [port]  Start web viewer (default port: 7331)
  tdai-memory-mcp backup [dir]   Backup database and audit log
  tdai-memory-mcp sync-export    Export memory to .tdai-memory/ in the project root
  tdai-memory-mcp sync-import    Import memory from .tdai-memory/ (auto on startup)
  tdai-memory-mcp version        Print the version
  tdai-memory-mcp help           Print this help

Export options:
  --session-key <key>  Export only captures from this session
  --type <type>        Export only captures of this type

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
    console.error(`[tdai-memory] Storage backend "${config.storage}" is not implemented yet. Using sqlite.`);
  }
  const storage = new SQLiteBackend(config.dbPath);

  // Initialize the embedder
  const embedder = new LocalEmbedder();

  // Initialize the pipeline
  const pipeline = new NoopPipeline();

  // Initialize the audit logger
  const audit = new AuditLogger(config.auditLogPath, config.security.auditLog);

  // Create the MCP server
  const server = createServer({
    storage,
    embedder,
    pipeline,
    pipelineCtx: { llmClient: undefined, storage, embedder },
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
