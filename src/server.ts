import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Embedder } from "./embedding/types.js";
import type { PipelineContext, PipelineStage } from "./pipeline/types.js";
import { AuditLogger } from "./security/audit.js";
import { checkContentLength, enforceQuota } from "./security/quota.js";
import { redact } from "./security/redactor.js";
import type {
  CaptureEntry,
  CaptureMessage,
  CaptureType,
  DeleteFilter,
  DeleteResult,
  KnowledgeEntry,
  SearchMode,
  StorageBackend,
} from "./storage/types.js";
import { formatResults } from "./tools/format.js";
import { generateId } from "./utils/ulid.js";

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

/** Multi-tenant isolation parameters shared across tools. */
const TENANT_PARAMS = {
  team_id: {
    type: "string",
    description:
      "The team ID. Use this to isolate memory by team. When set, all queries filter by this value.",
  },
  agent_id: {
    type: "string",
    description:
      "The agent ID. Use this to isolate memory by agent role within a team. Defaults to the detected agent.",
  },
  user_id: {
    type: "string",
    description:
      "The user ID. Use this to isolate memory by user within a team. When set with team_id, queries filter by both.",
  },
  task_id: {
    type: "string",
    description:
      "The task ID. Use this to isolate memory by a specific task. Link captures to a task for finer isolation.",
  },
};

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
        ...TENANT_PARAMS,
      },
      required: ["query"],
    },
  },
  {
    name: "capture",
    description:
      "Save a decision, a learning, or a task outcome to memory. " +
      "Call this tool after you complete a non-trivial task, make a decision, or fix a bug with a known root cause. " +
      "You can capture a single text string, or a list of role-based conversation messages.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "The text to remember. The tool redacts secrets before it stores the text. " +
            "Use this for a single message. Use 'messages' instead for a multi-turn conversation.",
        },
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: {
                type: "string",
                description: "The role of the speaker: 'user' or 'assistant'.",
              },
              content: {
                type: "string",
                description: "The message content.",
              },
            },
            required: ["role", "content"],
          },
          description:
            "A list of role-based conversation messages to capture. When set, 'content' is ignored. " +
            "The tool flattens the messages into a single text for search, and stores the original messages for retrieval.",
        },
        type: {
          type: "string",
          enum: ["conversation", "decision", "learning", "task", "error", "atom"],
          description: "The type of the memory.",
        },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        session_key: { type: "string", description: "The session key. The default is hash(cwd)." },
        metadata: { type: "object", description: "Optional metadata." },
        ...TENANT_PARAMS,
      },
      required: ["type"],
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
            agent_id: {
              type: "string",
              description: "Filter by the agent that captured the memory.",
            },
            date_from: { type: "string", description: "Filter by date. The format is ISO 8601." },
            date_to: { type: "string", description: "Filter by date. The format is ISO 8601." },
            team_id: { type: "string", description: "Filter by team ID." },
            user_id: { type: "string", description: "Filter by user ID." },
            task_id: { type: "string", description: "Filter by task ID." },
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
            team_id: { type: "string", description: "Delete captures from this team only." },
            user_id: { type: "string", description: "Delete captures from this user only." },
            task_id: { type: "string", description: "Delete captures linked to this task only." },
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
          description:
            "A summary of what has been done so far. Include the root cause if this is a bug fix.",
        },
        decisions: {
          type: "array",
          items: { type: "string" },
          description:
            "A list of decisions made during this session. Include what was chosen and why.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "A list of files that matter for this task. Use the format: path:lines - reason.",
        },
        next_steps: {
          type: "array",
          items: { type: "string" },
          description: "A list of next steps for the next agent. Order by priority.",
        },
        session_key: { type: "string", description: "The session key. The default is hash(cwd)." },
        ...TENANT_PARAMS,
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
          description:
            "The problem or situation that requires a decision. Why is this decision needed?",
        },
        decision: {
          type: "string",
          description: "The decision that was made. What was chosen?",
        },
        alternatives: {
          type: "array",
          items: { type: "string" },
          description:
            "Other options that were considered but rejected. Include why each was rejected.",
        },
        consequences: {
          type: "string",
          description:
            "The consequences of this decision. What are the trade-offs, risks, and benefits?",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for filtering. Example: ['arch', 'storage'].",
        },
        session_key: { type: "string", description: "The session key. The default is hash(cwd)." },
        ...TENANT_PARAMS,
      },
      required: ["title", "context", "decision"],
    },
  },
  // ─── Knowledge management tools ──────────────────────────────
  {
    name: "knowledge_create",
    description:
      "Register a knowledge asset (wiki or code-graph) for the team. " +
      "The asset metadata is stored locally. The actual content is processed by an external knowledge service.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: { type: "string", description: "The team ID." },
        name: { type: "string", description: "The asset name." },
        type: {
          type: "string",
          enum: ["wiki", "code-graph"],
          description: "The asset type.",
        },
        summary: { type: "string", description: "A short description." },
        service_url: {
          type: "string",
          description: "The URL of the knowledge service (for example: http://localhost:8424/v3).",
        },
        repo_url: { type: "string", description: "The repository URL (for code-graph)." },
        branch: { type: "string", description: "The repository branch (for code-graph)." },
      },
      required: ["team_id", "name", "type"],
    },
  },
  {
    name: "knowledge_get",
    description: "Get a single knowledge asset by ID.",
    inputSchema: {
      type: "object",
      properties: {
        knowledge_id: { type: "string", description: "The knowledge asset ID." },
      },
      required: ["knowledge_id"],
    },
  },
  {
    name: "knowledge_list",
    description: "List knowledge assets for a team. Optionally filter by type.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: { type: "string", description: "The team ID." },
        type: {
          type: "string",
          enum: ["wiki", "code-graph"],
          description: "Filter by type.",
        },
      },
      required: ["team_id"],
    },
  },
  {
    name: "knowledge_delete",
    description: "Delete one or more knowledge assets by ID.",
    inputSchema: {
      type: "object",
      properties: {
        knowledge_ids: {
          type: "array",
          items: { type: "string" },
          description: "The knowledge asset IDs to delete.",
        },
      },
      required: ["knowledge_ids"],
    },
  },
  // ─── Skill management tools ──────────────────────────────────
  {
    name: "skill_get",
    description: "Get a single skill by ID, including its full content and version.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "The skill ID." },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "skill_list",
    description: "List skills bound to a team. Optionally filter by agent.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: { type: "string", description: "The team ID." },
        agent_id: {
          type: "string",
          description:
            "Filter by agent ID. When set, returns agent-specific and team-global skills.",
        },
      },
      required: ["team_id"],
    },
  },
  {
    name: "skill_search",
    description: "Search skills by keyword. Returns matching skills with descriptions.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: { type: "string", description: "The team ID." },
        agent_id: { type: "string", description: "The agent ID." },
        query: { type: "string", description: "The search query." },
        topK: {
          type: "integer",
          default: 10,
          maximum: 50,
          description: "The maximum number of results.",
        },
      },
      required: ["team_id", "agent_id", "query"],
    },
  },
];

