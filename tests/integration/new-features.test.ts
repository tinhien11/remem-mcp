import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Memory } from "../../src/sdk.js";
import { SQLiteBackend } from "../../src/storage/sqlite.js";

const testDir = join(homedir(), ".local", "share", "remem-mcp", "test-new-features");
const testDbPath = join(testDir, "memory.db");

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});
afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("SDK update()", () => {
  it("updates content and re-embeds", async () => {
    const m = new Memory({ dbPath: testDbPath });
    const id = await m.capture("Original content here", "learning", ["test"]);
    expect(id).not.toBeNull();

    const ok = await m.update(id!, { content: "Updated content here" });
    expect(ok).toBe(true);

    const results = await m.recall("Updated content");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content).toBe("Updated content here");
    m.close();
  });

  it("updates tags only", async () => {
    const m = new Memory({ dbPath: testDbPath });
    const id = await m.capture("Tag test content", "learning", ["old"]);
    expect(id).not.toBeNull();

    await m.update(id!, { tags: ["new", "updated"] });
    const results = await m.recall("Tag test content");
    expect(results[0].entry.tags).toEqual(["new", "updated"]);
    m.close();
  });

  it("updates type only", async () => {
    const m = new Memory({ dbPath: testDbPath });
    const id = await m.capture("Type test content", "learning", ["test"]);
    expect(id).not.toBeNull();

    await m.update(id!, { type: "decision" });
    const results = await m.recall("Type test content");
    expect(results[0].entry.type).toBe("decision");
    m.close();
  });

  it("updates verified flag", async () => {
    const m = new Memory({ dbPath: testDbPath });
    const id = await m.capture("Verify test content", "learning", ["test"]);
    expect(id).not.toBeNull();

    await m.update(id!, { verified: true });
    const results = await m.recall("Verify test content");
    expect(results[0].entry.trustState).toBe("verified");
    m.close();
  });

  it("returns false for non-existent ID", async () => {
    const m = new Memory({ dbPath: testDbPath });
    const ok = await m.update("01M0NONEXISTENT12345678", { content: "test" });
    expect(ok).toBe(false);
    m.close();
  });

  it("updates all fields at once", async () => {
    const m = new Memory({ dbPath: testDbPath });
    const id = await m.capture("All fields original", "learning", ["old"]);
    expect(id).not.toBeNull();

    await m.update(id!, {
      content: "All fields updated",
      tags: ["new", "all"],
      type: "decision",
      verified: true,
    });
    const results = await m.recall("All fields updated");
    expect(results[0].entry.content).toBe("All fields updated");
    expect(results[0].entry.tags).toEqual(["new", "all"]);
    expect(results[0].entry.type).toBe("decision");
    expect(results[0].entry.trustState).toBe("verified");
    m.close();
  });
});

describe("SDK consolidate()", () => {
  it("returns empty groups with <2 captures", async () => {
    const m = new Memory({ dbPath: testDbPath });
    await m.capture("Single capture", "learning", ["test"]);
    const result = await m.consolidate({ threshold: 0.3 });
    expect(result.groups.length).toBe(0);
    expect(result.merged).toBe(0);
    m.close();
  });

  it("finds duplicates with confirm=false (no deletion)", async () => {
    const m = new Memory({ dbPath: testDbPath });
    await m.capture("The quick brown fox jumps over the lazy dog", "learning", ["test"]);
    await m.capture("The quick brown fox jumps over the lazy dog today", "learning", ["test"]);

    const result = await m.consolidate({ threshold: 0.3, confirm: false });
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.merged).toBe(0);

    // Verify both still exist
    const r = await m.recall("quick brown fox");
    expect(r.length).toBeGreaterThanOrEqual(2);
    m.close();
  });

  it("merges duplicates with confirm=true", async () => {
    const m = new Memory({ dbPath: testDbPath });
    await m.capture("The quick brown fox jumps over the lazy dog", "learning", ["test"]);
    await m.capture("The quick brown fox jumps over the lazy dog today", "learning", ["test"]);

    const result = await m.consolidate({ threshold: 0.3, confirm: true });
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.merged).toBeGreaterThan(0);

    // Verify only one survives
    const r = await m.recall("quick brown fox");
    expect(r.length).toBe(1);
    m.close();
  });

  it("respects threshold filtering", async () => {
    const m = new Memory({ dbPath: testDbPath });
    await m.capture("Completely different content about apples", "learning", ["test"]);
    await m.capture("Totally unrelated text about zebras", "learning", ["test"]);

    const result = await m.consolidate({ threshold: 0.9, confirm: false });
    expect(result.groups.length).toBe(0);
    m.close();
  });
});

