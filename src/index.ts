#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { SQLiteBackend } from "./storage/sqlite.js";
import { LocalEmbedder } from "./embedding/local.js";
import { NoopPipeline } from "./pipeline/noop.js";
import { AuditLogger } from "./security/audit.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
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
