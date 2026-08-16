/**
 * Programmatic API for remem-mcp.
 * Use this to embed memory directly in your application without MCP.
 *
 * @example
 * ```ts
 * import { Memory } from "remem-mcp";
 *
 * const memory = new Memory();
 * await memory.capture("We chose SQLite for storage.", "decision", ["arch"]);
 * const results = await memory.recall("storage decision");
 * ```
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { LocalEmbedder } from "./embedding/local.js";
import { redact } from "./security/redactor.js";
import { SQLiteBackend, stripQueryProperNouns } from "./storage/sqlite.js";
import type {
  CaptureEntry,
  CaptureType,
  DeleteFilter,
  DeleteResult,
  SearchFilters,
  SearchMode,
  SearchResult,
} from "./storage/types.js";
import { generateId } from "./utils/ulid.js";

/**
 * Auto-classify content as global (cross-project) or project-specific.
 * Generic rules/conventions/learnings → global; content with file paths,
 * line numbers, project names, or specific identifiers → project.
 */
export function classifyGlobalContent(content: string, type: CaptureType): boolean {
  if (type !== "learning" && type !== "decision" && type !== "task") return false;

  // Project-specific signals → NOT global
  const projectSignals = [
    /\b\/[a-z]/i,
    /\b\w+\/\w+\.\w{1,5}\b/,
    /line\s*\d+/i,
    /\b\d{4,}\b/,
    /\bcommit\s+[0-9a-f]{7,}/i,
    /\bsrc\//,
    /\bdist\//,
    /\btests?\//,
  ];
  for (const sig of projectSignals) {
    if (sig.test(content)) return false;
  }

  const lower = content.toLowerCase();
  const globalSignals = [
    /\balways\s+/i,
    /\bnever\s+/i,
    /\brule\b/i,
    /\bconvention\b/i,
    /\bpattern\b/i,
    /\bprefer\b/i,
    /\bavoid\b/i,
    /\bshould\b/i,
    /\bbest\s+practice\b/i,
  ];
  let score = 0;
  for (const sig of globalSignals) {
    if (sig.test(lower)) score++;
  }

  if (content.length < 300 && score >= 1) return true;
  if (content.length < 150 && type === "learning") return true;
  return false;
}

export type {
  CaptureEntry,
  CaptureType,
  DeleteFilter,
  DeleteResult,
  SearchFilters,
  SearchMode,
  SearchResult,
};
export { LocalEmbedder, SQLiteBackend };

/** High-level memory API. */
export class Memory {
  private storage: SQLiteBackend;
  private embedder: LocalEmbedder;
  private sessionKey: string;
  private globalKey: string | null;
  private redactSecrets: boolean;

  constructor(opts?: {
    dbPath?: string;
    sessionKey?: string;
    globalSessionKey?: string;
    redactSecrets?: boolean;
  }) {
    const dbPath = opts?.dbPath ?? join(homedir(), ".local", "share", "remem-mcp", "memory.db");
    this.storage = new SQLiteBackend(dbPath);
    this.embedder = new LocalEmbedder();
    this.sessionKey =
      opts?.sessionKey ??
      process.env.REMEM_SESSION_KEY ??
      createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
    this.globalKey = opts?.globalSessionKey ?? process.env.REMEM_GLOBAL_SESSION_KEY ?? null;
    this.redactSecrets = opts?.redactSecrets ?? true;
  }

  /** Capture a memory entry. Returns the ID, or null if duplicate. */
  async capture(
    content: string,
    type: CaptureType,
    tags: string[] = [],
    opts?: { sessionKey?: string; autoGlobal?: boolean },
  ): Promise<string | null> {
    const { text: redactedContent } = this.redactSecrets ? redact(content) : { text: content };
    let sessionKey = opts?.sessionKey ?? this.sessionKey;

    // Auto-classify: route generic rules/learnings to global session
    if (opts?.autoGlobal && !opts?.sessionKey && this.globalKey && this.globalKey !== sessionKey) {
      if (classifyGlobalContent(content, type)) {
        sessionKey = this.globalKey;
      }
    }

    // Dedup check
    const contentHash = createHash("sha256").update(redactedContent).digest("hex");
    const existing = await this.storage.findByContentHash(contentHash, sessionKey);
    if (existing.length > 0) return null;

    const id = generateId();
    const entry: CaptureEntry = {
      id,
      sessionKey,
      agentId: "sdk",
      type,
      content: redactedContent,
      tags,
      createdAt: Date.now(),
    };

    await this.storage.put(entry);

    try {
      const embedding = await this.embedder.embed(redactedContent);
      await this.storage.putVector(id, embedding);
    } catch {
      // Embedding is optional
    }

    return id;
  }