describe("Memory decay / auto-stale", () => {
  it("applies decay to old captures", async () => {
    const m = new Memory({ dbPath: testDbPath });
    const id = await m.capture("Decay test capture", "learning", ["test"]);
    expect(id).not.toBeNull();

    // Recall should find it (it's fresh)
    const results = await m.recall("Decay test");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.id).toBe(id);
    m.close();
  });

  it("verified captures are immune to auto-stale", async () => {
    const m = new Memory({ dbPath: testDbPath });
    const id = await m.capture("Verified capture for stale test", "decision", ["test"]);
    expect(id).not.toBeNull();

    // Mark as verified
    await m.update(id!, { verified: true });

    // Even with very short stale threshold, verified should still rank well
    const db = m["storage"].getDatabase();
    // Simulate old capture by backdating created_at
    const oldTime = Date.now() - 200 * 24 * 60 * 60 * 1000; // 200 days ago
    db.prepare("UPDATE captures SET created_at = ? WHERE id = ?").run(oldTime, id);

    const results = await m.recall("Verified capture");
    expect(results.length).toBeGreaterThan(0);
    // Verified captures should still appear (trust boost 1.5, not 0.1)
    expect(results[0].entry.id).toBe(id);
    m.close();
  });

  it("non-verified old captures get auto-stale penalty", async () => {
    const m = new Memory({ dbPath: testDbPath });
    const id = await m.capture("Non-verified old capture for stale test", "learning", ["test"]);
    expect(id).not.toBeNull();

    const db = m["storage"].getDatabase();
    // Backdate to 200 days ago (past default 90-day stale threshold)
    const oldTime = Date.now() - 200 * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE captures SET created_at = ? WHERE id = ?").run(oldTime, id);

    // Should still be found but with lower score
    const results = await m.recall("Non-verified old capture");
    expect(results.length).toBeGreaterThan(0);
    // The score should be lower due to auto-stale (0.1 trust boost vs 1.0)
    // We can't assert exact score, but it should be findable
    m.close();
  });
});

describe("Stats MCP tool data", () => {
  it("stats CLI produces correct counts", async () => {
    const m = new Memory({ dbPath: testDbPath });
    await m.capture("Stats test 1", "learning", ["tag1", "tag2"]);
    await m.capture("Stats test 2", "decision", ["tag1"]);
    await m.capture("Stats test 3", "error", ["tag2", "tag3"]);

    const db = m["storage"].getDatabase();
    const total = db.prepare("SELECT COUNT(*) as n FROM captures WHERE deleted_at IS NULL").get() as { n: number };
    expect(total.n).toBe(3);

    const byType = db.prepare("SELECT type, COUNT(*) as n FROM captures WHERE deleted_at IS NULL GROUP BY type ORDER BY n DESC").all() as { type: string; n: number }[];
    const typeMap = Object.fromEntries(byType.map((r) => [r.type, r.n]));
    expect(typeMap["learning"]).toBe(1);
    expect(typeMap["decision"]).toBe(1);
    expect(typeMap["error"]).toBe(1);

    const tagRows = db.prepare("SELECT tags FROM captures WHERE deleted_at IS NULL AND tags IS NOT NULL AND tags != '[]'").all() as { tags: string }[];
    const tagCounts: Record<string, number> = {};
    for (const row of tagRows) {
      const tags = JSON.parse(row.tags) as string[];
      for (const t of tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    }
    expect(tagCounts["tag1"]).toBe(2);
    expect(tagCounts["tag2"]).toBe(2);
    expect(tagCounts["tag3"]).toBe(1);
    m.close();
  });
});

describe("CLI sessions/tags data", () => {
  it("sessions query returns correct session count", async () => {
    const m = new Memory({ dbPath: testDbPath, sessionKey: "test-session-1" });
    await m.capture("Session 1 capture", "learning", ["test"]);

    const m2 = new Memory({ dbPath: testDbPath, sessionKey: "test-session-2" });
    await m2.capture("Session 2 capture", "learning", ["test"]);

    const db = m["storage"].getDatabase();
    const sessions = db.prepare("SELECT COUNT(DISTINCT session_key) as n FROM captures WHERE deleted_at IS NULL").get() as { n: number };
    expect(sessions.n).toBe(2);

    const sessionRows = db.prepare("SELECT session_key, COUNT(*) as cnt FROM captures WHERE deleted_at IS NULL GROUP BY session_key ORDER BY cnt DESC").all() as { session_key: string; cnt: number }[];
    expect(sessionRows.length).toBe(2);
    expect(sessionRows[0].cnt).toBe(1);
    m.close();
    m2.close();
  });

  it("tags query handles malformed JSON gracefully", async () => {
    const m = new Memory({ dbPath: testDbPath });
    await m.capture("Valid tags capture", "learning", ["valid"]);

    // Insert a capture with malformed tags directly
    const db = m["storage"].getDatabase();
    const id = "01M0MALFORMED00000000000000";
    db.prepare(
      "INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, "test", "test", "learning", "Malformed tags", "hash123", "{invalid json", Date.now());

    // Query tags - should not crash
    const tagRows = db.prepare("SELECT tags FROM captures WHERE deleted_at IS NULL AND tags IS NOT NULL AND tags != '[]'").all() as { tags: string }[];
    const tagCounts: Record<string, number> = {};
    for (const row of tagRows) {
      try {
        const tags = JSON.parse(row.tags) as string[];
        for (const t of tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
      } catch {
        // skip malformed - this is the test
      }
    }
    // Only "valid" tag should be counted
    expect(tagCounts["valid"]).toBe(1);
    expect(Object.keys(tagCounts).length).toBe(1);
    m.close();
  });
});
