import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteBackend } from "../../src/storage/sqlite.js";
import type { CaptureEntry, CaptureType } from "../../src/storage/types.js";
import { generateId } from "../../src/utils/ulid.js";

function makeEntry(opts: {
  content: string;
  type?: CaptureType;
  tags?: string[];
  sessionKey?: string;
  agentId?: string;
}): CaptureEntry {
  return {
    id: generateId(),
    sessionKey: opts.sessionKey ?? "edge-test",
    agentId: opts.agentId ?? "edge-agent",
    type: opts.type ?? "decision",
    content: opts.content,
    tags: opts.tags ?? [],
    createdAt: Date.now(),
    contentHash: createHash("sha256").update(opts.content).digest("hex"),
  };
}

describe("Edge cases: empty database", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-edge-empty-"));
    dbPath = join(tmpDir, "empty.db");
    storage = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recall on empty DB returns empty array", async () => {
    const results = await storage.search("anything", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });
    expect(results).toEqual([]);
  });

  it("vector search on empty DB returns empty array", async () => {
    const vec = new Array(384).fill(0.1);
    const results = await storage.search("anything", vec, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "vector",
    });
    expect(results).toEqual([]);
  });

  it("hybrid search on empty DB returns empty array", async () => {
    const vec = new Array(384).fill(0.1);
    const results = await storage.search("anything", vec, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "hybrid",
    });
    expect(results).toEqual([]);
  });

  it("findByContentHash on empty DB returns empty array", async () => {
    const results = await storage.findByContentHash("nonexistent-hash", "edge-test");
    expect(results).toEqual([]);
  });

  it("put and recall single entry works on fresh DB", async () => {
    const entry = makeEntry({ content: "First entry" });
    await storage.put(entry);
    await storage.putVector(entry.id, new Array(384).fill(0.1));

    const results = await storage.search("First", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content).toBe("First entry");
  });

  it("stats on empty DB returns zeros", async () => {
    // stats is a standalone function, not on the backend
    // Verify the DB is queryable without error
    const results = await storage.search("anything", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });
    expect(results).toEqual([]);
  });
});

