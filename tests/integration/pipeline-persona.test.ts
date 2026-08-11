import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../src/embedding/types.js";
import { AtomPipeline } from "../../src/pipeline/atom.js";
import type { LLMClient, PipelineContext } from "../../src/pipeline/types.js";
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

/** Mock LLM client that returns pre-defined facts. */
class MockLLMClient implements LLMClient {
  async complete(prompt: string): Promise<string> {
    if (prompt.includes("SQLite")) {
      return "[fact] The project uses SQLite with sqlite-vec for vector search.\n[fact] FTS5 is used for full-text search.";
    }
    if (prompt.includes("RRF")) {
      return "[fact] The RRF fusion constant k is 60.";
    }
    return "No facts found.";
  }
}

describe("Integration: L1 atom extraction pipeline", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-atom-test-"));
    dbPath = join(tmpDir, "memory.db");
    storage = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts atoms from a decision capture", async () => {
    const captureId = "test-capture-1";
    await storage.put({
      id: captureId,
      sessionKey: "test",
      agentId: "test",
      type: "decision",
      content: "We decided to use SQLite with sqlite-vec and FTS5 for the storage backend.",
      tags: ["arch"],
      createdAt: Date.now(),
    });

    const pipeline = new AtomPipeline();
    const ctx: PipelineContext = {
      llmClient: new MockLLMClient(),
      storage,
      embedder: new MockEmbedder(),
      sessionKey: "test",
    };

    const output = await pipeline.process(
      {
        id: captureId,
        content: "We decided to use SQLite with sqlite-vec and FTS5 for the storage backend.",
        type: "decision",
        tags: ["arch"],
        sessionKey: "test",
      },
      ctx,
    );

    expect(output.atoms).toBeDefined();
    expect(output.atoms?.length).toBe(2);
    const facts = output.atoms?.map((a) => a.fact);
    expect(facts.some((f) => f.includes("SQLite"))).toBe(true);
    expect(facts.some((f) => f.includes("FTS5"))).toBe(true);

    // Verify atoms were stored
    const atoms = await storage.listAtoms({ captureId });
    expect(atoms.length).toBe(2);
    const storedFacts = atoms.map((a) => a.fact);
    expect(storedFacts.some((f) => f.includes("SQLite"))).toBe(true);
    expect(storedFacts.some((f) => f.includes("FTS5"))).toBe(true);
  });

  it("skips non-decision/learning/error types", async () => {
    const pipeline = new AtomPipeline();
    const ctx: PipelineContext = {
      llmClient: new MockLLMClient(),
      storage,
      embedder: new MockEmbedder(),
      sessionKey: "test",
    };

    const output = await pipeline.process(
      {
        id: "test-capture-2",
        content: "A task outcome.",
        type: "task",
        tags: [],
        sessionKey: "test",
      },
      ctx,
    );

    expect(output.atoms).toBeUndefined();
  });

  it("throws when no LLM client is provided", async () => {
    const pipeline = new AtomPipeline();
    const ctx: PipelineContext = {
      storage,
      embedder: new MockEmbedder(),
      sessionKey: "test",
    };

    await expect(
      pipeline.process(
        {
          id: "test-capture-3",
          content: "A decision.",
          type: "decision",
          tags: [],
          sessionKey: "test",
        },
        ctx,
      ),
    ).rejects.toThrow("LLM client");
  });

  it("stores team_id and user_id on extracted atoms", async () => {
    const captureId = "test-capture-4";
    await storage.put({
      id: captureId,
      sessionKey: "test",
      agentId: "test",
      type: "decision",
      content: "We use RRF for hybrid search.",
      tags: [],
      createdAt: Date.now(),
      teamId: "team-atom",
      userId: "user-atom",
    });

    const pipeline = new AtomPipeline();
    const ctx: PipelineContext = {
      llmClient: new MockLLMClient(),
      storage,
      embedder: new MockEmbedder(),
      sessionKey: "test",
    };

    await pipeline.process(
      {
        id: captureId,
        content: "We use RRF for hybrid search.",
        type: "decision",
        tags: [],
        sessionKey: "test",
        teamId: "team-atom",
        userId: "user-atom",
      },
      ctx,
    );

    const atoms = await storage.listAtoms({ teamId: "team-atom" });
    expect(atoms.length).toBe(1);
    expect(atoms[0].teamId).toBe("team-atom");
    expect(atoms[0].userId).toBe("user-atom");
    expect(atoms[0].fact).toContain("RRF");
  });

  it("searches atoms by keyword", async () => {
    // Create parent captures first (FK constraint)
    await storage.put({
      id: "cap-1",
      sessionKey: "test",
      agentId: "test",
      type: "decision",
      content: "Decision about database.",
      tags: [],
      createdAt: Date.now(),
    });
    await storage.put({
      id: "cap-2",
      sessionKey: "test",
      agentId: "test",
      type: "decision",
      content: "Decision about frontend.",
      tags: [],
      createdAt: Date.now(),
    });

    await storage.putAtom({
      id: "atom-1",
      captureId: "cap-1",
      fact: "The database uses SQLite.",
      confidence: 0.9,
      createdAt: Date.now(),
    });
    await storage.putAtom({
      id: "atom-2",
      captureId: "cap-2",
      fact: "The frontend uses React.",
      confidence: 0.9,
      createdAt: Date.now(),
    });

    const results = await storage.searchAtoms("SQLite");
    expect(results.length).toBe(1);
    expect(results[0].fact).toContain("SQLite");
  });
});

