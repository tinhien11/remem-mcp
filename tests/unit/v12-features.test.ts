/**
 * Tests for v12 features: feedback, explain mode, TTL + audit log.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteBackend } from "../../src/storage/sqlite.js";
import type { CaptureEntry } from "../../src/storage/types.js";

function makeCapture(overrides: Partial<CaptureEntry> = {}): CaptureEntry {
  return {
    id: `test-${Math.random().toString(36).slice(2, 12)}`,
    sessionKey: "test-session",
    agentId: "test-agent",
    type: "learning",
    content: "Test content for capture",
    tags: ["unit-test"],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("v12 features", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-v12-test-"));
    dbPath = join(tmpDir, "test.db");
    db = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Feedback ───────────────────────────────────────────────────

  describe("feedback", () => {
    it("has capture_feedback table", () => {
      const table = db
        .getDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='capture_feedback'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("capture_feedback");
    });

    it("recordFeedback stores signal and adjusts salience", async () => {
      const id = `fb1-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Test capture for feedback" }));

      db.recordFeedback(id, "helpful", "answered my question");

      const feedback = db.getFeedback(id);
      expect(feedback.length).toBe(1);
      expect(feedback[0].signal).toBe("helpful");
      expect(feedback[0].reason).toBe("answered my question");
    });

    it("helpful signal increases feedback_salience", async () => {
      const id = `fb2-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Helpful capture" }));

      const before = db
        .getDatabase()
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(id) as { feedback_salience: number };
      expect(before.feedback_salience).toBe(1.0);

      db.recordFeedback(id, "helpful");

      const after = db
        .getDatabase()
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(id) as { feedback_salience: number };
      expect(after.feedback_salience).toBe(1.1);
    });

    it("not_helpful signal decreases feedback_salience", async () => {
      const id = `fb3-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Not helpful capture" }));

      db.recordFeedback(id, "not_helpful");

      const after = db
        .getDatabase()
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(id) as { feedback_salience: number };
      expect(after.feedback_salience).toBe(0.9);
    });

    it("stale signal floors salience at 0.3", async () => {
      const id = `fb4-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Stale capture" }));

      // First boost with helpful to get above 0.3
      db.recordFeedback(id, "helpful");
      db.recordFeedback(id, "helpful");
      const boosted = db
        .getDatabase()
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(id) as { feedback_salience: number };
      expect(boosted.feedback_salience).toBeCloseTo(1.2, 5);

      // Now mark stale — should floor at 0.3
      db.recordFeedback(id, "stale");
      const after = db
        .getDatabase()
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(id) as { feedback_salience: number };
      expect(after.feedback_salience).toBeCloseTo(0.3, 5);
    });

    it("wrong signal floors salience at 0.1", async () => {
      const id = `fb5-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Wrong capture" }));

      db.recordFeedback(id, "wrong");

      const after = db
        .getDatabase()
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(id) as { feedback_salience: number };
      expect(after.feedback_salience).toBe(0.1);
    });

    it("multiple helpful signals cap at 2.0", async () => {
      const id = `fb6-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Very helpful capture" }));

      for (let i = 0; i < 20; i++) {
        db.recordFeedback(id, "helpful");
      }

      const after = db
        .getDatabase()
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(id) as { feedback_salience: number };
      expect(after.feedback_salience).toBe(2.0);
    });

    it("multiple not_helpful signals floor at 0.1", async () => {
      const id = `fb7-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Very unhelpful capture" }));

      for (let i = 0; i < 20; i++) {
        db.recordFeedback(id, "not_helpful");
      }

      const after = db
        .getDatabase()
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(id) as { feedback_salience: number };
      expect(after.feedback_salience).toBe(0.1);
    });

    it("getFeedback returns all signals ordered by recency", async () => {
      const id = `fb8-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Multi-feedback capture" }));

      db.recordFeedback(id, "helpful");
      db.recordFeedback(id, "not_helpful");
      db.recordFeedback(id, "stale");

      const feedback = db.getFeedback(id);
      expect(feedback.length).toBe(3);
      // Most recent first
      expect(feedback[0].signal).toBe("stale");
      expect(feedback[2].signal).toBe("helpful");
    });
  });

  // ─── Audit log ──────────────────────────────────────────────────

  describe("mutation_log", () => {
    it("has mutation_log table", () => {
      const table = db
        .getDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mutation_log'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("mutation_log");
    });

    it("put creates an audit entry", async () => {
      const id = `audit1-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Audited capture" }));

      const entries = db.queryAudit({ captureId: id });
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((e) => e.action === "put")).toBe(true);
    });

    it("linkCaptures creates an audit entry", async () => {
      const id1 = `audit2-${Math.random().toString(36).slice(2, 10)}`;
      const id2 = `audit3-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id: id1, content: "First" }));
      await db.put(makeCapture({ id: id2, content: "Second" }));

      db.linkCaptures(id1, id2, "related");

      const entries = db.queryAudit({ action: "link" });
      expect(entries.length).toBeGreaterThan(0);
    });

    it("feedback creates an audit entry", async () => {
      const id = `audit4-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Feedback audited" }));

      db.recordFeedback(id, "helpful");

      const entries = db.queryAudit({ action: "feedback" });
      expect(entries.length).toBeGreaterThan(0);
    });

    it("queryAudit filters by action", async () => {
      const id = `audit5-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Filter test" }));
      db.recordFeedback(id, "helpful");

      const putEntries = db.queryAudit({ action: "put" });
      const feedbackEntries = db.queryAudit({ action: "feedback" });
      expect(putEntries.every((e) => e.action === "put")).toBe(true);
      expect(feedbackEntries.every((e) => e.action === "feedback")).toBe(true);
    });

    it("queryAudit filters by since timestamp", async () => {
      const beforeTime = Date.now();
      const id = `audit6-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Time filter test" }));

      const entries = db.queryAudit({ since: beforeTime });
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.created_at >= beforeTime)).toBe(true);
    });

    it("queryAudit limits results", async () => {
      // Create multiple captures
      for (let i = 0; i < 5; i++) {
        await db.put(makeCapture({ id: `limit-${i}-${Math.random().toString(36).slice(2, 6)}`, content: `Capture ${i}` }));
      }

      const entries = db.queryAudit({ limit: 2 });
      expect(entries.length).toBe(2);
    });
  });

  // ─── TTL expires_at ─────────────────────────────────────────────

  describe("TTL expires_at", () => {
    it("has expires_at column", () => {
      const cols = db
        .getDatabase()
        .prepare("PRAGMA table_info(captures)")
        .all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain("expires_at");
    });

    it("forgetSweep hard-deletes TTL-expired captures regardless of salience", async () => {
      const id = `ttl1-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(
        makeCapture({
          id,
          content: "Time-sensitive config: port=5432",
          createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
          sessionKey: "ttl-session",
        }),
      );

      // Set TTL to past
      db.getDatabase()
        .prepare("UPDATE captures SET expires_at = ? WHERE id = ?")
        .run(Date.now() - 1000, id);

      // Run sweep with very low threshold (capture is only 10 days old, salience should be high)
      const result = await db.forgetSweep({ threshold: 0.001, maxAgeDays: 1 });
      expect(result.swept).toBeGreaterThan(0);

      // Verify capture is soft-deleted
      const row = db
        .getDatabase()
        .prepare("SELECT deleted_at FROM captures WHERE id = ?")
        .get(id) as { deleted_at: number | null };
      expect(row.deleted_at).not.toBeNull();
    });

    it("forgetSweep does not delete captures with future TTL", async () => {
      const id = `ttl2-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(
        makeCapture({
          id,
          content: "Future TTL capture",
          createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
          sessionKey: "ttl-session",
        }),
      );

      // Set TTL to future
      db.getDatabase()
        .prepare("UPDATE captures SET expires_at = ? WHERE id = ?")
        .run(Date.now() + 30 * 24 * 60 * 60 * 1000, id);

      const result = await db.forgetSweep({ threshold: 0.001, maxAgeDays: 1 });
      // Should not be swept because TTL is in future (even though it's old enough for maxAgeDays)
      // Note: it might still be swept if salience < threshold, but threshold is 0.001 (very low)
      const row = db
        .getDatabase()
        .prepare("SELECT deleted_at FROM captures WHERE id = ?")
        .get(id) as { deleted_at: number | null };
      expect(row.deleted_at).toBeNull();
    });
  });

  // ─── Explain mode ───────────────────────────────────────────────

  describe("explain mode", () => {
    it("returns scoreDetails when explain=true", async () => {
      const id = `exp1-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(
        makeCapture({
          id,
          content: "PostgreSQL database configuration port 5432",
          sessionKey: "explain-session",
        }),
      );

      const results = await db.search("postgresql", null, {
        sessionKey: "explain-session",
        limit: 10,
        offset: 0,
        mode: "keyword",
        explain: true,
      });

      expect(results.length).toBeGreaterThan(0);
      const match = results.find((r) => r.entry.id === id);
      expect(match).toBeDefined();
      expect(match?.scoreDetails).toBeDefined();
      expect(match?.scoreDetails?.bm25_rank).toBeDefined();
    });

    it("does not return scoreDetails when explain=false", async () => {
      const id = `exp2-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(
        makeCapture({
          id,
          content: "Another PostgreSQL capture",
          sessionKey: "explain-session-2",
        }),
      );

      const results = await db.search("postgresql", null, {
        sessionKey: "explain-session-2",
        limit: 10,
        offset: 0,
        mode: "keyword",
        explain: false,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].scoreDetails).toBeUndefined();
    });

    it("scoreDetails includes authority_multiplier", async () => {
      const id = `exp3-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(
        makeCapture({
          id,
          content: "Database decision: use PostgreSQL",
          type: "decision",
          tags: ["database", "decision"],
          sessionKey: "explain-session-3",
        }),
      );

      const results = await db.search("database", null, {
        sessionKey: "explain-session-3",
        limit: 10,
        offset: 0,
        mode: "keyword",
        explain: true,
      });

      const match = results.find((r) => r.entry.id === id);
      expect(match?.scoreDetails?.authority_multiplier).toBeDefined();
      // decision tier gets +0.15
      expect(match?.scoreDetails?.authority_multiplier).toBeGreaterThan(1.0);
    });

    it("scoreDetails includes feedback_salience after feedback", async () => {
      const id = `exp4-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(
        makeCapture({
          id,
          content: "Feedback explain test capture",
          sessionKey: "explain-session-4",
        }),
      );

      db.recordFeedback(id, "helpful");

      const results = await db.search("feedback", null, {
        sessionKey: "explain-session-4",
        limit: 10,
        offset: 0,
        mode: "keyword",
        explain: true,
      });

      const match = results.find((r) => r.entry.id === id);
      expect(match?.scoreDetails?.feedback_salience).toBe(1.1);
    });
  });

  // ─── Schema v12 migration ───────────────────────────────────────

  describe("schema v12 migration", () => {
    it("has feedback_salience column with default 1.0", async () => {
      const id = `sch1-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Schema test" }));

      const row = db
        .getDatabase()
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(id) as { feedback_salience: number };
      expect(row.feedback_salience).toBe(1.0);
    });

    it("has expires_at column (nullable)", () => {
      const cols = db
        .getDatabase()
        .prepare("PRAGMA table_info(captures)")
        .all() as { name: string; notnull: number; dflt_value: string | null }[];
      const expiresCol = cols.find((c) => c.name === "expires_at");
      expect(expiresCol).toBeDefined();
      expect(expiresCol?.notnull).toBe(0); // nullable
    });
  });
});
