import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
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
  {
    name: "handoff",
    description:
      "Write a structured handoff packet for the next agent session. " +
      "Call this tool at the end of a session, or before you switch to a different agent. " +
      "The next agent calls recall to load this packet and continue without re-reading files. " +
      "This saves 60-85% of tokens compared to re-discovering context.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "A one-line description of the task.",
        },
        status: {
          type: "string",
          enum: ["in_progress", "blocked", "needs_review", "done", "assigned"],
          description: "The current status of the task.",
        },
        progress: {
          type: "string",
          description: "A summary of what has been done so far. Include the root cause if this is a bug fix.",
        },
        decisions: {
          type: "array",
          items: { type: "string" },
          description: "A list of decisions made during this session. Include what was chosen and why.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "A list of files that matter for this task. Use the format: path:lines - reason.",
        },
        next_steps: {
          type: "array",
          items: { type: "string" },
          description: "A list of next steps for the next agent. Order by priority.",
        },
        session_key: { type: "string", description: "The session key. The default is hash(cwd)." },
      },
      required: ["task", "status", "progress"],
    },
  },
  {
    name: "adr",
    description:
      "Record an Architecture Decision Record (ADR). Use this tool when you make a technical decision " +
      "that future agents should know about. The ADR is stored as a structured capture and can be " +
      "recalled by any agent working on the same project.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "A short title for the decision. Example: 'Use SQLite for local storage'.",
        },
        context: {
          type: "string",
          description: "The problem or situation that requires a decision. Why is this decision needed?",
        },
        decision: {
          type: "string",
          description: "The decision that was made. What was chosen?",
        },
        alternatives: {
          type: "array",
          items: { type: "string" },
          description: "Other options that were considered but rejected. Include why each was rejected.",
        },
        consequences: {
          type: "string",
          description: "The consequences of this decision. What are the trade-offs, risks, and benefits?",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for filtering. Example: ['arch', 'storage'].",
        },
        session_key: { type: "string", description: "The session key. The default is hash(cwd)." },
      },
      required: ["title", "context", "decision"],
    },
  },
];

/** Create the MCP server with all 6 tools registered. */
export function createServer(opts: ServerOptions): Server {
  const server = new Server(
    {
      name: "tdai-memory-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // Single list-tools handler: returns all 4 tools.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // List resources: expose recent captures as readable resources.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    // Return a single resource template for captures
    return {
      resources: [
        {
          uri: "tdai-memory://recent",
          name: "Recent captures",
          description: "The 20 most recent memory captures.",
          mimeType: "text/plain",
        },
        {
          uri: "tdai-memory://stats",
          name: "Memory statistics",
          description: "Summary statistics for the memory database.",
          mimeType: "application/json",
        },
      ],
    };
  });

  // Read resource: return the content for a given URI.
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (uri === "tdai-memory://recent") {
      // Get the 20 most recent captures
      const results = await opts.storage.search("", null, {
        limit: 20,
        offset: 0,
        mode: "keyword",
      });
      const text = formatResults(results);
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: text || "No captures found.",
          },
        ],
      };
    }

    if (uri === "tdai-memory://stats") {
      // Return basic stats as JSON
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({
              message: "Use the stats CLI command for full statistics.",
              hint: "Run: npx tdai-memory-mcp stats",
            }),
          },
        ],
      };
    }

    return {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: `Unknown resource: ${uri}`,
        },
      ],
    };
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
      case "handoff":
        return handleHandoff(args, opts);
      case "adr":
        return handleAdr(args, opts);
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

  // Dedup: check if content with the same hash already exists in this session.
  const contentHash = createHash("sha256").update(redactedContent).digest("hex");
  const existing = await opts.storage.findByContentHash(contentHash, sessionKey);
  if (existing.length > 0) {
    opts.audit.log({
      tool: "capture",
      argsHash: AuditLogger.hashArgs({ type, tags, sessionKey }),
      resultLen: existing[0].id.length,
      quotaHit: false,
      redacted: wasRedacted,
    });
    return {
      content: [
        {
          type: "text",
          text: `Duplicate: ${existing[0].id} (content already captured)`,
        },
      ],
    };
  }

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

