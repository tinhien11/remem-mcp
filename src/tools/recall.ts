import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { StorageBackend } from "../storage/types.js";
import type { Embedder } from "../embedding/types.js";
import type { AuditLogger } from "../security/audit.js";
import { enforceQuota } from "../security/quota.js";
import { formatResults } from "./format.js";

/** Register the recall tool on the MCP server. */
export function registerRecall(
  server: Server,
  storage: StorageBackend,
  embedder: Embedder,
  audit: AuditLogger,
  maxTokens: number,
): void {
  // The tool definition is in the list-tools handler.
  // The call handler checks the tool name and runs the recall logic.

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "recall",
          description:
            "Retrieve relevant past memory. Call this tool before you answer the user. " +
            "Use it when the user references past work or when the task needs project context.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "A natural language query. The tool uses this text for the BM25 search and the vector search.",
              },
              session_key: {
                type: "string",
                description:
                  "The session key. The default is hash(cwd). Use this to recall memory from a different project.",
              },
              limit: {
                type: "integer",
                default: 10,
                maximum: 50,
                description: "The maximum number of results.",
              },
              offset: {
                type: "integer",
                default: 0,
                description: "The pagination offset. Use this to get the next page of results.",
              },
              max_tokens: {
                type: "integer",
                default: 4000,
                maximum: 8000,
                description:
                  "The maximum number of tokens in the response. If the result exceeds this value, the tool truncates the text.",
              },
              mode: {
                type: "string",
                enum: ["hybrid", "keyword", "vector"],
                default: "hybrid",
                description: "The search mode.",
              },
            },
            required: ["query"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "recall") return null;

    const args = request.params.arguments as {
      query: string;
      session_key?: string;
      limit?: number;
      offset?: number;
      max_tokens?: number;
      mode?: "hybrid" | "keyword" | "vector";
    };

    const limit = Math.min(args.limit ?? 10, 50);
    const offset = args.offset ?? 0;
    const tokenCap = Math.min(args.max_tokens ?? maxTokens, 8000);
    const mode = args.mode ?? "hybrid";

    // Generate the query embedding
    let queryEmbedding: number[] | null = null;
    if (mode === "hybrid" || mode === "vector") {
      try {
        queryEmbedding = await embedder.embed(args.query);
      } catch (err) {
        // If the embedding fails, fall back to keyword-only
        console.error(`[tdai-memory] Embedding failed: ${err}`);
      }
    }

    // Run the search
    const results = await storage.search(args.query, queryEmbedding, {
      sessionKey: args.session_key,
      limit,
      offset,
      mode,
    });

    // Format the results
    const text = formatResults(results);

    // Enforce the quota
    const { text: finalText, quotaHit } = enforceQuota(text, tokenCap);

    // Log the audit entry
    audit.log({
      tool: "recall",
      argsHash: AuditLogger.hashArgs({ query: args.query, limit, offset, mode }),
      resultLen: finalText.length,
      quotaHit,
      redacted: false,
    });

    return {
      content: [{ type: "text", text: finalText }],
    };
  });
}