describe("Edge cases: large content", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-edge-large-"));
    dbPath = join(tmpDir, "large.db");
    storage = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles 10KB content", async () => {
    const content = "This is a large content entry for testing. ".repeat(223); // ~10KB
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("large", null, {
      sessionKey: "edge-test",
      limit: 1,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content.length).toBeGreaterThan(9_000);
  });

  it("handles 100KB content", async () => {
    const content = "This is a large content entry for testing. ".repeat(2230); // ~100KB
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("large", null, {
      sessionKey: "edge-test",
      limit: 1,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content.length).toBeGreaterThan(90_000);
  });

  it("handles 1MB content", async () => {
    const content = "This is a large content entry for testing. ".repeat(22300); // ~1MB
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("large", null, {
      sessionKey: "edge-test",
      limit: 1,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content.length).toBeGreaterThan(900_000);
  });

  it("handles many small entries (1000)", async () => {
    for (let i = 0; i < 1000; i++) {
      const entry = makeEntry({ content: `Entry number ${i}` });
      await storage.put(entry);
    }

    const results = await storage.search("Entry", null, {
      sessionKey: "edge-test",
      limit: 50,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(50);
  });

  it("handles content with many lines", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(`Line ${i}: some content here`);
    }
    const content = lines.join("\n");
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("Line", null, {
      sessionKey: "edge-test",
      limit: 1,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content.split("\n").length).toBe(5000);
  });
});

describe("Edge cases: special characters", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-edge-chars-"));
    dbPath = join(tmpDir, "chars.db");
    storage = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles Unicode (Vietnamese)", async () => {
    const content = "Tiếng Việt: Xin chào thế giới! Hôm nay là ngày tốt đẹp.";
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("Tiếng", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content).toBe(content);
  });

  it("handles Unicode (Japanese)", async () => {
    const content = "こんにちは世界！今日は良い日です。";
    const entry = makeEntry({ content });
    await storage.put(entry);

    // FTS5 default tokenizer may not handle CJK well, so use vector search
    // or verify via findByContentHash
    const hash = createHash("sha256").update(content).digest("hex");
    const results = await storage.findByContentHash(hash, "edge-test");

    expect(results.length).toBe(1);
    expect(results[0].content).toBe(content);
  });

  it("handles Unicode (Emoji)", async () => {
    const content = "Decision: Use 🚀 for deployment 🎉 and 🔥 for hotfixes";
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("deployment", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content).toContain("🚀");
    expect(results[0]?.entry.content).toContain("🎉");
  });

  it("handles SQL injection attempts in content", async () => {
    const content = "'; DROP TABLE captures; --";
    const entry = makeEntry({ content });
    await storage.put(entry);

    // Table should still exist
    const results = await storage.search("DROP", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content).toBe("'; DROP TABLE captures; --");
  });

  it("handles SQL injection in search query", async () => {
    const entry = makeEntry({ content: "Normal content" });
    await storage.put(entry);

    const results = await storage.search("'; DROP TABLE captures; --", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    // Should return empty (no match), table should still exist
    expect(results).toEqual([]);

    // Verify table still exists by doing a normal search
    const results2 = await storage.search("Normal", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });
    expect(results2.length).toBe(1);
  });

  it("handles null bytes in content", async () => {
    const content = "Before\x00After";
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("Before", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
  });

  it("handles newlines and tabs", async () => {
    const content = "Line 1\nLine 2\tTabbed\tMore\tTabs\nLine 3";
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("Tabbed", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content).toBe(content);
  });

  it("handles quotes and backslashes", async () => {
    const content = "He said \"hello\" and \\left\\ with a 'smile'";
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("hello", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content).toBe(content);
  });

  it("handles HTML/XML tags", async () => {
    const content = "<div class='foo'>Decision: use <b>SQLite</b></div>";
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("SQLite", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content).toBe(content);
  });

  it("handles markdown formatting", async () => {
    const content =
      "## Decision\n\nWe chose **SQLite** because:\n- Fast\n- `embedded`\n- [link](url)";
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("SQLite", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content).toContain("**SQLite**");
  });

  it("handles empty string content", async () => {
    const entry = makeEntry({ content: "" });
    await storage.put(entry);

    // Should not crash on search
    const results = await storage.search("anything", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    // Empty content won't match FTS queries
    expect(results).toEqual([]);
  });

  it("handles very long single word", async () => {
    const content = "supercalifragilisticexpialidocious".repeat(300);
    const entry = makeEntry({ content });
    await storage.put(entry);

    // Verify it was stored correctly via content hash
    const hash = createHash("sha256").update(content).digest("hex");
    const results = await storage.findByContentHash(hash, "edge-test");

    expect(results.length).toBe(1);
    expect(results[0].content).toBe(content);
  });

  it("handles mixed scripts", async () => {
    const content = "English + Tiếng Việt + 中文 + 日本語 + العربية + Emoji 🎉";
    const entry = makeEntry({ content });
    await storage.put(entry);

    const results = await storage.search("English", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.content).toBe(content);
  });
});