describe("Integration: L3 persona", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-persona-test-"));
    dbPath = join(tmpDir, "memory.db");
    storage = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads a persona", async () => {
    await storage.writePersona(
      "team-1",
      "agent-1",
      "user-1",
      "Prefers concise answers. Works on backend.",
    );

    const persona = await storage.readPersona("team-1", "agent-1", "user-1");
    expect(persona).not.toBeNull();
    expect(persona?.teamId).toBe("team-1");
    expect(persona?.agentId).toBe("agent-1");
    expect(persona?.userId).toBe("user-1");
    expect(persona?.content).toContain("concise answers");
  });

  it("returns null for non-existent persona", async () => {
    const persona = await storage.readPersona("no-team", "no-agent", "no-user");
    expect(persona).toBeNull();
  });

  it("upserts persona on write", async () => {
    await storage.writePersona("team-2", "agent-2", "user-2", "Initial content.");
    await storage.writePersona("team-2", "agent-2", "user-2", "Updated content.");

    const persona = await storage.readPersona("team-2", "agent-2", "user-2");
    expect(persona?.content).toBe("Updated content.");
  });

  it("isolates persona by team/agent/user", async () => {
    await storage.writePersona("team-a", "agent-x", "user-1", "Persona A.");
    await storage.writePersona("team-b", "agent-x", "user-1", "Persona B.");

    const personaA = await storage.readPersona("team-a", "agent-x", "user-1");
    const personaB = await storage.readPersona("team-b", "agent-x", "user-1");

    expect(personaA?.content).toBe("Persona A.");
    expect(personaB?.content).toBe("Persona B.");
  });
});

describe("Integration: L2 scenarios", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tdai-scenario-test-"));
    dbPath = join(tmpDir, "memory.db");
    storage = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves a scenario", async () => {
    await storage.putScenario({
      id: "scenario-1",
      atomIds: ["atom-1", "atom-2"],
      summary: "The team chose SQLite for local storage.",
      personaTags: ["backend", "storage"],
      createdAt: Date.now(),
      teamId: "team-s",
    });

    const scenario = await storage.getScenario("scenario-1");
    expect(scenario).not.toBeNull();
    expect(scenario?.summary).toContain("SQLite");
    expect(scenario?.atomIds).toEqual(["atom-1", "atom-2"]);
    expect(scenario?.personaTags).toEqual(["backend", "storage"]);
    expect(scenario?.teamId).toBe("team-s");
  });

  it("lists scenarios filtered by team", async () => {
    await storage.putScenario({
      id: "scenario-a",
      atomIds: [],
      summary: "Team A scenario.",
      createdAt: Date.now(),
      teamId: "team-a",
    });
    await storage.putScenario({
      id: "scenario-b",
      atomIds: [],
      summary: "Team B scenario.",
      createdAt: Date.now(),
      teamId: "team-b",
    });

    const scenarios = await storage.listScenarios({ teamId: "team-a" });
    expect(scenarios.length).toBe(1);
    expect(scenarios[0].summary).toContain("Team A");
  });

  it("returns null for non-existent scenario", async () => {
    const scenario = await storage.getScenario("nonexistent");
    expect(scenario).toBeNull();
  });
});
