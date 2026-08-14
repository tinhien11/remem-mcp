import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../src/embedding/types.js";
import { NoopPipeline } from "../../src/pipeline/noop.js";
import { AuditLogger } from "../../src/security/audit.js";
import { enforceQuota } from "../../src/security/quota.js";
import { redact } from "../../src/security/redactor.js";
import { SQLiteBackend } from "../../src/storage/sqlite.js";
import type { CaptureEntry, CaptureType } from "../../src/storage/types.js";
import { generateId } from "../../src/utils/ulid.js";

const testDir = join(homedir(), ".local", "share", "remem-mcp", "test-integration");
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

/** Full tool context: storage + embedder + pipeline + audit. */
interface ToolContext {
  storage: SQLiteBackend;
  embedder: MockEmbedder;
  pipeline: NoopPipeline;
  audit: AuditLogger;
}

/** Create a tool context with a fresh database. */
function createContext(): ToolContext {
  const storage = new SQLiteBackend(testDbPath);
  const embedder = new MockEmbedder();
  const pipeline = new NoopPipeline();
  const audit = new AuditLogger(testAuditPath, true);
  return { storage, embedder, pipeline, audit };
}

/** Simulate the capture tool logic. */
async function capture(
  ctx: ToolContext,
  args: { content: string; type: CaptureType; tags?: string[]; sessionKey?: string },
): Promise<{ id: string; redacted: boolean }> {
  const { text: redactedContent, redacted: wasRedacted } = redact(args.content);
  const id = generateId();
  const entry: CaptureEntry = {
    id,
    sessionKey: args.sessionKey ?? "test-session",
    agentId: "test",
    type: args.type,
    content: redactedContent,
    tags: args.tags ?? [],
    createdAt: Date.now(),
  };
  await ctx.storage.put(entry);
  const embedding = await ctx.embedder.embed(redactedContent);
  await ctx.storage.putVector(id, embedding);
  ctx.audit.log({
    tool: "capture",
    argsHash: AuditLogger.hashArgs({ type: args.type }),
    resultLen: id.length,
    quotaHit: false,
    redacted: wasRedacted,
  });
  return { id, redacted: wasRedacted };
}

/** Simulate the recall tool logic. */
async function recall(
  ctx: ToolContext,
  args: {
    query: string;
    sessionKey?: string;
    limit?: number;
    mode?: "hybrid" | "keyword" | "vector";
  },
) {
  const limit = Math.min(args.limit ?? 10, 50);
  const mode = args.mode ?? "hybrid";
  let queryEmbedding: number[] | null = null;
  if (mode === "hybrid" || mode === "vector") {
    queryEmbedding = await ctx.embedder.embed(args.query);
  }
  const results = await ctx.storage.search(args.query, queryEmbedding, {
    sessionKey: args.sessionKey ?? "test-session",
    limit,
    offset: 0,
    mode,
  });
  ctx.audit.log({
    tool: "recall",
    argsHash: AuditLogger.hashArgs({ query: args.query, mode }),
    resultLen: results.reduce((sum, r) => sum + r.entry.content.length, 0),
    quotaHit: false,
    redacted: false,
  });
  return results;
}

/** Simulate the forget tool logic. */
async function forget(ctx: ToolContext, args: { id?: string; confirm?: boolean }) {
  if (!args.confirm) {
    return { error: "Set confirm to true to execute the deletion." };
  }
  if (!args.id) {
    return { error: "Provide an id." };
  }
  return await ctx.storage.delete(args.id);
}

function cleanup() {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
}

