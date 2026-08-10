import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { StorageBackend, CaptureType, CaptureEntry, SearchMode, DeleteFilter } from "./storage/types.js";
import type { Embedder } from "./embedding/types.js";
import type { PipelineStage, PipelineContext } from "./pipeline/types.js";
import { AuditLogger } from "./security/audit.js";
import { redact } from "./security/redactor.js";
import { enforceQuota, checkContentLength } from "./security/quota.js";
import { generateId } from "./utils/ulid.js";
import { formatResults } from "./tools/format.js";
import { createHash } from "node:crypto";

/** Default session key: hash of the current working directory. */
function defaultSessionKey(): string {
  const cwd = process.cwd();
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/** Detect the agent ID from environment variables. */
function detectAgentId(): string {
  if (process.env.DEVIN_SESSION_ID) return "devin";
  if (process.env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (process.env.CURSOR_DEBUG) return "cursor";
  return "unknown";
}

/** Options to create the MCP server. */
export interface ServerOptions {
  storage: StorageBackend;
  embedder: Embedder;
  pipeline: PipelineStage;
  pipelineCtx: Omit<PipelineContext, "sessionKey">;
  audit: AuditLogger;
  redactSecrets: boolean;
  maxContentLength: number;
  maxTokensRecall: number;
  maxTokensSearch: number;
}

/** Tool definitions for the MCP protocol. */
const TOOLS: Tool[] = [
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
  {
    name: "capture",
    description:
      "Save a decision, a learning, or a task outcome to memory. " +
      "Call this tool after you complete a non-trivial task, make a decision, or fix a bug with a known root cause.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The text to remember. The tool redacts secrets before it stores the text.",
        },
        type: {
          type: "string",
          enum: ["conversation", "decision", "learning", "task", "error", "atom"],
          description: "The type of the memory.",
        },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        session_key: { type: "string", description: "The session key. The default is hash(cwd)." },
        metadata: { type: "object", description: "Optional metadata." },
      },
      required: ["content", "type"],
    },
  },
  {
    name: "search",
    description:
      "Search memory by keyword or by semantic similarity. " +
      "Use this tool when recall is too broad and you need specific facts.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search text." },
        mode: {
          type: "string",
          enum: ["hybrid", "keyword", "vector"],
          default: "hybrid",
          description: "The search mode.",
        },
        filters: {
          type: "object",
          properties: {
            type: { type: "string", description: "Filter by the memory type." },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Filter by tags. A capture must have at least one of these tags.",
            },
            agent_id: { type: "string", description: "Filter by the agent that captured the memory." },
            date_from: { type: "string", description: "Filter by date. The format is ISO 8601." },
            date_to: { type: "string", description: "Filter by date. The format is ISO 8601." },
          },
        },
        limit: { type: "integer", default: 20, maximum: 100 },
      },
      required: ["query"],
    },
  },
  {
    name: "forget",
    description:
      "Delete specific memory entries. Use this tool only when the user requests a deletion. " +
      "Do not auto-forget.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The ID of the capture to delete." },
        filter: {
          type: "object",
          properties: {
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Delete all captures that have at least one of these tags.",
            },
            type: { type: "string", description: "Delete all captures of this type." },
            date_before: {
              type: "string",
              description: "Delete all captures before this date. The format is ISO 8601.",
            },
          },
        },
        confirm: {
          type: "boolean",
          default: false,
          description: "Set this to true to execute the deletion.",
        },
      },
    },
  },
];

/** Create the MCP server with all 4 tools registered. */
export function createServer(opts: ServerOptions): Server {
  const server = new Server(
    {
      name: "tdai-memory-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Single list-tools handler: returns all 4 tools.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Single call-tool handler: dispatches to the correct tool logic.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    switch (name) {
      case "recall":
        return handleRecall(args, opts);
      case "capture":
        return handleCapture(args, opts);
      case "search":
        return handleSearch(args, opts);
      case "forget":
        return handleForget(args, opts);
      default:
        return {
          content: [{ type: "text", text: `Error: Unknown tool "${name}".` }],
          isError: true,
        };
    }
  });

  return server;
}

/** Handle the recall tool. */
async function handleRecall(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const query = args.query as string;
  const sessionKey = args.session_key as string | undefined;
  const limit = Math.min((args.limit as number) ?? 10, 50);
  const offset = (args.offset as number) ?? 0;
  const tokenCap = Math.min((args.max_tokens as number) ?? opts.maxTokensRecall, 8000);
  const mode = (args.mode as SearchMode) ?? "hybrid";

  let queryEmbedding: number[] | null = null;
  if (mode === "hybrid" || mode === "vector") {
    try {
      queryEmbedding = await opts.embedder.embed(query);
    } catch (err) {
      console.error(`[tdai-memory] Embedding failed: ${err}`);
    }
  }

  const results = await opts.storage.search(query, queryEmbedding, {
    sessionKey,
    limit,
    offset,
    mode,
  });

  const text = formatResults(results);
  const { text: finalText, quotaHit } = enforceQuota(text, tokenCap);

  opts.audit.log({
    tool: "recall",
    argsHash: AuditLogger.hashArgs({ query, limit, offset, mode }),
    resultLen: finalText.length,
    quotaHit,
    redacted: false,
  });

  return { content: [{ type: "text", text: finalText }] };
}

