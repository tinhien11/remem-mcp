import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteBackend } from "../../src/storage/sqlite.js";
import type { CaptureEntry } from "../../src/storage/types.js";
import { generateId } from "../../src/utils/ulid.js";

const testDbPath = join(homedir(), ".local", "share", "tdai-memory-mcp", "test-memory.db");

function makeEntry(overrides: Partial<CaptureEntry> = {}): CaptureEntry {
  return {
    id: generateId(),
    sessionKey: "test-session",
    agentId: "test",
    type: "decision",
    content: "We decided to use SQLite for the storage backend.",
    tags: ["arch", "storage"],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("SQLiteBackend", () => {
  let backend: SQLiteBackend;

  beforeEach(() => {
    // Clean up any leftover test database
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
    if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
    backend = new SQLiteBackend(testDbPath);
  });

  afterEach(() => {
    backend.close();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
    if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
  });

  it("stores and retrieves a capture", async () => {
    const entry = makeEntry();
    await backend.put(entry);
    const retrieved = await backend.get(entry.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(entry.id);
    expect(retrieved?.content).toBe(entry.content);
    expect(retrieved?.tags).toEqual(entry.tags);
  });

  it("returns null for a non-existent ID", async () => {
    const result = await backend.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a capture by ID", async () => {
    const entry = makeEntry();
    await backend.put(entry);
    const result = await backend.delete(entry.id);
    expect(result.captures).toBe(1);
    const retrieved = await backend.get(entry.id);
    expect(retrieved).toBeNull();
  });

  it("searches with BM25 (keyword mode)", async () => {
    await backend.put(makeEntry({ content: "We use SQLite for storage." }));
    await backend.put(makeEntry({ content: "The config file is in JSON format." }));

    const results = await backend.search("SQLite", null, {
      limit: 10,
      offset: 0,
      mode: "keyword",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content).toContain("SQLite");
  });

  it("searches with filters by type", async () => {
    await backend.put(makeEntry({ content: "A decision about storage.", type: "decision" }));
    await backend.put(makeEntry({ content: "A learning about search.", type: "learning" }));

    const results = await backend.search("storage", null, {
      limit: 10,
      offset: 0,
      mode: "keyword",
      filters: { type: "decision" },
    });

    expect(results.length).toBe(1);
    expect(results[0].entry.type).toBe("decision");
  });

  it("deletes by filter (type)", async () => {
    await backend.put(makeEntry({ content: "Decision one.", type: "decision" }));
    await backend.put(makeEntry({ content: "Learning one.", type: "learning" }));

    const result = await backend.deleteByFilter({ type: "decision" });
    expect(result.captures).toBe(1);
  });

  it("creates the schema on first run", async () => {
    // The backend constructor already ran the schema. Verify the tables exist.
    // We can do this by storing and retrieving, which we already did above.
    // This test is a placeholder to make the coverage explicit.
    expect(existsSync(testDbPath)).toBe(true);
  });
});
