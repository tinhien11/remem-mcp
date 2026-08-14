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

describe("Integration: conversation messages", () => {
  let tmpDir: string;
  let dbPath: string;
  let auditPath: string;
  let storage: SQLiteBackend;
  let server: Server;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-messages-test-"));
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

  it("captures a conversation with role-based messages", async () => {
    const text = await callTool(server, "capture", {
      type: "conversation",
      messages: [
        { role: "user", content: "How do I fix the auth bug?" },
        { role: "assistant", content: "The root cause is a missing JWT refresh." },
        { role: "user", content: "Thanks, that fixed it." },
      ],
    });

    expect(text).toContain("Captured:");
    expect(text).toContain("3 messages");

    // Extract the capture ID
    const id = text.match(/Captured:\s+(\S+)/)?.[1];
    expect(id).toBeDefined();

    // Verify the messages were stored
    const messages = await storage.getMessages(id as string);
    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("auth bug");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContain("JWT refresh");
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toContain("fixed it");
  });

  it("flattens messages into searchable content", async () => {
    await callTool(server, "capture", {
      type: "conversation",
      messages: [
        { role: "user", content: "What is the RRF constant?" },
        { role: "assistant", content: "The RRF constant k is 60." },
      ],
    });

    // The flattened content must be searchable
    const results = await storage.search("RRF constant", null, {
      sessionKey: SESSION_KEY,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content).toContain("RRF constant");
    expect(results[0].entry.content).toContain("user:");
    expect(results[0].entry.content).toContain("assistant:");
  });

  it("ignores content when messages are provided", async () => {
    const text = await callTool(server, "capture", {
      content: "This should be ignored.",
      messages: [{ role: "user", content: "Use this instead." }],
      type: "conversation",
    });

    const id = text.match(/Captured:\s+(\S+)/)?.[1];
    const entry = await storage.get(id as string);
    expect(entry?.content).toContain("Use this instead.");
    expect(entry?.content).not.toContain("This should be ignored.");
  });

  it("requires either content or messages", async () => {
    const text = await callTool(server, "capture", {
      type: "conversation",
    });

    expect(text).toContain("Error:");
    expect(text).toContain("content");
    expect(text).toContain("messages");
  });

  it("soft-deletes capture and removes it from search (tombstone)", async () => {
    const text = await callTool(server, "capture", {
      type: "conversation",
      messages: [{ role: "user", content: "Delete test message." }],
    });

    const id = text.match(/Captured:\s+(\S+)/)?.[1];
    expect(id).toBeDefined();

    // Verify message exists
    const messagesBefore = await storage.getMessages(id as string);
    expect(messagesBefore.length).toBe(1);

    // Soft-delete the capture (tombstone)
    await storage.delete(id as string);

    // Capture should not be retrievable via get()
    const retrieved = await storage.get(id as string);
    expect(retrieved).toBeNull();

    // Messages still exist in DB (soft delete does not cascade)
    const messagesAfter = await storage.getMessages(id as string);
    expect(messagesAfter.length).toBe(1);
  });

  it("supports conversation type in capture", async () => {
    const text = await callTool(server, "capture", {
      type: "conversation",
      messages: [
        { role: "user", content: "Hello." },
        { role: "assistant", content: "Hi there." },
      ],
    });

    expect(text).toContain("Captured:");

    const id = text.match(/Captured:\s+(\S+)/)?.[1];
    const entry = await storage.get(id as string);
    expect(entry?.type).toBe("conversation");
  });

  it("handles empty messages array", async () => {
    const text = await callTool(server, "capture", {
      type: "conversation",
      messages: [],
      content: "Fallback content when messages is empty.",
    });

    expect(text).toContain("Captured:");
    const id = text.match(/Captured:\s+(\S+)/)?.[1];
    const entry = await storage.get(id as string);
    expect(entry?.content).toContain("Fallback content");
  });
});
