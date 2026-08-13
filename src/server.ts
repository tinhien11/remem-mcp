import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  findCallees as cgFindCallees,
  findCallers as cgFindCallers,
  impactAnalysis as cgImpactAnalysis,
  indexDirectory as cgIndexDirectory,
  indexFile as cgIndexFile,
  listSymbols as cgListSymbols,
  searchSymbols as cgSearchSymbols,
} from "./codegraph/engine.js";
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
  SearchResult,
  StorageBackend,
  TrustState,
} from "./storage/types.js";
import { formatResults } from "./tools/format.js";
import { generateId } from "./utils/ulid.js";
import {
  getWikiPage as wikiGet,
  ingestDirectory as wikiIngestDir,
  ingestFile as wikiIngestFile,
  findOutdatedPages as wikiOutdated,
  searchWiki as wikiSearch,
} from "./wiki/engine.js";

/** Default session key: hash of the current working directory. */
function defaultSessionKey(): string {
  // TDAI_SESSION_KEY overrides the default hash(cwd) — use for single global session
  if (process.env.TDAI_SESSION_KEY) return process.env.TDAI_SESSION_KEY;
  const cwd = process.cwd();
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/** Global session key for cross-project memory (rules, learnings). */
function globalSessionKey(): string | null {
  return process.env.TDAI_GLOBAL_SESSION_KEY ?? null;
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
        verified: {
          type: "boolean",
          default: false,
          description:
            "Set this to true to mark the capture as verified. Verified captures rank higher in recall.",
        },
        supersedes: {
          type: "string",
          description:
            "The ID of a capture that this one replaces. The old capture is marked as stale and ranks lower.",
        },
        override_rejection: {
          type: "boolean",
          default: false,
          description:
            "Set this to true to force capture even if the content was previously rejected. Use this only when the rejection reason no longer applies.",
        },
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
    name: "explain_recall",
    description:
      "Explain WHY a memory was recalled for a given query. " +
      "Shows the BM25 score, vector score, RRF fused score, rank, and matching keywords for each result. " +
      "Use this to debug unexpected recall results or to understand the retrieval pipeline. " +
      "If you provide a capture_id, the tool explains why that specific capture was or was not retrieved.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The same query you used with recall or search.",
        },
        capture_id: {
          type: "string",
          description:
            "Optional. The ID of a specific capture to explain. " +
            "If set, the tool shows why this capture was or was not in the results.",
        },
        session_key: {
          type: "string",
          description: "The session key. The default is hash(cwd).",
        },
        mode: {
          type: "string",
          enum: ["hybrid", "keyword", "vector"],
          default: "hybrid",
          description: "The search mode to explain.",
        },
        limit: {
          type: "integer",
          default: 10,
          maximum: 50,
          description: "The maximum number of results to explain.",
        },
        ...TENANT_PARAMS,
      },
      required: ["query"],
    },
  },
  {
    name: "related",
    description:
      "Find memories connected to a given memory by shared tags, project, or co-occurrence. " +
      "Use this after recall or search to discover related context you might have missed. " +
      "Inspired by graph spreading-activation (Mnema pattern).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the capture to find related memories for.",
        },
        limit: {
          type: "number",
          description: "Maximum number of related memories to return (default: 10).",
        },
      },
      required: ["id"],
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
        reject: {
          type: "boolean",
          default: false,
          description:
            "Set this to true to reject the capture instead of deleting it. " +
            "The capture is marked as rejected with a reason, and the same content cannot be captured again. " +
            "Use this when the memory is wrong, not just outdated.",
        },
        reason: {
          type: "string",
          description:
            "The reason for rejection. Required when reject is true. The agent stores this with the tombstone.",
        },
      },
    },
  },
  {
    name: "resolve",
    description:
      "Resolve a conflict between two captures. Mark one as the winner and the other as stale. " +
      "Call this tool when capture reports a conflict between two memories.",
    inputSchema: {
      type: "object",
      properties: {
        winner: {
          type: "string",
          description: "The ID of the capture that is correct. This capture stays active.",
        },
        loser: {
          type: "string",
          description:
            "The ID of the capture that is wrong or outdated. This capture is marked as stale.",
        },
        reason: {
          type: "string",
          description: "The reason for the resolution. The agent stores this in the audit log.",
        },
      },
      required: ["winner", "loser"],
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
  // ─── CodeGraph tools ───
  {
    name: "codegraph_index",
    description:
      "Index a file or directory into the code graph. Extracts symbols (functions, classes, methods), " +
      "call relationships, and imports. Supports TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, C#. " +
      "Run this before using codegraph_search, codegraph_callers, codegraph_callees, or codegraph_impact.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The file or directory path to index. For directories, all supported files are indexed recursively.",
        },
        repo_path: {
          type: "string",
          description:
            "The root path of the repository. Used to compute relative file paths. Defaults to the path argument.",
        },
        team_id: { type: "string", description: "The team ID for isolation." },
        max_files: {
          type: "integer",
          default: 500,
          maximum: 5000,
          description: "Maximum number of files to index (for directory mode).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "codegraph_search",
    description:
      "Search for code symbols by name. Returns matching functions, classes, methods, etc. " +
      "with file paths and line numbers. Use this to find where a function or class is defined.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The symbol name or pattern to search for." },
        kind: {
          type: "string",
          description: "Filter by symbol kind (Function, Class, Method, Struct, etc.).",
        },
        language: {
          type: "string",
          description:
            "Filter by language (typescript, javascript, python, go, rust, java, c, cpp, csharp).",
        },
        team_id: { type: "string", description: "The team ID for isolation." },
        limit: { type: "integer", default: 20, maximum: 100 },
      },
      required: ["query"],
    },
  },
  {
    name: "codegraph_callers",
    description:
      "Find all callers of a symbol — who calls this function? " +
      "Returns the calling functions with file paths and line numbers. " +
      "Requires the symbol ID from codegraph_search.",
    inputSchema: {
      type: "object",
      properties: {
        symbol_id: { type: "string", description: "The symbol ID (from codegraph_search)." },
        limit: { type: "integer", default: 50, maximum: 200 },
      },
      required: ["symbol_id"],
    },
  },
  {
    name: "codegraph_callees",
    description:
      "Find all callees of a symbol — what does this function call? " +
      "Returns the called functions with file paths and line numbers. " +
      "Requires the symbol ID from codegraph_search.",
    inputSchema: {
      type: "object",
      properties: {
        symbol_id: { type: "string", description: "The symbol ID (from codegraph_search)." },
        limit: { type: "integer", default: 50, maximum: 200 },
      },
      required: ["symbol_id"],
    },
  },
  {
    name: "codegraph_impact",
    description:
      "Perform impact analysis: if I change this symbol, what else might be affected? " +
      "Traverses the call graph upward (callers of callers) to find all potentially impacted code. " +
      "Requires the symbol ID from codegraph_search.",
    inputSchema: {
      type: "object",
      properties: {
        symbol_id: { type: "string", description: "The symbol ID (from codegraph_search)." },
        max_depth: {
          type: "integer",
          default: 5,
          maximum: 20,
          description: "Maximum traversal depth in the call graph.",
        },
      },
      required: ["symbol_id"],
    },
  },
  {
    name: "codegraph_list",
    description:
      "List all symbols in a file or directory. Returns symbols sorted by line number. " +
      "Use this to get an overview of what a file contains.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The file path (relative to repo root) to list symbols for.",
        },
        kind: {
          type: "string",
          description: "Filter by symbol kind (Function, Class, Method, etc.).",
        },
        team_id: { type: "string", description: "The team ID for isolation." },
        limit: { type: "integer", default: 100, maximum: 500 },
      },
      required: ["file_path"],
    },
  },
  // ─── Wiki tools ───
  {
    name: "wiki_ingest",
    description:
      "Ingest markdown documentation files into the wiki. Parses frontmatter, headings, " +
      "[[wikilinks]], and [text](url) links to build a structured page graph. " +
      "Supports .md and .markdown files.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The file or directory path to ingest. For directories, all .md files are indexed recursively.",
        },
        repo_path: {
          type: "string",
          description:
            "The root path for computing relative file paths. Defaults to the path argument.",
        },
        team_id: { type: "string", description: "The team ID for isolation." },
        max_files: {
          type: "integer",
          default: 200,
          maximum: 2000,
          description: "Maximum number of files to ingest (for directory mode).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "wiki_search",
    description:
      "Search wiki pages by content. Returns matching pages with title, file path, and a snippet. " +
      "Use this to find documentation relevant to a topic.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query (FTS5 syntax supported)." },
        team_id: { type: "string", description: "The team ID for isolation." },
        limit: { type: "integer", default: 10, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "wiki_get",
    description:
      "Get a wiki page by ID, including its links and backlinks. " +
      "Use this to read a specific page and see what it links to and what links to it.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page ID (from wiki_search)." },
      },
      required: ["page_id"],
    },
  },
  {
    name: "wiki_outdated",
    description:
      "Find wiki pages whose source file has changed since the last ingest. " +
      "Returns pages that need re-ingesting because the source markdown was modified or deleted.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "The root path to check for source files." },
        team_id: { type: "string", description: "The team ID for isolation." },
      },
      required: ["repo_path"],
    },
  },
  {
    name: "update",
    description:
      "Update an existing memory entry. Use this when a capture needs corrections " +
      "(wrong info, missing tags, needs rewording). Preserves the original ID and created_at.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the capture to update.",
        },
        content: {
          type: "string",
          description: "The new content. If omitted, the original content is kept.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "The new tags. Replaces existing tags entirely.",
        },
        type: {
          type: "string",
          enum: ["conversation", "decision", "learning", "task", "error", "atom"],
          description: "The new type. If omitted, the original type is kept.",
        },
        verified: {
          type: "boolean",
          default: false,
          description: "Set to true to mark as verified.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "consolidate",
    description:
      "Find and merge duplicate or near-duplicate memories. " +
      "Use this when you suspect redundant captures (e.g. same decision captured twice). " +
      "Returns groups of similar captures. Set confirm=true to merge them.",
    inputSchema: {
      type: "object",
      properties: {
        session_key: {
          type: "string",
          description:
            "The session key to consolidate. Default is hash(cwd). Use 'all' for all projects.",
        },
        threshold: {
          type: "number",
          default: 0.75,
          description: "Similarity threshold (0-1). Higher = stricter matching. Default 0.75.",
        },
        confirm: {
          type: "boolean",
          default: false,
          description: "Set to true to merge duplicates. Without confirm, returns candidates only.",
        },
      },
    },
  },
];

