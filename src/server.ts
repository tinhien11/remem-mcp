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
import { classifyGlobalContent } from "./sdk.js";
import { AuditLogger } from "./security/audit.js";
import { checkContentLength, enforceQuota } from "./security/quota.js";
import { redact } from "./security/redactor.js";
import { stripQueryProperNouns } from "./storage/sqlite.js";
import type {
  CaptureEntry,
  CaptureMessage,
  CaptureType,
  DeleteFilter,
  DeleteResult,
  KnowledgeEntry,
  ScenarioEntry,
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
  // REMEM_SESSION_KEY overrides the default hash(cwd) — use for single global session
  if (process.env.REMEM_SESSION_KEY) return process.env.REMEM_SESSION_KEY;
  const cwd = process.cwd();
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/** Global session key for cross-project memory (rules, learnings). */
function globalSessionKey(): string | null {
  return process.env.REMEM_GLOBAL_SESSION_KEY ?? null;
}

/** Detect the agent ID from environment variables.
 *  Checks for known coding agent signatures in the process environment.
 *  Returns "unknown" when no agent is identifiable — the value is still
 *  stored on every capture and filterable on every query, so "unknown"
 *  captures are searchable but distinguishable from named agents. */
function detectAgentId(): string {
  if (process.env.DEVIN_SESSION_ID) return "devin";
  if (process.env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (process.env.CURSOR_DEBUG) return "cursor";
  if (process.env.CODEX_HOME) return "codex";
  if (process.env.WINDSURF_USER_KEY) return "windsurf";
  return "unknown";
}

/**
 * Dedup search results by content prefix. When multiple captures share the
 * same first N characters (e.g. repeated checkpoints or audit summaries),
 * keep only the highest-scoring one. This prevents noise from long-run loops
 * and repeated captures with near-identical content.
 */
function dedupByContentPrefix(results: SearchResult[], prefixLen = 60): SearchResult[] {
  const seen = new Map<string, number>(); // prefix → index in output
  const out: SearchResult[] = [];
  for (const r of results) {
    const prefix = r.entry.content.slice(0, prefixLen).trim().toLowerCase();
    if (prefix.length < 10) {
      // Too short to dedup meaningfully — keep as-is
      out.push(r);
      continue;
    }
    const existingIdx = seen.get(prefix);
    if (existingIdx === undefined) {
      seen.set(prefix, out.length);
      out.push(r);
    } else {
      // Keep whichever has higher score
      if (r.score > out[existingIdx].score) {
        out[existingIdx] = r;
      }
    }
  }
  return out;
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
      "Use it when the user references past work or when the task needs project context. " +
      "Automatically searches both project memory and global cross-project memory (rules, learnings) " +
      "when REMEM_GLOBAL_SESSION_KEY is configured.",
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
        type: {
          type: "string",
          enum: ["conversation", "decision", "learning", "task", "error", "atom"],
          description:
            "Filter results by memory type. Use 'decision' to skip checkpoints/tasks, 'error' for past failures, etc.",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          default: "text",
          description:
            "The response format. Use 'json' for structured data (e.g. benchmarks). Defaults to 'text'.",
        },
        ...TENANT_PARAMS,
      },
      required: ["query"],
    },
  },
  {
    name: "capture",
    description:
      "Store a decision, a learning, or a task outcome to memory. " +
      "Call this tool after you complete a non-trivial task, make a decision, or fix a bug with a known root cause. " +
      "You can capture a single text string, or a list of role-based conversation messages. " +
      "To store cross-project knowledge (rules, conventions, learnings reusable across projects), " +
      'pass session_key="global" or auto_global=true — these appear in every project\'s recall automatically.',
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
          default: "conversation",
          description: "The type of the memory. Defaults to 'conversation' if omitted.",
        },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        session_key: {
          type: "string",
          description:
            "The session key. The default is hash(cwd). Use 'global' to store cross-project knowledge " +
            "(rules, conventions, learnings) that should appear in every project's recall.",
        },
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
        override_reason: {
          type: "string",
          description:
            "Required when override_rejection is true. Explain why the rejection no longer applies. Logged to audit.",
        },
        auto_global: {
          type: "boolean",
          default: false,
          description:
            "Set to true to auto-classify: generic rules/learnings go to global, project-specific content stays in project. " +
            "Only applies when session_key is not explicitly set. Requires REMEM_GLOBAL_SESSION_KEY to be configured.",
        },
        atoms: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional L1 atom facts distilled from this capture. Each atom is a short, self-contained fact " +
            "useful on its own (e.g., 'vitest config missing causes npm test exit 1'). " +
            "When provided, recall() returns these atoms instead of the raw content — 90% fewer tokens. " +
            "Write 1-3 atoms for decisions, learnings, and errors. Skip for conversations.",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          default: "text",
          description:
            "The response format. Use 'json' for structured data (e.g. benchmarks). Defaults to 'text'.",
        },
        ...TENANT_PARAMS,
      },
    },
  },
  {
    name: "search",
    description:
      "Search memory by keyword or by semantic similarity. " +
      "Use this tool when recall is too broad and you need specific facts. " +
      "Automatically searches both project and global cross-project memory " +
      "when REMEM_GLOBAL_SESSION_KEY is configured.",
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
        session_key: {
          type: "string",
          description:
            "The session key. Defaults to hash(cwd). Use this to search memory from a different project.",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          default: "text",
          description:
            "The response format. Use 'json' for structured data (e.g. benchmarks). Defaults to 'text'.",
        },
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
        format: {
          type: "string",
          enum: ["text", "json"],
          default: "text",
          description:
            "The response format. Use 'json' for structured data (e.g. benchmarks). Defaults to 'text'.",
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
  // ─── L2 scenario consolidation ───────────────────────────────
  {
    name: "scenario_create",
    description:
      "Consolidate multiple L1 atoms into an L2 scenario summary. " +
      "Call this when you have 5+ atoms about the same topic — it creates a high-signal summary " +
      "that recall injects in ~100 tokens instead of 5+ individual atoms. " +
      "No LLM needed — you write the summary yourself based on the atoms you've seen.",
    inputSchema: {
      type: "object",
      properties: {
        atom_ids: {
          type: "array",
          items: { type: "string" },
          description: "The L1 atom IDs to consolidate (1-20).",
        },
        summary: {
          type: "string",
          description:
            "A 1-3 sentence summary that captures the key insight from these atoms. " +
            "Write it as a self-contained fact useful on its own.",
        },
        persona_tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization (e.g., ['database', 'migration']).",
        },
        ...TENANT_PARAMS,
      },
      required: ["atom_ids", "summary"],
    },
  },
  // ─── L3 persona update ───────────────────────────────────────
  {
    name: "persona_update",
    description:
      "Update the L3 persona profile for this user/team. " +
      "Call this when you notice a user preference or pattern (e.g., 'prefers concise output', 'works in Vietnamese', 'uses AZR project'). " +
      "Persona is injected at SessionStart — every session gets it automatically in ~50 tokens. " +
      "No LLM needed — you write the trait/value yourself.",
    inputSchema: {
      type: "object",
      properties: {
        trait: {
          type: "string",
          description: "The trait name (e.g., 'language', 'output_style', 'project', 'timezone').",
        },
        value: {
          type: "string",
          description: "The trait value (e.g., 'Vietnamese', 'concise', 'AZR', 'Asia/Ho_Chi_Minh').",
        },
        ...TENANT_PARAMS,
      },
      required: ["trait", "value"],
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
      "Note: codegraph_search auto-indexes on first use, so you only need this for explicit re-indexing or custom paths.",
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
      "with file paths and line numbers. Use this INSTEAD of grep when looking for function/class/method definitions. " +
      "If the codebase hasn't been indexed yet, this auto-indexes src/ (or cwd) on first use — no manual setup needed.",
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
        path: {
          type: "string",
          description:
            "Optional: directory to auto-index if no symbols are found yet. " +
            "Defaults to src/ under the current working directory. " +
            "Use this when searching a different project than the MCP server's cwd.",
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
      "Returns groups of similar captures. Set confirm=true to merge them. " +
      "Use batch_size to limit how many captures are processed in one call (cost control).",
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
        batch_size: {
          type: "integer",
          default: 0,
          description:
            "Maximum captures to process in this batch. 0 = all (default). " +
            "Use for incremental consolidation on large databases.",
        },
      },
    },
  },
  {
    name: "stats",
    description:
      "Query memory statistics: total captures, breakdown by type, top tags, " +
      "session count, date range, and database size. Use this to understand memory " +
      "health and coverage. No arguments needed — returns a summary.",
    inputSchema: {
      type: "object",
      properties: {
        session_key: {
          type: "string",
          description:
            "Filter stats to a specific session. Default is hash(cwd). Use 'all' for all projects.",
        },
      },
    },
  },
  {
    name: "confirm",
    description:
      "Confirm that a memory is accurate. Increments the Bayesian confirmation count, " +
      "raising its confidence score in future searches. Use when a recalled memory " +
      "proved helpful and correct.",
    inputSchema: {
      type: "object",
      properties: {
        capture_id: {
          type: "string",
          description: "The ID of the capture to confirm.",
        },
      },
      required: ["capture_id"],
    },
  },
  {
    name: "correct",
    description:
      "Mark a memory as inaccurate or outdated. Increments the Bayesian correction count, " +
      "lowering its confidence score in future searches. Use when a recalled memory was " +
      "wrong, misleading, or superseded by newer information.",
    inputSchema: {
      type: "object",
      properties: {
        capture_id: {
          type: "string",
          description: "The ID of the capture to correct.",
        },
        reason: {
          type: "string",
          description: "Optional explanation of why this memory is wrong.",
        },
      },
      required: ["capture_id"],
    },
  },
  {
    name: "supersede",
    description:
      "Mark an old memory as superseded by a newer one. The old memory's superseded_by " +
      "field is set, and it will be filtered out of search results (unless explicitly " +
      "requested). Use when a fact has changed (e.g. 'database is MySQL' → 'database is PostgreSQL').",
    inputSchema: {
      type: "object",
      properties: {
        old_id: {
          type: "string",
          description: "The ID of the old/outdated capture.",
        },
        new_id: {
          type: "string",
          description: "The ID of the new/replacement capture.",
        },
      },
      required: ["old_id", "new_id"],
    },
  },
  {
    name: "record_outcome",
    description:
      "Record whether a correction was heeded (agent followed the advice) or recurred (same error happened again). " +
      "This tracks correction effectiveness over time. Call after applying a correction to a recalled memory.",
    inputSchema: {
      type: "object",
      properties: {
        capture_id: {
          type: "string",
          description: "The ID of the correction capture.",
        },
        outcome: {
          type: "string",
          enum: ["heeded", "recurred"],
          description:
            "'heeded' = agent followed the correction. 'recurred' = same error repeated.",
        },
      },
      required: ["capture_id", "outcome"],
    },
  },
  {
    name: "correction_kpis",
    description:
      "Get correction learning metrics: total corrections, average precision, heed rate, " +
      "noise candidates (precision < 0.3), and high-signal candidates (precision >= 0.8). " +
      "Use this to evaluate memory quality and identify unhelpful corrections to prune.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "session_start",
    description:
      "Open a session and return recent context. Call this at the start of a multi-turn conversation " +
      "to get a summary of recent captures and correction alignment metrics. " +
      "Returns both project-specific and global cross-project memory when configured.",
    inputSchema: {
      type: "object",
      properties: {
        session_key: {
          type: "string",
          description: "Session identifier. Default is hash(cwd).",
        },
        context_query: {
          type: "string",
          description: "Optional query to fetch relevant context for this session.",
        },
      },
    },
  },
  {
    name: "session_end",
    description:
      "Close a session and optionally capture a summary. Call this at the end of a conversation " +
      "to record what was accomplished.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Session summary to capture as a memory.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for the summary capture.",
        },
      },
    },
  },
  {
    name: "session_checkpoint",
    description:
      "Create a checkpoint of the current session state. Returns a checkpoint ID that can be " +
      "used to resume later. Stores recent captures as a named snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Checkpoint name for easy reference.",
        },
        summary: {
          type: "string",
          description: "What was happening at this checkpoint.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "health",
    description:
      "Diagnose memory server health: DB integrity, index status, capture count, schema version, embedding model.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/**
 * All tools available by default. Set REMEM_CORE_ONLY=1 to reduce token
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
  "stats",
  "confirm",
  "correct",
  "supersede",
  "record_outcome",
  "correction_kpis",
  "session_start",
  "session_end",
  "session_checkpoint",
  "health",
]);

