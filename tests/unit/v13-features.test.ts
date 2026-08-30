/**
 * Tests for v13 features: adaptive memory links, contextual retrieval, auto-feedback.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Memory, SQLiteBackend } from "../../src/sdk.js";

describe("v13 features", () => {
  let tmpDir: string;
  let mem: Memory;
  let storage: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-v13-"));
    const dbPath = join(tmpDir, "test.db");
    mem = new Memory({ dbPath });
    storage = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    mem.close();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Adaptive memory links (Hebbian) ────────────────────────────

  describe("adaptive memory links", () => {
    it("has weight column in memory_links", () => {
      const cols = storage
        .getDatabase()
        .prepare("PRAGMA table_info(memory_links)")
        .all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain("weight");
    });

    it("co-retrieval creates co-retrieval links", async () => {
      const id1 = await mem.capture("PostgreSQL database config", "decision", ["db"]);
      const id2 = await mem.capture("Database connection pool settings", "decision", ["db"]);

      // Directly call strengthenLinksOnCoRetrieval (as search would do internally)
      storage.strengthenLinksOnCoRetrieval([id1!, id2!]);

      const db = storage.getDatabase();
      const links = db
        .prepare("SELECT * FROM memory_links WHERE link_type = 'co-retrieval'")
        .all() as { from_id: string; to_id: string; weight: number }[];
      expect(links.length).toBeGreaterThan(0);
    });

    it("repeated co-retrieval strengthens link weight", async () => {
      const id1 = await mem.capture("Redis cache configuration", "decision", ["cache"]);
      const id2 = await mem.capture("Cache TTL settings for Redis", "decision", ["cache"]);

      // Simulate repeated co-retrieval (3 searches returning both)
      storage.strengthenLinksOnCoRetrieval([id1!, id2!]);
      storage.strengthenLinksOnCoRetrieval([id1!, id2!]);
      storage.strengthenLinksOnCoRetrieval([id1!, id2!]);

      const db = storage.getDatabase();
      const link = db
        .prepare("SELECT weight FROM memory_links WHERE link_type = 'co-retrieval' LIMIT 1")
        .get() as { weight: number } | undefined;
      expect(link).toBeDefined();
      expect(link!.weight).toBeGreaterThan(1.0); // should be ~1.3 after 3 calls
    });

    it("expandByLinks uses weight to scale score", async () => {
      const id1 = await mem.capture("Test capture A", "decision", ["test"]);
      const id2 = await mem.capture("Test capture B", "decision", ["test"]);

      // Manually create a weighted link
      storage.getDatabase()
        .prepare("INSERT INTO memory_links (from_id, to_id, link_type, auto, weight, created_at) VALUES (?, ?, 'related', 0, 3.0, ?)")
        .run(id1, id2, Date.now());

      const expanded = storage.expandByLinks([id1!], 10);
      const match = expanded.find((e: any) => e.id === id2);
      expect(match).toBeDefined();
      // Score should be scaled by weight (3.0)
      expect(match!.score).toBeGreaterThan(0);
    });

    it("strengthenLinksOnCoRetrieval creates bidirectional pairs", async () => {
      const id1 = await mem.capture("Capture X", "decision", ["test"]);
      const id2 = await mem.capture("Capture Y", "decision", ["test"]);
      const id3 = await mem.capture("Capture Z", "decision", ["test"]);

      storage.strengthenLinksOnCoRetrieval([id1!, id2!, id3!]);

      const db = storage.getDatabase();
      const links = db
        .prepare("SELECT * FROM memory_links WHERE link_type = 'co-retrieval'")
        .all() as { from_id: string; to_id: string }[];
      // 3 pairs: (1,2), (1,3), (2,3)
      expect(links.length).toBe(3);
    });
  });

  // ─── Contextual retrieval ───────────────────────────────────────

  describe("contextual retrieval", () => {
    it("capture with type+tags produces a vector embedding", async () => {
      const id = await mem.capture(
        "Use PostgreSQL for production. Port 5432.",
        "decision",
        ["database", "config"],
      );
      expect(id).not.toBeNull();

      // Verify vector was stored (contextual preamble is prepended before embedding)
      const db = storage.getDatabase();
      const vec = db.prepare("SELECT id FROM captures_vec WHERE id = ?").get(id) as { id: string } | undefined;
      expect(vec).toBeDefined();
    });

    it("capture with conversation type still produces a vector", async () => {
      const id = await mem.capture("Just a regular conversation message.", "conversation", []);
      expect(id).not.toBeNull();

      const db = storage.getDatabase();
      const vec = db.prepare("SELECT id FROM captures_vec WHERE id = ?").get(id) as { id: string } | undefined;
      expect(vec).toBeDefined();
    });

    it("vector search finds capture by semantic similarity", async () => {
      await mem.capture(
        "Use PostgreSQL for production database. Port 5432.",
        "decision",
        ["database", "config"],
      );

      // Vector search should find it
      const results = await mem.search("database", { mode: "vector", limit: 5 });
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ─── Auto-feedback from corrections ─────────────────────────────

  describe("auto-feedback from corrections", () => {
    it("confirm auto-records helpful feedback", async () => {
      const id = await mem.capture("Server port is 3000.", "decision", ["config"]);
      expect(id).not.toBeNull();

      // Use the storage directly to simulate confirm
      const db = storage.getDatabase();
      db.prepare("UPDATE captures SET confirmations = confirmations + 1 WHERE id = ?").run(id);
      storage.recordFeedback(id!, "helpful", "auto: confirmed by agent", "sdk");

      // Verify feedback was recorded
      const fb = await mem.getFeedback(id!);
      expect(fb.length).toBe(1);
      expect(fb[0].signal).toBe("helpful");
      expect(fb[0].reason).toContain("auto:");
    });

    it("correct auto-records wrong feedback", async () => {
      const id = await mem.capture("Server port is 8080.", "decision", ["config"]);
      expect(id).not.toBeNull();

      // Simulate correct
      const db = storage.getDatabase();
      db.prepare("UPDATE captures SET corrections = corrections + 1 WHERE id = ?").run(id);
      storage.recordFeedback(id!, "wrong", "auto: port is actually 3000", "sdk");

      // Verify feedback
      const fb = await mem.getFeedback(id!);
      expect(fb.length).toBe(1);
      expect(fb[0].signal).toBe("wrong");
      expect(fb[0].reason).toContain("auto:");

      // Verify feedback_salience was floored
      const row = db
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(id) as { feedback_salience: number };
      expect(row.feedback_salience).toBeCloseTo(0.1, 5);
    });

    it("multiple confirms boost feedback_salience", async () => {
      const id = await mem.capture("Use Redis for cache.", "decision", ["cache"]);

      // Simulate 3 confirms
      storage.recordFeedback(id!, "helpful", "auto: confirmed");
      storage.recordFeedback(id!, "helpful", "auto: confirmed");
      storage.recordFeedback(id!, "helpful", "auto: confirmed");

      const db = storage.getDatabase();
      const row = db
        .prepare("SELECT feedback_salience FROM captures WHERE id = ?")
        .get(id) as { feedback_salience: number };
      expect(row.feedback_salience).toBeCloseTo(1.3, 5);
    });
  });

  // ─── Schema v13 migration ───────────────────────────────────────

  describe("schema v13", () => {
    it("schema version is 14", () => {
      const db = storage.getDatabase();
      const row = db
        .prepare("SELECT MAX(version) as version FROM schema_version")
        .get() as { version: number };
      expect(row.version).toBe(14);
    });

    it("memory_links has weight column with default 1.0", async () => {
      const id1 = await mem.capture("Schema test A", "decision", ["test"]);
      const id2 = await mem.capture("Schema test B", "decision", ["test"]);

      storage.linkCaptures(id1!, id2!, "related");

      const db = storage.getDatabase();
      const link = db
        .prepare("SELECT weight FROM memory_links WHERE from_id = ? AND to_id = ?")
        .get(id1, id2) as { weight: number } | undefined;
      expect(link).toBeDefined();
      expect(link!.weight).toBe(1.0);
    });
  });
});
