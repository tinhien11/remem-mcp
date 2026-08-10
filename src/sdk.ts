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

import { SQLiteBackend } from "./storage/sqlite.js";
import { LocalEmbedder } from "./embedding/local.js";
import { generateId } from "./utils/ulid.js";
import { redact } from "./security/redactor.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CaptureType, CaptureEntry, SearchResult, DeleteFilter, DeleteResult, SearchMode, SearchFilters } from "./storage/types.js";

export { SQLiteBackend, LocalEmbedder };
export type { CaptureType, CaptureEntry, SearchResult, DeleteFilter, DeleteResult, SearchMode, SearchFilters };

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
    const dbPath = opts?.dbPath ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db");
    this.storage = new SQLiteBackend(dbPath);
    this.embedder = new LocalEmbedder();
    this.sessionKey = opts?.sessionKey ?? createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
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
  async recall(query: string, opts?: { limit?: number; mode?: SearchMode }): Promise<SearchResult[]> {
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
  async search(query: string, opts?: { mode?: SearchMode; filters?: SearchFilters; limit?: number }): Promise<SearchResult[]> {
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

  /** Close the database connection. */
  close(): void {
    this.storage.close();
  }
}
