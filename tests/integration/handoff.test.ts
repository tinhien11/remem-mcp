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

/** The session key used by the server when no session_key is passed in tool args. */
const SESSION_KEY = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);

/** Helper: call a tool on the server and return the text response. */
async function callTool(
  server: Server,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  // Access the internal handler via the server's request handler
  // We use the server's internal _handlers via setRequestHandler
  // Instead, we call the handler directly through the server object
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

  return result.content.map((c) => c.text).join("\n");
}

/** Helper: list tools on the server. */
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

describe("Integration: handoff tool", () => {
  let tmpDir: string;
  let dbPath: string;
  let auditPath: string;
  let storage: SQLiteBackend;
  let server: Server;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-handoff-test-"));
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

  it("registers handoff in the tool list", async () => {
    const tools = await listTools(server);
    expect(tools).toContain("handoff");
    expect(tools).toContain("recall");
    expect(tools).toContain("capture");
    expect(tools).toContain("search");
    expect(tools).toContain("forget");
  });

  it("saves a handoff packet with all fields", async () => {
    const text = await callTool(server, "handoff", {
      task: "Fix auth bug in login flow",
      status: "in_progress",
      progress: "Found root cause: JWT refresh token not rotating.",
      decisions: ["Rotate refresh tokens on every use", "Store in httpOnly cookie"],
      files: ["src/auth/jwt.ts:45-60 - refresh token logic"],
      next_steps: ["Implement rotation logic", "Add test for rotation"],
    });

    expect(text).toContain("Handoff saved:");
    expect(text).toContain("Status: in_progress");
    expect(text).toContain("recall");

    // Verify the capture was stored
    const results = await storage.search("auth bug handoff", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBeGreaterThan(0);
    const handoffEntry = results.find((r) => r.entry.tags.includes("handoff"));
    expect(handoffEntry).toBeDefined();
    expect(handoffEntry?.entry.type).toBe("task");
    expect(handoffEntry?.entry.content).toContain("# Handoff: Fix auth bug in login flow");
    expect(handoffEntry?.entry.content).toContain("Status: in_progress");
    expect(handoffEntry?.entry.content).toContain("## Progress");
    expect(handoffEntry?.entry.content).toContain("JWT refresh token not rotating");
    expect(handoffEntry?.entry.content).toContain("## Decisions");
    expect(handoffEntry?.entry.content).toContain("Rotate refresh tokens");
    expect(handoffEntry?.entry.content).toContain("## Files");
    expect(handoffEntry?.entry.content).toContain("src/auth/jwt.ts:45-60");
    expect(handoffEntry?.entry.content).toContain("## Next steps");
    expect(handoffEntry?.entry.content).toContain("Implement rotation logic");
  });

  it("saves a handoff with only required fields", async () => {
    const text = await callTool(server, "handoff", {
      task: "Quick task",
      status: "done",
      progress: "Finished the task.",
    });

    expect(text).toContain("Handoff saved:");
    expect(text).toContain("Status: done");

    const results = await storage.search("quick task", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    const handoffEntry = results.find((r) => r.entry.tags.includes("handoff"));
    expect(handoffEntry).toBeDefined();
    expect(handoffEntry?.entry.content).toContain("# Handoff: Quick task");
    expect(handoffEntry?.entry.content).not.toContain("## Decisions");
    expect(handoffEntry?.entry.content).not.toContain("## Files");
    expect(handoffEntry?.entry.content).not.toContain("## Next steps");
  });

  it("stores structured metadata in the handoff capture", async () => {
    await callTool(server, "handoff", {
      task: "Refactor payment module",
      status: "blocked",
      progress: "Waiting on API spec from team.",
      decisions: ["Use strategy pattern"],
      files: ["src/payment/service.ts"],
      next_steps: ["Get API spec", "Implement StripeStrategy"],
    });

    const results = await storage.search("payment refactor", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    const handoffEntry = results.find((r) => r.entry.tags.includes("handoff"));
    expect(handoffEntry).toBeDefined();
    expect(handoffEntry?.entry.metadata).toBeDefined();
    expect(handoffEntry?.entry.metadata?.handoff).toBe(true);
    expect(handoffEntry?.entry.metadata?.task).toBe("Refactor payment module");
    expect(handoffEntry?.entry.metadata?.status).toBe("blocked");
    expect(handoffEntry?.entry.metadata?.progress).toBe("Waiting on API spec from team.");
    expect(handoffEntry?.entry.metadata?.decisions).toEqual(["Use strategy pattern"]);
    expect(handoffEntry?.entry.metadata?.files).toEqual(["src/payment/service.ts"]);
    expect(handoffEntry?.entry.metadata?.nextSteps).toEqual([
      "Get API spec",
      "Implement StripeStrategy",
    ]);
  });

  it("tags handoff with status tag", async () => {
    await callTool(server, "handoff", {
      task: "Test status tagging",
      status: "needs_review",
      progress: "Done, needs review.",
    });

    const results = await storage.search("status tagging", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    const handoffEntry = results.find((r) => r.entry.tags.includes("handoff"));
    expect(handoffEntry).toBeDefined();
    expect(handoffEntry?.entry.tags).toContain("handoff");
    expect(handoffEntry?.entry.tags).toContain("status:needs_review");
  });

  it("rejects duplicate handoff with same content", async () => {
    const args = {
      task: "Duplicate test",
      status: "in_progress" as const,
      progress: "Same content.",
      session_key: SESSION_KEY,
    };

    const first = await callTool(server, "handoff", args);
    expect(first).toContain("Handoff saved:");

    const second = await callTool(server, "handoff", args);
    expect(second).toContain("Duplicate handoff:");
  });

  it("can be recalled by the next agent session", async () => {
    // Agent A creates a handoff
    await callTool(server, "handoff", {
      task: "Fix login timeout bug",
      status: "in_progress",
      progress: "Found that the timeout is caused by a missing index on the users table.",
      decisions: ["Add index on users.email"],
      files: ["src/db/schema.ts:20-30 - users table definition"],
      next_steps: ["Add migration for index", "Test query performance"],
    });

    // Agent B recalls the handoff
    const recallText = await callTool(server, "recall", {
      query: "login timeout bug handoff",
      mode: "keyword",
    });

    expect(recallText).toContain("Fix login timeout bug");
    expect(recallText).toContain("missing index");
    expect(recallText).toContain("users table");
    expect(recallText).toContain("Add migration");
  });

  it("writes to the audit log", async () => {
    await callTool(server, "handoff", {
      task: "Audit test",
      status: "done",
      progress: "Testing audit log.",
    });

    expect(existsSync(auditPath)).toBe(true);
    const auditContent = readFileSync(auditPath, "utf-8");
    const lines = auditContent.trim().split("\n");
    const lastEntry = JSON.parse(lines[lines.length - 1]!);
    expect(lastEntry.tool).toBe("handoff");
  });

  it("supports all status values", async () => {
    const statuses = ["in_progress", "blocked", "needs_review", "done", "assigned"];

    for (const status of statuses) {
      const text = await callTool(server, "handoff", {
        task: `Status test: ${status}`,
        status,
        progress: `Testing status ${status}.`,
      });
      expect(text).toContain(`Status: ${status}`);
    }

    // Verify all 5 were stored
    const results = await storage.search("status test", null, {
      sessionKey: SESSION_KEY,
      limit: 20,
      offset: 0,
      mode: "keyword",
    });
    const handoffResults = results.filter((r) => r.entry.tags.includes("handoff"));
    expect(handoffResults.length).toBe(5);
  });

  it("handles empty optional arrays", async () => {
    const text = await callTool(server, "handoff", {
      task: "Empty arrays test",
      status: "in_progress",
      progress: "Testing empty arrays.",
      decisions: [],
      files: [],
      next_steps: [],
    });

    expect(text).toContain("Handoff saved:");

    const results = await storage.search("empty arrays", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    const handoffEntry = results.find((r) => r.entry.tags.includes("handoff"));
    expect(handoffEntry).toBeDefined();
    expect(handoffEntry?.entry.content).not.toContain("## Decisions");
    expect(handoffEntry?.entry.content).not.toContain("## Files");
    expect(handoffEntry?.entry.content).not.toContain("## Next steps");
  });
});