function getTools(): Tool[] {
  const coreOnly = process.env.REMEM_CORE_ONLY === "1" || process.env.REMEM_CORE_ONLY === "true";
  if (coreOnly) return TOOLS.filter((t) => CORE_TOOL_NAMES.has(t.name));
  return TOOLS;
}

/** Create the MCP server with all tools registered. */
export function createServer(opts: ServerOptions): Server {
  const server = new Server(
    {
      name: "remem-mcp",
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
          uri: "remem-mcp://recent",
          name: "Recent captures",
          description: "The 20 most recent memory captures.",
          mimeType: "text/plain",
        },
        {
          uri: "remem-mcp://stats",
          name: "Memory statistics",
          description: "Summary statistics for the memory database.",
          mimeType: "application/json",
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (uri === "remem-mcp://recent") {
      // Direct SQL query — search("") returns [] because escapeFtsQuery('') is empty.
      // Filter by current session (+ global if configured) to prevent cross-session leaks.
      const db = getDb(opts);
      const sessionKey = defaultSessionKey();
      const globalKey = globalSessionKey();
      const sessionKeys =
        globalKey && globalKey !== sessionKey ? [sessionKey, globalKey] : [sessionKey];
      const placeholders = sessionKeys.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT id, session_key, agent_id, type, content, tags, created_at, trust_state, superseded_by, team_id, user_id, task_id, content_hash FROM captures WHERE deleted_at IS NULL AND trust_state != 'rejected' AND superseded_by IS NULL AND session_key IN (${placeholders}) ORDER BY created_at DESC LIMIT 20`,
        )
        .all(...sessionKeys) as Record<string, unknown>[];
      const results: SearchResult[] = rows.map((r, i) => ({
        entry: {
          id: r.id as string,
          sessionKey: r.session_key as string,
          agentId: r.agent_id as string,
          type: r.type as CaptureType,
          content: r.content as string,
          tags: r.tags ? JSON.parse(r.tags as string) : [],
          createdAt: r.created_at as number,
          trustState: (r.trust_state as TrustState) ?? "candidate",
          supersededBy: (r.superseded_by as string | null) ?? undefined,
          teamId: r.team_id as string | undefined,
          userId: r.user_id as string | undefined,
          taskId: r.task_id as string | undefined,
          contentHash: r.content_hash as string,
        },
        score: 1 - i * 0.01,
      }));
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

    if (uri === "remem-mcp://stats") {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({
              message: "Use the stats CLI command for full statistics.",
              hint: "Run: npx remem-mcp stats",
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
      case "scenario_create":
        return handleScenarioConsolidate(args, opts);
      case "persona_update":
        return handlePersonaUpdate(args, opts);
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
      case "stats":
        return handleStats(args, opts);
      case "confirm":
        return handleConfirm(args, opts);
      case "correct":
        return handleCorrect(args, opts);
      case "supersede":
        return handleSupersede(args, opts);
      case "record_outcome":
        return handleRecordOutcome(args, opts);
      case "correction_kpis":
        return handleCorrectionKPIs(args, opts);
      case "session_start":
        return handleSessionStart(args, opts);
      case "session_end":
        return handleSessionEnd(args, opts);
      case "session_checkpoint":
        return handleSessionCheckpoint(args, opts);
      case "health":
        return handleHealth(args, opts);
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
  const format = (args.format as "text" | "json") ?? "text";
  const typeFilter = (args.type as CaptureType | undefined) ?? undefined;
  const { teamId, userId, taskId } = extractTenant(args);
  // "org" scoped memories are shared across agents (e.g. a cross-agent handoff
  // where agent B retrieves context stored by agent A). In that case we must not
  // restrict the search to the querying agent's own captures.
  const scope = (args.scope as string | undefined) ?? undefined;
  const agentId = scope === "org" ? undefined : ((args.agent_id as string) ?? undefined);

  let queryEmbedding: number[] | null = null;
  let vectorDegraded = false;
  if (mode === "hybrid" || mode === "vector") {
    try {
      // Use stripped query (proper nouns removed) for vector embedding.
      // This prevents a rare proper noun (e.g. "Tin") from dominating vector
      // similarity over content words (e.g. "editor use" → Neovim).
      const stripped = stripQueryProperNouns(query);
      queryEmbedding = await opts.embedder.embed(stripped || query);
    } catch (err) {
      console.error(`[remem-mcp] Embedding failed: ${err}`);
      vectorDegraded = true;
    }
  }

  // If REMEM_GLOBAL_SESSION_KEY is set and session_key wasn't explicitly provided,
  // search project session first, then global as fallback for remaining slots.
  // Project-specific captures are always more relevant than generic cross-project
  // rules when the user is working in a project directory.
  const globalKey = globalSessionKey();
  const useGlobalFallback = !!globalKey && !args.session_key && globalKey !== sessionKey;

  let results: SearchResult[];
  if (useGlobalFallback) {
    // Reserve 3 slots for global so cross-project knowledge isn't buried
    // when project has enough results to fill the limit. Always leave the
    // project search at least 1 slot — project captures are more relevant
    // and must not be zeroed out entirely for small limits (e.g. limit: 2).
    const reservedGlobal = Math.min(3, limit);
    const projectLimit = Math.max(1, limit - reservedGlobal);
    const projectResults = await opts.storage.search(query, queryEmbedding, {
      sessionKey,
      limit: projectLimit,
      offset,
      mode,
      filters: { teamId, userId, taskId, agentId, type: typeFilter },
    });
    let globalResults: SearchResult[] = [];
    try {
      globalResults = await opts.storage.search(query, queryEmbedding, {
        sessionKey: globalKey,
        limit: reservedGlobal,
        offset: 0,
        mode,
        filters: { teamId, userId, taskId, agentId, type: typeFilter },
      });
    } catch {
      // Global search failure is non-fatal
    }
    // Merge: project first, then global (dedup by id), cap at limit
    const seen = new Set(projectResults.map((r) => r.entry.id));
    const merged = [...projectResults, ...globalResults.filter((r) => !seen.has(r.entry.id))];
    results = merged.slice(0, limit);
  } else {
    results = await opts.storage.search(query, queryEmbedding, {
      sessionKey,
      limit,
      offset,
      mode,
      filters: { teamId, userId, taskId, agentId, type: typeFilter },
    });
  }

  // Dedup: remove near-duplicate captures with same content prefix (first 60 chars).
  // This prevents noise from repeated checkpoints/audits with identical content.
  results = dedupByContentPrefix(results, 60);

  // Atom-aware: if atoms exist for a capture, use the atom fact as content
  // instead of the raw capture. L1 facts are distilled and shorter than L0 raw text.
  const atomMap = new Map<string, string>();
  for (const r of results) {
    try {
      const atoms = await opts.pipelineCtx.storage.listAtoms({ captureId: r.entry.id, limit: 5 });
      if (atoms.length > 0) {
        atomMap.set(r.entry.id, atoms.map((a) => a.fact).join(" | "));
      }
    } catch {
      // atoms unavailable (non-SQLite backend) — fall back to raw content
    }
  }
  // Replace content with atom facts where available
  for (const r of results) {
    const atomContent = atomMap.get(r.entry.id);
    if (atomContent) {
      r.entry = { ...r.entry, content: atomContent };
    }
  }

  let text = formatResults(results);

  // JSON format: return a structured array (mirrors the search tool). Used by
  // programmatic consumers (e.g. benchmark adapters) that parse the response.
  if (format === "json") {
    const jsonResults = results.map((r) => ({
      id: r.entry.id,
      content: r.entry.content,
      score: r.score,
      type: r.entry.type,
      tags: r.entry.tags,
      created_at: new Date(r.entry.createdAt).toISOString(),
      trust_state: r.entry.trustState ?? "candidate",
    }));
    const jsonText = JSON.stringify(
      vectorDegraded
        ? { results: jsonResults, _meta: { vector_degraded: true, channels_run: ["keyword"] } }
        : { results: jsonResults, _meta: { channels_run: mode === "vector" ? ["vector"] : ["keyword", "vector"] } },
    );
    opts.audit.log({
      tool: "recall",
      argsHash: AuditLogger.hashArgs({ query, limit, offset, mode, teamId, userId, taskId }),
      resultLen: jsonText.length,
      quotaHit: false,
      redacted: false,
    });
    return { content: [{ type: "text", text: jsonText }] };
  }

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

  // Augment with L2 scenarios (high-signal summaries, ~100 tokens)
  try {
    const scenarios = await opts.storage.listScenarios({
      teamId,
      agentId,
      userId,
      limit: 3,
    });
    if (scenarios.length > 0) {
      const scenarioLines = scenarios.map(
        (s) => `  ${s.summary}`,
      );
      text += `\n\n## Scenarios (L2 summaries)\n${scenarioLines.join("\n")}`;
    }
  } catch {
    // Scenarios not available
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
  const type = (args.type as CaptureType) ?? "conversation";
  const tags = (args.tags as string[]) ?? [];
  const autoGlobal = (args.auto_global as boolean) ?? false;
  const globalKey = globalSessionKey();
  let sessionKey = (args.session_key as string) ?? defaultSessionKey();

  // Auto-classify: if auto_global is set, session_key wasn't explicitly passed,
  // and global is configured, decide whether content is generic (global) or
  // project-specific (project).
  let autoClassified = false;
  if (autoGlobal && !args.session_key && globalKey && globalKey !== sessionKey) {
    // Build content first to classify (mirror logic below)
    let classifyContent: string;
    const rawMsgs = args.messages as CaptureMessage[] | undefined;
    if (rawMsgs && rawMsgs.length > 0) {
      classifyContent = rawMsgs.map((m) => `${m.role}: ${m.content}`).join("\n");
    } else {
      classifyContent = (args.content as string) ?? "";
    }
    if (classifyGlobalContent(classifyContent, type)) {
      sessionKey = globalKey;
      autoClassified = true;
    }
  }

  const metadata = args.metadata as Record<string, unknown> | undefined;
  const { teamId, userId, taskId } = extractTenant(args);
  const agentId = (args.agent_id as string) ?? detectAgentId();
  const verified = (args.verified as boolean) ?? false;
  const supersedes = args.supersedes as string | undefined;
  const overrideRejection = (args.override_rejection as boolean) ?? false;
  const overrideReason = args.override_reason as string | undefined;
  // Programmatic callers (e.g. benchmark adapters) that explicitly scope captures
  // with agent_id expect a JSON-parseable response so they can extract the stored ID
  // for later cleanup. Human callers don't pass agent_id and get the readable
  // "Captured: <id>" text. An explicit format arg always wins.
  const format =
    (args.format as "text" | "json") ?? (args.agent_id !== undefined ? "json" : "text");

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
    const rejected = await opts.storage.findRejectedByContentHash(contentHash, sessionKey, agentId);
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
            text: `Blocked: This content was previously rejected (${rejected[0].id}). Reason: ${reason}. Set override_rejection: true and override_reason: "<why>" to force capture.`,
          },
        ],
        isError: true,
      };
    }
  } else if (!overrideReason) {
    return {
      content: [
        {
          type: "text",
          text: "Error: override_rejection is true but override_reason is missing. Provide a reason explaining why the rejection no longer applies.",
        },
      ],
      isError: true,
    };
  } else {
    // Log the override to audit so there's a traceable record
    opts.audit.log({
      tool: "capture",
      argsHash: AuditLogger.hashArgs({ type, tags, sessionKey, overrideReason, teamId, userId, taskId }),
      resultLen: 0,
      quotaHit: false,
      redacted: wasRedacted,
    });
  }

  // Dedup: check if content with the same hash already exists in this session.
  // Scoped to (session, agent) so the same fact captured by a different agent
  // (e.g. a fresh benchmark run with a unique agent_id) is not treated as a dup.
  const existing = await opts.storage.findByContentHash(contentHash, sessionKey, agentId);
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

  // Fuzzy dedup: check if a capture with the same first 60 chars already exists.
  // This catches near-duplicates like repeated checkpoints ("Checkpoint: X round N")
  // or audit summaries with only minor differences. Keep the newest, supersede the old.
  const newId = generateId();
  const fuzzyPrefix = redactedContent.slice(0, 60).trim().toLowerCase();
  let fuzzyDupId: string | null = null;
  if (fuzzyPrefix.length >= 10) {
    try {
      const fuzzyMatches = await opts.storage.search(fuzzyPrefix, null, {
        sessionKey,
        limit: 5,
        offset: 0,
        mode: "keyword",
        filters: { agentId, type },
      });
      const fuzzyDup = fuzzyMatches.find(
        (r) => r.entry.content.slice(0, 60).trim().toLowerCase() === fuzzyPrefix,
      );
      if (fuzzyDup) {
        // Defer the supersede until after the new capture is persisted, so a
        // failed put can't leave the old capture pointing at a non-existent id.
        fuzzyDupId = fuzzyDup.entry.id;
      }
    } catch {
      // Fuzzy dedup is best-effort — don't block capture if it fails.
    }
  }

  const id = newId;
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

  // Now that the new capture is persisted, supersede the fuzzy-dup older
  // capture (if any). Doing this before put would leave a dangling
  // superseded_by pointing at a non-existent id if put failed.
  if (fuzzyDupId) {
    try {
      await opts.storage.supersede(fuzzyDupId, id);
    } catch (err) {
      console.error(`[remem-mcp] Fuzzy supersede failed: ${err}`);
    }
  }

  // If supersedes is set, mark the old capture as stale.
  if (supersedes) {
    try {
      await opts.storage.supersede(supersedes, id);
    } catch (err) {
      console.error(`[remem-mcp] Supersede failed: ${err}`);
    }
  }

  let embedding: number[] | null = null;
  try {
    embedding = await opts.embedder.embed(redactedContent);
    await opts.storage.putVector(id, embedding);
  } catch (err) {
    console.error(`[remem-mcp] Embedding failed: ${err}`);
  }

  // Conflict detection: find similar captures in the same session.
  // Threshold is cosine DISTANCE (lower = more similar). 0.2 means we only
  // flag captures with >80% similarity — close enough to be a true duplicate
  // or contradiction. Previous threshold (0.3 = >70%) caused false positives
  // when captures shared topic/format but had different content (e.g. session
  // summaries starting with "Dogfood Phiên X").
  let conflictInfo = "";
  let conflictIds: string[] = [];
  if (embedding) {
    try {
      const conflicts = await opts.storage.findConflicts(embedding, sessionKey, 0.2);
      const filtered = conflicts.filter((c) => c.id !== id);
      conflictIds = filtered.map((c) => c.id);
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
      console.error(`[remem-mcp] Conflict detection failed: ${err}`);
    }
  }

  if (opts.pipeline.name !== "noop") {
    try {
      await opts.pipeline.process(
        { id, content: redactedContent, type, tags, sessionKey, teamId, userId, taskId },
        { ...opts.pipelineCtx, sessionKey },
      );
    } catch (err) {
      console.error(`[remem-mcp] Pipeline failed: ${err}`);
    }
  }

  // Save agent-provided L1 atoms (if any). These are distilled facts the agent
  // wrote alongside the raw capture — no LLM API key needed, no rule-based extraction.
  // Agent atoms take precedence over pipeline atoms (agent understands context better).
  const agentAtoms = args.atoms as string[] | undefined;
  if (agentAtoms && agentAtoms.length > 0) {
    try {
      // Clear any existing pipeline-extracted atoms for this capture first
      try {
        opts.pipelineCtx.storage.deleteAtomsByCaptureId(id);
      } catch {
        // Method may not exist on all backends — ignore
      }
      for (const fact of agentAtoms.slice(0, 5)) {
        const atomId = generateId();
        await opts.pipelineCtx.storage.putAtom({
          id: atomId,
          captureId: id,
          fact,
          confidence: 0.95, // agent-written atoms are high confidence
          createdAt: Date.now(),
          teamId,
          agentId,
          userId,
        });
      }
    } catch (err) {
      console.error(`[remem-mcp] Agent atom save failed: ${err}`);
    }
  }

  opts.audit.log({
    tool: "capture",
    argsHash: AuditLogger.hashArgs({ type, tags, sessionKey, teamId, userId, taskId }),
    resultLen: id.length,
    quotaHit: false,
    redacted: wasRedacted,
  });

  if (format === "json") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id,
            content: redactedContent,
            type,
            tags,
            session_key: sessionKey,
            auto_classified: autoClassified || undefined,
            created_at: new Date(entry.createdAt).toISOString(),
            verified: trustState === "verified",
            conflicts: conflictInfo ? conflictInfo.trim() : undefined,
            conflict_ids: conflictIds.length > 0 ? conflictIds : undefined,
          }),
        },
      ],
    };
  }

  const redactionNote = wasRedacted ? " (secrets were redacted)" : "";
  const msgNote = messages ? ` (${messages.length} messages)` : "";
  const trustNote = trustState === "verified" ? " [verified]" : "";
  const supersedesNote = supersedes ? ` (supersedes ${supersedes})` : "";
  const globalNote = autoClassified
    ? " [auto→global]"
    : sessionKey === globalKey
      ? " [global]"
      : "";
  return {
    content: [
      {
        type: "text",
        text: `Captured: ${id}${redactionNote}${msgNote}${trustNote}${supersedesNote}${globalNote}${conflictInfo}`,
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
  const format = (args.format as "text" | "json") ?? "text";
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
  const limit = Math.min((args.limit as number) ?? 20, 500);

  let queryEmbedding: number[] | null = null;
  let vectorDegraded = false;
  if (mode === "hybrid" || mode === "vector") {
    try {
      const stripped = stripQueryProperNouns(query);
      queryEmbedding = await opts.embedder.embed(stripped || query);
    } catch (err) {
      console.error(`[remem-mcp] Embedding failed: ${err}`);
      vectorDegraded = true;
    }
  }

  const sessionKey = (args.session_key as string) ?? defaultSessionKey();
  const globalKey = globalSessionKey();
  const useGlobalFallback = !!globalKey && !args.session_key && globalKey !== sessionKey;

  const searchFilters = filters
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
    : undefined;

  let results: SearchResult[];
  if (useGlobalFallback) {
    // Always leave the project search at least 1 slot — project captures are
    // more relevant and must not be zeroed out entirely for small limits.
    const reservedGlobal = Math.min(3, limit);
    const projectLimit = Math.max(1, limit - reservedGlobal);
    const projectResults = await opts.storage.search(query, queryEmbedding, {
      sessionKey,
      limit: projectLimit,
      offset: 0,
      mode,
      filters: searchFilters,
    });
    let globalResults: SearchResult[] = [];
    try {
      globalResults = await opts.storage.search(query, queryEmbedding, {
        sessionKey: globalKey,
        limit: reservedGlobal,
        offset: 0,
        mode,
        filters: searchFilters,
      });
    } catch {
      // Global search failure is non-fatal
    }
    const seen = new Set(projectResults.map((r) => r.entry.id));
    const merged = [...projectResults, ...globalResults.filter((r) => !seen.has(r.entry.id))];
    results = merged.slice(0, limit);
  } else {
    results = await opts.storage.search(query, queryEmbedding, {
      sessionKey,
      limit,
      offset: 0,
      mode,
      filters: searchFilters,
    });
  }

  // Dedup near-identical captures (same first 60 chars) — keep highest score.
  results = dedupByContentPrefix(results, 60);

  // Atom-aware: if atoms exist for a capture, use the atom fact as content
  // instead of the raw capture. This ensures distilled facts (L1) replace
  // raw capture text (L0) — less noise, more signal.
  const atomMap = new Map<string, string>();
  for (const r of results) {
    try {
      const atoms = await opts.pipelineCtx.storage.listAtoms({ captureId: r.entry.id, limit: 5 });
      if (atoms.length > 0) {
        atomMap.set(r.entry.id, atoms.map((a) => a.fact).join(" | "));
      }
    } catch {}
  }
  // Replace content with atom facts where available (mutate in place)
  for (const r of results) {
    const atomContent = atomMap.get(r.entry.id);
    if (atomContent) {
      r.entry = { ...r.entry, content: atomContent };
    }
  }

  if (format === "json") {
    const jsonResults = results.map((r) => ({
      id: r.entry.id,
      content: r.entry.content,
      score: r.score,
      type: r.entry.type,
      tags: r.entry.tags,
      created_at: new Date(r.entry.createdAt).toISOString(),
      trust_state: r.entry.trustState ?? "candidate",
    }));
    const jsonText = JSON.stringify(
      vectorDegraded
        ? { results: jsonResults, _meta: { vector_degraded: true, channels_run: ["keyword"] } }
        : { results: jsonResults, _meta: { channels_run: mode === "vector" ? ["vector"] : ["keyword", "vector"] } },
    );
    opts.audit.log({
      tool: "search",
      argsHash: AuditLogger.hashArgs({ query, mode, filters }),
      resultLen: jsonText.length,
      quotaHit: false,
      redacted: false,
    });
    return { content: [{ type: "text", text: jsonText }] };
  }

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

  const sourceTags = source.tags ?? [];
  const sourceSessionKey = source.sessionKey;
  const sourceType = source.type;

  // Build candidate pool: search by tags + by content keywords.
  // listByTags bypasses FTS5 — direct SQL on tags column.
  const candidateMap = new Map<
    string,
    { entry: CaptureEntry; score: number; reasons: Set<string> }
  >();

  // Search by tags (if any) — direct SQL, no FTS5
  if (sourceTags.length > 0) {
    const tagMatches = await opts.storage.listByTags(
      sourceTags.slice(0, 10),
      100,
      sourceSessionKey,
    );
    for (const entry of tagMatches) {
      if (entry.id === id) continue;
      const entryTags = entry.tags ?? [];
      const sharedTags = sourceTags.filter((t: string) => entryTags.includes(t));
      const tagScore = sharedTags.length * 3;
      const existing = candidateMap.get(entry.id);
      if (existing) {
        existing.score += tagScore;
        for (const t of sharedTags) existing.reasons.add(`tag: ${t}`);
      } else {
        candidateMap.set(entry.id, {
          entry,
          score: tagScore,
          reasons: new Set(sharedTags.map((t: string) => `tag: ${t}`)),
        });
      }
    }
  }

  // Also search by content keywords (broader net)
  const contentResults = await opts.storage.search(source.content.slice(0, 200), null, {
    limit: 100,
    offset: 0,
    mode: "keyword",
  });
  for (const r of contentResults) {
    if (r.entry.id === id) continue;
    const existing = candidateMap.get(r.entry.id);
    if (existing) {
      existing.score += Math.min(r.score, 5);
      existing.reasons.add("content overlap");
    } else {
      candidateMap.set(r.entry.id, {
        entry: r.entry,
        score: Math.min(r.score, 5),
        reasons: new Set(["content overlap"]),
      });
    }
  }

  // Score: add same project and same type bonuses
  const scored: Array<{ entry: CaptureEntry; score: number; reasons: string[] }> = [];
  for (const { entry, score, reasons } of candidateMap.values()) {
    let finalScore = score;
    const reasonList = [...reasons];

    // Same project (session_key)
    if (sourceSessionKey && entry.sessionKey === sourceSessionKey) {
      finalScore += 2;
      reasonList.push("same project");
    }

    // Same type
    if (sourceType && entry.type === sourceType) {
      finalScore += 1;
      reasonList.push(`same type: ${entry.type}`);
    }

    if (finalScore > 0) {
      scored.push({ entry, score: finalScore, reasons: reasonList });
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
    if (entry.tags && entry.tags.length > 0) {
      lines.push(`  tags: ${entry.tags.join(", ")}`);
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
 * Run a search mirroring handleRecall's global-fallback behavior: search the
 * project session with the full limit first, then the global session for any
 * remaining slots, and merge by id (project first, global deduped against it).
 * When useGlobalFallback is false, this is a plain single-session search.
 */
async function searchWithGlobalFallback(
  storage: StorageBackend,
  params: {
    query: string;
    queryEmbedding: number[] | null;
    useGlobalFallback: boolean | "" | null;
    sessionKey: string;
    globalKey: string | null | undefined;
    teamId: string | undefined;
    userId: string | undefined;
    taskId: string | undefined;
    limit: number;
    mode: SearchMode;
  },
): Promise<SearchResult[]> {
  if (!params.useGlobalFallback || !params.globalKey || params.globalKey === params.sessionKey) {
    return storage.search(params.query, params.queryEmbedding, {
      sessionKey: params.sessionKey,
      limit: params.limit,
      offset: 0,
      mode: params.mode,
      filters: { teamId: params.teamId, userId: params.userId, taskId: params.taskId },
    });
  }
  const projectResults = await storage.search(params.query, params.queryEmbedding, {
    sessionKey: params.sessionKey,
    limit: Math.max(1, params.limit - Math.min(3, params.limit)),
    offset: 0,
    mode: params.mode,
    filters: { teamId: params.teamId, userId: params.userId, taskId: params.taskId },
  });
  const reservedGlobal = Math.min(3, params.limit);
  let globalResults: SearchResult[] = [];
  try {
    globalResults = await storage.search(params.query, params.queryEmbedding, {
      sessionKey: params.globalKey,
      limit: reservedGlobal,
      offset: 0,
      mode: params.mode,
      filters: { teamId: params.teamId, userId: params.userId, taskId: params.taskId },
    });
  } catch {
    // Global search failure is non-fatal
  }
  const seen = new Set(projectResults.map((r) => r.entry.id));
  const merged = [...projectResults, ...globalResults.filter((r) => !seen.has(r.entry.id))];
  return merged.slice(0, params.limit);
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
  const globalKey = globalSessionKey();
  const useGlobalFallback = !!globalKey && !args.session_key && globalKey !== sessionKey;
  const mode = (args.mode as SearchMode) ?? "hybrid";
  const limit = Math.min((args.limit as number) ?? 10, 50);
  const { teamId, userId, taskId } = extractTenant(args);

  let queryEmbedding: number[] | null = null;
  let vectorDegraded = false;
  if (mode === "hybrid" || mode === "vector") {
    try {
      queryEmbedding = await opts.embedder.embed(query);
    } catch (err) {
      console.error(`[remem-mcp] Embedding failed: ${err}`);
      vectorDegraded = true;
    }
  }

  // When REMEM_GLOBAL_SESSION_KEY is set and no explicit session_key was passed,
  // mirror handleRecall: search the project session with the full limit first,
  // then the global session for any remaining slots, and merge by id (project
  // first). Without this, all three searches below would run against the global
  // session only and project captures would be reported as "NOT in top N" even
  // though recall() would return them.
  const searchOpts = {
    query,
    queryEmbedding,
    useGlobalFallback,
    sessionKey,
    globalKey: globalKey ?? undefined,
    teamId,
    userId,
    taskId,
  };

  // Get keyword-only results
  const keywordResults: SearchResult[] =
    mode === "vector"
      ? []
      : await searchWithGlobalFallback(opts.storage, {
          ...searchOpts,
          limit: limit * 3,
          mode: "keyword",
        });

  // Get vector-only results
  const vectorResults: SearchResult[] =
    mode === "keyword" || !queryEmbedding
      ? []
      : await searchWithGlobalFallback(opts.storage, {
          ...searchOpts,
          limit: limit * 3,
          mode: "vector",
        });

  // Get hybrid results (what recall actually returns)
  const hybridResults: SearchResult[] = await searchWithGlobalFallback(opts.storage, {
    ...searchOpts,
    limit,
    mode,
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
  // When id is provided, default confirm to true (for MCP adapter compatibility)
  const confirm = (args.confirm as boolean) ?? !!id;
  const reject = (args.reject as boolean) ?? false;
  const reason = args.reason as string | undefined;
  const format = (args.format as "text" | "json") ?? "text";

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
    // Scope filter to the current session to prevent cross-session data loss
    const sessionKey = (args.session_key as string) ?? defaultSessionKey();
    result = await opts.storage.deleteByFilter({ ...filter, sessionKey });
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
  if (format === "json") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            deleted: true,
            id: id ?? null,
            action: action.toLowerCase(),
            captures: result.captures,
            atoms: result.atoms,
            scenarios: result.scenarios,
          }),
        },
      ],
    };
  }
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
    | (Record<string, unknown> & { rowid?: number })
    | undefined;
  if (!row) {
    return { content: [{ type: "text", text: `Error: Capture ${id} not found.` }], isError: true };
  }

  const rawContent = (args.content as string) ?? (row.content as string);
  // Redact secrets if enabled — same as handleCapture
  const { text: newContent } = opts.redactSecrets ? redact(rawContent) : { text: rawContent };
  const newTags = args.tags ? JSON.stringify(args.tags) : (row.tags as string);
  const newType = (args.type as string) ?? (row.type as string);
  const newTrust = args.verified ? "verified" : (row.trust_state as string);

  // Update content hash
  const contentHash = createHash("sha256").update(newContent).digest("hex");

  db.prepare(
    "UPDATE captures SET content = ?, tags = ?, type = ?, trust_state = ?, content_hash = ? WHERE id = ?",
  ).run(newContent, newTags, newType, newTrust, contentHash, id);

  // FTS index is synced automatically by the captures_au AFTER UPDATE trigger
  // — no manual delete+insert needed here. Re-embed if content changed so
  // vector search returns fresh results.
  if (args.content && args.content !== (row.content as string)) {
    try {
      const embedding = await opts.embedder.embed(newContent);
      await opts.storage.putVector(id, embedding);
    } catch (err) {
      console.error(`[remem-mcp] Re-embedding failed: ${err}`);
    }
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
  const batchSize = (args.batch_size as number) ?? 0;
  const sessionKey = (args.session_key as string) ?? defaultSessionKey();

  if (threshold < 0 || threshold > 1) {
    return {
      content: [{ type: "text", text: "Error: threshold must be between 0 and 1." }],
      isError: true,
    };
  }
  if (batchSize < 0) {
    return {
      content: [{ type: "text", text: "Error: batch_size must be non-negative." }],
      isError: true,
    };
  }

  const db = getDb(opts);

  // Get all non-deleted captures for the session (or all if session_key === "all")
  let sql = "SELECT id, content, type, tags, created_at FROM captures WHERE deleted_at IS NULL";
  const params: unknown[] = [];
  if (sessionKey !== "all") {
    sql += " AND session_key = ?";
    params.push(sessionKey);
  }
  sql += " ORDER BY created_at DESC";
  if (batchSize > 0) {
    sql += " LIMIT ?";
    params.push(batchSize);
  }
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
          text: `No duplicates found (threshold: ${threshold}). ${rows.length} captures checked.${batchSize > 0 ? ` (batch_size: ${batchSize})` : ""}`,
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

  // Merge: keep the oldest capture, soft-delete the rest (transactional)
  let merged = 0;
  const softDelete = db.prepare("UPDATE captures SET deleted_at = ? WHERE id = ?");
  const deleteVec = db.prepare("DELETE FROM captures_vec WHERE id = ?");
  const deleteAtoms = db.prepare("DELETE FROM atoms WHERE capture_id = ?");
  const mergeTx = db.transaction(() => {
    for (const g of groups) {
      const groupRows = g.ids
        .map((id) => rows.find((r) => r.id === id))
        .filter(Boolean)
        .sort((a, b) => a!.created_at - b!.created_at);
      const dups = groupRows.slice(1);
      for (const dup of dups) {
        softDelete.run(Date.now(), dup!.id);
        deleteVec.run(dup!.id);
        deleteAtoms.run(dup!.id);
        merged++;
      }
    }
  });
  try {
    mergeTx();
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
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

/** Handle the stats tool — query memory statistics for agents. */
async function handleStats(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const sessionKey = (args.session_key as string) ?? defaultSessionKey();
  const db = getDb(opts);

  // Total captures (non-deleted)
  const totalRow = db
    .prepare("SELECT COUNT(*) as n FROM captures WHERE deleted_at IS NULL")
    .get() as { n: number };

  // By type
  const typeRows = db
    .prepare(
      "SELECT type, COUNT(*) as n FROM captures WHERE deleted_at IS NULL GROUP BY type ORDER BY n DESC",
    )
    .all() as { type: string; n: number }[];

  // Top tags
  const tagRows = db
    .prepare(
      "SELECT tags FROM captures WHERE deleted_at IS NULL AND tags IS NOT NULL AND tags != '[]'",
    )
    .all() as { tags: string }[];
  const tagCounts: Record<string, number> = {};
  for (const row of tagRows) {
    try {
      const tags = JSON.parse(row.tags) as string[];
      for (const t of tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    } catch {
      // skip malformed
    }
  }
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Session count
  const sessionRow = db
    .prepare("SELECT COUNT(DISTINCT session_key) as n FROM captures WHERE deleted_at IS NULL")
    .get() as { n: number };

  // Date range
  const dateRow = db
    .prepare(
      "SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM captures WHERE deleted_at IS NULL",
    )
    .get() as { oldest: number | null; newest: number | null };

  // DB file size
  let dbSize = 0;
  try {
    const dbPath = db.name;
    const stat = await import("node:fs").then((fs) => fs.statSync(dbPath));
    dbSize = stat.size;
  } catch {
    // ignore
  }

  // Per-session stats if filtered
  let sessionStats: { sessionKey: string; count: number }[] | null = null;
  if (sessionKey !== "all") {
    const sRow = db
      .prepare("SELECT COUNT(*) as n FROM captures WHERE deleted_at IS NULL AND session_key = ?")
      .get(sessionKey) as { n: number };
    sessionStats = [{ sessionKey, count: sRow.n }];
  } else {
    sessionStats = (
      db
        .prepare(
          "SELECT session_key, COUNT(*) as n FROM captures WHERE deleted_at IS NULL GROUP BY session_key ORDER BY n DESC LIMIT 10",
        )
        .all() as { session_key: string; n: number }[]
    ).map((r) => ({ sessionKey: r.session_key, count: r.n }));
  }

  const result = {
    totalCaptures: totalRow.n,
    byType: Object.fromEntries(typeRows.map((r) => [r.type, r.n])),
    topTags: topTags.map(([tag, count]) => ({ tag, count })),
    sessionCount: sessionRow.n,
    dateRange: {
      oldest: dateRow.oldest ? new Date(dateRow.oldest).toISOString() : null,
      newest: dateRow.newest ? new Date(dateRow.newest).toISOString() : null,
    },
    dbSizeBytes: dbSize,
    dbSizeMB: Math.round((dbSize / 1024 / 1024) * 100) / 100,
    sessions: sessionStats,
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/**
 * Handle the health tool — diagnose memory server health.
 *
 * Checks DB connection, integrity, FTS5 index, sqlite-vec index, capture count,
 * schema version, embedding model, DB file size, and last capture timestamp.
 * Returns status "healthy" when all critical checks pass, "degraded" otherwise.
 */
async function handleHealth(
  _args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const db = getDb(opts);
  const checks: Record<string, unknown> = {};
  let degraded = false;

  // DB connection: can we read from the captures table?
  try {
    const row = db.prepare("SELECT COUNT(*) as n FROM captures").get() as { n: number };
    checks.dbConnection = { ok: true, rowCount: row.n };
  } catch (e) {
    checks.dbConnection = { ok: false, error: String(e) };
    degraded = true;
  }

  // DB integrity: PRAGMA integrity_check
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    const ok = row.integrity_check === "ok";
    checks.dbIntegrity = { ok, result: row.integrity_check };
    if (!ok) degraded = true;
  } catch (e) {
    checks.dbIntegrity = { ok: false, error: String(e) };
    degraded = true;
  }

  // FTS5 index status
  try {
    const row = db
      .prepare("SELECT * FROM captures_fts WHERE captures_fts MATCH 'test' LIMIT 1")
      .get() as { count?: number } | undefined;
    checks.fts5Index = { ok: true, reachable: true };
  } catch (e) {
    checks.fts5Index = { ok: false, reachable: false, error: String(e) };
    degraded = true;
  }

  // sqlite-vec index status
  try {
    const row = db.prepare("SELECT count(*) as n FROM captures_vec").get() as { n: number };
    checks.vecIndex = { ok: true, reachable: true, rowCount: row.n };
  } catch (e) {
    checks.vecIndex = { ok: false, reachable: false, error: String(e) };
    degraded = true;
  }

  // Total captures count (non-deleted)
  try {
    const row = db.prepare("SELECT COUNT(*) as n FROM captures WHERE deleted_at IS NULL").get() as {
      n: number;
    };
    checks.totalCaptures = row.n;
  } catch (e) {
    checks.totalCaptures = { error: String(e) };
    degraded = true;
  }

  // Schema version
  try {
    const row = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as {
      version: number | null;
    };
    checks.schemaVersion = row.version;
  } catch (e) {
    checks.schemaVersion = { error: String(e) };
    degraded = true;
  }

  // Embedding model (from REMEM_EMBEDDER env or default)
  const embeddingModel =
    process.env.REMEM_EMBEDDER ?? opts.embedder.model ?? "Xenova/all-MiniLM-L6-v2";
  checks.embeddingModel = embeddingModel;

  // DB file size
  let dbSizeBytes = 0;
  try {
    const dbPath = db.name;
    const stat = await import("node:fs").then((fs) => fs.statSync(dbPath));
    dbSizeBytes = stat.size;
  } catch {
    // ignore
  }
  checks.dbSizeBytes = dbSizeBytes;
  checks.dbSizeMB = Math.round((dbSizeBytes / 1024 / 1024) * 100) / 100;

  // Last capture timestamp
  try {
    const row = db
      .prepare("SELECT MAX(created_at) as last FROM captures WHERE deleted_at IS NULL")
      .get() as { last: number | null };
    checks.lastCapture = row.last ? new Date(row.last).toISOString() : null;
  } catch (e) {
    checks.lastCapture = { error: String(e) };
  }

  const result = {
    status: degraded ? "degraded" : "healthy",
    timestamp: new Date().toISOString(),
    checks,
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/** Handle the confirm tool — increase Bayesian confidence for a capture. */
async function handleConfirm(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const captureId = args.capture_id as string;
  if (!captureId) {
    return {
      content: [{ type: "text", text: "Error: capture_id is required." }],
      isError: true,
    };
  }
  const db = getDb(opts);
  const row = db
    .prepare(
      "SELECT id, confirmations, corrections FROM captures WHERE id = ? AND deleted_at IS NULL",
    )
    .get(captureId) as { id: string; confirmations: number; corrections: number } | undefined;
  if (!row) {
    return {
      content: [{ type: "text", text: `Error: Capture ${captureId} not found or deleted.` }],
      isError: true,
    };
  }
  try {
    db.prepare("UPDATE captures SET confirmations = confirmations + 1 WHERE id = ?").run(captureId);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }
  const alpha = 1 + row.confirmations + 1;
  const beta = 1 + row.corrections;
  const confidence = alpha / (alpha + beta);
  return {
    content: [
      {
        type: "text",
        text: `Confirmed capture ${captureId}. Confidence: ${confidence.toFixed(2)} (${row.confirmations + 1} confirmations, ${row.corrections} corrections).`,
      },
    ],
  };
}

/** Handle the correct tool — decrease Bayesian confidence for a capture. */
async function handleCorrect(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const captureId = args.capture_id as string;
  const reason = (args.reason as string) ?? "";
  if (!captureId) {
    return {
      content: [{ type: "text", text: "Error: capture_id is required." }],
      isError: true,
    };
  }
  const db = getDb(opts);
  const row = db
    .prepare(
      "SELECT id, confirmations, corrections FROM captures WHERE id = ? AND deleted_at IS NULL",
    )
    .get(captureId) as { id: string; confirmations: number; corrections: number } | undefined;
  if (!row) {
    return {
      content: [{ type: "text", text: `Error: Capture ${captureId} not found or deleted.` }],
      isError: true,
    };
  }
  try {
    db.prepare("UPDATE captures SET corrections = corrections + 1 WHERE id = ?").run(captureId);
    if (reason) {
      db.prepare("UPDATE captures SET rejection_reason = ? WHERE id = ?").run(reason, captureId);
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }
  const alpha = 1 + row.confirmations;
  const beta = 1 + row.corrections + 1;
  const confidence = alpha / (alpha + beta);
  return {
    content: [
      {
        type: "text",
        text: `Corrected capture ${captureId}. Confidence: ${confidence.toFixed(2)} (${row.confirmations} confirmations, ${row.corrections + 1} corrections).${reason ? ` Reason: ${reason}` : ""}`,
      },
    ],
  };
}

/** Handle the supersede tool — mark an old capture as replaced by a newer one. */
async function handleSupersede(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const oldId = args.old_id as string;
  const newId = args.new_id as string;
  if (!oldId || !newId) {
    return {
      content: [{ type: "text", text: "Error: old_id and new_id are required." }],
      isError: true,
    };
  }
  if (oldId === newId) {
    return {
      content: [{ type: "text", text: "Error: old_id and new_id cannot be the same." }],
      isError: true,
    };
  }
  const db = getDb(opts);
  const oldRow = db
    .prepare("SELECT id, content FROM captures WHERE id = ? AND deleted_at IS NULL")
    .get(oldId) as { id: string; content: string } | undefined;
  if (!oldRow) {
    return {
      content: [{ type: "text", text: `Error: Old capture ${oldId} not found or deleted.` }],
      isError: true,
    };
  }
  const newRow = db
    .prepare("SELECT id, content FROM captures WHERE id = ? AND deleted_at IS NULL")
    .get(newId) as { id: string; content: string } | undefined;
  if (!newRow) {
    return {
      content: [{ type: "text", text: `Error: New capture ${newId} not found or deleted.` }],
      isError: true,
    };
  }
  const { updated } = await opts.storage.supersede(oldId, newId);
  if (updated === 0) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Old capture ${oldId} could not be superseded (it may already be rejected).`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `Superseded: "${oldRow.content.slice(0, 60)}..." → "${newRow.content.slice(0, 60)}...".\nOld capture ${oldId} will be filtered from search results. New capture ${newId} takes precedence.`,
      },
    ],
  };
}

/** Handle the record_outcome tool — track if a correction was heeded or recurred. */
async function handleRecordOutcome(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const captureId = args.capture_id as string;
  const outcome = args.outcome as string;
  if (!captureId || (outcome !== "heeded" && outcome !== "recurred")) {
    return {
      content: [
        {
          type: "text",
          text: "Error: capture_id and outcome ('heeded' or 'recurred') are required.",
        },
      ],
      isError: true,
    };
  }
  const db = getDb(opts);
  const row = db
    .prepare(
      "SELECT id, heeded_count, recurrence_count FROM captures WHERE id = ? AND deleted_at IS NULL",
    )
    .get(captureId) as { id: string; heeded_count: number; recurrence_count: number } | undefined;
  if (!row) {
    return {
      content: [{ type: "text", text: `Error: Capture ${captureId} not found or deleted.` }],
      isError: true,
    };
  }
  try {
    opts.storage.recordCorrectionOutcome(captureId, outcome as "heeded" | "recurred");
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }
  const total = row.heeded_count + row.recurrence_count + 1;
  const heeded = outcome === "heeded" ? row.heeded_count + 1 : row.heeded_count;
  const precision = total > 0 ? heeded / total : 0;
  return {
    content: [
      {
        type: "text",
        text: `Recorded: correction ${captureId} was ${outcome}. Precision: ${precision.toFixed(2)} (${heeded}/${total} heeded).`,
      },
    ],
  };
}

/** Handle the correction_kpis tool — get correction learning metrics. */
async function handleCorrectionKPIs(
  _args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const kpis = opts.storage.getCorrectionKPIs();
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(kpis, null, 2),
      },
    ],
  };
}

/** Handle the session_start tool — return recent context + correction alignment. */
async function handleSessionStart(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const sessionKey = (args.session_key as string) ?? defaultSessionKey();
  const globalKey = globalSessionKey();
  const useGlobalFallback = !!globalKey && !args.session_key && globalKey !== sessionKey;
  const contextQuery = args.context_query as string | undefined;
  const db = getDb(opts);

  // Recent captures (last 5) from project session (+ global if configured)
  const sessionKeys = useGlobalFallback ? [sessionKey, globalKey] : [sessionKey];
  const placeholders = sessionKeys.map(() => "?").join(",");
  const recent = db
    .prepare(
      `SELECT id, session_key, type, content, tags, created_at FROM captures WHERE deleted_at IS NULL AND session_key IN (${placeholders}) ORDER BY created_at DESC LIMIT 5`,
    )
    .all(...sessionKeys) as {
    id: string;
    session_key: string;
    type: string;
    content: string;
    tags: string;
    created_at: number;
  }[];

  // Correction KPIs
  const kpis = opts.storage.getCorrectionKPIs();

  // Optional context query (with global fallback). Embedding/search failures
  // must not reject the whole session_start — degrade to empty context instead.
  let contextResults: string[] = [];
  if (contextQuery) {
    try {
      // Compute embedding first (mirror handleRecall) so a single embedder
      // failure doesn't blow up both the project and global searches.
      let queryEmbedding: number[] | null = null;
      try {
        queryEmbedding = await opts.embedder.embed(contextQuery);
      } catch (err) {
        console.error(`[remem-mcp] Embedding failed: ${err}`);
      }
      const reservedGlobal = useGlobalFallback ? 1 : 0;
      const projectResults = await opts.storage.search(contextQuery, queryEmbedding, {
        limit: 3 - reservedGlobal,
        offset: 0,
        mode: "hybrid",
        sessionKey,
      });
      let globalResults: SearchResult[] = [];
      if (useGlobalFallback) {
        try {
          globalResults = await opts.storage.search(contextQuery, queryEmbedding, {
            limit: reservedGlobal,
            offset: 0,
            mode: "hybrid",
            sessionKey: globalKey,
          });
        } catch {
          // Global search failure is non-fatal
        }
      }
      const seen = new Set(projectResults.map((r) => r.entry.id));
      const all = [...projectResults, ...globalResults.filter((r) => !seen.has(r.entry.id))].slice(
        0,
        3,
      );
      contextResults = all.map((r) => `[${r.entry.type}] ${r.entry.content.slice(0, 100)}`);
    } catch (err) {
      console.error(`[remem-mcp] session_start context query failed: ${err}`);
      contextResults = [];
    }
  }

  const summary: Record<string, unknown> = {
    sessionKey,
    globalMemoryEnabled: !!globalKey,
    globalSessionKey: globalKey ?? undefined,
    recentCaptures: recent.map((r) => ({
      id: r.id,
      type: r.type,
      preview: r.content.slice(0, 80),
      createdAt: new Date(r.created_at).toISOString(),
    })),
    correctionAlignment: {
      totalCorrections: kpis.totalCorrections,
      heedRate: kpis.heedRate,
      alignment:
        kpis.totalCorrections > 0
          ? `${Math.round(kpis.heedRate * 100)}% corrections heeded (${kpis.totalCorrections} total)`
          : "No corrections recorded yet",
    },
    contextResults,
  };

  // Show global captures separately so the agent knows they exist
  if (globalKey && recent.some((r) => r.session_key === globalKey)) {
    summary.globalCaptures = recent
      .filter((r) => r.session_key === globalKey)
      .map((r) => ({
        id: r.id,
        type: r.type,
        preview: r.content.slice(0, 80),
        createdAt: new Date(r.created_at).toISOString(),
      }));
  }

  return {
    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
  };
}

/** Handle the session_end tool — capture a summary if provided. */
async function handleSessionEnd(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const summary = args.summary as string | undefined;
  const tags = (args.tags as string[]) ?? ["session-summary"];

  if (!summary) {
    return {
      content: [{ type: "text", text: "Session ended. No summary provided." }],
    };
  }

  // Capture the summary as a memory
  const id = generateId();
  const entry: CaptureEntry = {
    id,
    sessionKey: (args.session_key as string) ?? defaultSessionKey(),
    agentId: detectAgentId(),
    type: "task",
    content: summary,
    tags: [...tags, "session-end"],
    createdAt: Date.now(),
  };
  try {
    await opts.storage.put(entry);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }
  try {
    const embedding = await opts.embedder.embed(summary);
    await opts.storage.putVector(id, embedding);
  } catch (err) {
    console.error(`[remem-mcp] Embedding failed: ${err}`);
  }

  return {
    content: [{ type: "text", text: `Session ended. Summary captured: ${id}` }],
  };
}

/** Handle the session_checkpoint tool — create a named checkpoint. */
async function handleSessionCheckpoint(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const name = args.name as string;
  const summary = (args.summary as string) ?? "";
  const sessionKey = (args.session_key as string) ?? defaultSessionKey();

  if (!name || name.trim() === "") {
    return {
      content: [{ type: "text", text: "Error: name is required and cannot be empty." }],
      isError: true,
    };
  }
  if (name.length > 100) {
    return {
      content: [{ type: "text", text: "Error: name must be 100 characters or less." }],
      isError: true,
    };
  }

  const db = getDb(opts);

  // Get recent captures as checkpoint snapshot
  const recent = db
    .prepare(
      "SELECT id, type, content, tags, created_at FROM captures WHERE deleted_at IS NULL AND session_key = ? ORDER BY created_at DESC LIMIT 20",
    )
    .all(sessionKey) as {
    id: string;
    type: string;
    content: string;
    tags: string;
    created_at: number;
  }[];

  // Store checkpoint as a capture with metadata
  const checkpointId = generateId();
  const checkpointContent = `Checkpoint: ${name}${summary ? ` — ${summary}` : ""}\n${recent.length} captures in snapshot.`;
  const entry: CaptureEntry = {
    id: checkpointId,
    sessionKey,
    agentId: detectAgentId(),
    type: "task",
    content: checkpointContent,
    tags: ["checkpoint", name],
    createdAt: Date.now(),
    metadata: {
      checkpointName: name,
      summary,
      captureIds: recent.map((r) => r.id),
      captureCount: recent.length,
    },
  };
  try {
    await opts.storage.put(entry);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }
  try {
    const embedding = await opts.embedder.embed(checkpointContent);
    await opts.storage.putVector(checkpointId, embedding);
  } catch (err) {
    console.error(`[remem-mcp] Embedding failed: ${err}`);
  }

  return {
    content: [
      {
        type: "text",
        text: `Checkpoint "${name}" created: ${checkpointId}. ${recent.length} captures snapshot. Recall with: recall("checkpoint ${name}")`,
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

  let result: Awaited<ReturnType<typeof opts.storage.supersede>>;
  try {
    result = await opts.storage.supersede(loser, winner);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: Supersede failed: ${err}` }],
      isError: true,
    };
  }

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
  let existing: CaptureEntry[] = [];
  try {
    existing = await opts.storage.findByContentHash(contentHash, sessionKey);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }
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

  try {
    await opts.storage.put(entry);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }

  try {
    const embedding = await opts.embedder.embed(content);
    await opts.storage.putVector(id, embedding);
  } catch (err) {
    console.error(`[remem-mcp] Embedding failed: ${err}`);
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
  let existing: CaptureEntry[] = [];
  try {
    existing = await opts.storage.findByContentHash(contentHash, sessionKey);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }
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

  try {
    await opts.storage.put(entry);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }

  try {
    const embedding = await opts.embedder.embed(content);
    await opts.storage.putVector(id, embedding);
  } catch (err) {
    console.error(`[remem-mcp] Embedding failed: ${err}`);
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

  try {
    await opts.storage.putKnowledge(entry);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }

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
  let count: number;
  try {
    count = await opts.storage.deleteKnowledge(knowledgeIds);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }
  opts.audit.log({
    tool: "knowledge_delete",
    argsHash: AuditLogger.hashArgs({ knowledgeIds }),
    resultLen: null,
    quotaHit: false,
    redacted: false,
  });
  return { content: [{ type: "text", text: `Deleted ${count} knowledge asset(s).` }] };
}

// ─── L2 scenario consolidation handler ──────────────────────────

async function handleScenarioConsolidate(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const atomIds = args.atom_ids as string[];
  const summary = args.summary as string;
  const personaTags = args.persona_tags as string[] | undefined;
  const { teamId, userId, taskId } = extractTenant(args);
  const agentId = (args.agent_id as string) ?? detectAgentId();

  if (!atomIds || atomIds.length === 0) {
    return { content: [{ type: "text", text: "Error: atom_ids is required." }], isError: true };
  }
  if (!summary || summary.trim().length < 10) {
    return { content: [{ type: "text", text: "Error: summary must be at least 10 characters." }], isError: true };
  }
  if (atomIds.length > 20) {
    return { content: [{ type: "text", text: "Error: Maximum 20 atom_ids per consolidation." }], isError: true };
  }

  const id = generateId();
  const scenario: ScenarioEntry = {
    id,
    atomIds,
    summary: summary.trim(),
    personaTags,
    createdAt: Date.now(),
    teamId,
    agentId,
    userId,
  };

  try {
    await opts.storage.putScenario(scenario);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }

  opts.audit.log({
    tool: "consolidate",
    argsHash: AuditLogger.hashArgs({ atomIds, summary }),
    resultLen: id.length,
    quotaHit: false,
    redacted: false,
  });

  return {
    content: [
      {
        type: "text",
        text: `Consolidated ${atomIds.length} atoms into scenario ${id}. Recall will inject this summary automatically.`,
      },
    ],
  };
}

// ─── L3 persona update handler ──────────────────────────────────

async function handlePersonaUpdate(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const trait = args.trait as string;
  const value = args.value as string;
  const { teamId, userId } = extractTenant(args);
  const agentId = (args.agent_id as string) ?? detectAgentId();

  if (!trait || !value) {
    return { content: [{ type: "text", text: "Error: trait and value are required." }], isError: true };
  }

  const tid = teamId ?? "default";
  const uid = userId ?? "default";

  // Read existing persona, append/update trait
  let existing = await opts.storage.readPersona(tid, agentId, uid);
  let content: string;
  if (existing) {
    // Parse existing content as "trait: value" lines, update or append
    const lines = existing.content.split("\n").filter((l) => l.trim());
    const traitPattern = new RegExp(`^${trait.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "i");
    const idx = lines.findIndex((l) => traitPattern.test(l));
    if (idx >= 0) {
      lines[idx] = `${trait}: ${value}`;
    } else {
      lines.push(`${trait}: ${value}`);
    }
    content = lines.join("\n");
  } else {
    content = `${trait}: ${value}`;
  }

  try {
    await opts.storage.writePersona(tid, agentId, uid, content);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
  }

  opts.audit.log({
    tool: "persona_update",
    argsHash: AuditLogger.hashArgs({ trait, value }),
    resultLen: content.length,
    quotaHit: false,
    redacted: false,
  });

  return {
    content: [
      {
        type: "text",
        text: `Persona updated: ${trait} = ${value}. SessionStart will inject this automatically.`,
      },
    ],
  };
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
  try {
    if (stat.isDirectory()) {
      results = await cgIndexDirectory(db, path, repoPath, teamId, maxFiles);
    } else {
      const result = await cgIndexFile(db, path, repoPath, teamId);
      results = [result];
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
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

async function handleCodegraphSearch(
  args: Record<string, unknown>,
  opts: ServerOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const query = args.query as string;
  const kind = args.kind as string | undefined;
  const language = args.language as string | undefined;
  const customPath = args.path as string | undefined;
  const teamId = (args.team_id as string) ?? undefined;
  const limit = (args.limit as number) ?? 20;

  if (!query) {
    return { content: [{ type: "text", text: "Error: query is required." }], isError: true };
  }

  const db = getDb(opts);
  // Scope search to the specified repo path if provided, so results
  // don't leak symbols from other indexed repos in the same DB.
  const repoPath = customPath || undefined;
  let symbols = cgSearchSymbols(db, query, { teamId, kind, language, limit, repoPath });

  // Auto-index: if no symbols found, try indexing the specified path
  // or the current directory, then retry the search.
  // This makes CodeGraph work with zero setup.
  if (symbols.length === 0) {
    const cwd = process.cwd();
    const { existsSync } = await import("node:fs");
    // Use custom path if provided, otherwise look for src/ in cwd
    let indexPath: string;
    let repoRoot: string;
    if (customPath) {
      indexPath = customPath;
      repoRoot = customPath;
    } else {
      indexPath = existsSync(`${cwd}/src`) ? `${cwd}/src` : cwd;
      repoRoot = cwd;
    }
    try {
      const results = await cgIndexDirectory(db, indexPath, repoRoot, teamId, 500);
      const indexed = results.filter((r) => !r.skipped);
      if (indexed.length > 0) {
        // Retry search after indexing, scoped to the repo
        symbols = cgSearchSymbols(db, query, { teamId, kind, language, limit, repoPath: repoRoot });
      }
      if (symbols.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No symbols found. Auto-indexed ${indexed.length} files from ${indexPath} — try a different search term, or call codegraph_index with a specific path.`,
            },
          ],
        };
      }
    } catch {
      return {
        content: [
          {
            type: "text",
            text: "No symbols found. Call codegraph_index with a path to index your codebase first.",
          },
        ],
      };
    }
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

  let results: import("./wiki/engine.js").IngestResult[];
  try {
    if (stat.isDirectory()) {
      results = wikiIngestDir(db, path, repoPath, teamId, maxFiles);
    } else {
      const result = wikiIngestFile(db, path, repoPath, teamId);
      results = [result];
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
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
