import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteBackend } from "../../src/storage/sqlite.js";

const testDir = join(homedir(), ".local", "share", "remem-mcp", "test-detection");
const testDbPath = join(testDir, "memory.db");

function cleanup() {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
}

describe("Integration: database detection and migration", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("creates a fresh database when no database exists", () => {
    expect(existsSync(testDbPath)).toBe(false);

    const backend = new SQLiteBackend(testDbPath);

    // The database file must exist now.
    expect(existsSync(testDbPath)).toBe(true);

    // The schema_version table must exist and have the current version.
    const db = new Database(testDbPath);
    const row = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(14);

    // All tables must exist.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("captures");
    expect(tableNames).toContain("atoms");
    expect(tableNames).toContain("scenarios");
    expect(tableNames).toContain("audit_log");
    expect(tableNames).toContain("schema_version");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("persona");
    expect(tableNames).toContain("knowledge");
    expect(tableNames).toContain("skills");
    expect(tableNames).toContain("symbols");
    expect(tableNames).toContain("calls");
    expect(tableNames).toContain("imports");
    expect(tableNames).toContain("wiki_pages");
    expect(tableNames).toContain("wiki_links");

    db.close();
    backend.close();
  });

  it("keeps data when the database exists and the schema version is current", async () => {
    // First run: create the database and store a capture.
    const backend1 = new SQLiteBackend(testDbPath);
    const { generateId } = await import("../../src/utils/ulid.js");
    const id = generateId();
    await backend1.put({
      id,
      sessionKey: "test",
      agentId: "test",
      type: "decision",
      content: "A decision to keep.",
      tags: [],
      createdAt: Date.now(),
    });
    backend1.close();

    // Second run: open the same database.
    const backend2 = new SQLiteBackend(testDbPath);
    const entry = await backend2.get(id);

    expect(entry).not.toBeNull();
    expect(entry?.content).toBe("A decision to keep.");

    backend2.close();
  });

  it("handles an old database without a schema_version table", async () => {
    // Simulate an old database: create a captures table with the full schema but no schema_version.
    mkdirSync(testDir, { recursive: true });
    const db = new Database(testDbPath);
    db.exec(`
      CREATE TABLE captures (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT,
        tags TEXT,
        created_at INTEGER NOT NULL,
        metadata TEXT
      )
    `);
    db.exec(
      "INSERT INTO captures (id, session_key, agent_id, type, content, tags, created_at) VALUES ('old-1', 'test', 'test', 'decision', 'Old data from version 0', '[]', 0)",
    );
    db.close();

    // Now start the backend. It must detect the old database, back it up, and migrate.
    const backend = new SQLiteBackend(testDbPath);

    // The backup file must exist.
    expect(existsSync(`${testDbPath}.bak.v0`)).toBe(true);

    // The schema_version table must now exist.
    const db2 = new Database(testDbPath);
    const row = db2.prepare("SELECT MAX(version) as version FROM schema_version").get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(14);

    // The old data must still be there.
    const oldRow = db2.prepare("SELECT content FROM captures WHERE id = 'old-1'").get() as
      | { content: string }
      | undefined;
    expect(oldRow?.content).toBe("Old data from version 0");

    db2.close();
    backend.close();
  });

  it("does not create a backup for a fresh database", () => {
    const backend = new SQLiteBackend(testDbPath);
    backend.close();

    // No backup file must exist for a fresh database.
    expect(existsSync(`${testDbPath}.bak.v0`)).toBe(false);
  });

  it("creates a backup when migrating an old database", () => {
    // Create an old database with the full captures schema but no schema_version.
    mkdirSync(testDir, { recursive: true });
    const db = new Database(testDbPath);
    db.exec(`
      CREATE TABLE captures (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT,
        tags TEXT,
        created_at INTEGER NOT NULL,
        metadata TEXT
      )
    `);
    db.exec(
      "INSERT INTO captures (id, session_key, agent_id, type, content, tags, created_at) VALUES ('old-1', 'test', 'test', 'decision', 'Old data', '[]', 0)",
    );
    db.close();

    const backend = new SQLiteBackend(testDbPath);
    backend.close();

    // The backup file must exist.
    expect(existsSync(`${testDbPath}.bak.v0`)).toBe(true);
  });
});