/** Create the MCP server with all tools registered. */
export function createServer(opts: ServerOptions): Server {
  const server = new Server(
    {
      name: "tdai-memory-mcp",
      version: "0.3.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
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

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (uri === "tdai-memory://recent") {
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
      case "knowledge_create":
        return handleKnowledgeCreate(args, opts);
      case "knowledge_get":
        return handleKnowledgeGet(args, opts);
      case "knowledge_list":
        return handleKnowledgeList(args, opts);
      case "knowledge_delete":
        return handleKnowledgeDelete(args, opts);
      case "skill_get":
        return handleSkillGet(args, opts);
      case "skill_list":
        return handleSkillList(args, opts);
      case "skill_search":
        return handleSkillSearch(args, opts);
      default:
        return {
          content: [{ type: "text", text: `Error: Unknown tool "${name}".` }],
          isError: true,
        };
    }
  });

  return server;
}

/** Extract multi-tenant fields from tool args. */
function extractTenant(args: Record<string, unknown>): {
  teamId?: string;
  agentId?: string;
  userId?: string;
  taskId?: string;
} {
  return {
    teamId: args.team_id as string | undefined,
    agentId: args.agent_id as string | undefined,
    userId: args.user_id as string | undefined,
    taskId: args.task_id as string | undefined,
  };
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
  const { teamId, userId, taskId } = extractTenant(args);
  const agentId = (args.agent_id as string) ?? undefined;

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
    filters: { teamId, userId, taskId, agentId },
  });

  const text = formatResults(results);
  const { text: finalText, quotaHit } = enforceQuota(text, tokenCap);

  opts.audit.log({
    tool: "recall",
    argsHash: AuditLogger.hashArgs({ query, limit, offset, mode, teamId, userId, taskId }),
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
  const type = args.type as CaptureType;
  const tags = (args.tags as string[]) ?? [];
  const sessionKey = (args.session_key as string) ?? defaultSessionKey();
  const metadata = args.metadata as Record<string, unknown> | undefined;
  const { teamId, userId, taskId } = extractTenant(args);
  const agentId = (args.agent_id as string) ?? detectAgentId();

  // Build content from either 'content' or 'messages'
  let content: string;
  let messages: CaptureMessage[] | undefined;
  const rawMessages = args.messages as CaptureMessage[] | undefined;

  if (rawMessages && rawMessages.length > 0) {
    messages = rawMessages;
    // Flatten messages into a single text for search and dedup
    content = rawMessages.map((m) => `${m.role}: ${m.content}`).join("\n");
  } else {
    content = args.content as string;
    if (!content) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Provide either 'content' or 'messages'.",
          },
        ],
        isError: true,
      };
    }
  }

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
      argsHash: AuditLogger.hashArgs({ type, tags, sessionKey, teamId, userId, taskId }),
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

  const entry: CaptureEntry = {
    id,
    sessionKey,
    agentId,
    type,
    content: redactedContent,
    tags,
    createdAt: Date.now(),
    metadata,
    teamId,
    userId,
    taskId,
    messages: messages ?? undefined,
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
        { id, content: redactedContent, type, tags, sessionKey, teamId, userId, taskId },
        { ...opts.pipelineCtx, sessionKey },
      );
    } catch (err) {
      console.error(`[tdai-memory] Pipeline failed: ${err}`);
    }
  }

  opts.audit.log({
    tool: "capture",
    argsHash: AuditLogger.hashArgs({ type, tags, sessionKey, teamId, userId, taskId }),
    resultLen: id.length,
    quotaHit: false,
    redacted: wasRedacted,
  });

  const redactionNote = wasRedacted ? " (secrets were redacted)" : "";
  const msgNote = messages ? ` (${messages.length} messages)` : "";
  return { content: [{ type: "text", text: `Captured: ${id}${redactionNote}${msgNote}` }] };
}

