import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("Integration: multi-tenant isolation", () => {
  let tmpDir: string;
  let dbPath: string;
  let auditPath: string;
  let storage: SQLiteBackend;
  let server: Server;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-tenant-test-"));
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

  it("isolates captures by team_id", async () => {
    await callTool(server, "capture", {
      content: "Team A decision: use Postgres.",
      type: "decision",
      team_id: "team-a",
    });
    await callTool(server, "capture", {
      content: "Team B decision: use MySQL.",
      type: "decision",
      team_id: "team-b",
    });

    const resultsA = await storage.search("decision", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
      filters: { teamId: "team-a" },
    });
    const resultsB = await storage.search("decision", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
      filters: { teamId: "team-b" },
    });

    expect(resultsA.length).toBe(1);
    expect(resultsA[0].entry.content).toContain("Postgres");
    expect(resultsA[0].entry.teamId).toBe("team-a");

    expect(resultsB.length).toBe(1);
    expect(resultsB[0].entry.content).toContain("MySQL");
    expect(resultsB[0].entry.teamId).toBe("team-b");
  });

  it("isolates captures by user_id within a team", async () => {
    await callTool(server, "capture", {
      content: "User 1 learning: TypeScript is strict.",
      type: "learning",
      team_id: "team-x",
      user_id: "user-1",
    });
    await callTool(server, "capture", {
      content: "User 2 learning: Rust is fast.",
      type: "learning",
      team_id: "team-x",
      user_id: "user-2",
    });

    const results1 = await storage.search("learning", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
      filters: { teamId: "team-x", userId: "user-1" },
    });
    const results2 = await storage.search("learning", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
      filters: { teamId: "team-x", userId: "user-2" },
    });

    expect(results1.length).toBe(1);
    expect(results1[0].entry.content).toContain("TypeScript");
    expect(results1[0].entry.userId).toBe("user-1");

    expect(results2.length).toBe(1);
    expect(results2[0].entry.content).toContain("Rust");
    expect(results2[0].entry.userId).toBe("user-2");
  });

  it("isolates captures by task_id", async () => {
    await callTool(server, "capture", {
      content: "Task 1: fix login bug.",
      type: "task",
      team_id: "team-y",
      task_id: "task-1",
    });
    await callTool(server, "capture", {
      content: "Task 2: add export feature.",
      type: "task",
      team_id: "team-y",
      task_id: "task-2",
    });

    const results1 = await storage.search("task", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
      filters: { teamId: "team-y", taskId: "task-1" },
    });

    expect(results1.length).toBe(1);
    expect(results1[0].entry.content).toContain("login bug");
    expect(results1[0].entry.taskId).toBe("task-1");
  });

  it("stores team_id, user_id, task_id on capture", async () => {
    await callTool(server, "capture", {
      content: "Multi-tenant capture test.",
      type: "decision",
      team_id: "team-test",
      user_id: "user-test",
      task_id: "task-test",
    });

    const results = await storage.search("multi-tenant", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
      filters: { teamId: "team-test" },
    });

    expect(results.length).toBe(1);
    expect(results[0].entry.teamId).toBe("team-test");
    expect(results[0].entry.userId).toBe("user-test");
    expect(results[0].entry.taskId).toBe("task-test");
  });

  it("filters by team_id in recall tool", async () => {
    await callTool(server, "capture", {
      content: "Team A recall test.",
      type: "decision",
      team_id: "team-a",
    });
    await callTool(server, "capture", {
      content: "Team B recall test.",
      type: "decision",
      team_id: "team-b",
    });

    const recallA = await callTool(server, "recall", {
      query: "recall test",
      mode: "keyword",
      team_id: "team-a",
    });

    expect(recallA).toContain("Team A");
    expect(recallA).not.toContain("Team B");
  });

  it("deleteByFilter respects team_id", async () => {
    await callTool(server, "capture", {
      content: "Team A delete test.",
      type: "decision",
      team_id: "team-a",
    });
    await callTool(server, "capture", {
      content: "Team B keep test.",
      type: "decision",
      team_id: "team-b",
    });

    const result = await storage.deleteByFilter({ teamId: "team-a" });
    expect(result.captures).toBe(1);

    const remaining = await storage.search("test", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });
    const contents = remaining.map((r) => r.entry.content);
    expect(contents).toContain("Team B keep test.");
    expect(contents).not.toContain("Team A delete test.");
  });
});
