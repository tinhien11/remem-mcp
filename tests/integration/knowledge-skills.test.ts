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

const describeOrSkip = process.env.CI ? describe.skip : describe;

describeOrSkip("Integration: knowledge management", () => {
  let tmpDir: string;
  let dbPath: string;
  let auditPath: string;
  let storage: SQLiteBackend;
  let server: Server;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-knowledge-test-"));
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

  it("registers knowledge tools in the tool list", async () => {
    const tools = await listTools(server);
    expect(tools).toContain("knowledge_create");
    expect(tools).toContain("knowledge_get");
    expect(tools).toContain("knowledge_list");
    expect(tools).toContain("knowledge_delete");
  });

  it("creates and retrieves a knowledge asset", async () => {
    const createText = await callTool(server, "knowledge_create", {
      team_id: "team-1",
      name: "Project Wiki",
      type: "wiki",
      summary: "Internal documentation for the project.",
      service_url: "http://localhost:8424/v3",
    });

    expect(createText).toContain("Knowledge created:");
    const id = createText.match(/Knowledge created: (\S+)/)?.[1];
    expect(id).toBeDefined();

    const getText = await callTool(server, "knowledge_get", {
      knowledge_id: id,
    });

    const entry = JSON.parse(getText);
    expect(entry.id).toBe(id);
    expect(entry.teamId).toBe("team-1");
    expect(entry.name).toBe("Project Wiki");
    expect(entry.type).toBe("wiki");
    expect(entry.summary).toContain("Internal documentation");
    expect(entry.serviceUrl).toBe("http://localhost:8424/v3");
  });

  it("lists knowledge assets for a team", async () => {
    await callTool(server, "knowledge_create", {
      team_id: "team-2",
      name: "Wiki A",
      type: "wiki",
    });
    await callTool(server, "knowledge_create", {
      team_id: "team-2",
      name: "Code Graph B",
      type: "code-graph",
      repo_url: "https://github.com/example/repo",
      branch: "main",
    });
    await callTool(server, "knowledge_create", {
      team_id: "team-3",
      name: "Other Team Wiki",
      type: "wiki",
    });

    const listText = await callTool(server, "knowledge_list", {
      team_id: "team-2",
    });

    expect(listText).toContain("Wiki A");
    expect(listText).toContain("Code Graph B");
    expect(listText).not.toContain("Other Team Wiki");
  });

  it("lists knowledge assets filtered by type", async () => {
    await callTool(server, "knowledge_create", {
      team_id: "team-4",
      name: "Wiki Only",
      type: "wiki",
    });
    await callTool(server, "knowledge_create", {
      team_id: "team-4",
      name: "Graph Only",
      type: "code-graph",
    });

    const wikiList = await callTool(server, "knowledge_list", {
      team_id: "team-4",
      type: "wiki",
    });

    expect(wikiList).toContain("Wiki Only");
    expect(wikiList).not.toContain("Graph Only");
  });

  it("deletes knowledge assets by ID", async () => {
    const createText = await callTool(server, "knowledge_create", {
      team_id: "team-5",
      name: "To Delete",
      type: "wiki",
    });
    const id = createText.match(/Knowledge created: (\S+)/)?.[1];

    const deleteText = await callTool(server, "knowledge_delete", {
      knowledge_ids: [id],
    });

    expect(deleteText).toContain("Deleted 1 knowledge asset");

    const getText = await callTool(server, "knowledge_get", {
      knowledge_id: id,
    });
    expect(getText).toContain("not found");
  });

  it("returns empty list for team with no assets", async () => {
    const listText = await callTool(server, "knowledge_list", {
      team_id: "empty-team",
    });
    expect(listText).toContain("No knowledge assets found.");
  });

  it("returns error for non-existent knowledge ID", async () => {
    const getText = await callTool(server, "knowledge_get", {
      knowledge_id: "nonexistent-id",
    });
    expect(getText).toContain("not found");
  });
});

describeOrSkip("Integration: skill management", () => {
  let tmpDir: string;
  let dbPath: string;
  let auditPath: string;
  let storage: SQLiteBackend;
  let server: Server;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-skills-test-"));
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

  it("registers skill tools in the tool list", async () => {
    const tools = await listTools(server);
    expect(tools).toContain("skill_get");
    expect(tools).toContain("skill_list");
    expect(tools).toContain("skill_search");
  });

  it("lists skills for a team", async () => {
    // Insert skills directly via storage
    await storage.putSkill({
      id: "skill-1",
      teamId: "team-skills",
      name: "Deploy Workflow",
      description: "How to deploy the service.",
      content: "Step 1: build. Step 2: deploy.",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await storage.putSkill({
      id: "skill-2",
      teamId: "team-skills",
      agentId: "agent-x",
      name: "Agent-Specific Skill",
      description: "Only for agent-x.",
      version: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await storage.putSkill({
      id: "skill-3",
      teamId: "other-team",
      name: "Other Team Skill",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const listText = await callTool(server, "skill_list", {
      team_id: "team-skills",
    });

    expect(listText).toContain("Deploy Workflow");
    expect(listText).toContain("Agent-Specific Skill");
    expect(listText).not.toContain("Other Team Skill");
  });

  it("filters skills by agent_id", async () => {
    await storage.putSkill({
      id: "skill-global",
      teamId: "team-filter",
      name: "Global Skill",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await storage.putSkill({
      id: "skill-agent",
      teamId: "team-filter",
      agentId: "agent-a",
      name: "Agent A Skill",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await storage.putSkill({
      id: "skill-other-agent",
      teamId: "team-filter",
      agentId: "agent-b",
      name: "Agent B Skill",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const listText = await callTool(server, "skill_list", {
      team_id: "team-filter",
      agent_id: "agent-a",
    });

    expect(listText).toContain("Global Skill");
    expect(listText).toContain("Agent A Skill");
    expect(listText).not.toContain("Agent B Skill");
  });

  it("gets a skill by ID", async () => {
    await storage.putSkill({
      id: "skill-get-test",
      teamId: "team-get",
      name: "Get Test Skill",
      description: "A skill for testing get.",
      content: "Full content here.",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const getText = await callTool(server, "skill_get", {
      skill_id: "skill-get-test",
    });

    const entry = JSON.parse(getText);
    expect(entry.id).toBe("skill-get-test");
    expect(entry.name).toBe("Get Test Skill");
    expect(entry.content).toBe("Full content here.");
  });

  it("searches skills by keyword", async () => {
    await storage.putSkill({
      id: "skill-search-1",
      teamId: "team-search",
      agentId: "agent-s",
      name: "Deploy to Production",
      description: "Steps to deploy the app.",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await storage.putSkill({
      id: "skill-search-2",
      teamId: "team-search",
      agentId: "agent-s",
      name: "Rollback Release",
      description: "How to rollback a failed deploy.",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const searchText = await callTool(server, "skill_search", {
      team_id: "team-search",
      agent_id: "agent-s",
      query: "deploy",
    });

    expect(searchText).toContain("Deploy to Production");
    expect(searchText).toContain("Rollback Release");
  });

  it("returns error for non-existent skill ID", async () => {
    const getText = await callTool(server, "skill_get", {
      skill_id: "nonexistent",
    });
    expect(getText).toContain("not found");
  });

  it("returns empty list for team with no skills", async () => {
    const listText = await callTool(server, "skill_list", {
      team_id: "empty-skills-team",
    });
    expect(listText).toContain("No skills found.");
  });
});
