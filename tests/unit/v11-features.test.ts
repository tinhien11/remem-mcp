/**
 * Tests for v11 features: memory-to-memory links, raw observation fallback, write queue.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteBackend } from "../../src/storage/sqlite.js";
import { WriteQueue } from "../../src/utils/write-queue.js";
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

describe("v11 features", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-v11-test-"));
    dbPath = join(tmpDir, "test.db");
    db = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Memory-to-memory links ─────────────────────────────────────

  describe("memory_links", () => {
    it("has memory_links table", () => {
      const table = db
        .getDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_links'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("memory_links");
    });

    it("linkCaptures creates a link", async () => {
      const id1 = `link1-${Math.random().toString(36).slice(2, 10)}`;
      const id2 = `link2-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id: id1, content: "First capture" }));
      await db.put(makeCapture({ id: id2, content: "Second capture" }));

      db.linkCaptures(id1, id2, "related");
      // Wait for write queue to drain
      await new Promise((r) => setTimeout(r, 50));

      const links = db.getLinksFrom(id1);
      expect(links.length).toBeGreaterThan(0);
      expect(links.some((l) => l.to_id === id2)).toBe(true);
    });

    it("linkCaptures does not create self-links", async () => {
      const id = `self-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Self link test" }));

      db.linkCaptures(id, id, "related");
      await new Promise((r) => setTimeout(r, 50));

      const links = db.getLinksFrom(id);
      expect(links.every((l) => l.to_id !== id)).toBe(true);
    });

    it("getLinksTo returns inbound links", async () => {
      const id1 = `in1-${Math.random().toString(36).slice(2, 10)}`;
      const id2 = `in2-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id: id1, content: "Source" }));
      await db.put(makeCapture({ id: id2, content: "Target" }));

      db.linkCaptures(id1, id2, "cause-effect");
      await new Promise((r) => setTimeout(r, 50));

      const links = db.getLinksTo(id2);
      expect(links.some((l) => l.from_id === id1)).toBe(true);
    });

    it("auto-links captures with shared tags", async () => {
      const id1 = `auto1-${Math.random().toString(36).slice(2, 10)}`;
      const id2 = `auto2-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(
        makeCapture({
          id: id1,
          content: "First decision about SQLite",
          tags: ["database", "decision"],
          sessionKey: "shared-session",
        }),
      );
      await db.put(
        makeCapture({
          id: id2,
          content: "Second decision about Postgres",
          tags: ["database", "decision"],
          sessionKey: "shared-session",
        }),
      );
      // Wait for auto-linking to complete
      await new Promise((r) => setTimeout(r, 100));

      const links = db.getLinksFrom(id2);
      // Should have at least one auto-link (shared-tag)
      expect(links.some((l) => l.link_type === "shared-tag" && l.auto === 1)).toBe(true);
    });

    it("auto-links captures with shared entities", async () => {
      const id1 = `ent1-${Math.random().toString(36).slice(2, 10)}`;
      const id2 = `ent2-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(
        makeCapture({
          id: id1,
          content: "Configured SQLite for the database layer",
          sessionKey: "entity-session",
        }),
      );
      await db.put(
        makeCapture({
          id: id2,
          content: "SQLite migration completed successfully",
          sessionKey: "entity-session",
        }),
      );
      await new Promise((r) => setTimeout(r, 100));

      const links = db.getLinksFrom(id2);
      // Should have at least one auto-link (shared-entity for "sqlite")
      expect(links.some((l) => l.link_type === "shared-entity" && l.auto === 1)).toBe(true);
    });

    it("expandByLinks returns linked captures", async () => {
      const id1 = `exp1-${Math.random().toString(36).slice(2, 10)}`;
      const id2 = `exp2-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id: id1, content: "Source capture" }));
      await db.put(makeCapture({ id: id2, content: "Linked capture" }));

      db.linkCaptures(id1, id2, "related");
      await new Promise((r) => setTimeout(r, 50));

      const expanded = db.expandByLinks([id1], 10);
      expect(expanded.some((e) => e.id === id2)).toBe(true);
    });

    it("expandByLinks returns empty for no links", async () => {
      const id = `nolink-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id, content: "Lonely capture" }));

      const expanded = db.expandByLinks([id], 10);
      expect(expanded).toEqual([]);
    });

    it("expandByLinks returns empty for empty input", () => {
      expect(db.expandByLinks([], 10)).toEqual([]);
    });
  });

  // ─── Raw observation fallback ───────────────────────────────────

  describe("rawFallbackSearch", () => {
    it("finds captures that normal search filters out (stale via trust_state)", async () => {
      const id = `stale-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(
        makeCapture({
          id,
          content: "Unique keyword: zzzfallbacktest about database config",
          sessionKey: "fallback-session",
        }),
      );

      // Set trust_state to 'rejected' directly (without deleted_at, unlike reject())
      // Normal search filters by trust_state != 'rejected'
      db.setTrustState(id, "rejected");

      // Normal keyword search should not find it (trust_state filter)
      const normalResults = await db.search("zzzfallbacktest", null, {
        sessionKey: "fallback-session",
        limit: 10,
        offset: 0,
        mode: "keyword",
      });
      expect(normalResults.length).toBe(0);

      // Raw fallback should find it (hybrid mode, 0 results → fallback)
      // Raw fallback includes rejected (trust_state) but excludes superseded/deleted
      const fallbackResults = await db.search("zzzfallbacktest", null, {
        sessionKey: "fallback-session",
        limit: 10,
        offset: 0,
        mode: "hybrid",
      });
      // Fallback should find the rejected capture
      expect(fallbackResults.length).toBeGreaterThan(0);
      expect(fallbackResults.some((r) => r.entry.content.includes("zzzfallbacktest"))).toBe(true);
    });

    it("does not trigger fallback when normal search has results", async () => {
      const id1 = `has1-${Math.random().toString(36).slice(2, 10)}`;
      const id2 = `has2-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(
        makeCapture({
          id: id1,
          content: "Normal searchable content about postgres",
          sessionKey: "no-fallback-session",
        }),
      );
      await db.put(
        makeCapture({
          id: id2,
          content: "Stale content about postgres",
          sessionKey: "no-fallback-session",
        }),
      );
      await db.supersede(id2, id1);

      const results = await db.search("postgres", null, {
        sessionKey: "no-fallback-session",
        limit: 10,
        offset: 0,
        mode: "hybrid",
      });
      // Should find id1 (non-stale), not trigger fallback
      expect(results.some((r) => r.entry.id === id1)).toBe(true);
    });
  });

  // ─── WriteQueue ─────────────────────────────────────────────────

  describe("WriteQueue", () => {
    it("serializes write operations", async () => {
      const queue = new WriteQueue();
      const order: number[] = [];

      const tasks = [1, 2, 3].map((n) =>
        queue.enqueue(async () => {
          order.push(n);
          await new Promise((r) => setTimeout(r, 10));
        }),
      );

      await Promise.all(tasks);
      expect(order).toEqual([1, 2, 3]);
    });

    it("one failure does not block subsequent tasks", async () => {
      const queue = new WriteQueue();
      const results: string[] = [];

      await Promise.all([
        queue.enqueue(async () => {
          results.push("first");
          throw new Error("fail");
        }).catch(() => {}),
        queue.enqueue(async () => {
          results.push("second");
        }),
      ]);

      expect(results).toEqual(["first", "second"]);
    });

    it("drain waits for all pending tasks", async () => {
      const queue = new WriteQueue();
      let completed = false;

      queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 50));
        completed = true;
      });

      await queue.drain();
      expect(completed).toBe(true);
    });

    it("pending count tracks running tasks", async () => {
      const queue = new WriteQueue();
      expect(queue.pending).toBe(0);

      const task = queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(queue.pending).toBe(1);
      await task;
      expect(queue.pending).toBe(0);
    });
  });

  // ─── Schema v11 migration ───────────────────────────────────────

  describe("schema v11 migration", () => {
    it("has memory_links table with correct columns", () => {
      const cols = db
        .getDatabase()
        .prepare("PRAGMA table_info(memory_links)")
        .all() as { name: string }[];
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("from_id");
      expect(colNames).toContain("to_id");
      expect(colNames).toContain("link_type");
      expect(colNames).toContain("auto");
      expect(colNames).toContain("created_at");
    });

    it("has unique constraint on (from_id, to_id, link_type)", async () => {
      const id1 = `uniq1-${Math.random().toString(36).slice(2, 10)}`;
      const id2 = `uniq2-${Math.random().toString(36).slice(2, 10)}`;
      await db.put(makeCapture({ id: id1, content: "First" }));
      await db.put(makeCapture({ id: id2, content: "Second" }));

      db.linkCaptures(id1, id2, "related");
      db.linkCaptures(id1, id2, "related"); // duplicate — should be ignored
      await new Promise((r) => setTimeout(r, 50));

      const links = db.getLinksFrom(id1).filter((l) => l.to_id === id2 && l.link_type === "related");
      expect(links.length).toBe(1);
    });
  });
});
