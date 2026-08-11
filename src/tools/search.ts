import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Embedder } from "../embedding/types.js";
import type { AuditLogger } from "../security/audit.js";
import { enforceQuota } from "../security/quota.js";
import type { SearchFilters, SearchMode, StorageBackend } from "../storage/types.js";
import { formatResults } from "./format.js";

/** Register the search tool on the MCP server. */
export function registerSearch(
  server: Server,
  storage: StorageBackend,
  embedder: Embedder,
  audit: AuditLogger,
  maxTokens: number,
): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "search") return null;

    const args = request.params.arguments as {
      query: string;
      mode?: SearchMode;
      filters?: SearchFilters;
      limit?: number;
    };

    const limit = Math.min(args.limit ?? 20, 100);
    const mode = args.mode ?? "hybrid";

    // Generate the query embedding
    let queryEmbedding: number[] | null = null;
    if (mode === "hybrid" || mode === "vector") {
      try {
        queryEmbedding = await embedder.embed(args.query);
      } catch (err) {
        console.error(`[tdai-memory] Embedding failed: ${err}`);
      }
    }

    // Run the search
    const results = await storage.search(args.query, queryEmbedding, {
      limit,
      offset: 0,
      mode,
      filters: args.filters,
    });

    // Format the results
    const text = formatResults(results);

    // Enforce the quota
    const { text: finalText, quotaHit } = enforceQuota(text, maxTokens);

    // Log the audit entry
    audit.log({
      tool: "search",
      argsHash: AuditLogger.hashArgs({ query: args.query, mode, filters: args.filters }),
      resultLen: finalText.length,
      quotaHit,
      redacted: false,
    });

    return {
      content: [{ type: "text", text: finalText }],
    };
  });
}
