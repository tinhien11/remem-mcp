#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { SQLiteBackend } from "./storage/sqlite.js";
import { LocalEmbedder } from "./embedding/local.js";
import { NoopPipeline } from "./pipeline/noop.js";
import { AuditLogger } from "./security/audit.js";
import { createServer } from "./server.js";
import { installSkill } from "./install-skill.js";

async function main(): Promise<void> {
  // Check for CLI subcommands
  const arg = process.argv[2];
  if (arg === "install-skill") {
    await installSkill();
    return;
  }
  if (arg === "version" || arg === "--version" || arg === "-v") {
    console.log("tdai-memory-mcp v0.1.1");
    return;
  }
  if (arg === "help" || arg === "--help" || arg === "-h") {
    console.log(`tdai-memory-mcp - Local-first MCP memory server

Usage:
  tdai-memory-mcp                Start the MCP server (stdio)
  tdai-memory-mcp install-skill  Install the agent skill for Devin CLI
  tdai-memory-mcp version        Print the version
  tdai-memory-mcp help           Print this help

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
