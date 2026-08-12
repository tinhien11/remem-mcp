/**
 * Storage backend interface.
 * The default implementation is SQLiteBackend.
 * Future implementations: PgVectorBackend, FileBackend, TdaiGatewayBackend.
 *
 * Adapted from TencentDB Agent Memory factory pattern (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 */

export type CaptureType =
  | "conversation"
  | "decision"
  | "learning"
  | "task"
  | "error"
  | "atom"
  | "pattern";

/** Trust state for a capture. Controls retrieval filtering and ranking. */
export type TrustState = "candidate" | "verified" | "rejected" | "stale";

/** A single role-based message within a conversation capture. */
export interface CaptureMessage {
  role: string;
  content: string;
}

export interface CaptureEntry {
  id: string;
  sessionKey: string;
  agentId: string;
  type: CaptureType;
  content: string;
  tags: string[];
  createdAt: number;
  metadata?: Record<string, unknown>;
  /** Optional pre-computed content hash for dedup. If not set, it is computed from content. */
  contentHash?: string;
  /** Multi-tenant isolation: team ID. */
  teamId?: string;
  /** Multi-tenant isolation: user ID. */
  userId?: string;
  /** Multi-tenant isolation: task ID. */
  taskId?: string;
  /** Role-based conversation messages. If set, content is a flattened summary. */
  messages?: CaptureMessage[];
  /** Trust state: candidate (default), verified, rejected, stale. */
  trustState?: TrustState;
  /** Reason for rejection, if trust_state is 'rejected'. */
  rejectionReason?: string;
  /** ID of the capture that supersedes this one, if trust_state is 'stale'. */
  supersededBy?: string;
}

export interface MessageRow {
  id: string;
  captureId: string;
  role: string;
  content: string;
  seq: number;
  createdAt: number;
}

export interface SearchFilters {
  type?: CaptureType;
  tags?: string[];
  agentId?: string;
  dateFrom?: string;
  dateTo?: string;
  teamId?: string;
  userId?: string;
  taskId?: string;
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
  teamId?: string;
  userId?: string;
  taskId?: string;
}

export interface DeleteResult {
  captures: number;
  atoms: number;
  scenarios: number;
}

/** Result of a conflict detection check. */
export interface ConflictResult {
  id: string;
  content: string;
  distance: number;
  trustState: TrustState;
}

/** Result of a resolve operation. */
export interface ResolveResult {
  winnerId: string;
  loserId: string;
  updated: number;
}

/** L1 atomic fact extracted from a capture. */
export interface AtomEntry {
  id: string;
  captureId: string;
  fact: string;
  confidence: number;
  createdAt: number;
  teamId?: string;
  agentId?: string;
  userId?: string;
}

/** L2 scenario block. */
export interface ScenarioEntry {
  id: string;
  atomIds: string[];
  summary: string;
  personaTags?: string[];
  createdAt: number;
  teamId?: string;
  agentId?: string;
  userId?: string;
}

/** L3 persona. One per team/agent/user. */
export interface PersonaEntry {
  teamId: string;
  agentId: string;
  userId: string;
  content: string;
  updatedAt: number;
}

/** Knowledge asset (wiki or code-graph). */
export interface KnowledgeEntry {
  id: string;
  teamId: string;
  name: string;
  type: string;
  summary?: string;
  serviceUrl?: string;
  repoUrl?: string;
  branch?: string;
  createdAt: number;
}

/** Skill: reusable workflow extracted from conversations. */
export interface SkillEntry {
  id: string;
  teamId: string;
  agentId?: string;
  name: string;
  description?: string;
  content?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface StorageBackend {
  /** Store a capture entry (L0). Returns the entry ID. */
  put(entry: CaptureEntry): Promise<void>;

  /** Store the vector embedding for a capture. */
  putVector(id: string, embedding: number[]): Promise<void>;

  /** Get a capture entry by ID. */
  get(id: string): Promise<CaptureEntry | null>;

  /** Get the role-based messages for a capture, ordered by seq. */
  getMessages(captureId: string): Promise<MessageRow[]>;

  /** Hybrid search: BM25 + vector + RRF fusion. */
  search(
    query: string,
    queryEmbedding: number[] | null,
    opts: QueryOptions,
  ): Promise<SearchResult[]>;

  /** Find captures with content hash matching the given content. Used for dedup. */
  findByContentHash(contentHash: string, sessionKey?: string): Promise<CaptureEntry[]>;

  /** Find rejected tombstones by content hash. Used to block re-extraction of rejected values. */
  findRejectedByContentHash(contentHash: string, sessionKey?: string): Promise<CaptureEntry[]>;

  /** Delete a capture by ID. Also deletes children (atoms, scenarios, messages). */
  delete(id: string): Promise<DeleteResult>;

  /** Reject a capture: set trust_state to 'rejected' with a reason. Keeps the row as a tombstone. */
  reject(id: string, reason: string): Promise<DeleteResult>;

  /** Delete captures that match the filter. */
  deleteByFilter(filter: DeleteFilter): Promise<DeleteResult>;

  /** Find captures with vector distance below threshold (potential conflicts). */
  findConflicts(
    embedding: number[],
    sessionKey: string,
    threshold: number,
  ): Promise<ConflictResult[]>;

  /** Mark a capture as stale, superseded by another. Returns the number of rows updated. */
  supersede(loserId: string, winnerId: string): Promise<ResolveResult>;

  /** Set the trust state of a capture (e.g., candidate → verified). */
  setTrustState(id: string, state: TrustState): Promise<number>;

  // L1 atoms
  putAtom(atom: AtomEntry): Promise<void>;
  listAtoms(opts: {
    teamId?: string;
    agentId?: string;
    userId?: string;
    captureId?: string;
    limit?: number;
    offset?: number;
  }): Promise<AtomEntry[]>;
  searchAtoms(
    query: string,
    opts: { teamId?: string; agentId?: string; userId?: string; limit?: number },
  ): Promise<AtomEntry[]>;

  // L2 scenarios
  putScenario(scenario: ScenarioEntry): Promise<void>;
  listScenarios(opts: {
    teamId?: string;
    agentId?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<ScenarioEntry[]>;
  getScenario(id: string): Promise<ScenarioEntry | null>;

  // L3 persona
  readPersona(teamId: string, agentId: string, userId: string): Promise<PersonaEntry | null>;
  writePersona(teamId: string, agentId: string, userId: string, content: string): Promise<void>;

  // Knowledge
  putKnowledge(entry: KnowledgeEntry): Promise<void>;
  getKnowledge(id: string): Promise<KnowledgeEntry | null>;
  listKnowledge(teamId: string, type?: string): Promise<KnowledgeEntry[]>;
  deleteKnowledge(ids: string[]): Promise<number>;

  // Skills
  putSkill(entry: SkillEntry): Promise<void>;
  getSkill(id: string): Promise<SkillEntry | null>;
  listSkills(teamId: string, agentId?: string): Promise<SkillEntry[]>;
  searchSkills(
    teamId: string,
    agentId: string,
    query: string,
    topK?: number,
  ): Promise<SkillEntry[]>;

  /** Close the database connection. */
  close(): void;
}