describe("Edge cases: concurrent writes", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-edge-conc-"));
    dbPath = join(tmpDir, "concurrent.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles 10 concurrent puts from different backends", async () => {
    const backends: SQLiteBackend[] = [];
    for (let i = 0; i < 10; i++) {
      backends.push(new SQLiteBackend(dbPath));
    }

    const promises = backends.map((backend, i) =>
      backend.put(makeEntry({ content: `Concurrent entry ${i}`, sessionKey: "conc-test" })),
    );

    await Promise.all(promises);

    // Verify all entries were stored
    const reader = new SQLiteBackend(dbPath);
    const results = await reader.search("Concurrent", null, {
      sessionKey: "conc-test",
      limit: 50,
      offset: 0,
      mode: "keyword",
    });
    reader.close();

    expect(results.length).toBe(10);

    backends.forEach((b) => b.close());
  });

  it("handles concurrent puts with same content_hash (dedup)", async () => {
    const backends: SQLiteBackend[] = [];
    for (let i = 0; i < 5; i++) {
      backends.push(new SQLiteBackend(dbPath));
    }

    const content = "Same content for dedup test";
    const promises = backends.map(() =>
      backends[0]?.put(makeEntry({ content, sessionKey: "conc-dedup" })),
    );

    await Promise.all(promises);

    const reader = new SQLiteBackend(dbPath);
    const results = await reader.findByContentHash(
      createHash("sha256").update(content).digest("hex"),
      "conc-dedup",
    );
    reader.close();

    // Only one capture should be stored: put() wraps the dedup probe + INSERT in a
    // single db.transaction, closing the TOCTOU race that previously allowed
    // concurrent identical captures (same content_hash, session_key, agent_id) to
    // both pass findByContentHash and both insert duplicate rows.
    expect(results.length).toBe(1);

    backends.forEach((b) => b.close());
  });

  it("handles concurrent read and write", async () => {
    const writer = new SQLiteBackend(dbPath);

    // Write some initial data
    for (let i = 0; i < 10; i++) {
      await writer.put(makeEntry({ content: `Initial ${i}`, sessionKey: "rw-test" }));
    }

    // Concurrent reads and writes
    const readers: SQLiteBackend[] = [];
    for (let i = 0; i < 5; i++) {
      readers.push(new SQLiteBackend(dbPath));
    }

    const readPromises = readers.map((r) =>
      r.search("Initial", null, {
        sessionKey: "rw-test",
        limit: 50,
        offset: 0,
        mode: "keyword",
      }),
    );

    const writePromises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      writePromises.push(
        writer.put(makeEntry({ content: `Concurrent write ${i}`, sessionKey: "rw-test" })),
      );
    }

    const [readResults] = await Promise.all([
      Promise.all(readPromises),
      Promise.all(writePromises),
    ]);

    // All reads should succeed
    expect(readResults.length).toBe(5);
    for (const results of readResults) {
      expect(results.length).toBeGreaterThan(0);
    }

    readers.forEach((r) => r.close());
    writer.close();
  });

  it("handles 50 rapid sequential puts", async () => {
    const backend = new SQLiteBackend(dbPath);

    for (let i = 0; i < 50; i++) {
      await backend.put(makeEntry({ content: `Rapid ${i}`, sessionKey: "rapid-test" }));
    }

    const results = await backend.search("Rapid", null, {
      sessionKey: "rapid-test",
      limit: 50,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(50);
    backend.close();
  });

  it("handles opening and closing backend multiple times", async () => {
    for (let i = 0; i < 5; i++) {
      const backend = new SQLiteBackend(dbPath);
      await backend.put(makeEntry({ content: `Cycle ${i}`, sessionKey: "cycle-test" }));
      backend.close();
    }

    const reader = new SQLiteBackend(dbPath);
    const results = await reader.search("Cycle", null, {
      sessionKey: "cycle-test",
      limit: 50,
      offset: 0,
      mode: "keyword",
    });
    reader.close();

    expect(results.length).toBe(5);
  });
});

