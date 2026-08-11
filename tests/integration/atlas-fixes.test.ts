/**
 * Integration tests for fixes from the Agent Memory Atlas analysis.
 *
 * The Atlas (neoneye.github.io/agent-memory-atlas) analyzed the repo at
 * commit 281180e7 and found 6 issues. These tests verify each fix through
 * the real MCP server handler — not a reimplementation of the caller.
 *
 * Tests enter through the same door as production: the real tools/call
 * handler on the real server instance.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../src/embedding/types.js";
import { NoopPipeline } from "../../src/pipeline/noop.js";
import { AuditLogger } from "../../src/security/audit.js";
import { createServer } from "../../src/server.js";
import { SQLiteBackend } from "../../src/storage/sqlite.js";

// ─── Mock embedder ─────────────────────────────────────────────
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

// ─── Failing embedder (for vector degradation test) ────────────
class FailingEmbedder implements Embedder {
  readonly dimension = 384;
  readonly model = "failing";

  async embed(): Promise<number[]> {
    throw new Error("model not loaded");
  }
}

// ─── Helpers ───────────────────────────────────────────────────
async function callTool(
  server: Server,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  const handler = (
    server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    }
  )._requestHandlers.get("tools/call");
  if (!handler) throw new Error("No tools/call handler found");

  const result = (await handler({
    method: "tools/call",
    params: { name, arguments: args },
  })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

  return {
    text: result.content.map((c) => c.text).join("\n"),
    isError: result.isError,
  };
}

function defaultSessionKey(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}

// ─── Test setup ────────────────────────────────────────────────
describe("Integration: Atlas fixes", () => {
  let tmpDir: string;
  let dbPath: string;
  let auditPath: string;
  let storage: SQLiteBackend;
  let embedder: MockEmbedder;
  let audit: AuditLogger;
  let server: Server;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-atlas-"));
    dbPath = join(tmpDir, "memory.db");
    auditPath = join(tmpDir, "audit.jsonl");

    storage = new SQLiteBackend(dbPath);
    embedder = new MockEmbedder();
    audit = new AuditLogger(auditPath, true);
    server = createServer({
      storage,
      embedder,
      pipeline: new NoopPipeline(),
      pipelineCtx: {},
      audit,
      redactSecrets: true,
      maxTokensRecall: 4000,
      maxTokensSearch: 8000,
      maxContentLength: 50000,
    });
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Fix #1: recall without session_key uses defaultSessionKey ──
  describe("Fix #1: session_key default on recall", () => {
    it("recall without session_key does not leak across projects", async () => {
      // Capture to a different session key
      await callTool(server, "capture", {
        type: "decision",
        content: "Project Alpha uses Redis for caching.",
        session_key: "project-alpha",
      });

      // Recall without session_key — should default to sha256(cwd), not project-alpha
      const result = await callTool(server, "recall", {
        query: "Redis caching",
        mode: "keyword",
      });

      // Should NOT find the project-alpha decision
      expect(result.text).not.toContain("Project Alpha");
      expect(result.text).not.toContain("Redis");
    });

    it("recall with explicit session_key finds the right project", async () => {
      await callTool(server, "capture", {
        type: "decision",
        content: "Project Alpha uses Redis for caching.",
        session_key: "project-alpha",
      });

      const result = await callTool(server, "recall", {
        query: "Redis caching",
        mode: "keyword",
        session_key: "project-alpha",
      });

      expect(result.text).toContain("Project Alpha");
      expect(result.text).toContain("Redis");
    });

    it("search without session_key does not leak across projects", async () => {
      await callTool(server, "capture", {
        type: "decision",
        content: "Project Beta uses Postgres for storage.",
        session_key: "project-beta",
      });

      const result = await callTool(server, "search", {
        query: "Postgres storage",
        mode: "keyword",
      });

      expect(result.text).not.toContain("Project Beta");
      expect(result.text).not.toContain("Postgres");
    });

    it("recall and capture use the same default session key", async () => {
      // Capture without session_key (uses default)
      await callTool(server, "capture", {
        type: "decision",
        content: "Default session capture about SQLite.",
      });

      // Recall without session_key (should use same default)
      const result = await callTool(server, "recall", {
        query: "SQLite",
        mode: "keyword",
      });

      expect(result.text).toContain("SQLite");
    });
  });

  // ─── Fix #3: tombstone (soft delete) ────────────────────────────
  describe("Fix #3: tombstone / soft delete", () => {
    it("forget removes entry from search results", async () => {
      const capResult = await callTool(server, "capture", {
        type: "decision",
        content: "Delete me: use MongoDB for the new service.",
      });
      const id = capResult.text.match(/Captured:\s+(\S+)/)?.[1];
      expect(id).toBeDefined();

      // Verify it appears in recall
      const before = await callTool(server, "recall", {
        query: "MongoDB",
        mode: "keyword",
      });
      expect(before.text).toContain("MongoDB");

      // Forget it
      const forgetResult = await callTool(server, "forget", {
        id,
        confirm: true,
      });
      expect(forgetResult.text).toContain("1");

      // Should no longer appear in recall
      const after = await callTool(server, "recall", {
        query: "MongoDB",
        mode: "keyword",
      });
      expect(after.text).not.toContain("MongoDB");
    });

    it("forget removes entry from vector search", async () => {
      const capResult = await callTool(server, "capture", {
        type: "learning",
        content: "Vector search uses cosine distance for similarity.",
      });
      const id = capResult.text.match(/Captured:\s+(\S+)/)?.[1];

      // Verify vector search finds it
      const before = await callTool(server, "recall", {
        query: "cosine distance similarity",
        mode: "vector",
      });
      expect(before.text).toContain("Vector search");

      // Forget
      await callTool(server, "forget", { id, confirm: true });

      // Vector search should not find it
      const after = await callTool(server, "recall", {
        query: "cosine distance similarity",
        mode: "vector",
      });
      expect(after.text).not.toContain("Vector search");
    });

    it("forget removes entry from hybrid search", async () => {
      const capResult = await callTool(server, "capture", {
        type: "decision",
        content: "Hybrid search combines BM25 and vector results.",
      });
      const id = capResult.text.match(/Captured:\s+(\S+)/)?.[1];

      await callTool(server, "forget", { id, confirm: true });

      const after = await callTool(server, "recall", {
        query: "hybrid BM25 vector",
        mode: "hybrid",
      });
      expect(after.text).not.toContain("Hybrid search");
    });

    it("tombstoned row still exists in DB with deleted_at set", async () => {
      const capResult = await callTool(server, "capture", {
        type: "decision",
        content: "Tombstone test content.",
      });
      const id = capResult.text.match(/Captured:\s+(\S+)/)?.[1];

      await callTool(server, "forget", { id, confirm: true });

      // Direct DB query — row should exist with deleted_at set
      const db = storage as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } };
      const row = db.db.prepare("SELECT id, deleted_at FROM captures WHERE id = ?").get(id) as
        | { id: string; deleted_at: number | null }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.deleted_at).not.toBeNull();
      expect(row?.deleted_at).toBeGreaterThan(0);
    });

    it("get() returns null for tombstoned entry", async () => {
      const capResult = await callTool(server, "capture", {
        type: "decision",
        content: "Get after delete test.",
      });
      const id = capResult.text.match(/Captured:\s+(\S+)/)?.[1];

      await callTool(server, "forget", { id, confirm: true });

      const entry = await storage.get(id!);
      expect(entry).toBeNull();
    });

    it("can recapture same content after forget (no dedup block)", async () => {
      const capResult = await callTool(server, "capture", {
        type: "decision",
        content: "Recapture after delete: use Redis for sessions.",
      });
      const id = capResult.text.match(/Captured:\s+(\S+)/)?.[1];

      await callTool(server, "forget", { id, confirm: true });

      // Recapture same content
      const recapResult = await callTool(server, "capture", {
        type: "decision",
        content: "Recapture after delete: use Redis for sessions.",
      });
      expect(recapResult.text).toContain("Captured:");
      expect(recapResult.text).not.toContain("Duplicate");

      // Should be findable again
      const recallResult = await callTool(server, "recall", {
        query: "Redis sessions",
        mode: "keyword",
      });
      expect(recallResult.text).toContain("Recapture after delete");
    });

    it("deleteByFilter tombstones matching entries", async () => {
      await callTool(server, "capture", {
        type: "decision",
        content: "Old decision from 2024 about Docker.",
      });
      await callTool(server, "capture", {
        type: "learning",
        content: "Recent learning about Kubernetes.",
      });

      // Delete all decisions
      const result = await callTool(server, "forget", {
        filter: { type: "decision" },
        confirm: true,
      });
      expect(result.text).toContain("1");

      // Decision should be gone from search
      const decisionSearch = await callTool(server, "search", {
        query: "Docker",
        mode: "keyword",
      });
      expect(decisionSearch.text).not.toContain("Docker");

      // Learning should still be there
      const learningSearch = await callTool(server, "search", {
        query: "Kubernetes",
        mode: "keyword",
      });
      expect(learningSearch.text).toContain("Kubernetes");
    });
  });

  // ─── Fix #4: audit log records mutation ────────────────────────
  describe("Fix #4: audit log mutation field", () => {
    it("forget logs mutation with id and capture count", async () => {
      const capResult = await callTool(server, "capture", {
        type: "decision",
        content: "Audit mutation test content.",
      });
      const id = capResult.text.match(/Captured:\s+(\S+)/)?.[1];

      await callTool(server, "forget", { id, confirm: true });

      // Read audit log
      expect(existsSync(auditPath)).toBe(true);
      const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
      const forgetEntry = lines
        .map((l) => JSON.parse(l))
        .find((e: { tool: string }) => e.tool === "forget");

      expect(forgetEntry).toBeDefined();
      expect(forgetEntry.mutation).toBeDefined();
      expect(forgetEntry.mutation.id).toBe(id);
      expect(forgetEntry.mutation.captures).toBe(1);
    });

    it("capture does not log a mutation", async () => {
      await callTool(server, "capture", {
        type: "decision",
        content: "No mutation on capture.",
      });

      const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
      const captureEntry = lines
        .map((l) => JSON.parse(l))
        .find((e: { tool: string }) => e.tool === "capture");

      expect(captureEntry).toBeDefined();
      expect(captureEntry.mutation).toBeUndefined();
    });
  });

  // ─── Fix #5: vector arm degradation surfaced in response ───────
  describe("Fix #5: vector degradation visible in response", () => {
    it("recall surfaces note when vector search fails", async () => {
      // Create server with failing embedder
      const failingServer = createServer({
        storage,
        embedder: new FailingEmbedder(),
        pipeline: new NoopPipeline(),
        pipelineCtx: {},
        audit,
        redactSecrets: true,
        maxTokensRecall: 4000,
        maxTokensSearch: 8000,
        maxContentLength: 50000,
      });

      // Capture with the working server first (uses MockEmbedder)
      await callTool(server, "capture", {
        type: "decision",
        content: "Degradation test: use FTS5 for full-text search.",
      });

      // Recall with failing embedder in hybrid mode
      const result = await callTool(failingServer, "recall", {
        query: "FTS5 full-text search",
        mode: "hybrid",
      });

      // Should contain the degradation note
      expect(result.text).toContain("vector search unavailable");
      expect(result.text).toContain("keyword-only");

      // Should still return keyword results
      expect(result.text).toContain("FTS5");
    });

    it("recall in keyword mode does not show degradation note", async () => {
      const failingServer = createServer({
        storage,
        embedder: new FailingEmbedder(),
        pipeline: new NoopPipeline(),
        pipelineCtx: {},
        audit,
        redactSecrets: true,
        maxTokensRecall: 4000,
        maxTokensSearch: 8000,
        maxContentLength: 50000,
      });

      await callTool(server, "capture", {
        type: "decision",
        content: "Keyword mode does not use vector search.",
      });

      const result = await callTool(failingServer, "recall", {
        query: "keyword vector",
        mode: "keyword",
      });

      // Should NOT contain the degradation note (keyword mode doesn't use vector)
      expect(result.text).not.toContain("vector search unavailable");
    });

    it("search surfaces note when vector search fails", async () => {
      const failingServer = createServer({
        storage,
        embedder: new FailingEmbedder(),
        pipeline: new NoopPipeline(),
        pipelineCtx: {},
        audit,
        redactSecrets: true,
        maxTokensRecall: 4000,
        maxTokensSearch: 8000,
        maxContentLength: 50000,
      });

      await callTool(server, "capture", {
        type: "decision",
        content: "Search degradation test: SQLite is embedded.",
      });

      const result = await callTool(failingServer, "search", {
        query: "SQLite embedded",
        mode: "hybrid",
      });

      expect(result.text).toContain("vector search unavailable");
      expect(result.text).toContain("SQLite");
    });
  });

  // ─── Fix #6: real handler test (not reimplemented caller) ──────
  describe("Fix #6: real handler session isolation", () => {
    it("real recall handler defaults to current project, not all projects", async () => {
      // This is the test the Atlas said was missing:
      // "a test that calls the server's own recall handler with no
      //  session_key and asserts another session's content is absent"
      const otherSession = "ffffffffffffffff"; // clearly not defaultSessionKey()

      await callTool(server, "capture", {
        type: "decision",
        content: "Other project decision about Kafka.",
        session_key: otherSession,
      });

      // Call real handler with NO session_key
      const result = await callTool(server, "recall", {
        query: "Kafka",
        mode: "keyword",
      });

      // The default session key is sha256(cwd), not "ffffffffffffffff"
      // So the other project's content should NOT appear
      expect(result.text).not.toContain("Kafka");
      expect(result.text).not.toContain("Other project");
    });

    it("real search handler defaults to current project, not all projects", async () => {
      const otherSession = "abcdef0123456789";

      await callTool(server, "capture", {
        type: "learning",
        content: "Other project learning about RabbitMQ.",
        session_key: otherSession,
      });

      const result = await callTool(server, "search", {
        query: "RabbitMQ",
        mode: "keyword",
      });

      expect(result.text).not.toContain("RabbitMQ");
      expect(result.text).not.toContain("Other project");
    });

    it("default session key matches between capture and recall", async () => {
      // Capture without session_key → uses defaultSessionKey()
      await callTool(server, "capture", {
        type: "decision",
        content: "Same default session test about DuckDB.",
      });

      // Recall without session_key → should use same defaultSessionKey()
      const result = await callTool(server, "recall", {
        query: "DuckDB",
        mode: "keyword",
      });

      expect(result.text).toContain("DuckDB");
    });
  });
});