  /** Recall relevant memory. Searches project + global (if configured). */
  async recall(
    query: string,
    opts?: { limit?: number; mode?: SearchMode; sessionKey?: string },
  ): Promise<SearchResult[]> {
    const limit = Math.min(opts?.limit ?? 10, 50);
    const mode = opts?.mode ?? "hybrid";
    const sessionKey = opts?.sessionKey ?? this.sessionKey;

    let queryEmbedding: number[] | null = null;
    if (mode === "hybrid" || mode === "vector") {
      const stripped = stripQueryProperNouns(query);
      queryEmbedding = await this.embedder.embed(stripped || query);
    }

    // Global fallback: search project first, then global for remaining slots
    if (this.globalKey && !opts?.sessionKey && this.globalKey !== sessionKey) {
      const reservedGlobal = Math.min(3, limit);
      const projectLimit = limit - reservedGlobal;
      const projectResults = await this.storage.search(query, queryEmbedding, {
        sessionKey,
        limit: projectLimit,
        offset: 0,
        mode,
      });
      let globalResults: SearchResult[] = [];
      try {
        globalResults = await this.storage.search(query, queryEmbedding, {
          sessionKey: this.globalKey,
          limit: reservedGlobal,
          offset: 0,
          mode,
        });
      } catch {
        // Global search failure is non-fatal
      }
      const seen = new Set(projectResults.map((r) => r.entry.id));
      return [...projectResults, ...globalResults.filter((r) => !seen.has(r.entry.id))].slice(0, limit);
    }

    return this.storage.search(query, queryEmbedding, {
      sessionKey,
      limit,
      offset: 0,
      mode,
    });
  }

  /** Search with filters. Searches project + global (if configured). */
  async search(
    query: string,
    opts?: { mode?: SearchMode; filters?: SearchFilters; limit?: number; sessionKey?: string },
  ): Promise<SearchResult[]> {
    const limit = Math.min(opts?.limit ?? 20, 100);
    const mode = opts?.mode ?? "hybrid";
    const sessionKey = opts?.sessionKey ?? this.sessionKey;

    let queryEmbedding: number[] | null = null;
    if (mode === "hybrid" || mode === "vector") {
      const stripped = stripQueryProperNouns(query);
      queryEmbedding = await this.embedder.embed(stripped || query);
    }

    // Global fallback
    if (this.globalKey && !opts?.sessionKey && this.globalKey !== sessionKey) {
      const reservedGlobal = Math.min(3, limit);
      const projectLimit = limit - reservedGlobal;
      const projectResults = await this.storage.search(query, queryEmbedding, {
        sessionKey,
        limit: projectLimit,
        offset: 0,
        mode,
        filters: opts?.filters,
      });
      let globalResults: SearchResult[] = [];
      try {
        globalResults = await this.storage.search(query, queryEmbedding, {
          sessionKey: this.globalKey,
          limit: reservedGlobal,
          offset: 0,
          mode,
          filters: opts?.filters,
        });
      } catch {
        // Global search failure is non-fatal
      }
      const seen = new Set(projectResults.map((r) => r.entry.id));
      return [...projectResults, ...globalResults.filter((r) => !seen.has(r.entry.id))].slice(0, limit);
    }

    return this.storage.search(query, queryEmbedding, {
      sessionKey,
      limit,
      offset: 0,
      mode,
      filters: opts?.filters,
    });
  }

  /** Compute the embedding vector for a piece of text using the configured embedder. */
  async embed(text: string): Promise<number[]> {
    return this.embedder.embed(text);
  }