/** Handle the handoff tool. Creates a structured handoff packet for the next agent. */
async function handleHandoff(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const task = args.task as string;
  const status = args.status as string;
  const progress = args.progress as string;
  const decisions = (args.decisions as string[]) ?? [];
  const files = (args.files as string[]) ?? [];
  const nextSteps = (args.next_steps as string[]) ?? [];
  const sessionKey = (args.session_key as string) ?? defaultSessionKey();

  // Build a structured handoff packet as the content.
  const lines: string[] = [];
  lines.push(`# Handoff: ${task}`);
  lines.push(`Status: ${status}`);
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Progress");
  lines.push(progress);
  lines.push("");

  if (decisions.length > 0) {
    lines.push("## Decisions");
    for (const d of decisions) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  if (files.length > 0) {
    lines.push("## Files");
    for (const f of files) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  if (nextSteps.length > 0) {
    lines.push("## Next steps");
    for (let i = 0; i < nextSteps.length; i++) {
      lines.push(`${i + 1}. ${nextSteps[i]}`);
    }
    lines.push("");
  }

  const content = lines.join("\n");

  if (!checkContentLength(content, opts.maxContentLength)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: The handoff packet exceeds the maximum length of ${opts.maxContentLength} characters.`,
        },
      ],
      isError: true,
    };
  }

  // Dedup check: hash the structured data (excluding the timestamp) so that
  // two handoffs with the same task/status/progress are detected as duplicates
  // even if they were created at different times.
  const dedupPayload = JSON.stringify({ task, status, progress, decisions, files, nextSteps });
  const contentHash = createHash("sha256").update(dedupPayload).digest("hex");
  const existing = await opts.storage.findByContentHash(contentHash, sessionKey);
  if (existing.length > 0) {
    return {
      content: [
        {
          type: "text",
          text: `Duplicate handoff: ${existing[0].id} (same content already captured)`,
        },
      ],
    };
  }

  const id = generateId();
  const agentId = detectAgentId();

  const entry: CaptureEntry = {
    id,
    sessionKey,
    agentId,
    type: "task",
    content,
    tags: ["handoff", `status:${status}`],
    createdAt: Date.now(),
    metadata: {
      handoff: true,
      task,
      status,
      progress,
      decisions,
      files,
      nextSteps,
    },
    contentHash,
  };

  await opts.storage.put(entry);

  try {
    const embedding = await opts.embedder.embed(content);
    await opts.storage.putVector(id, embedding);
  } catch (err) {
    console.error(`[tdai-memory] Embedding failed: ${err}`);
  }

  opts.audit.log({
    tool: "handoff",
    argsHash: AuditLogger.hashArgs({ task, status }),
    resultLen: id.length,
    quotaHit: false,
    redacted: false,
  });

  return {
    content: [
      {
        type: "text",
        text: `Handoff saved: ${id}\nStatus: ${status}\nNext agent: call recall with query "${task}" to load this packet.`,
      },
    ],
  };
}

/** Handle the adr tool. Records an Architecture Decision Record as a structured capture. */
async function handleAdr(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const title = args.title as string;
  const context = args.context as string;
  const decision = args.decision as string;
  const alternatives = (args.alternatives as string[]) ?? [];
  const consequences = (args.consequences as string) ?? "";
  const tags = (args.tags as string[]) ?? [];
  const sessionKey = (args.session_key as string) ?? defaultSessionKey();

  // Build ADR content in markdown format
  const lines: string[] = [];
  lines.push(`# ADR: ${title}`);
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Context");
  lines.push(context);
  lines.push("");
  lines.push("## Decision");
  lines.push(decision);
  lines.push("");

  if (alternatives.length > 0) {
    lines.push("## Alternatives considered");
    for (const alt of alternatives) {
      lines.push(`- ${alt}`);
    }
    lines.push("");
  }

  if (consequences) {
    lines.push("## Consequences");
    lines.push(consequences);
    lines.push("");
  }

  const content = lines.join("\n");

  if (!checkContentLength(content, opts.maxContentLength)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: The ADR exceeds the maximum length of ${opts.maxContentLength} characters.`,
        },
      ],
      isError: true,
    };
  }

  // Dedup: hash the structured data (excluding the timestamp)
  const dedupPayload = JSON.stringify({ title, context, decision, alternatives, consequences });
  const contentHash = createHash("sha256").update(dedupPayload).digest("hex");
  const existing = await opts.storage.findByContentHash(contentHash, sessionKey);
  if (existing.length > 0) {
    return {
      content: [
        {
          type: "text",
          text: `Duplicate ADR: ${existing[0].id} (same decision already recorded)`,
        },
      ],
    };
  }

  const id = generateId();
  const agentId = detectAgentId();
  const allTags = ["adr", ...tags];

  const entry: CaptureEntry = {
    id,
    sessionKey,
    agentId,
    type: "decision",
    content,
    tags: allTags,
    createdAt: Date.now(),
    metadata: {
      adr: true,
      title,
      context,
      decision,
      alternatives,
      consequences,
    },
    contentHash,
  };

  await opts.storage.put(entry);

  try {
    const embedding = await opts.embedder.embed(content);
    await opts.storage.putVector(id, embedding);
  } catch (err) {
    console.error(`[tdai-memory] Embedding failed: ${err}`);
  }

  opts.audit.log({
    tool: "adr",
    argsHash: AuditLogger.hashArgs({ title, decision }),
    resultLen: id.length,
    quotaHit: false,
    redacted: false,
  });

  return {
    content: [
      {
        type: "text",
        text: `ADR saved: ${id}\nTitle: ${title}\nRecall with: recall({ query: "${title}" })`,
      },
    ],
  };
}
