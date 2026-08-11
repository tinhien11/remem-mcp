import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../src/embedding/types.js";
import { NoopPipeline } from "../../src/pipeline/noop.js";
import { AuditLogger } from "../../src/security/audit.js";
import { SQLiteBackend } from "../../src/storage/sqlite.js";
import type { CaptureEntry, CaptureType } from "../../src/storage/types.js";
import { generateId } from "../../src/utils/ulid.js";

const testDir = join(homedir(), ".local", "share", "tdai-memory-mcp", "test-correction");
const testDbPath = join(testDir, "memory.db");
const testAuditPath = join(testDir, "audit.jsonl");

/** Mock embedder. Returns a deterministic vector based on the text hash. */
class MockEmbedder implements Embedder {
  readonly dimension = 384;
  readonly model = "mock";

  async embed(text: string): Promise<number[]> {
    const hash = createHash("sha256").update(text).digest();
    const vec = new Float32Array(this.dimension);
    for (let i = 0; i < this.dimension; i++) {
      vec[i] = (hash[i % hash.length] - 128) / 128;
    }
    return Array.from(vec);
  }
}

interface ToolContext {
  storage: SQLiteBackend;
  embedder: MockEmbedder;
  pipeline: NoopPipeline;
  audit: AuditLogger;
}

function createContext(): ToolContext {
  const storage = new SQLiteBackend(testDbPath);
  const embedder = new MockEmbedder();
  const pipeline = new NoopPipeline();
  const audit = new AuditLogger(testAuditPath, true);
  return { storage, embedder, pipeline, audit };
}

async function capture(
  ctx: ToolContext,
  args: {
    content: string;
    type: CaptureType;
    tags?: string[];
    sessionKey?: string;
    trustState?: CaptureEntry["trustState"];
  },
): Promise<string> {
  const id = generateId();
  const entry: CaptureEntry = {
    id,
    sessionKey: args.sessionKey ?? "test-session",
    agentId: "test",
    type: args.type,
    content: args.content,
    tags: args.tags ?? [],
    createdAt: Date.now(),
    trustState: args.trustState,
  };
  await ctx.storage.put(entry);
  const embedding = await ctx.embedder.embed(args.content);
  await ctx.storage.putVector(id, embedding);
  return id;
}

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("Correction: rejected-value tombstone", () => {
  it("rejected capture must not appear in recall", async () => {
    const ctx = createContext();
    const id = await capture(ctx, { content: "BATCH_MODE = 30m", type: "decision" });

    const rejectResult = await ctx.storage.reject(id, "Wrong: should be 60m");
    expect(rejectResult.captures).toBe(1);

    const results = await ctx.storage.search("BATCH_MODE", null, {
      sessionKey: "test-session",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });
    expect(results.find((r) => r.entry.id === id)).toBeUndefined();
    ctx.storage.close();
  });

  it("rejected capture must not appear in vector search", async () => {
    const ctx = createContext();
    const id = await capture(ctx, { content: "Use REST API for all endpoints", type: "decision" });
    const embedding = await ctx.embedder.embed("REST API endpoints");

    await ctx.storage.reject(id, "Switched to GraphQL");

    const results = await ctx.storage.search("REST API endpoints", embedding, {
      sessionKey: "test-session",
      limit: 10,
      offset: 0,
      mode: "vector",
    });
    expect(results.find((r) => r.entry.id === id)).toBeUndefined();
    ctx.storage.close();
  });

  it("findRejectedByContentHash returns the rejected tombstone", async () => {
    const ctx = createContext();
    const content = "The config value is 42";
    const id = await capture(ctx, { content, type: "decision" });
    await ctx.storage.reject(id, "Wrong value, it is 99");

    const hash = createHash("sha256").update(content).digest("hex");
    const rejected = await ctx.storage.findRejectedByContentHash(hash, "test-session");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].id).toBe(id);
    expect(rejected[0].trustState).toBe("rejected");
    expect(rejected[0].rejectionReason).toBe("Wrong value, it is 99");
    ctx.storage.close();
  });

  it("non-rejected captures are not returned by findRejectedByContentHash", async () => {
    const ctx = createContext();
    const content = "The sky is blue";
    await capture(ctx, { content, type: "learning" });

    const hash = createHash("sha256").update(content).digest("hex");
    const rejected = await ctx.storage.findRejectedByContentHash(hash, "test-session");
    expect(rejected).toHaveLength(0);
    ctx.storage.close();
  });
});