  /** Delete a capture by ID. */
  async forget(id: string): Promise<DeleteResult> {
    return this.storage.delete(id);
  }

  /** Update an existing capture's content, tags, type, or trust state. */
  async update(id: string, opts: {
    content?: string;
    tags?: string[];
    type?: CaptureType;
    verified?: boolean;
  }): Promise<boolean> {
    const existing = await this.storage.get(id);
    if (!existing) return false;

    const newContent = opts.content ?? existing.content;
    const newTags = opts.tags ?? existing.tags;
    const newType = opts.type ?? existing.type;
    const newTrust = opts.verified ? "verified" : existing.trustState ?? "candidate";

    // Recompute content hash
    const contentHash = createHash("sha256").update(newContent).digest("hex");

    // Use raw SQL update (matches server.ts handleUpdate logic)
    const db = this.storage.getDatabase();
    db.prepare(
      "UPDATE captures SET content = ?, tags = ?, type = ?, trust_state = ?, content_hash = ? WHERE id = ?",
    ).run(newContent, JSON.stringify(newTags), newType, newTrust, contentHash, id);

    // Update FTS index
    const rowid = (db.prepare("SELECT rowid FROM captures WHERE id = ?").get(id) as
      | { rowid?: number }
      | undefined)?.rowid;
    if (rowid) {
      db.prepare(
        "INSERT INTO captures_fts(captures_fts, rowid, content, tags, type) VALUES('delete', ?, '', '', '')",
      ).run(rowid);
      db.prepare(
        "INSERT INTO captures_fts (rowid, id, content, tags, type) VALUES (?, ?, ?, ?, ?)",
      ).run(rowid, id, newContent, JSON.stringify(newTags), newType);
    }

    // Re-embed if content changed
    if (opts.content && opts.content !== existing.content) {
      try {
        const embedding = await this.embedder.embed(newContent);
        await this.storage.putVector(id, embedding);
      } catch {
        // Embedding is optional
      }
    }

    return true;
  }

  /** Find and optionally merge duplicate captures by content similarity (Jaccard). */
  async consolidate(opts: {
    threshold?: number;
    confirm?: boolean;
    sessionKey?: string;
  }): Promise<{
    groups: { ids: string[]; similarity: number; preview: string }[];
    merged: number;
  }> {
    const threshold = opts.threshold ?? 0.75;
    const confirm = opts.confirm ?? false;
    const sessionKey = opts.sessionKey ?? this.sessionKey;

    const db = this.storage.getDatabase();
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

    if (rows.length < 2) return { groups: [], merged: 0 };

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

    if (!confirm || groups.length === 0) {
      return { groups, merged: 0 };
    }

    // Merge: keep oldest, soft-delete rest (transactional)
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
    mergeTx();

    return { groups, merged };
  }

  /** Create a handoff packet for the next agent session. */
  async handoff(opts: {
    task: string;
    status: "in_progress" | "blocked" | "needs_review" | "done" | "assigned";
    progress: string;
    decisions?: string[];
    files?: string[];
    nextSteps?: string[];
  }): Promise<string | null> {
    const lines: string[] = [];
    lines.push(`# Handoff: ${opts.task}`);
    lines.push(`Status: ${opts.status}`);
    lines.push(`Date: ${new Date().toISOString()}`);
    lines.push("");
    lines.push("## Progress");
    lines.push(opts.progress);
    lines.push("");

    if (opts.decisions && opts.decisions.length > 0) {
      lines.push("## Decisions");
      for (const d of opts.decisions) lines.push(`- ${d}`);
      lines.push("");
    }
    if (opts.files && opts.files.length > 0) {
      lines.push("## Files");
      for (const f of opts.files) lines.push(`- ${f}`);
      lines.push("");
    }
    if (opts.nextSteps && opts.nextSteps.length > 0) {
      lines.push("## Next steps");
      opts.nextSteps.forEach((s, i) => {
        lines.push(`${i + 1}. ${s}`);
      });
      lines.push("");
    }

    const content = lines.join("\n");
    // Dedup: hash the structured data (excluding the timestamp)
    const dedupPayload = JSON.stringify({
      task: opts.task,
      status: opts.status,
      progress: opts.progress,
      decisions: opts.decisions ?? [],
      files: opts.files ?? [],
      nextSteps: opts.nextSteps ?? [],
    });
    const contentHash = createHash("sha256").update(dedupPayload).digest("hex");
    const existing = await this.storage.findByContentHash(contentHash, this.sessionKey);
    if (existing.length > 0) return null;

    const id = generateId();
    const entry: CaptureEntry = {
      id,
      sessionKey: this.sessionKey,
      agentId: "sdk",
      type: "task",
      content,
      tags: ["handoff", `status:${opts.status}`],
      createdAt: Date.now(),
      metadata: {
        handoff: true,
        task: opts.task,
        status: opts.status,
        progress: opts.progress,
        decisions: opts.decisions ?? [],
        files: opts.files ?? [],
        nextSteps: opts.nextSteps ?? [],
      },
      contentHash,
    };

    await this.storage.put(entry);

    try {
      const embedding = await this.embedder.embed(content);
      await this.storage.putVector(id, embedding);
    } catch {
      // Embedding is optional
    }

    return id;
  }

