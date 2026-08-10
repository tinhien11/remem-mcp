/**
 * Storage backend interface.
 * The default implementation is SQLiteBackend.
 * Future implementations: PgVectorBackend, FileBackend, TdaiGatewayBackend.
 *
 * Adapted from TencentDB Agent Memory factory pattern (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 */

export type CaptureType = "conversation" | "decision" | "learning" | "task" | "error" | "atom";

export interface CaptureEntry {
  id: string;
  sessionKey: string;
  agentId: string;
  type: CaptureType;
  content: string;
  tags: string[];
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface SearchFilters {
  type?: CaptureType;
  tags?: string[];
  agentId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export type SearchMode = "hybrid" | "keyword" | "vector";

export interface QueryOptions {
  sessionKey?: string;
  limit: number;
  offset: number;
  mode: SearchMode;
  filters?: SearchFilters;
}

export interface SearchResult {
  entry: CaptureEntry;
  score: number;
}

export interface DeleteFilter {
  tags?: string[];
  type?: CaptureType;
  dateBefore?: string;
}

export interface DeleteResult {
  captures: number;
  atoms: number;
  scenarios: number;
}

export interface StorageBackend {
  /** Store a capture entry (L0). Returns the entry ID. */
  put(entry: CaptureEntry): Promise<void>;

  /** Store the vector embedding for a capture. */
  putVector(id: string, embedding: number[]): Promise<void>;

  /** Get a capture entry by ID. */
  get(id: string): Promise<CaptureEntry | null>;

  /** Hybrid search: BM25 + vector + RRF fusion. */
  search(query: string, queryEmbedding: number[] | null, opts: QueryOptions): Promise<SearchResult[]>;

  /** Find captures with content hash matching the given content. Used for dedup. */
  findByContentHash(contentHash: string, sessionKey?: string): Promise<CaptureEntry[]>;

  /** Delete a capture by ID. Also deletes children (atoms, scenarios). */
  delete(id: string): Promise<DeleteResult>;

  /** Delete captures that match the filter. */
  deleteByFilter(filter: DeleteFilter): Promise<DeleteResult>;

  /** Close the database connection. */
  close(): void;
}