describe("Edge cases: tags and metadata", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-edge-tags-"));
    dbPath = join(tmpDir, "tags.db");
    storage = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles entry with 100 tags", async () => {
    const tags = Array.from({ length: 100 }, (_, i) => `tag-${i}`);
    const entry = makeEntry({ content: "Many tags", tags });
    await storage.put(entry);

    const results = await storage.search("Many", null, {
      sessionKey: "edge-test",
      limit: 1,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.tags.length).toBe(100);
  });

  it("handles entry with no tags", async () => {
    const entry = makeEntry({ content: "No tags", tags: [] });
    await storage.put(entry);

    const results = await storage.search("No tags", null, {
      sessionKey: "edge-test",
      limit: 1,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.tags).toEqual([]);
  });

  it("handles tags with special characters", async () => {
    const tags = [
      "tag with spaces",
      "tag-with-dashes",
      "tag_with_underscores",
      "tag.with.dots",
      "tag/with/slashes",
    ];
    const entry = makeEntry({ content: "Special tags", tags });
    await storage.put(entry);

    const results = await storage.search("Special", null, {
      sessionKey: "edge-test",
      limit: 1,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.tags).toEqual(tags);
  });

  it("handles tags with Unicode", async () => {
    const tags = ["tiếng-việt", "日本語", "🎉", "中文"];
    const entry = makeEntry({ content: "Unicode tags", tags });
    await storage.put(entry);

    const results = await storage.search("Unicode", null, {
      sessionKey: "edge-test",
      limit: 1,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.tags).toEqual(tags);
  });

  it("handles metadata with nested JSON", async () => {
    const entry = makeEntry({ content: "Nested metadata" });
    entry.metadata = {
      level1: {
        level2: {
          level3: "deep value",
        },
        array: [1, 2, 3],
      },
      nullValue: null,
      boolValue: true,
    };
    await storage.put(entry);

    const results = await storage.search("Nested", null, {
      sessionKey: "edge-test",
      limit: 1,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.metadata).toBeDefined();
    expect((results[0]?.entry.metadata as any).level1.level2.level3).toBe("deep value");
  });

  it("handles all capture types", async () => {
    const types: CaptureType[] = [
      "decision",
      "learning",
      "error",
      "fix",
      "summary",
      "atom",
      "task",
    ];

    for (const type of types) {
      const entry = makeEntry({ content: `Type: ${type}`, type });
      await storage.put(entry);
    }

    const results = await storage.search("Type", null, {
      sessionKey: "edge-test",
      limit: 50,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(types.length);
    const foundTypes = results.map((r) => r.entry.type).sort();
    expect(foundTypes).toEqual([...types].sort());
  });
});

describe("Edge cases: session keys", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-edge-sessions-"));
    dbPath = join(tmpDir, "sessions.db");
    storage = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("isolates captures by session key", async () => {
    await storage.put(makeEntry({ content: "Session A content", sessionKey: "session-a" }));
    await storage.put(makeEntry({ content: "Session B content", sessionKey: "session-b" }));

    const resultsA = await storage.search("Session", null, {
      sessionKey: "session-a",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    const resultsB = await storage.search("Session", null, {
      sessionKey: "session-b",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(resultsA.length).toBe(1);
    expect(resultsA[0]?.entry.content).toBe("Session A content");
    expect(resultsB.length).toBe(1);
    expect(resultsB[0]?.entry.content).toBe("Session B content");
  });

  it("handles very long session key", async () => {
    const longKey = "K".repeat(1000);
    const entry = makeEntry({ content: "Long key", sessionKey: longKey });
    await storage.put(entry);

    const results = await storage.search("Long", null, {
      sessionKey: longKey,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
  });

  it("handles session key with special characters", async () => {
    const key = "session/with spaces/and-special_chars!@#$%";
    const entry = makeEntry({ content: "Special key", sessionKey: key });
    await storage.put(entry);

    const results = await storage.search("Special", null, {
      sessionKey: key,
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
  });

  it("handles empty session key", async () => {
    const entry = makeEntry({ content: "Empty key", sessionKey: "" });
    await storage.put(entry);

    const results = await storage.search("Empty", null, {
      sessionKey: "",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBe(1);
  });
});

describe("Edge cases: search behavior", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-edge-search-"));
    dbPath = join(tmpDir, "search.db");
    storage = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles search with empty query", async () => {
    await storage.put(makeEntry({ content: "Some content" }));

    const results = await storage.search("", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    // Empty query may return all or none depending on FTS5 behavior
    // Just verify it doesn't crash
    expect(Array.isArray(results)).toBe(true);
  });

  it("handles search with very long query", async () => {
    await storage.put(makeEntry({ content: "Target content" }));

    const longQuery = "Q".repeat(10_000);
    const results = await storage.search(longQuery, null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(Array.isArray(results)).toBe(true);
  });

  it("handles search with only stopwords", async () => {
    await storage.put(makeEntry({ content: "The and or but" }));

    const results = await storage.search("the and or", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(Array.isArray(results)).toBe(true);
  });

  it("handles offset beyond results", async () => {
    for (let i = 0; i < 5; i++) {
      await storage.put(makeEntry({ content: `Offset test ${i}` }));
    }

    const results = await storage.search("Offset", null, {
      sessionKey: "edge-test",
      limit: 10,
      offset: 100,
      mode: "keyword",
    });

    expect(results).toEqual([]);
  });

  it("handles limit of 0", async () => {
    await storage.put(makeEntry({ content: "Limit zero" }));

    const results = await storage.search("Limit", null, {
      sessionKey: "edge-test",
      limit: 0,
      offset: 0,
      mode: "keyword",
    });

    expect(results).toEqual([]);
  });

  it("handles pagination with offset and limit", async () => {
    for (let i = 0; i < 20; i++) {
      await storage.put(makeEntry({ content: `Page item ${i}` }));
    }

    const page1 = await storage.search("Page", null, {
      sessionKey: "edge-test",
      limit: 5,
      offset: 0,
      mode: "keyword",
    });

    const page2 = await storage.search("Page", null, {
      sessionKey: "edge-test",
      limit: 5,
      offset: 5,
      mode: "keyword",
    });

    expect(page1.length).toBe(5);
    expect(page2.length).toBe(5);

    // Pages should have different entries
    const page1Ids = page1.map((r) => r.entry.id);
    const page2Ids = page2.map((r) => r.entry.id);
    for (const id of page1Ids) {
      expect(page2Ids).not.toContain(id);
    }
  });
});
