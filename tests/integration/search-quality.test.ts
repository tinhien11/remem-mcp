import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Memory } from "../../src/sdk.js";

describe("Search quality: proper noun handling (hybrid mode)", () => {
  let tmpDir: string;
  let memory: Memory;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-search-quality-"));
    const dbPath = join(tmpDir, "test.db");
    memory = new Memory({ dbPath });

    // Seed a small knowledge base that mimics real user memory.
    // The intro mentions "Tin" — a rare proper noun that BM25 over-weights.
    const seeds = [
      "Hi, I am Tin. I work at a startup called Acme. We use React and TypeScript.",
      "My favorite editor is Neovim. I hate VS Code.",
      "I live in Vietnam. The timezone is GMT+7.",
      "I am allergic to peanuts. Severe reaction.",
      "Our auth service uses JWT tokens with RS256 signing.",
      "I have a meeting with Sarah tomorrow at 3pm about the API redesign.",
      "We decided on REST for the API design. GraphQL was rejected for simplicity.",
      "The database is PostgreSQL on AWS RDS. We have read replicas in us-east-1.",
      "Our CI/CD runs on GitHub Actions. Deploys to Vercel for frontend.",
      "I have a dog named Rex. He is a golden retriever.",
      "Notifications are sent via Server-Sent Events (SSE), not WebSockets.",
      "We deployed v2.3.0 last week. Had a rollback due to memory leak in the auth service.",
    ];
    for (const content of seeds) {
      memory.capture(content, "decision", []);
    }
  });

  afterEach(() => {
    memory.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // These tests verify that proper noun stripping in both BM25 and vector
  // embedding prevents rare names (e.g. "Tin") from dominating search results.
  // Without stripping, "what editor does Tin use" returns the "I am Tin" intro
  // instead of the Neovim capture, because "Tin" is a rare BM25 token and
  // the embedding model sees "Tin" as a strong semantic match.

  it("returns Neovim for 'what editor does Tin use' (not the Tin intro)", async () => {
    const results = await memory.search("what editor does Tin use", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content.toLowerCase()).toContain("neovim");
  });

  it("returns PostgreSQL for 'what database does Acme use'", async () => {
    const results = await memory.search("what database does Acme use", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content.toLowerCase()).toContain("postgresql");
  });

  it("returns peanut allergy for 'Tin allergies'", async () => {
    const results = await memory.search("Tin allergies", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content.toLowerCase()).toContain("peanut");
  });

  it("returns Sarah meeting for 'meeting with who tomorrow'", async () => {
    const results = await memory.search("meeting with who tomorrow", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content.toLowerCase()).toContain("sarah");
  });

  it("returns REST for 'API design GraphQL or REST' (keeps acronyms)", async () => {
    const results = await memory.search("API design GraphQL or REST", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    // Should match the REST decision, not the Sarah meeting (which mentions "API redesign")
    expect(results[0].entry.content.toLowerCase()).toContain("rest");
  });

  it("returns GitHub Actions for 'CI/CD setup' (keeps mixed-case terms)", async () => {
    const results = await memory.search("CI/CD setup", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content.toLowerCase()).toContain("github actions");
  });

  it("returns SSE for 'notification system'", async () => {
    const results = await memory.search("notification system", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content.toLowerCase()).toContain("sse");
  });

  it("returns Rex for 'Tin dog name'", async () => {
    const results = await memory.search("Tin dog name", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content.toLowerCase()).toContain("rex");
  });

  it("returns JWT for 'auth service technology'", async () => {
    const results = await memory.search("auth service technology", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content.toLowerCase()).toContain("jwt");
  });

  it("returns Vietnam for 'where does Tin live'", async () => {
    const results = await memory.search("where does Tin live", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content.toLowerCase()).toContain("vietnam");
  });
});
