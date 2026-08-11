import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactPath, exportArtifact, hasArtifact, importArtifact } from "../../src/artifact.js";
import type { Embedder } from "../../src/embedding/types.js";
import { NoopPipeline } from "../../src/pipeline/noop.js";
import { AuditLogger } from "../../src/security/audit.js";
import { createServer } from "../../src/server.js";
import { SQLiteBackend } from "../../src/storage/sqlite.js";

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

const SESSION_KEY = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);

async function callTool(
  server: Server,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const handler = (
    server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    }
  )._requestHandlers.get("tools/call");
  if (!handler) throw new Error("No tools/call handler found");

  const result = (await handler({
    method: "tools/call",
    params: { name, arguments: args },
  })) as { content: Array<{ type: string; text: string }> };

  return result.content.map((c) => c.text).join("\n");
}

async function listTools(server: Server): Promise<string[]> {
  const handler = (
    server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    }
  )._requestHandlers.get("tools/list");
  if (!handler) throw new Error("No tools/list handler found");

  const result = (await handler({ method: "tools/list" })) as {
    tools: Array<{ name: string }>;
  };
  return result.tools.map((t) => t.name);
}

describe("Integration: ADR tool", () => {
  let tmpDir: string;
  let dbPath: string;
  let auditPath: string;
  let storage: SQLiteBackend;
  let server: Server;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-adr-test-"));
    dbPath = join(tmpDir, "memory.db");
    auditPath = join(tmpDir, "audit.jsonl");

    storage = new SQLiteBackend(dbPath);
    server = createServer({
      storage,
      embedder: new MockEmbedder(),
      pipeline: new NoopPipeline(),
      pipelineCtx: {},
      audit: new AuditLogger(auditPath, true),
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

  it("registers adr in the tool list", async () => {
    const tools = await listTools(server);
    expect(tools).toContain("adr");
  });

  it("saves an ADR with all fields", async () => {
    const text = await callTool(server, "adr", {
      title: "Use SQLite for local storage",
      context: "We need zero-setup storage that works offline.",
      decision: "Use SQLite with FTS5 and sqlite-vec.",
      alternatives: [
        "Postgres with pgvector — rejected: requires running server",
        "DuckDB — rejected: lacks mature vector search",
      ],
      consequences: "Single-writer limitation, but zero setup and zero cost.",
      tags: ["arch", "storage"],
    });

    expect(text).toContain("ADR saved:");
    expect(text).toContain("Use SQLite for local storage");

    const results = await storage.search("SQLite storage ADR", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    const adrEntry = results.find((r) => r.entry.tags.includes("adr"));
    expect(adrEntry).toBeDefined();
    expect(adrEntry?.entry.type).toBe("decision");
    expect(adrEntry?.entry.content).toContain("# ADR: Use SQLite for local storage");
    expect(adrEntry?.entry.content).toContain("## Context");
    expect(adrEntry?.entry.content).toContain("zero-setup");
    expect(adrEntry?.entry.content).toContain("## Decision");
    expect(adrEntry?.entry.content).toContain("SQLite with FTS5");
    expect(adrEntry?.entry.content).toContain("## Alternatives considered");
    expect(adrEntry?.entry.content).toContain("Postgres with pgvector");
    expect(adrEntry?.entry.content).toContain("## Consequences");
    expect(adrEntry?.entry.content).toContain("Single-writer limitation");
  });

  it("saves an ADR with only required fields", async () => {
    const text = await callTool(server, "adr", {
      title: "Simple decision",
      context: "Need to pick a linter.",
      decision: "Use Biome.",
    });

    expect(text).toContain("ADR saved:");

    const results = await storage.search("simple decision linter", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    const adrEntry = results.find((r) => r.entry.tags.includes("adr"));
    expect(adrEntry).toBeDefined();
    expect(adrEntry?.entry.content).not.toContain("## Alternatives considered");
    expect(adrEntry?.entry.content).not.toContain("## Consequences");
  });

  it("stores structured metadata", async () => {
    await callTool(server, "adr", {
      title: "Use ONNX for embeddings",
      context: "Need local embeddings without API key.",
      decision: "Use all-MiniLM-L6-v2 via ONNX Runtime.",
      alternatives: ["OpenAI API — rejected: requires API key"],
      consequences: "384-dim vectors, runs on CPU.",
      tags: ["ml", "embedding"],
    });

    const results = await storage.search("ONNX embeddings", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    const adrEntry = results.find((r) => r.entry.tags.includes("adr"));
    expect(adrEntry).toBeDefined();
    expect(adrEntry?.entry.metadata).toBeDefined();
    expect(adrEntry?.entry.metadata?.adr).toBe(true);
    expect(adrEntry?.entry.metadata?.title).toBe("Use ONNX for embeddings");
    expect(adrEntry?.entry.metadata?.decision).toBe("Use all-MiniLM-L6-v2 via ONNX Runtime.");
    expect(adrEntry?.entry.metadata?.alternatives).toEqual([
      "OpenAI API — rejected: requires API key",
    ]);
  });

  it("tags ADR with 'adr' tag", async () => {
    await callTool(server, "adr", {
      title: "Tag test",
      context: "Testing tags.",
      decision: "Test decision.",
      tags: ["custom-tag"],
    });

    const results = await storage.search("tag test", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    const adrEntry = results.find((r) => r.entry.tags.includes("adr"));
    expect(adrEntry).toBeDefined();
    expect(adrEntry?.entry.tags).toContain("adr");
    expect(adrEntry?.entry.tags).toContain("custom-tag");
  });

  it("rejects duplicate ADR", async () => {
    const args = {
      title: "Duplicate ADR",
      context: "Same context.",
      decision: "Same decision.",
      session_key: SESSION_KEY,
    };

    const first = await callTool(server, "adr", args);
    expect(first).toContain("ADR saved:");

    const second = await callTool(server, "adr", args);
    expect(second).toContain("Duplicate ADR:");
  });

  it("can be recalled by future agents", async () => {
    await callTool(server, "adr", {
      title: "Use tree-sitter for parsing",
      context: "Need fast, incremental parsing for 158 languages.",
      decision: "Use tree-sitter with vendored grammars.",
      alternatives: ["LSP — rejected: too heavy for indexing"],
      consequences: "Large binary size, but fast and offline.",
    });

    const recallText = await callTool(server, "recall", {
      query: "tree-sitter parsing decision",
      mode: "keyword",
    });

    expect(recallText).toContain("tree-sitter");
    expect(recallText).toContain("vendored grammars");
  });

  it("writes to the audit log", async () => {
    await callTool(server, "adr", {
      title: "Audit test ADR",
      context: "Testing audit.",
      decision: "Test.",
    });

    expect(existsSync(auditPath)).toBe(true);
    const auditContent = readFileSync(auditPath, "utf-8");
    const lines = auditContent.trim().split("\n");
    const lastEntry = JSON.parse(lines[lines.length - 1]!);
    expect(lastEntry.tool).toBe("adr");
  });
});

describe("Integration: team-shared artifact", () => {
  let tmpDir: string;
  let projectDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-artifact-test-"));
    projectDir = join(tmpDir, "my-project");
    dbPath = join(tmpDir, "memory.db");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exports captures to .tdai-memory/memory-export.json", () => {
    // Insert a capture directly
    const db = new (require("better-sqlite3"))(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, session_key TEXT NOT NULL, agent_id TEXT NOT NULL,
        type TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT,
        tags TEXT, created_at INTEGER NOT NULL, metadata TEXT
      );
      INSERT INTO schema_version VALUES (1, ${Date.now()});
      INSERT INTO captures VALUES ('test-id-1', 'session-1', 'agent-1', 'decision', 'Test content', 'hash-1', '["tag1"]', ${Date.now()}, NULL);
    `);
    db.close();

    exportArtifact(dbPath, projectDir);

    const artifactFile = join(projectDir, ".tdai-memory", "memory-export.json");
    expect(existsSync(artifactFile)).toBe(true);

    const content = JSON.parse(readFileSync(artifactFile, "utf-8"));
    expect(content.version).toBe(1);
    expect(content.count).toBe(1);
    expect(content.captures[0].id).toBe("test-id-1");
    expect(content.captures[0].content).toBe("Test content");
  });

  it("imports captures from .tdai-memory/memory-export.json", () => {
    // Create artifact file
    const artifactDir = join(projectDir, ".tdai-memory");
    mkdirSync(artifactDir, { recursive: true });
    const artifactFile = join(artifactDir, "memory-export.json");

    const data = {
      version: 1,
      exported_at: Date.now(),
      count: 1,
      captures: [
        {
          id: "imported-id-1",
          session_key: "team-session",
          agent_id: "teammate-agent",
          type: "decision",
          content: "Team decision: use SQLite",
          content_hash: createHash("sha256").update("Team decision: use SQLite").digest("hex"),
          tags: '["adr", "arch"]',
          created_at: Date.now(),
          metadata: null,
        },
      ],
    };
    writeFileSync(artifactFile, JSON.stringify(data, null, 2));

    // Import
    const count = importArtifact(dbPath, projectDir);
    expect(count).toBe(1);

    // Verify it was imported
    const db = new (require("better-sqlite3"))(dbPath);
    const row = db.prepare("SELECT * FROM captures WHERE id = ?").get("imported-id-1");
    expect(row).toBeDefined();
    expect(row.content).toBe("Team decision: use SQLite");
    db.close();
  });

  it("skips already-existing captures on import", () => {
    // First import
    const artifactDir = join(projectDir, ".tdai-memory");
    mkdirSync(artifactDir, { recursive: true });
    const artifactFile = join(artifactDir, "memory-export.json");

    const data = {
      version: 1,
      exported_at: Date.now(),
      count: 1,
      captures: [
        {
          id: "dup-id-1",
          session_key: "s1",
          agent_id: "a1",
          type: "decision",
          content: "Duplicate test",
          content_hash: "hash-dup",
          tags: "[]",
          created_at: Date.now(),
          metadata: null,
        },
      ],
    };
    writeFileSync(artifactFile, JSON.stringify(data, null, 2));

    const first = importArtifact(dbPath, projectDir);
    expect(first).toBe(1);

    // Second import should skip
    const second = importArtifact(dbPath, projectDir);
    expect(second).toBe(0);
  });

  it("returns 0 when no artifact exists", () => {
    const count = importArtifact(dbPath, projectDir);
    expect(count).toBe(0);
  });

  it("hasArtifact returns true when artifact exists", () => {
    expect(hasArtifact(projectDir)).toBe(false);

    const artifactDir = join(projectDir, ".tdai-memory");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "memory-export.json"), "{}");

    expect(hasArtifact(projectDir)).toBe(true);
  });

  it("artifactPath returns the correct path", () => {
    const path = artifactPath(projectDir);
    expect(path).toBe(join(projectDir, ".tdai-memory", "memory-export.json"));
  });

  it("handles corrupted artifact gracefully", () => {
    const artifactDir = join(projectDir, ".tdai-memory");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "memory-export.json"), "not valid json {{{");

    const count = importArtifact(dbPath, projectDir);
    expect(count).toBe(0);
  });
});