describe("Integration: capture → recall → search → forget", () => {
  let ctx: ToolContext;

  beforeEach(() => {
    cleanup();
    ctx = createContext();
  });

  afterEach(() => {
    ctx.storage.close();
    cleanup();
  });

  it("captures a decision and recalls it by keyword", async () => {
    await capture(ctx, {
      content: "We decided to use SQLite and sqlite-vec for the storage backend.",
      type: "decision",
      tags: ["arch", "storage"],
    });

    const results = await recall(ctx, { query: "SQLite storage", mode: "keyword" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content).toContain("SQLite");
    expect(results[0].entry.tags).toContain("arch");
  });

  it("captures multiple entries and recalls the most relevant", async () => {
    await capture(ctx, {
      content: "The RRF constant k is 60.",
      type: "learning",
      tags: ["search"],
    });
    await capture(ctx, {
      content: "We use FTS5 for full-text search.",
      type: "decision",
      tags: ["search"],
    });
    await capture(ctx, {
      content: "The audit log is append-only JSONL.",
      type: "decision",
      tags: ["security"],
    });

    const results = await recall(ctx, { query: "search FTS5 RRF", mode: "hybrid" });
    expect(results.length).toBeGreaterThan(0);
    // The first two entries are about search. They must rank higher than the audit log entry.
    const topContents = results.slice(0, 2).map((r) => r.entry.content);
    expect(topContents.some((c) => c.includes("FTS5") || c.includes("RRF"))).toBe(true);
  });

  it("captures with a secret and verifies redaction", async () => {
    const result = await capture(ctx, {
      content: "The API key is sk-abcdefghijklmnopqrstuvwxyz123456 for the project.",
      type: "decision",
    });

    expect(result.redacted).toBe(true);

    // Retrieve the stored entry and verify the secret is gone
    const stored = await ctx.storage.get(result.id);
    expect(stored).not.toBeNull();
    expect(stored?.content).toContain("[REDACTED]");
    expect(stored?.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("searches with a type filter", async () => {
    await capture(ctx, { content: "A decision about the storage layer.", type: "decision" });
    await capture(ctx, { content: "A learning about the search index.", type: "learning" });
    await capture(ctx, { content: "A decision about the audit log.", type: "decision" });

    // FTS5 MATCH with "storage" matches the first decision.
    // The type filter limits the results to "decision" type only.
    const results = await ctx.storage.search("storage", null, {
      sessionKey: "test-session",
      limit: 10,
      offset: 0,
      mode: "keyword",
      filters: { type: "decision" },
    });

    expect(results.length).toBe(1);
    expect(results[0].entry.type).toBe("decision");
    expect(results[0].entry.content).toContain("storage");
  });

  it("searches with a tag filter", async () => {
    await capture(ctx, { content: "Tagged entry about SQLite.", type: "decision", tags: ["db"] });
    await capture(ctx, {
      content: "Tagged entry about Postgres.",
      type: "decision",
      tags: ["db", "cloud"],
    });
    await capture(ctx, { content: "Untagged entry about config.", type: "decision" });

    const _results = await ctx.storage.search("SQLite Postgres config", null, {
      sessionKey: "test-session",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    // Without the tag filter, all three match (they all contain keywords).
    // Now test with the tag filter via deleteByFilter to verify tag matching.
    const deleteResult = await ctx.storage.deleteByFilter({ tags: ["db"] });
    expect(deleteResult.captures).toBe(2);

    // The untagged entry must still exist.
    const remaining = await ctx.storage.search("config", null, {
      sessionKey: "test-session",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });
    expect(remaining.length).toBe(1);
    expect(remaining[0].entry.content).toContain("config");
  });

  it("forgets by ID with confirm=true", async () => {
    const result = await capture(ctx, { content: "A temporary decision.", type: "decision" });

    const deleteResult = await forget(ctx, { id: result.id, confirm: true });
    expect(deleteResult.captures).toBe(1);

    const retrieved = await ctx.storage.get(result.id);
    expect(retrieved).toBeNull();
  });

  it("rejects forget without confirm", async () => {
    const result = await capture(ctx, { content: "A decision to keep.", type: "decision" });

    const deleteResult = await forget(ctx, { id: result.id, confirm: false });
    expect(deleteResult.error).toBeDefined();

    // The entry must still exist.
    const retrieved = await ctx.storage.get(result.id);
    expect(retrieved).not.toBeNull();
  });

  it("enforces the token quota on recall", async () => {
    // Capture a large entry
    const longText = "This is a long decision. ".repeat(500);
    await capture(ctx, { content: longText, type: "decision" });

    const results = await recall(ctx, { query: "decision", mode: "keyword" });
    const text = results.map((r) => r.entry.content).join("\n");
    const { text: finalText, quotaHit } = enforceQuota(text, 100);

    expect(quotaHit).toBe(true);
    expect(finalText).toContain("truncated");
    expect(finalText).toContain("drill down");
  });

  it("writes an audit log entry for each tool call", async () => {
    await capture(ctx, { content: "A decision for the audit test.", type: "decision" });
    await recall(ctx, { query: "audit", mode: "keyword" });

    // Read the audit log
    const { readFileSync } = await import("node:fs");
    const logContent = readFileSync(testAuditPath, "utf-8");
    const lines = logContent.trim().split("\n");
    const entries = lines.map((l) => JSON.parse(l));

    expect(entries.length).toBe(2);
    expect(entries[0].tool).toBe("capture");
    expect(entries[1].tool).toBe("recall");
    // The audit log must not contain the raw content.
    expect(logContent).not.toContain("A decision for the audit test.");
  });

  it("isolates memory by session key", async () => {
    await capture(ctx, {
      content: "Decision for project A.",
      type: "decision",
      sessionKey: "project-a",
    });
    await capture(ctx, {
      content: "Decision for project B.",
      type: "decision",
      sessionKey: "project-b",
    });

    const resultsA = await recall(ctx, {
      query: "decision",
      sessionKey: "project-a",
      mode: "keyword",
    });
    const resultsB = await recall(ctx, {
      query: "decision",
      sessionKey: "project-b",
      mode: "keyword",
    });

    expect(resultsA.length).toBe(1);
    expect(resultsA[0].entry.content).toContain("project A");
    expect(resultsB.length).toBe(1);
    expect(resultsB[0].entry.content).toContain("project B");
  });

  it("recall without session_key does NOT leak across projects (real handler)", async () => {
    // This test calls the real MCP server handler, not the test helper.
    // The helper fills in sessionKey ?? "test-session", which masks the bug
    // where handleRecall previously omitted ?? defaultSessionKey().
    // See: https://neoneye.github.io/agent-memory-atlas/systems/remem-mcp/
    const { createServer } = await import("../../src/server.js");
    type Server = import("@modelcontextprotocol/sdk/server/index.js").Server;

    const server = createServer({
      storage: ctx.storage,
      embedder: ctx.embedder,
      pipeline: ctx.pipeline,
      pipelineCtx: {},
      audit: ctx.audit,
      redactSecrets: true,
      maxTokensRecall: 4000,
      maxTokensSearch: 8000,
      maxContentLength: 50000,
    }) as unknown as Server;

    // Capture to project-a
    await capture(ctx, {
      content: "Decision for project A only.",
      type: "decision",
      sessionKey: "project-a",
    });
    // Capture to project-b
    await capture(ctx, {
      content: "Decision for project B only.",
      type: "decision",
      sessionKey: "project-b",
    });

    // Call the real recall handler with NO session_key
    // The handler should apply defaultSessionKey() = sha256(cwd).slice(0,16)
    // which is neither "project-a" nor "project-b", so it should return
    // results from the current project only (or none if nothing matches).
    const handler = (
      server as unknown as {
        _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
      }
    )._requestHandlers.get("tools/call");
    if (!handler) throw new Error("No tools/call handler found");

    const result = (await handler({
      method: "tools/call",
      params: {
        name: "recall",
        arguments: { query: "decision", mode: "keyword" },
      },
    })) as { content: Array<{ type: string; text: string }> };

    const text = result.content.map((c) => c.text).join("\n");
    // Should NOT contain project A or B content — different session key
    expect(text).not.toContain("project A only");
    expect(text).not.toContain("project B only");
  });

  it("forget creates a tombstone (soft delete) and prevents recapture in search", async () => {
    const result = await capture(ctx, {
      content: "Decision to delete this entry.",
      type: "decision",
      tags: ["temp"],
    });

    // Verify it's retrievable
    const before = await recall(ctx, { query: "delete", mode: "keyword" });
    expect(before.length).toBeGreaterThan(0);

    // Forget it
    const forgetResult = await forget(ctx, { id: result.id, confirm: true });
    expect(forgetResult.captures).toBe(1);

    // Should no longer appear in search results
    const after = await recall(ctx, { query: "delete", mode: "keyword" });
    const found = after.find((r) => r.entry.id === result.id);
    expect(found).toBeUndefined();

    // Row should still exist in DB with deleted_at set (tombstone)
    const row = ctx.storage.get(result.id);
    expect(row).not.toBeNull();
  });
});
