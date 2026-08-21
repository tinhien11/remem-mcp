/**
 * Integration tests for v12 features: feedback, explain mode, TTL, mutation log.
 * Tests via SDK (Memory class) to verify the full stack works end-to-end.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Memory } from "../../src/sdk.js";

describe("v12 integration: feedback + explain + TTL + mutation log", () => {
  let tmpDir: string;
  let mem: Memory;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-v12-int-"));
    process.env.REMEM_DB_PATH = join(tmpDir, "test.db");
    mem = new Memory({ dbPath: join(tmpDir, "test.db") });
  });

  afterEach(() => {
    mem.close();
    delete process.env.REMEM_DB_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("feedback flywheel: helpful signal boosts ranking", async () => {
    const id1 = await mem.capture(
      "PostgreSQL is the database for Acme project. Port 5432.",
      "decision",
      ["database", "config"],
    );
    const id2 = await mem.capture(
      "MySQL was considered but rejected for Acme project.",
      "decision",
      ["database"],
    );

    // Before feedback: both have feedback_salience 1.0
    const beforeResults = await mem.search("database Acme", { mode: "keyword", limit: 5, explain: true });
    const before1 = beforeResults.find((r) => r.entry.id === id1);
    const before2 = beforeResults.find((r) => r.entry.id === id2);
    expect(before1?.scoreDetails?.feedback_salience).toBe(1.0);
    expect(before2?.scoreDetails?.feedback_salience).toBe(1.0);

    // Mark id1 as helpful
    await mem.feedback(id1!, "helpful", "this answered my question");

    // After feedback: id1 should have higher feedback_salience
    const afterResults = await mem.search("database Acme", { mode: "keyword", limit: 5, explain: true });
    const after1 = afterResults.find((r) => r.entry.id === id1);
    const after2 = afterResults.find((r) => r.entry.id === id2);
    expect(after1?.scoreDetails?.feedback_salience).toBe(1.1);
    expect(after2?.scoreDetails?.feedback_salience).toBe(1.0);
  });

  it("feedback flywheel: not_helpful signal lowers ranking", async () => {
    const id1 = await mem.capture(
      "Use Redis for caching layer. TTL 300 seconds.",
      "decision",
      ["cache", "redis"],
    );

    await mem.feedback(id1!, "not_helpful", "we decided not to use Redis");

    const results = await mem.search("cache Redis", { mode: "keyword", limit: 5, explain: true });
    const match = results.find((r) => r.entry.id === id1);
    expect(match?.scoreDetails?.feedback_salience).toBe(0.9);
  });

  it("feedback flywheel: stale signal floors at 0.3", async () => {
    const id1 = await mem.capture(
      "API endpoint is /v1/users. This is the current API design.",
      "decision",
      ["api", "config"],
    );

    // Boost first
    await mem.feedback(id1!, "helpful");
    await mem.feedback(id1!, "helpful");
    // Then mark stale
    await mem.feedback(id1!, "stale", "API changed to v2");

    const results = await mem.search("API endpoint", { mode: "keyword", limit: 5, explain: true });
    const match = results.find((r) => r.entry.id === id1);
    expect(match?.scoreDetails?.feedback_salience).toBeCloseTo(0.3, 5);
  });

  it("feedback flywheel: wrong signal floors at 0.1", async () => {
    const id1 = await mem.capture(
      "The server port is 8080. This is the production config.",
      "decision",
      ["config", "server"],
    );

    await mem.feedback(id1!, "wrong", "port is actually 3000");

    const results = await mem.search("server port", { mode: "keyword", limit: 5, explain: true });
    const match = results.find((r) => r.entry.id === id1);
    expect(match?.scoreDetails?.feedback_salience).toBeCloseTo(0.1, 5);
  });

  it("explain mode: returns bm25_rank for keyword search", async () => {
    await mem.capture(
      "PostgreSQL database configuration with connection pooling.",
      "decision",
      ["database"],
    );
    await mem.capture(
      "SQLite is simpler for small projects. No server needed.",
      "decision",
      ["database"],
    );

    const results = await mem.search("PostgreSQL", { mode: "keyword", limit: 5, explain: true });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.scoreDetails).toBeDefined();
      expect(r.scoreDetails?.bm25_rank).toBeDefined();
      expect(r.scoreDetails?.bm25_score).toBeDefined();
      expect(r.scoreDetails?.authority_multiplier).toBeDefined();
      expect(r.scoreDetails?.feedback_salience).toBeDefined();
    }
  });

  it("explain mode: off by default", async () => {
    await mem.capture(
      "Test capture for explain default behavior.",
      "decision",
      ["test"],
    );

    const results = await mem.search("test", { mode: "keyword", limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].scoreDetails).toBeUndefined();
  });

  it("explain mode: authority_multiplier reflects tier", async () => {
    // decision tier gets +0.15
    const id1 = await mem.capture(
      "Use PostgreSQL for the main database. Decided in architecture review.",
      "decision",
      ["database", "arch"],
    );

    const results = await mem.search("PostgreSQL database", { mode: "keyword", limit: 5, explain: true });
    const match = results.find((r) => r.entry.id === id1);
    expect(match?.scoreDetails?.authority_multiplier).toBeGreaterThan(1.0);
  });

  it("mutation log: records put, feedback actions", async () => {
    const id1 = await mem.capture(
      "Test capture for mutation log.",
      "decision",
      ["test"],
    );

    await mem.feedback(id1!, "helpful");

    const putEntries = await mem.queryAudit({ action: "put" });
    const feedbackEntries = await mem.queryAudit({ action: "feedback" });

    expect(putEntries.length).toBeGreaterThan(0);
    expect(putEntries.some((e) => e.capture_id === id1)).toBe(true);
    expect(feedbackEntries.length).toBeGreaterThan(0);
    expect(feedbackEntries.some((e) => e.capture_id === id1)).toBe(true);
  });

  it("mutation log: queryAudit filters by capture_id", async () => {
    const id1 = await mem.capture(
      "First capture for audit filter test.",
      "decision",
      ["test"],
    );
    const id2 = await mem.capture(
      "Second capture for audit filter test.",
      "decision",
      ["test"],
    );

    const entries1 = await mem.queryAudit({ captureId: id1! });
    const entries2 = await mem.queryAudit({ captureId: id2! });

    expect(entries1.every((e) => e.capture_id === id1)).toBe(true);
    expect(entries2.every((e) => e.capture_id === id2)).toBe(true);
  });

  it("mutation log: details contain action-specific metadata", async () => {
    const id1 = await mem.capture(
      "Test capture for details metadata.",
      "decision",
      ["test"],
    );

    await mem.feedback(id1!, "helpful", "test reason");

    const feedbackEntries = await mem.queryAudit({ action: "feedback", captureId: id1! });
    expect(feedbackEntries.length).toBe(1);
    const details = JSON.parse(feedbackEntries[0].details!);
    expect(details.signal).toBe("helpful");
    expect(details.reason).toBe("test reason");
    expect(details.newSalience).toBe(1.1);
  });

  it("TTL: forgetSweep deletes expired captures", async () => {
    const id1 = await mem.capture(
      "Temporary config: API key expires soon. Value=abc123.",
      "decision",
      ["config", "temp"],
    );

    // Set TTL to past via storage directly
    const storage = (mem as any).storage;
    storage.getDatabase()
      .prepare("UPDATE captures SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1000, id1);

    // Run forget sweep
    const result = await mem.forgetSweep({ threshold: 0.001, maxAgeDays: 365 });

    // Should have swept the TTL-expired capture
    expect(result.swept).toBeGreaterThan(0);

    // Verify capture is soft-deleted (get returns null for deleted)
    const entry = await mem.get(id1!);
    expect(entry).toBeNull();
  });

  it("TTL: future TTL preserves capture", async () => {
    const id1 = await mem.capture(
      "Active config: database port 5432. Valid for 30 more days.",
      "decision",
      ["config"],
    );

    // Set TTL to future
    const storage = (mem as any).storage;
    storage.getDatabase()
      .prepare("UPDATE captures SET expires_at = ? WHERE id = ?")
      .run(Date.now() + 30 * 24 * 60 * 60 * 1000, id1);

    await mem.forgetSweep({ threshold: 0.001, maxAgeDays: 365 });

    // Capture should still exist
    const entry = await mem.get(id1!);
    expect(entry).not.toBeNull();
  });

  it("feedback + explain: full flywheel cycle", async () => {
    // Capture 3 memories about the same topic
    const id1 = await mem.capture(
      "Use PostgreSQL for production database. Port 5432, pool size 20.",
      "decision",
      ["database", "config"],
    );
    const id2 = await mem.capture(
      "Use SQLite for development database. Simpler setup.",
      "decision",
      ["database"],
    );
    const id3 = await mem.capture(
      "Database connection timeout is 30 seconds. Old config.",
      "decision",
      ["database", "config"],
    );

    // Mark id1 as helpful (correct answer)
    await mem.feedback(id1!, "helpful", "correct production config");
    // Mark id3 as stale (old config)
    await mem.feedback(id3!, "stale", "timeout changed to 10s");

    // Search with explain
    const results = await mem.search("database production config", { mode: "keyword", limit: 5, explain: true });

    const r1 = results.find((r) => r.entry.id === id1);
    const r3 = results.find((r) => r.entry.id === id3);

    // id1 should have boosted salience
    expect(r1?.scoreDetails?.feedback_salience).toBe(1.1);
    // id3 should have floored salience
    expect(r3?.scoreDetails?.feedback_salience).toBeCloseTo(0.3, 5);
  });
});