/** Handle the capture tool. */
async function handleCapture(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const content = args.content as string;
  const type = args.type as CaptureType;
  const tags = (args.tags as string[]) ?? [];
  const sessionKey = (args.session_key as string) ?? defaultSessionKey();
  const metadata = args.metadata as Record<string, unknown> | undefined;

  if (!checkContentLength(content, opts.maxContentLength)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: The content exceeds the maximum length of ${opts.maxContentLength} characters.`,
        },
      ],
      isError: true,
    };
  }

  const { text: redactedContent, redacted: wasRedacted } = opts.redactSecrets
    ? redact(content)
    : { text: content, redacted: false };

  const id = generateId();
  const agentId = detectAgentId();

  const entry: CaptureEntry = {
    id,
    sessionKey,
    agentId,
    type,
    content: redactedContent,
    tags,
    createdAt: Date.now(),
    metadata,
  };

  await opts.storage.put(entry);

  try {
    const embedding = await opts.embedder.embed(redactedContent);
    await opts.storage.putVector(id, embedding);
  } catch (err) {
    console.error(`[tdai-memory] Embedding failed: ${err}`);
  }

  if (opts.pipeline.name !== "noop") {
    try {
      await opts.pipeline.process(
        { id, content: redactedContent, type, tags, sessionKey },
        { ...opts.pipelineCtx, sessionKey },
      );
    } catch (err) {
      console.error(`[tdai-memory] Pipeline failed: ${err}`);
    }
  }

  opts.audit.log({
    tool: "capture",
    argsHash: AuditLogger.hashArgs({ type, tags, sessionKey }),
    resultLen: id.length,
    quotaHit: false,
    redacted: wasRedacted,
  });

  const redactionNote = wasRedacted ? " (secrets were redacted)" : "";
  return { content: [{ type: "text", text: `Captured: ${id}${redactionNote}` }] };
}

/** Handle the search tool. */
async function handleSearch(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const query = args.query as string;
  const mode = (args.mode as SearchMode) ?? "hybrid";
  const filters = args.filters as { type?: CaptureType; tags?: string[]; agent_id?: string; date_from?: string; date_to?: string } | undefined;
  const limit = Math.min((args.limit as number) ?? 20, 100);

  let queryEmbedding: number[] | null = null;
  if (mode === "hybrid" || mode === "vector") {
    try {
      queryEmbedding = await opts.embedder.embed(query);
    } catch (err) {
      console.error(`[tdai-memory] Embedding failed: ${err}`);
    }
  }

  const results = await opts.storage.search(query, queryEmbedding, {
    limit,
    offset: 0,
    mode,
    filters: filters
      ? {
          type: filters.type,
          tags: filters.tags,
          agentId: filters.agent_id,
          dateFrom: filters.date_from,
          dateTo: filters.date_to,
        }
      : undefined,
  });

  const text = formatResults(results);
  const { text: finalText, quotaHit } = enforceQuota(text, opts.maxTokensSearch);

  opts.audit.log({
    tool: "search",
    argsHash: AuditLogger.hashArgs({ query, mode, filters }),
    resultLen: finalText.length,
    quotaHit,
    redacted: false,
  });

  return { content: [{ type: "text", text: finalText }] };
}

/** Handle the forget tool. */
async function handleForget(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const id = args.id as string | undefined;
  const filter = args.filter as DeleteFilter | undefined;
  const confirm = (args.confirm as boolean) ?? false;

  if (!confirm) {
    return {
      content: [
        {
          type: "text",
          text: "Error: Set confirm to true to execute the deletion. The tool did not delete anything.",
        },
      ],
      isError: true,
    };
  }

  let result;
  if (id) {
    result = await opts.storage.delete(id);
  } else if (filter) {
    result = await opts.storage.deleteByFilter(filter);
  } else {
    return {
      content: [
        {
          type: "text",
          text: "Error: Provide an id or a filter. The tool did not delete anything.",
        },
      ],
      isError: true,
    };
  }

  opts.audit.log({
    tool: "forget",
    argsHash: AuditLogger.hashArgs({ id, filter }),
    resultLen: null,
    quotaHit: false,
    redacted: false,
  });

  return {
    content: [
      {
        type: "text",
        text: `Deleted: ${result.captures} captures, ${result.atoms} atoms, ${result.scenarios} scenarios`,
      },
    ],
  };
}