/** Handle the search tool. */
async function handleSearch(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const query = args.query as string;
  const mode = (args.mode as SearchMode) ?? "hybrid";
  const filters = args.filters as
    | {
        type?: CaptureType;
        tags?: string[];
        agent_id?: string;
        date_from?: string;
        date_to?: string;
        team_id?: string;
        user_id?: string;
        task_id?: string;
      }
    | undefined;
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
          teamId: filters.team_id,
          userId: filters.user_id,
          taskId: filters.task_id,
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

  let result: DeleteResult;
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
  const { teamId, userId, taskId } = extractTenant(args);
  const agentId = (args.agent_id as string) ?? detectAgentId();

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
    teamId,
    userId,
    taskId,
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
    argsHash: AuditLogger.hashArgs({ task, status, teamId, userId, taskId }),
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
  const { teamId, userId, taskId } = extractTenant(args);
  const agentId = (args.agent_id as string) ?? detectAgentId();

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
    teamId,
    userId,
    taskId,
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
    argsHash: AuditLogger.hashArgs({ title, decision, teamId, userId, taskId }),
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

// ─── Knowledge handlers ────────────────────────────────────────

async function handleKnowledgeCreate(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const teamId = args.team_id as string;
  const name = args.name as string;
  const type = args.type as string;
  const summary = args.summary as string | undefined;
  const serviceUrl = args.service_url as string | undefined;
  const repoUrl = args.repo_url as string | undefined;
  const branch = args.branch as string | undefined;

  const id = generateId();
  const entry: KnowledgeEntry = {
    id,
    teamId,
    name,
    type,
    summary,
    serviceUrl,
    repoUrl,
    branch,
    createdAt: Date.now(),
  };

  await opts.storage.putKnowledge(entry);

  opts.audit.log({
    tool: "knowledge_create",
    argsHash: AuditLogger.hashArgs({ teamId, name, type }),
    resultLen: id.length,
    quotaHit: false,
    redacted: false,
  });

  return { content: [{ type: "text", text: `Knowledge created: ${id} (${type}: ${name})` }] };
}

async function handleKnowledgeGet(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const knowledgeId = args.knowledge_id as string;
  const entry = await opts.storage.getKnowledge(knowledgeId);
  if (!entry) {
    return {
      content: [{ type: "text", text: `Error: Knowledge asset ${knowledgeId} not found.` }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
}

async function handleKnowledgeList(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const teamId = args.team_id as string;
  const type = args.type as string | undefined;
  const entries = await opts.storage.listKnowledge(teamId, type);
  if (entries.length === 0) {
    return { content: [{ type: "text", text: "No knowledge assets found." }] };
  }
  const lines = entries.map(
    (e) => `- ${e.id}  [${e.type}]  ${e.name}${e.summary ? `  — ${e.summary}` : ""}`,
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleKnowledgeDelete(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const knowledgeIds = args.knowledge_ids as string[];
  const count = await opts.storage.deleteKnowledge(knowledgeIds);
  opts.audit.log({
    tool: "knowledge_delete",
    argsHash: AuditLogger.hashArgs({ knowledgeIds }),
    resultLen: null,
    quotaHit: false,
    redacted: false,
  });
  return { content: [{ type: "text", text: `Deleted ${count} knowledge asset(s).` }] };
}

// ─── Skill handlers ────────────────────────────────────────────

async function handleSkillGet(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const skillId = args.skill_id as string;
  const entry = await opts.storage.getSkill(skillId);
  if (!entry) {
    return {
      content: [{ type: "text", text: `Error: Skill ${skillId} not found.` }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
}

async function handleSkillList(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const teamId = args.team_id as string;
  const agentId = args.agent_id as string | undefined;
  const entries = await opts.storage.listSkills(teamId, agentId);
  if (entries.length === 0) {
    return { content: [{ type: "text", text: "No skills found." }] };
  }
  const lines = entries.map(
    (e) => `- ${e.id}  v${e.version}  ${e.name}${e.description ? `  — ${e.description}` : ""}`,
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleSkillSearch(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const teamId = args.team_id as string;
  const agentId = args.agent_id as string;
  const query = args.query as string;
  const topK = (args.topK as number) ?? 10;
  const entries = await opts.storage.searchSkills(teamId, agentId, query, topK);
  if (entries.length === 0) {
    return { content: [{ type: "text", text: "No matching skills found." }] };
  }
  const lines = entries.map(
    (e) => `- ${e.id}  v${e.version}  ${e.name}${e.description ? `  — ${e.description}` : ""}`,
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
