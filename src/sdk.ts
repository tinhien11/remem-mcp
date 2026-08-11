/**
 * Programmatic API for tdai-memory-mcp.
 * Use this to embed memory directly in your application without MCP.
 *
 * @example
 * ```ts
 * import { Memory } from "tdai-memory-mcp";
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
import { SQLiteBackend } from "./storage/sqlite.js";
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
  private redactSecrets: boolean;

  constructor(opts?: {
    dbPath?: string;
    sessionKey?: string;
    redactSecrets?: boolean;
  }) {
    const dbPath =
      opts?.dbPath ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db");
    this.storage = new SQLiteBackend(dbPath);
    this.embedder = new LocalEmbedder();
    this.sessionKey =
      opts?.sessionKey ?? createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
    this.redactSecrets = opts?.redactSecrets ?? true;
  }

  /** Capture a memory entry. Returns the ID, or null if duplicate. */
  async capture(content: string, type: CaptureType, tags: string[] = []): Promise<string | null> {
    const { text: redactedContent } = this.redactSecrets ? redact(content) : { text: content };

    // Dedup check
    const contentHash = createHash("sha256").update(redactedContent).digest("hex");
    const existing = await this.storage.findByContentHash(contentHash, this.sessionKey);
    if (existing.length > 0) return null;

    const id = generateId();
    const entry: CaptureEntry = {
      id,
      sessionKey: this.sessionKey,
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

  /** Recall relevant memory. */
  async recall(
    query: string,
    opts?: { limit?: number; mode?: SearchMode },
  ): Promise<SearchResult[]> {
    const limit = Math.min(opts?.limit ?? 10, 50);
    const mode = opts?.mode ?? "hybrid";

    let queryEmbedding: number[] | null = null;
    if (mode === "hybrid" || mode === "vector") {
      queryEmbedding = await this.embedder.embed(query);
    }

    return this.storage.search(query, queryEmbedding, {
      sessionKey: this.sessionKey,
      limit,
      offset: 0,
      mode,
    });
  }

  /** Search with filters. */
  async search(
    query: string,
    opts?: { mode?: SearchMode; filters?: SearchFilters; limit?: number },
  ): Promise<SearchResult[]> {
    const limit = Math.min(opts?.limit ?? 20, 100);
    const mode = opts?.mode ?? "hybrid";

    let queryEmbedding: number[] | null = null;
    if (mode === "hybrid" || mode === "vector") {
      queryEmbedding = await this.embedder.embed(query);
    }

    return this.storage.search(query, queryEmbedding, {
      limit,
      offset: 0,
      mode,
      filters: opts?.filters,
    });
  }

  /** Delete a capture by ID. */
  async forget(id: string): Promise<DeleteResult> {
    return this.storage.delete(id);
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

    if (opts.alternatives && opts.alternatives.length > 0) {
      lines.push("## Alternatives considered");
      for (const alt of opts.alternatives) lines.push(`- ${alt}`);
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
      alternatives: opts.alternatives ?? [],
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
        alternatives: opts.alternatives ?? [],
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
