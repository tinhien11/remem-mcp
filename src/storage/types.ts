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
  /** v12: When true, attach per-hit score_details explaining ranking. */
  explain?: boolean;
}

export interface ScoreDetails {
  bm25_rank?: number;
  bm25_score?: number;
  vector_rank?: number;
  vector_score?: number;
  entity_rank?: number;
  entity_matches?: string[];
  authority_multiplier?: number;
  feedback_salience?: number;
  link_provenance?: string;  // "expanded from <id>" if link-neighbor
  raw_fallback?: boolean;
}

export interface SearchResult {
  entry: CaptureEntry;
  score: number;
  /** v12: Per-hit score breakdown when explain=true. */
  scoreDetails?: ScoreDetails;
}

export interface DeleteFilter {
  tags?: string[];
  type?: CaptureType;
  dateBefore?: string;
  sessionKey?: string;
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
  /** Project session key (hash(cwd)). Scopes scenario injection to its project. */
  sessionKey?: string;
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
  /** v9: Skill auto-extraction fields */
  triggerConditions?: string[];
  steps?: string[];
  validationRules?: string[];
  sourceCaptureIds?: string[];
  archived?: boolean;
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

  /** Find captures by tag (bypasses FTS5, direct SQL on tags column). */
  listByTags(tags: string[], limit?: number, sessionKey?: string): Promise<CaptureEntry[]>;

  /** List recent captures (bypasses FTS5, direct SQL). Used by extract CLI. */
  listAll(limit?: number, offset?: number): Promise<CaptureEntry[]>;

  /** Delete all atoms for a capture (used when agent provides replacement atoms). */
  deleteAtomsByCaptureId(captureId: string): void;

  /** Find captures with content hash matching the given content. Used for dedup.
   *  When agentId is provided, dedup is scoped to that agent — the same content
   *  captured by a different agent is not treated as a duplicate. */
  findByContentHash(
    contentHash: string,
    sessionKey?: string,
    agentId?: string,
  ): Promise<CaptureEntry[]>;

  /** Find rejected tombstones by content hash. Used to block re-extraction of rejected values.
   *  Tombstone check is global — a rejected value is blocked across all projects and agents. */
  findRejectedByContentHash(
    contentHash: string,
    sessionKey?: string,
    agentId?: string,
  ): Promise<CaptureEntry[]>;

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

  /** Increment the access count for captures (Mem0-style access tracking). */
  recordAccess(ids: string[]): void;

  /** Increment the confirmation count for a capture (Bayesian confidence). */
  confirmCapture(id: string): void;

  /** Increment the correction count for a capture (Bayesian confidence). */
  correctCapture(id: string): void;

  /** Increment the retrieved count for a correction capture. */
  incrementRetrievedCount(id: string): void;

  /** Record the outcome of a correction (heeded or recurred). */
  recordCorrectionOutcome(id: string, outcome: "heeded" | "recurred"): void;

  /** Get correction learning KPIs (precision, heed rate, noise/high-signal candidates). */
  getCorrectionKPIs(): {
    totalCorrections: number;
    avgPrecision: number;
    heedRate: number;
    noiseCandidates: { id: string; precision: number; content: string }[];
    highSignalCandidates: { id: string; precision: number; content: string }[];
  };

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
    sessionKey?: string;
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

  // Canvas (v9: symbolic short-term memory)
  /** Append a node + edges to a session's Mermaid canvas. */
  appendCanvasNode(
    sessionKey: string,
    node: { id: string; label: string; captureId: string },
    edges: Array<{ from: string; to: string; label?: string }>,
    teamId?: string,
  ): Promise<void>;

  /** Get the latest node in a session's canvas (for linking new nodes). */
  getLatestCanvasNode(
    sessionKey: string,
  ): Promise<{ id: string; label: string; captureId: string } | null>;

  /** Get the cached Mermaid text for a session (fast path). */
  getCanvasMermaidText(sessionKey: string): Promise<string | null>;

  /** Write raw content to a ref file (context offloading). */
  writeRef(sessionKey: string, nodeId: string, content: string): Promise<void>;

  /** Read raw content from a ref file by node_id. */
  readRef(nodeId: string): Promise<string | null>;

  /** Close the database connection. */
  close(): void;

  // v10: Decay/forget sweep

  /** Run a forget sweep: compute salience for all captures, soft-delete those below threshold.
   *  Returns stats: { swept, remaining, checked }. */
  forgetSweep(opts?: {
    dryRun?: boolean;
    threshold?: number;
    maxAgeDays?: number;
  }): Promise<{ swept: number; remaining: number; checked: number }>;

  // v10: Entity-assisted recall

  /** Store extracted entities for a capture (replaces existing). */
  putEntities(captureId: string, entities: string[]): void;

  /** Get entities for a capture. */
  getEntities(captureId: string): string[];

  /** Search captures by entity match (lexical). Returns capture IDs ranked by match count. */
  searchByEntities(
    entities: string[],
    limit: number,
    sessionKey?: string,
    filters?: { teamId?: string; userId?: string; taskId?: string; type?: string },
  ): { id: string; score: number }[];

  // v11: Memory-to-memory links

  /** Link two captures. Auto-links use auto=1. */
  linkCaptures(fromId: string, toId: string, linkType: string, auto?: boolean): void;

  /** Get links from a capture (outbound). */
  getLinksFrom(captureId: string): { to_id: string; link_type: string; auto: number }[];

  /** Get links to a capture (inbound). */
  getLinksTo(captureId: string): { from_id: string; link_type: string; auto: number }[];

  /** Expand capture IDs via link-neighbor traversal (1-hop). Returns {id, hopScore}. */
  expandByLinks(ids: string[], limit: number): { id: string; score: number }[];

  /** v13: Hebbian co-retrieval strengthening. Strengthens links between co-occurring captures. */
  strengthenLinksOnCoRetrieval(ids: string[]): void;

  // v12: Feedback + audit + TTL

  /** Record feedback signal for a capture. Adjusts feedback_salience multiplier. */
  recordFeedback(
    captureId: string,
    signal: "helpful" | "not_helpful" | "stale" | "wrong",
    reason?: string,
    agentId?: string,
  ): void;

  /** Get feedback signals for a capture. */
  getFeedback(captureId: string): { signal: string; reason: string | null; created_at: number }[];

  /** Record an audit log entry. Called by all write methods. */
  recordAudit(action: string, captureId: string | null, details?: unknown, agentId?: string): void;

  /** Query audit log. */
  queryAudit(opts: { action?: string; captureId?: string; since?: number; limit?: number }): {
    id: number;
    action: string;
    capture_id: string | null;
    details: string | null;
    agent_id: string | null;
    created_at: number;
  }[];
}