/**
 * All tools available by default. Set TDAI_CORE_ONLY=1 to reduce token
 * overhead by excluding CodeGraph, Wiki, Knowledge, and Skill tools.
 */
const CORE_TOOL_NAMES = new Set([
  "recall",
  "capture",
  "search",
  "forget",
  "resolve",
  "handoff",
  "adr",
  "update",
  "consolidate",
]);

function getTools(): Tool[] {
  const coreOnly = process.env.TDAI_CORE_ONLY === "1" || process.env.TDAI_CORE_ONLY === "true";
  if (coreOnly) return TOOLS.filter((t) => CORE_TOOL_NAMES.has(t.name));
  return TOOLS;
}

/** Create the MCP server with all tools registered. */
export function createServer(opts: ServerOptions): Server {
  const server = new Server(
    {
      name: "tdai-memory-mcp",
      version: "0.5.6",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getTools() };
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
      case "related":
        return handleRelated(args, opts);
      case "explain_recall":
        return handleExplainRecall(args, opts);
      case "forget":
        return handleForget(args, opts);
      case "resolve":
        return handleResolve(args, opts);
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
      case "codegraph_index":
        return handleCodegraphIndex(args, opts);
      case "codegraph_search":
        return handleCodegraphSearch(args, opts);
      case "codegraph_callers":
        return handleCodegraphCallers(args, opts);
      case "codegraph_callees":
        return handleCodegraphCallees(args, opts);
      case "codegraph_impact":
        return handleCodegraphImpact(args, opts);
      case "codegraph_list":
        return handleCodegraphList(args, opts);
      case "wiki_ingest":
        return handleWikiIngest(args, opts);
      case "wiki_search":
        return handleWikiSearch(args, opts);
      case "wiki_get":
        return handleWikiGet(args, opts);
      case "wiki_outdated":
        return handleWikiOutdated(args, opts);
      case "update":
        return handleUpdate(args, opts);
      case "consolidate":
        return handleConsolidate(args, opts);
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
  const sessionKey = (args.session_key as string) ?? defaultSessionKey();
  const limit = Math.min((args.limit as number) ?? 10, 50);
  const offset = (args.offset as number) ?? 0;
  const tokenCap = Math.min((args.max_tokens as number) ?? opts.maxTokensRecall, 8000);
  const mode = (args.mode as SearchMode) ?? "hybrid";
  const { teamId, userId, taskId } = extractTenant(args);
  const agentId = (args.agent_id as string) ?? undefined;

  let queryEmbedding: number[] | null = null;
  let vectorDegraded = false;
  if (mode === "hybrid" || mode === "vector") {
    try {
      queryEmbedding = await opts.embedder.embed(query);
    } catch (err) {
      console.error(`[tdai-memory] Embedding failed: ${err}`);
      vectorDegraded = true;
    }
  }

  // If TDAI_GLOBAL_SESSION_KEY is set and session_key wasn't explicitly provided,
  // search both global and project session keys, global first.
  const globalKey = globalSessionKey();
  const useGlobalFallback = globalKey && !args.session_key && globalKey !== sessionKey;

  let results: SearchResult[];
  if (useGlobalFallback) {
    // Search global memory first (rules, learnings, cross-project decisions)
    const globalResults = await opts.storage.search(query, queryEmbedding, {
      sessionKey: globalKey,
      limit: Math.ceil(limit / 2),
      offset: 0,
      mode,
      filters: { teamId, userId, taskId, agentId },
    });
    // Then search project memory
    const projectResults = await opts.storage.search(query, queryEmbedding, {
      sessionKey,
      limit: limit - globalResults.length,
      offset: 0,
      mode,
      filters: { teamId, userId, taskId, agentId },
    });
    // Merge: global first, then project (dedup by id)
    const seen = new Set(globalResults.map((r) => r.id));
    results = [...globalResults, ...projectResults.filter((r) => !seen.has(r.id))];
  } else {
    results = await opts.storage.search(query, queryEmbedding, {
      sessionKey,
      limit,
      offset,
      mode,
      filters: { teamId, userId, taskId, agentId },
    });
  }

  let text = formatResults(results);

  // Augment with CodeGraph symbols if available
  try {
    const db = getDb(opts);
    const symbols = cgSearchSymbols(db, query, { teamId, limit: 5 });
    if (symbols.length > 0) {
      const symLines = symbols.map(
        (s) => `  ${s.kind} ${s.name}  at  ${s.filePath}:${s.lineStart}`,
      );
      text += `\n\n## Code symbols\n${symLines.join("\n")}`;
    }
  } catch {
    // CodeGraph not available (non-SQLite backend)
  }

  // Augment with Wiki pages if available
  try {
    const db = getDb(opts);
    const wikiResults = wikiSearch(db, query, { teamId, limit: 3 });
    if (wikiResults.length > 0) {
      const wikiLines = wikiResults.map(
        (w) => `  ${w.title}  (${w.sourceFile})  ${w.snippet.slice(0, 80)}`,
      );
      text += `\n\n## Wiki pages\n${wikiLines.join("\n")}`;
    }
  } catch {
    // Wiki not available (non-SQLite backend)
  }

  if (vectorDegraded) {
    text = `[note: vector search unavailable, results are keyword-only]\n${text}`;
  }
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
  const verified = (args.verified as boolean) ?? false;
  const supersedes = args.supersedes as string | undefined;
  const overrideRejection = (args.override_rejection as boolean) ?? false;

  // Build content from either 'content' or 'messages'
  let content: string;
  let messages: CaptureMessage[] | undefined;
  const rawMessages = args.messages as CaptureMessage[] | undefined;

  if (rawMessages && rawMessages.length > 0) {
    messages = rawMessages;
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

  const contentHash = createHash("sha256").update(redactedContent).digest("hex");

  // Rejected-value tombstone: check if this content was previously rejected.
  if (!overrideRejection) {
    const rejected = await opts.storage.findRejectedByContentHash(contentHash, sessionKey);
    if (rejected.length > 0) {
      const reason = rejected[0].rejectionReason ?? "no reason given";
      opts.audit.log({
        tool: "capture",
        argsHash: AuditLogger.hashArgs({ type, tags, sessionKey, teamId, userId, taskId }),
        resultLen: 0,
        quotaHit: false,
        redacted: wasRedacted,
      });
      return {
        content: [
          {
            type: "text",
            text: `Blocked: This content was previously rejected (${rejected[0].id}). Reason: ${reason}. Set override_rejection to true to force capture.`,
          },
        ],
        isError: true,
      };
    }
  }

  // Dedup: check if content with the same hash already exists in this session.
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
  const trustState: TrustState = verified ? "verified" : "candidate";

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
    trustState,
  };

  try {
    await opts.storage.put(entry);
  } catch {
    return {
      content: [
        {
          type: "text",
          text: `Error: Database is read-only (sandbox restriction). Capture failed. Set sandbox_mode to "danger-full-access" or add the DB directory to writable roots.`,
        },
      ],
      isError: true,
    };
  }

  // If supersedes is set, mark the old capture as stale.
  if (supersedes) {
    await opts.storage.supersede(supersedes, id);
  }

  let embedding: number[] | null = null;
  try {
    embedding = await opts.embedder.embed(redactedContent);
    await opts.storage.putVector(id, embedding);
  } catch (err) {
    console.error(`[tdai-memory] Embedding failed: ${err}`);
  }

  // Conflict detection: find similar captures in the same session.
  let conflictInfo = "";
  if (embedding) {
    try {
      const conflicts = await opts.storage.findConflicts(embedding, sessionKey, 0.3);
      const filtered = conflicts.filter((c) => c.id !== id);
      if (filtered.length > 0) {
        const conflictList = filtered
          .map(
            (c) =>
              `  - ${c.id} (similarity: ${(1 - c.distance).toFixed(2)}, state: ${c.trustState}): ${c.content.slice(0, 120)}`,
          )
          .join("\n");
        conflictInfo = `\nConflicts detected:\n${conflictList}\nCall resolve to mark one as superseding the other.`;
      }
    } catch (err) {
      console.error(`[tdai-memory] Conflict detection failed: ${err}`);
    }
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
  const trustNote = trustState === "verified" ? " [verified]" : "";
  const supersedesNote = supersedes ? ` (supersedes ${supersedes})` : "";
  return {
    content: [
      {
        type: "text",
        text: `Captured: ${id}${redactionNote}${msgNote}${trustNote}${supersedesNote}${conflictInfo}`,
      },
    ],
  };
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
  let vectorDegraded = false;
  if (mode === "hybrid" || mode === "vector") {
    try {
      queryEmbedding = await opts.embedder.embed(query);
    } catch (err) {
      console.error(`[tdai-memory] Embedding failed: ${err}`);
      vectorDegraded = true;
    }
  }

  const results = await opts.storage.search(query, queryEmbedding, {
    sessionKey: (args.session_key as string) ?? defaultSessionKey(),
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

  let text = formatResults(results);
  if (vectorDegraded) {
    text = `[note: vector search unavailable, results are keyword-only]\n${text}`;
  }
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

/**
 * Handle the related tool.
 * Finds memories connected to a given capture by shared tags, project (session_key),
 * or type. Inspired by Mnema's graph spreading-activation.
 *
 * Scoring: +3 for each shared tag, +2 for same session_key, +1 for same type.
 * Excludes the source capture itself.
 */
async function handleRelated(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const id = args.id as string;
  const limit = Math.min((args.limit as number) ?? 10, 50);

  // Get the source capture
  const source = await opts.storage.get(id);
  if (!source) {
    return {
      content: [{ type: "text", text: `Capture ${id} not found.` }],
      isError: true,
    };
  }

  const sourceTags = source.tags ? JSON.parse(source.tags) : [];
  const sourceSessionKey = source.sessionKey;
  const sourceType = source.type;

  // Get all captures (limited to a reasonable window) and score by relatedness
  // We use recent captures as the candidate pool — this is efficient and
  // covers the common case where related memories are recent.
  const recentResults = await opts.storage.search(source.content.slice(0, 200), null, {
    sessionKey: defaultSessionKey(),
    limit: 100,
    offset: 0,
    mode: "keyword",
  });

  const scored: Array<{ entry: any; score: number; reasons: string[] }> = [];
  for (const r of recentResults) {
    if (r.entry.id === id) continue; // skip source

    const entry = r.entry;
    let score = 0;
    const reasons: string[] = [];

    // Shared tags
    const entryTags = entry.tags ? JSON.parse(entry.tags) : [];
    const sharedTags = sourceTags.filter((t: string) => entryTags.includes(t));
    if (sharedTags.length > 0) {
      score += sharedTags.length * 3;
      reasons.push(`tags: ${sharedTags.join(", ")}`);
    }

    // Same project (session_key)
    if (sourceSessionKey && entry.sessionKey === sourceSessionKey) {
      score += 2;
      reasons.push("same project");
    }

    // Same type
    if (sourceType && entry.type === sourceType) {
      score += 1;
      reasons.push(`same type: ${entry.type}`);
    }

    // Keyword overlap bonus (from the search results)
    if (r.score > 0) {
      score += Math.min(r.score, 5);
      reasons.push("content overlap");
    }

    if (score > 0) {
      scored.push({ entry, score, reasons });
    }
  }

  // Sort by score, take top N
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  if (top.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No related memories found for capture ${id}.\n\nSource: ${source.content.slice(0, 100)}...`,
        },
      ],
    };
  }

  // Format output
  const lines: string[] = [
    `Related memories for capture ${id}:`,
    `Source: [${source.type}] ${source.content.slice(0, 100)}...`,
    "",
  ];

  for (const { entry, score, reasons } of top) {
    const date = new Date(entry.createdAt).toISOString().split("T")[0];
    const preview = entry.content.slice(0, 120).replace(/\n/g, " ");
    lines.push(`- [${entry.type}] ${date} (score=${score}, ${reasons.join("; ")})`);
    lines.push(`  ${preview}...`);
    if (entry.tags) {
      try {
        const tags = JSON.parse(entry.tags);
        if (Array.isArray(tags) && tags.length > 0) {
          lines.push(`  tags: ${tags.join(", ")}`);
        }
      } catch {
        // skip
      }
    }
    lines.push(`  id: ${entry.id}`);
    lines.push("");
  }

  lines.push(`Found ${top.length} related memor${top.length === 1 ? "y" : "ies"}.`);

  opts.audit.log({
    tool: "related",
    argsHash: AuditLogger.hashArgs({ id, limit }),
    resultLen: lines.join("\n").length,
    quotaHit: false,
    redacted: false,
  });

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/**
 * Handle the explain_recall tool.
 * Shows WHY each result was recalled: BM25 score, vector score, RRF fused score,
 * rank, and matching keywords. If capture_id is provided, explains why that
 * specific capture was or was not retrieved.
 */
async function handleExplainRecall(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const query = args.query as string;
  const captureId = args.capture_id as string | undefined;
  const sessionKey = (args.session_key as string) ?? defaultSessionKey();
  const mode = (args.mode as SearchMode) ?? "hybrid";
  const limit = Math.min((args.limit as number) ?? 10, 50);
  const { teamId, userId, taskId } = extractTenant(args);

  // Run keyword and vector searches separately to get individual scores
  let queryEmbedding: number[] | null = null;
  let vectorDegraded = false;
  if (mode === "hybrid" || mode === "vector") {
    try {
      queryEmbedding = await opts.embedder.embed(query);
    } catch (err) {
      console.error(`[tdai-memory] Embedding failed: ${err}`);
      vectorDegraded = true;
    }
  }

  // Get keyword-only results
  const keywordResults: SearchResult[] =
    mode === "vector"
      ? []
      : await opts.storage.search(query, null, {
          sessionKey,
          limit: limit * 3,
          offset: 0,
          mode: "keyword",
          filters: { teamId, userId, taskId },
        });

  // Get vector-only results
  const vectorResults: SearchResult[] =
    mode === "keyword" || !queryEmbedding
      ? []
      : await opts.storage.search(query, queryEmbedding, {
          sessionKey,
          limit: limit * 3,
          offset: 0,
          mode: "vector",
          filters: { teamId, userId, taskId },
        });

  // Get hybrid results (what recall actually returns)
  const hybridResults: SearchResult[] = await opts.storage.search(query, queryEmbedding, {
    sessionKey,
    limit,
    offset: 0,
    mode,
    filters: { teamId, userId, taskId },
  });

  // Build score lookup maps
  const keywordScores = new Map<string, number>();
  for (const r of keywordResults) keywordScores.set(r.entry.id, r.score);

  const vectorScores = new Map<string, number>();
  for (const r of vectorResults) vectorScores.set(r.entry.id, r.score);

  // Extract query keywords (simple tokenization)
  const queryTokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);

  // Build explanation
  const lines: string[] = [
    `## explain_recall: "${query}"`,
    `Mode: ${mode}${vectorDegraded ? " (vector degraded — keyword only)" : ""}`,
    `Session: ${sessionKey}`,
    `Query tokens: ${queryTokens.join(", ") || "(none)"}`,
    "",
    `### Top ${hybridResults.length} results (ranked by ${mode} score):`,
    "",
  ];

  for (let i = 0; i < hybridResults.length; i++) {
    const { entry, score } = hybridResults[i];
    const bm25Score = keywordScores.get(entry.id);
    const vecScore = vectorScores.get(entry.id);
    const date = new Date(entry.createdAt).toISOString().split("T")[0];

    lines.push(`[${i + 1}] id: ${entry.id}`);
    lines.push(`    type: ${entry.type}  date: ${date}  tags: [${entry.tags.join(", ")}]`);
    lines.push(`    fused_score: ${score.toFixed(4)}`);
    if (mode === "hybrid") {
      lines.push(
        `    bm25_score: ${bm25Score !== undefined ? bm25Score.toFixed(4) : "not in top-k (0)"}`,
      );
      lines.push(
        `    vector_score: ${vecScore !== undefined ? vecScore.toFixed(4) : "not in top-k (0)"}`,
      );
    } else if (mode === "keyword") {
      lines.push(`    bm25_score: ${score.toFixed(4)}`);
    } else {
      lines.push(`    vector_score: ${score.toFixed(4)}`);
    }

    // Show which query tokens appear in the content
    const contentLower = entry.content.toLowerCase();
    const matchedTokens = queryTokens.filter((t) => contentLower.includes(t));
    const missedTokens = queryTokens.filter((t) => !contentLower.includes(t));
    if (matchedTokens.length > 0) {
      lines.push(`    matched_keywords: ${matchedTokens.join(", ")}`);
    }
    if (missedTokens.length > 0) {
      lines.push(`    missed_keywords: ${missedTokens.join(", ")}`);
    }

    // Show trust state if not candidate
    if (entry.trustState && entry.trustState !== "candidate") {
      lines.push(`    trust_state: ${entry.trustState}`);
    }

    // Show content preview (first 120 chars)
    const preview = entry.content.slice(0, 120).replace(/\n/g, " ");
    lines.push(`    content_preview: ${preview}${entry.content.length > 120 ? "..." : ""}`);
    lines.push("");
  }

  // If capture_id was provided, explain why that specific capture was or wasn't retrieved
  if (captureId) {
    lines.push(`### Explanation for capture: ${captureId}`);
    lines.push("");

    const inResults = hybridResults.find((r) => r.entry.id === captureId);
    if (inResults) {
      const rank = hybridResults.findIndex((r) => r.entry.id === captureId) + 1;
      lines.push(`✓ This capture WAS retrieved at rank ${rank}/${hybridResults.length}.`);
      lines.push(`  fused_score: ${inResults.score.toFixed(4)}`);
      const bm25 = keywordScores.get(captureId);
      const vec = vectorScores.get(captureId);
      if (bm25 !== undefined) lines.push(`  bm25_score: ${bm25.toFixed(4)}`);
      if (vec !== undefined) lines.push(`  vector_score: ${vec.toFixed(4)}`);
    } else {
      lines.push(`✗ This capture was NOT in the top ${limit} results.`);

      // Check if it exists at all
      const entry = await opts.storage.get(captureId);
      if (!entry) {
        lines.push(`  Reason: capture not found in the database.`);
      } else {
        lines.push(`  The capture exists in the database but was not retrieved.`);
        lines.push(`  type: ${entry.type}  session: ${entry.sessionKey}`);
        const bm25 = keywordScores.get(captureId);
        const vec = vectorScores.get(captureId);
        if (bm25 === undefined && vec === undefined) {
          lines.push(
            `  Reason: low relevance — neither BM25 nor vector search ranked it in top ${limit * 3}.`,
          );
        } else {
          if (bm25 !== undefined) lines.push(`  bm25_score: ${bm25.toFixed(4)} (below threshold)`);
          if (vec !== undefined) lines.push(`  vector_score: ${vec.toFixed(4)} (below threshold)`);
        }

        // Check session mismatch
        if (entry.sessionKey !== sessionKey) {
          lines.push(
            `  Possible reason: session mismatch — capture is in session ${entry.sessionKey}, query was for session ${sessionKey}.`,
          );
        }

        // Check trust state
        if (entry.trustState === "rejected") {
          lines.push(`  Possible reason: capture is rejected (trust_state=rejected).`);
        }
        if (entry.trustState === "stale") {
          lines.push(`  Possible reason: capture is stale (trust_state=stale).`);
        }
      }
    }
    lines.push("");
  }

  // Summary stats
  lines.push("### Summary");
  lines.push(`keyword_results: ${keywordResults.length}`);
  lines.push(`vector_results: ${vectorResults.length}`);
  lines.push(`hybrid_results: ${hybridResults.length}`);
  if (vectorDegraded) {
    lines.push(`note: vector search was unavailable — results are keyword-only.`);
  }

  const text = lines.join("\n");

  opts.audit.log({
    tool: "explain_recall",
    argsHash: AuditLogger.hashArgs({ query, capture_id: captureId, mode, limit }),
    resultLen: text.length,
    quotaHit: false,
    redacted: false,
  });

  return { content: [{ type: "text", text }] };
}

/** Handle the forget tool. */
async function handleForget(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const id = args.id as string | undefined;
  const filter = args.filter as DeleteFilter | undefined;
  const confirm = (args.confirm as boolean) ?? false;
  const reject = (args.reject as boolean) ?? false;
  const reason = args.reason as string | undefined;

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

  if (reject && !reason) {
    return {
      content: [
        {
          type: "text",
          text: "Error: When reject is true, provide a reason. The tool did not delete anything.",
        },
      ],
      isError: true,
    };
  }

  if (reject && !id) {
    return {
      content: [
        {
          type: "text",
          text: "Error: When reject is true, provide an id. Reject mode does not support filters.",
        },
      ],
      isError: true,
    };
  }

  let result: DeleteResult;
  if (reject && id) {
    result = await opts.storage.reject(id, reason ?? "");
  } else if (id) {
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
    argsHash: AuditLogger.hashArgs({ id, filter, reject, reason }),
    resultLen: null,
    quotaHit: false,
    redacted: false,
    mutation: { id, filter, captures: result.captures, reject, reason },
  });

  const action = reject ? "Rejected" : "Deleted";
  return {
    content: [
      {
        type: "text",
        text: `${action}: ${result.captures} captures, ${result.atoms} atoms, ${result.scenarios} scenarios`,
      },
    ],
  };
}

/** Handle the update tool. */
async function handleUpdate(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const id = args.id as string;
  if (!id) {
    return { content: [{ type: "text", text: "Error: id is required." }], isError: true };
  }

  const db = getDb(opts);
  const row = db.prepare("SELECT * FROM captures WHERE id = ? AND deleted_at IS NULL").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return { content: [{ type: "text", text: `Error: Capture ${id} not found.` }], isError: true };
  }

  const newContent = (args.content as string) ?? (row.content as string);
  const newTags = args.tags ? JSON.stringify(args.tags) : (row.tags as string);
  const newType = (args.type as string) ?? (row.type as string);
  const newTrust = args.verified ? "verified" : (row.trust_state as string);

  // Update content hash
  const contentHash = createHash("sha256").update(newContent).digest("hex");

  db.prepare(
    "UPDATE captures SET content = ?, tags = ?, type = ?, trust_state = ?, content_hash = ? WHERE id = ?",
  ).run(newContent, newTags, newType, newTrust, contentHash, id);

  // Update FTS index
  const rowid =
    (row.rowid as number) ?? db.prepare("SELECT rowid FROM captures WHERE id = ?").get(id)?.rowid;
  if (rowid) {
    db.prepare(
      "INSERT INTO captures_fts(captures_fts, rowid, content, tags, type) VALUES('delete', ?, '', '', '')",
    ).run(rowid);
    db.prepare(
      "INSERT INTO captures_fts (rowid, id, content, tags, type) VALUES (?, ?, ?, ?, ?)",
    ).run(rowid, id, newContent, newTags, newType);
  }

  return {
    content: [{ type: "text", text: `Updated: ${id}\nType: ${newType}\nTrust: ${newTrust}` }],
  };
}

/** Handle the consolidate tool. */
async function handleConsolidate(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const threshold = (args.threshold as number) ?? 0.75;
  const confirm = (args.confirm as boolean) ?? false;
  const sessionKey = (args.session_key as string) ?? defaultSessionKey();
  const db = getDb(opts);

  // Get all non-deleted captures for the session (or all if session_key === "all")
  let sql = "SELECT id, content, type, tags, created_at FROM captures WHERE deleted_at IS NULL";
  const params: unknown[] = [];
  if (sessionKey !== "all") {
    sql += " AND session_key = ?";
    params.push(sessionKey);
  }
  sql += " ORDER BY created_at DESC";
  const rows = db.prepare(sql).all(...params) as {
    id: string;
    content: string;
    type: string;
    tags: string;
    created_at: number;
  }[];

  if (rows.length < 2) {
    return {
      content: [{ type: "text", text: "Not enough captures to consolidate (need at least 2)." }],
    };
  }

  // Find duplicates by comparing content similarity (Jaccard on word sets)
  const groups: { ids: string[]; similarity: number; preview: string }[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    if (seen.has(rows[i].id)) continue;
    const words1 = new Set(rows[i].content.toLowerCase().split(/\s+/));
    const group = [rows[i].id];

    for (let j = i + 1; j < rows.length; j++) {
      if (seen.has(rows[j].id)) continue;
      const words2 = new Set(rows[j].content.toLowerCase().split(/\s+/));
      const intersection = [...words1].filter((w) => words2.has(w)).length;
      const union = new Set([...words1, ...words2]).size;
      const sim = union > 0 ? intersection / union : 0;
      if (sim >= threshold) {
        group.push(rows[j].id);
        seen.add(rows[j].id);
      }
    }

    if (group.length > 1) {
      seen.add(rows[i].id);
      groups.push({
        ids: group,
        similarity: threshold,
        preview: rows[i].content.slice(0, 80).replace(/\n/g, " "),
      });
    }
  }

  if (groups.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No duplicates found (threshold: ${threshold}). ${rows.length} captures checked.`,
        },
      ],
    };
  }

  if (!confirm) {
    const lines: string[] = [
      `Found ${groups.length} duplicate group(s) (threshold: ${threshold}):`,
    ];
    for (const g of groups) {
      lines.push(`\n  Group (${g.ids.length} captures): ${g.preview}...`);
      for (const id of g.ids) {
        lines.push(`    - ${id}`);
      }
    }
    lines.push("\nSet confirm=true to merge (keeps oldest, deletes rest).");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Merge: keep the oldest capture, soft-delete the rest
  let merged = 0;
  for (const g of groups) {
    // Sort by created_at ascending (oldest first)
    const groupRows = g.ids
      .map((id) => rows.find((r) => r.id === id))
      .filter(Boolean)
      .sort((a, b) => a!.created_at - b!.created_at);
    const keeper = groupRows[0]!;
    const dups = groupRows.slice(1);
    for (const dup of dups) {
      db.prepare("UPDATE captures SET deleted_at = ? WHERE id = ?").run(Date.now(), dup.id);
      db.prepare("DELETE FROM captures_vec WHERE id = ?").run(dup.id);
      merged++;
    }
    // Log the merge
    void keeper;
  }

  return {
    content: [
      {
        type: "text",
        text: `Consolidated ${groups.length} group(s), merged ${merged} duplicate(s). Kept oldest capture in each group.`,
      },
    ],
  };
}

/** Handle the resolve tool. */
async function handleResolve(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const winner = args.winner as string;
  const loser = args.loser as string;
  const reason = args.reason as string | undefined;

  if (!winner || !loser) {
    return {
      content: [
        {
          type: "text",
          text: "Error: Provide both winner and loser IDs.",
        },
      ],
      isError: true,
    };
  }

  if (winner === loser) {
    return {
      content: [
        {
          type: "text",
          text: "Error: The winner and loser cannot be the same capture.",
        },
      ],
      isError: true,
    };
  }

  const result = await opts.storage.supersede(loser, winner);

  if (result.updated === 0) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Capture ${loser} was not found or is already rejected.`,
        },
      ],
      isError: true,
    };
  }

  opts.audit.log({
    tool: "resolve",
    argsHash: AuditLogger.hashArgs({ winner, loser, reason }),
    resultLen: null,
    quotaHit: false,
    redacted: false,
    mutation: { winner, loser, reason },
  });

  return {
    content: [
      {
        type: "text",
        text: `Resolved: ${loser} is now stale (superseded by ${winner}).${reason ? ` Reason: ${reason}` : ""}`,
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

  // Add code symbols for the touched files if CodeGraph is available
  try {
    const db = getDb(opts);
    const allSyms: string[] = [];
    for (const f of files.slice(0, 10)) {
      const syms = cgListSymbols(db, f, { teamId, limit: 5 });
      for (const s of syms) {
        allSyms.push(`- ${f}:${s.lineStart}  ${s.kind} ${s.name}`);
      }
    }
    if (allSyms.length > 0) {
      lines.push("## Code symbols");
      lines.push(...allSyms.slice(0, 20));
      lines.push("");
    }
  } catch {
    // CodeGraph not available
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
  const alternativesRaw = args.alternatives as string[] | string | undefined;
  const alternatives = Array.isArray(alternativesRaw)
    ? alternativesRaw
    : typeof alternativesRaw === "string" && alternativesRaw
      ? [alternativesRaw]
      : [];
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

// ─── CodeGraph handlers ───

/** Get the raw database from storage (SQLiteBackend only). */
function getDb(opts: ServerOptions): import("better-sqlite3").Database {
  const storage = opts.storage as unknown as {
    getDatabase?: () => import("better-sqlite3").Database;
  };
  if (!storage.getDatabase) {
    throw new Error("CodeGraph requires SQLite storage backend.");
  }
  return storage.getDatabase();
}

async function handleCodegraphIndex(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const path = args.path as string;
  const repoPath = (args.repo_path as string) ?? path;
  const teamId = (args.team_id as string) ?? null;
  const maxFiles = (args.max_files as number) ?? 500;

  if (!path) {
    return { content: [{ type: "text", text: "Error: path is required." }], isError: true };
  }

  const db = getDb(opts);
  const { statSync } = await import("node:fs");
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return { content: [{ type: "text", text: `Error: path not found: ${path}` }], isError: true };
  }

  let results: import("./codegraph/engine.js").IndexResult[];
  if (stat.isDirectory()) {
    results = await cgIndexDirectory(db, path, repoPath, teamId, maxFiles);
  } else {
    const result = await cgIndexFile(db, path, repoPath, teamId);
    results = [result];
  }

  const indexed = results.filter((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const totalSymbols = indexed.reduce((s, r) => s + r.symbols, 0);
  const totalCalls = indexed.reduce((s, r) => s + r.calls, 0);
  const totalImports = indexed.reduce((s, r) => s + r.imports, 0);

  const lines = [
    `Indexed ${indexed.length} file(s) (${skipped.length} skipped).`,
    `Symbols: ${totalSymbols}  Calls: ${totalCalls}  Imports: ${totalImports}`,
    "",
    ...indexed
      .slice(0, 20)
      .map(
        (r) =>
          `  ${r.language.padEnd(12)} ${r.symbols.toString().padStart(3)} sym  ${r.calls.toString().padStart(4)} calls  ${r.file}`,
      ),
  ];
  if (indexed.length > 20) {
    lines.push(`  ... and ${indexed.length - 20} more files.`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function handleCodegraphSearch(
  args: Record<string, unknown>,
  opts: ServerOptions,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const query = args.query as string;
  const kind = args.kind as string | undefined;
  const language = args.language as string | undefined;
  const teamId = (args.team_id as string) ?? undefined;
  const limit = (args.limit as number) ?? 20;

  if (!query) {
    return { content: [{ type: "text", text: "Error: query is required." }], isError: true };
  }

  const db = getDb(opts);
  const symbols = cgSearchSymbols(db, query, { teamId, kind, language, limit });

  if (symbols.length === 0) {
    return { content: [{ type: "text", text: "No symbols found." }] };
  }

  const lines = symbols.map(
    (s) => `${s.id}  ${s.kind.padEnd(10)}  ${s.name}  at  ${s.filePath}:${s.lineStart}`,
  );
  return {
    content: [{ type: "text", text: `Found ${symbols.length} symbol(s):\n${lines.join("\n")}` }],
  };
}

function handleCodegraphCallers(
  args: Record<string, unknown>,
  opts: ServerOptions,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const symbolId = args.symbol_id as string;
  const limit = (args.limit as number) ?? 50;

  if (!symbolId) {
    return { content: [{ type: "text", text: "Error: symbol_id is required." }], isError: true };
  }

  const db = getDb(opts);
  const callers = cgFindCallers(db, symbolId, { limit });

  if (callers.length === 0) {
    return { content: [{ type: "text", text: "No callers found." }] };
  }

  const lines = callers.map(
    (c) =>
      `${c.caller.id}  ${c.caller.kind.padEnd(10)}  ${c.caller.name}  calls at  ${c.caller.filePath}:${c.line}`,
  );
  return {
    content: [{ type: "text", text: `Found ${callers.length} caller(s):\n${lines.join("\n")}` }],
  };
}

function handleCodegraphCallees(
  args: Record<string, unknown>,
  opts: ServerOptions,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const symbolId = args.symbol_id as string;
  const limit = (args.limit as number) ?? 50;

  if (!symbolId) {
    return { content: [{ type: "text", text: "Error: symbol_id is required." }], isError: true };
  }

  const db = getDb(opts);
  const callees = cgFindCallees(db, symbolId, { limit });

  if (callees.length === 0) {
    return { content: [{ type: "text", text: "No callees found." }] };
  }

  const lines = callees.map(
    (c) =>
      `${c.calleeName}${c.callee ? `  ->  ${c.callee.kind} ${c.callee.name}  at  ${c.callee.filePath}:${c.callee.lineStart}` : "  (unresolved)"}`,
  );
  return {
    content: [{ type: "text", text: `Found ${callees.length} callee(s):\n${lines.join("\n")}` }],
  };
}

function handleCodegraphImpact(
  args: Record<string, unknown>,
  opts: ServerOptions,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const symbolId = args.symbol_id as string;
  const maxDepth = (args.max_depth as number) ?? 5;

  if (!symbolId) {
    return { content: [{ type: "text", text: "Error: symbol_id is required." }], isError: true };
  }

  const db = getDb(opts);
  let impact: import("./codegraph/engine.js").ImpactResult;
  try {
    impact = cgImpactAnalysis(db, symbolId, { maxDepth });
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  }

  const lines = [
    `Root: ${impact.rootSymbol.kind} ${impact.rootSymbol.name}  at  ${impact.rootSymbol.filePath}:${impact.rootSymbol.lineStart}`,
    `Affected: ${impact.affected.length} symbol(s)`,
    "",
    ...impact.affected.map(
      (a) =>
        `${"  ".repeat(a.depth)}-> ${a.symbol.kind} ${a.symbol.name}  at  ${a.symbol.filePath}:${a.symbol.lineStart}  (depth ${a.depth})`,
    ),
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function handleCodegraphList(
  args: Record<string, unknown>,
  opts: ServerOptions,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const filePath = args.file_path as string;
  const kind = args.kind as string | undefined;
  const teamId = (args.team_id as string) ?? undefined;
  const limit = (args.limit as number) ?? 100;

  if (!filePath) {
    return { content: [{ type: "text", text: "Error: file_path is required." }], isError: true };
  }

  const db = getDb(opts);
  const symbols = cgListSymbols(db, filePath, { teamId, kind, limit });

  if (symbols.length === 0) {
    return { content: [{ type: "text", text: "No symbols found." }] };
  }

  const lines = symbols.map(
    (s) => `${s.id}  ${s.kind.padEnd(10)}  L${s.lineStart}-${s.lineEnd}  ${s.name}`,
  );
  return {
    content: [
      {
        type: "text",
        text: `Found ${symbols.length} symbol(s) in ${filePath}:\n${lines.join("\n")}`,
      },
    ],
  };
}

// ─── Wiki handlers ───

async function handleWikiIngest(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const path = args.path as string;
  const repoPath = (args.repo_path as string) ?? path;
  const teamId = (args.team_id as string) ?? null;
  const maxFiles = (args.max_files as number) ?? 200;

  if (!path) {
    return { content: [{ type: "text", text: "Error: path is required." }], isError: true };
  }

  const db = getDb(opts);
  const { statSync } = await import("node:fs");
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return { content: [{ type: "text", text: `Error: path not found: ${path}` }], isError: true };
  }

  let results: import("./wiki/engine.js").WikiIngestResult[];
  if (stat.isDirectory()) {
    results = wikiIngestDir(db, path, repoPath, teamId, maxFiles);
  } else {
    const result = wikiIngestFile(db, path, repoPath, teamId);
    results = [result];
  }

  const ingested = results.filter((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const totalPages = ingested.reduce((s, r) => s + r.pages, 0);
  const totalLinks = ingested.reduce((s, r) => s + r.links, 0);

  const lines = [
    `Ingested ${totalPages} page(s) from ${ingested.length} file(s) (${skipped.length} skipped).`,
    `Links: ${totalLinks}`,
    "",
    ...ingested.slice(0, 20).map((r) => `  ${r.pages} page  ${r.links} links  ${r.file}`),
  ];
  if (ingested.length > 20) {
    lines.push(`  ... and ${ingested.length - 20} more files.`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function handleWikiSearch(
  args: Record<string, unknown>,
  opts: ServerOptions,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const query = args.query as string;
  const teamId = (args.team_id as string) ?? undefined;
  const limit = (args.limit as number) ?? 10;

  if (!query) {
    return { content: [{ type: "text", text: "Error: query is required." }], isError: true };
  }

  const db = getDb(opts);
  const results = wikiSearch(db, query, { teamId, limit });

  if (results.length === 0) {
    return { content: [{ type: "text", text: "No pages found." }] };
  }

  const lines = results.map((r) => `${r.id}  ${r.title}  (${r.sourceFile})\n    ${r.snippet}`);
  return {
    content: [{ type: "text", text: `Found ${results.length} page(s):\n${lines.join("\n")}` }],
  };
}

function handleWikiGet(
  args: Record<string, unknown>,
  opts: ServerOptions,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const pageId = args.page_id as string;

  if (!pageId) {
    return { content: [{ type: "text", text: "Error: page_id is required." }], isError: true };
  }

  const db = getDb(opts);
  const result = wikiGet(db, pageId);

  if (!result) {
    return { content: [{ type: "text", text: "Page not found." }], isError: true };
  }

  const { page, links, backlinks } = result;
  const lines = [
    `Title: ${page.title}`,
    `Source: ${page.sourceFile}`,
    `Tags: ${page.tags ?? "(none)"}`,
    "",
    page.content.slice(0, 500) + (page.content.length > 500 ? "..." : ""),
    "",
    `Links (${links.length}):`,
    ...links.map(
      (l) =>
        `  -> ${l.toTitle}${l.toPageId ? " (resolved)" : " (unresolved)"}  [${l.linkType}]  L${l.line}`,
    ),
    "",
    `Backlinks (${backlinks.length}):`,
    ...backlinks.map((l) => `  <- ${l.toTitle}  [${l.linkType}]  L${l.line}`),
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleWikiOutdated(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const repoPath = args.repo_path as string;
  const teamId = (args.team_id as string) ?? undefined;

  if (!repoPath) {
    return { content: [{ type: "text", text: "Error: repo_path is required." }], isError: true };
  }

  const db = getDb(opts);
  const outdated = wikiOutdated(db, repoPath, { teamId });

  if (outdated.length === 0) {
    return { content: [{ type: "text", text: "All pages are up to date." }] };
  }

  const lines = outdated.map((o) => `${o.id}  ${o.title}  (${o.sourceFile})  — ${o.reason}`);
  return {
    content: [
      { type: "text", text: `Found ${outdated.length} outdated page(s):\n${lines.join("\n")}` },
    ],
  };
}