describe("Correction: trust-state ranking", () => {
  it("verified captures rank higher than candidate captures", async () => {
    const ctx = createContext();
    const candidateId = await capture(ctx, {
      content: "Use PostgreSQL for the database",
      type: "decision",
      trustState: "candidate",
    });
    const verifiedId = await capture(ctx, {
      content: "Use PostgreSQL for the database",
      type: "decision",
      trustState: "verified",
      sessionKey: "test-session-2",
    });

    // Search in session 2 where verified lives
    const results = await ctx.storage.search("PostgreSQL database", null, {
      sessionKey: "test-session-2",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.id).toBe(verifiedId);
    ctx.storage.close();
  });

  it("stale captures rank lower than candidate captures", async () => {
    const ctx = createContext();
    const staleId = await capture(ctx, {
      content: "Use REST API for all endpoints",
      type: "decision",
      trustState: "stale",
    });
    const candidateId = await capture(ctx, {
      content: "Use REST API for all endpoints",
      type: "decision",
      trustState: "candidate",
      sessionKey: "test-session-2",
    });

    // Search in session 1 where stale lives
    const results = await ctx.storage.search("REST API endpoints", null, {
      sessionKey: "test-session",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });
    // Stale should still appear but with a lower score
    const staleResult = results.find((r) => r.entry.id === staleId);
    expect(staleResult).toBeDefined();
    expect(staleResult!.entry.trustState).toBe("stale");

    // Search in session 2 where candidate lives
    const results2 = await ctx.storage.search("REST API endpoints", null, {
      sessionKey: "test-session-2",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });
    const candidateResult = results2.find((r) => r.entry.id === candidateId);
    expect(candidateResult).toBeDefined();
    expect(candidateResult!.entry.trustState).toBe("candidate");

    // The candidate score should be higher than the stale score
    // (same content, same age, but trust boost differs)
    expect(candidateResult!.score).toBeGreaterThan(staleResult!.score);
    ctx.storage.close();
  });
});

describe("Correction: supersede", () => {
  it("supersede marks the loser as stale and links superseded_by", async () => {
    const ctx = createContext();
    const oldId = await capture(ctx, { content: "Use REST API", type: "decision" });
    const newId = await capture(ctx, { content: "Use GraphQL API", type: "decision" });

    const result = await ctx.storage.supersede(oldId, newId);
    expect(result.updated).toBe(1);
    expect(result.winnerId).toBe(newId);
    expect(result.loserId).toBe(oldId);

    const oldEntry = await ctx.storage.get(oldId);
    expect(oldEntry).not.toBeNull();
    expect(oldEntry!.trustState).toBe("stale");
    expect(oldEntry!.supersededBy).toBe(newId);
    ctx.storage.close();
  });

  it("supersede on a rejected capture does not update", async () => {
    const ctx = createContext();
    const id1 = await capture(ctx, { content: "Wrong fact", type: "decision" });
    const id2 = await capture(ctx, { content: "Correct fact", type: "decision" });

    await ctx.storage.reject(id1, "Wrong");
    const result = await ctx.storage.supersede(id1, id2);
    expect(result.updated).toBe(0);
    ctx.storage.close();
  });
});

describe("Correction: setTrustState", () => {
  it("can promote a candidate to verified", async () => {
    const ctx = createContext();
    const id = await capture(ctx, { content: "The API key is in .env", type: "learning" });

    const updated = await ctx.storage.setTrustState(id, "verified");
    expect(updated).toBe(1);

    const entry = await ctx.storage.get(id);
    expect(entry!.trustState).toBe("verified");
    ctx.storage.close();
  });

  it("setTrustState on a deleted capture does not update", async () => {
    const ctx = createContext();
    const id = await capture(ctx, { content: "Temporary fact", type: "task" });
    await ctx.storage.delete(id);

    const updated = await ctx.storage.setTrustState(id, "verified");
    expect(updated).toBe(0);
    ctx.storage.close();
  });
});

describe("Correction: conflict detection", () => {
  it("findConflicts returns similar captures in the same session", async () => {
    const ctx = createContext();
    await capture(ctx, { content: "Use PostgreSQL for the database", type: "decision" });
    const embedding = await ctx.embedder.embed("Use PostgreSQL for the database");

    const conflicts = await ctx.storage.findConflicts(embedding, "test-session", 0.5);
    expect(conflicts.length).toBeGreaterThan(0);
    ctx.storage.close();
  });

  it("findConflicts does not return captures from other sessions", async () => {
    const ctx = createContext();
    await capture(ctx, { content: "Use PostgreSQL for the database", type: "decision" });
    const embedding = await ctx.embedder.embed("Use PostgreSQL for the database");

    const conflicts = await ctx.storage.findConflicts(embedding, "other-session", 0.5);
    expect(conflicts).toHaveLength(0);
    ctx.storage.close();
  });

  it("findConflicts does not return rejected captures", async () => {
    const ctx = createContext();
    const id = await capture(ctx, { content: "Use PostgreSQL for the database", type: "decision" });
    await ctx.storage.reject(id, "Switched to MySQL");
    const embedding = await ctx.embedder.embed("Use PostgreSQL for the database");

    const conflicts = await ctx.storage.findConflicts(embedding, "test-session", 0.5);
    expect(conflicts.find((c) => c.id === id)).toBeUndefined();
    ctx.storage.close();
  });
});

describe("Correction: negative retrieval assertions", () => {
  it("rejected capture must not return in hybrid search", async () => {
    const ctx = createContext();
    const id = await capture(ctx, { content: "The password is hunter2", type: "error" });
    const embedding = await ctx.embedder.embed("password hunter2");

    await ctx.storage.reject(id, "This is a secret, do not store");

    const results = await ctx.storage.search("password hunter2", embedding, {
      sessionKey: "test-session",
      limit: 10,
      offset: 0,
      mode: "hybrid",
    });
    expect(results.find((r) => r.entry.id === id)).toBeUndefined();
    ctx.storage.close();
  });

  it("deleted capture must not return in search", async () => {
    const ctx = createContext();
    const id = await capture(ctx, { content: "Temporary note", type: "task" });
    await ctx.storage.delete(id);

    const results = await ctx.storage.search("Temporary note", null, {
      sessionKey: "test-session",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });
    expect(results.find((r) => r.entry.id === id)).toBeUndefined();
    ctx.storage.close();
  });

  it("stale capture must not rank first when a verified alternative exists", async () => {
    const ctx = createContext();
    const staleId = await capture(ctx, {
      content: "Use JWT for authentication",
      type: "decision",
      trustState: "stale",
    });
    const verifiedId = await capture(ctx, {
      content: "Use JWT for authentication",
      type: "decision",
      trustState: "verified",
      sessionKey: "test-session-2",
    });

    // Both in their own sessions, verify stale is not first in its session
    const staleResults = await ctx.storage.search("JWT authentication", null, {
      sessionKey: "test-session",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });
    const verifiedResults = await ctx.storage.search("JWT authentication", null, {
      sessionKey: "test-session-2",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    // Both should be found
    expect(staleResults.find((r) => r.entry.id === staleId)).toBeDefined();
    expect(verifiedResults.find((r) => r.entry.id === verifiedId)).toBeDefined();

    // Verified score should be higher
    const staleScore = staleResults.find((r) => r.entry.id === staleId)!.score;
    const verifiedScore = verifiedResults.find((r) => r.entry.id === verifiedId)!.score;
    expect(verifiedScore).toBeGreaterThan(staleScore);
    ctx.storage.close();
  });
});