  /** Record an Architecture Decision Record (ADR). */
  async adr(opts: {
    title: string;
    context: string;
    decision: string;
    alternatives?: string[];
    consequences?: string;
    tags?: string[];
  }): Promise<string | null> {
    const lines: string[] = [];
    lines.push(`# ADR: ${opts.title}`);
    lines.push(`Date: ${new Date().toISOString()}`);
    lines.push("");
    lines.push("## Context");
    lines.push(opts.context);
    lines.push("");
    lines.push("## Decision");
    lines.push(opts.decision);
    lines.push("");

    const alternatives = Array.isArray(opts.alternatives)
      ? opts.alternatives
      : typeof opts.alternatives === "string" && opts.alternatives
        ? [opts.alternatives]
        : [];
    if (alternatives.length > 0) {
      lines.push("## Alternatives considered");
      for (const alt of alternatives) lines.push(`- ${alt}`);
      lines.push("");
    }
    if (opts.consequences) {
      lines.push("## Consequences");
      lines.push(opts.consequences);
      lines.push("");
    }

    const content = lines.join("\n");
    const dedupPayload = JSON.stringify({
      title: opts.title,
      context: opts.context,
      decision: opts.decision,
      alternatives,
      consequences: opts.consequences ?? "",
    });
    const contentHash = createHash("sha256").update(dedupPayload).digest("hex");
    const existing = await this.storage.findByContentHash(contentHash, this.sessionKey);
    if (existing.length > 0) return null;

    const id = generateId();
    const entry: CaptureEntry = {
      id,
      sessionKey: this.sessionKey,
      agentId: "sdk",
      type: "decision",
      content,
      tags: ["adr", ...(opts.tags ?? [])],
      createdAt: Date.now(),
      metadata: {
        adr: true,
        title: opts.title,
        context: opts.context,
        decision: opts.decision,
        alternatives,
        consequences: opts.consequences ?? "",
      },
      contentHash,
    };

    await this.storage.put(entry);

    try {
      const embedding = await this.embedder.embed(content);
      await this.storage.putVector(id, embedding);
    } catch {
      // Embedding is optional
    }

    return id;
  }

  /** Close the database connection. */
  close(): void {
    this.storage.close();
  }
}

export type {
  CallInfo,
  ImpactResult,
  ImportInfo,
  IndexResult,
  SymbolInfo,
} from "./codegraph/engine.js";
// Re-export CodeGraph engine for programmatic use
export {
  detectLanguage,
  findCallees,
  findCallers,
  impactAnalysis,
  indexDirectory,
  indexFile,
  listSymbols,
  SUPPORTED_LANGUAGES,
  searchSymbols,
} from "./codegraph/engine.js";
export type { IngestResult as WikiIngestResult, WikiLink, WikiPage } from "./wiki/engine.js";
// Re-export Wiki engine for programmatic use
export {
  findOutdatedPages,
  getWikiPage,
  ingestDirectory as wikiIngestDirectory,
  ingestFile as wikiIngestFile,
  searchWiki,
} from "./wiki/engine.js";
