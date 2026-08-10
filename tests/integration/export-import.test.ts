import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { exportData } from "../../src/export.js";
import { importData } from "../../src/import.js";
import { SQLiteBackend } from "../../src/storage/sqlite.js";
import { generateId } from "../../src/utils/ulid.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, rmSync, readFileSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";

const testDir = join(homedir(), ".local", "share", "tdai-memory-mcp", "test-export-import");
const testDbPath = join(testDir, "memory.db");
const exportPath = join(testDir, "export.json");

function cleanup() {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
}

function makeEntry(overrides: Partial<{
  id: string;
  sessionKey: string;
  agentId: string;
  type: string;
  content: string;
  tags: string[];
}> = {}) {
  return {
    id: generateId(),
    sessionKey: "test-session",
    agentId: "test",
    type: "decision" as const,
    content: "We decided to use SQLite for the storage backend.",
    tags: ["arch"],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("Integration: export and import", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("exports all captures to a JSON file", async () => {
    const backend = new SQLiteBackend(testDbPath);
    await backend.put(makeEntry({ content: "Decision one." }));
    await backend.put(makeEntry({ content: "Decision two." }));
    backend.close();

    exportData(testDbPath, exportPath);

    expect(existsSync(exportPath)).toBe(true);
    const data = JSON.parse(readFileSync(exportPath, "utf-8"));
    expect(data.version).toBe(1);
    expect(data.count).toBe(2);
    expect(data.captures.length).toBe(2);
    expect(data.captures[0].content).toContain("Decision");
  });

  it("exports to stdout when output is '-'", async () => {
    const backend = new SQLiteBackend(testDbPath);
    await backend.put(makeEntry({ content: "Stdout test." }));
    backend.close();

    // Capture stdout
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string) => {
      captured += chunk;
      return true;
    }) as typeof process.stdout.write;

    exportData(testDbPath, "-");

    process.stdout.write = originalWrite;

    const data = JSON.parse(captured);
    expect(data.count).toBe(1);
    expect(data.captures[0].content).toBe("Stdout test.");
  });

  it("exports with session-key filter", async () => {
    const backend = new SQLiteBackend(testDbPath);
    await backend.put(makeEntry({ content: "Project A.", sessionKey: "project-a" }));
    await backend.put(makeEntry({ content: "Project B.", sessionKey: "project-b" }));
    backend.close();

    exportData(testDbPath, exportPath, { sessionKey: "project-a" });

    const data = JSON.parse(readFileSync(exportPath, "utf-8"));
    expect(data.count).toBe(1);
    expect(data.captures[0].session_key).toBe("project-a");
  });

  it("exports with type filter", async () => {
    const backend = new SQLiteBackend(testDbPath);
    await backend.put(makeEntry({ content: "A decision.", type: "decision" }));
    await backend.put(makeEntry({ content: "A learning.", type: "learning" }));
    backend.close();

    exportData(testDbPath, exportPath, { type: "decision" });

    const data = JSON.parse(readFileSync(exportPath, "utf-8"));
    expect(data.count).toBe(1);
    expect(data.captures[0].type).toBe("decision");
  });

  it("imports captures into a fresh database", async () => {
    // Source database with data
    const backend = new SQLiteBackend(testDbPath);
    await backend.put(makeEntry({ content: "Import test decision." }));
    await backend.put(makeEntry({ content: "Import test learning.", type: "learning" as const }));
    backend.close();

    // Export
    exportData(testDbPath, exportPath);

    // Import into a new database
    const newDbPath = join(testDir, "new-memory.db");
    importData(newDbPath, exportPath);

    // Verify the data is in the new database
    const db = new Database(newDbPath);
    const rows = db.prepare("SELECT * FROM captures ORDER BY created_at").all() as Array<{
      content: string;
    }>;
    db.close();

    expect(rows.length).toBe(2);
    expect(rows[0].content).toBe("Import test decision.");
    expect(rows[1].content).toBe("Import test learning.");
  });

  it("skips captures that already exist on import", async () => {
    const backend = new SQLiteBackend(testDbPath);
    await backend.put(makeEntry({ content: "Existing capture." }));
    backend.close();

    // Export
    exportData(testDbPath, exportPath);

    // Capture console.log output
    const originalLog = console.log;
    let captured = "";
    console.log = (...args: unknown[]) => {
      captured += args.join(" ") + "\n";
    };

    importData(testDbPath, exportPath);

    console.log = originalLog;

    expect(captured).toContain("skipped 1");
    expect(captured).toContain("Imported 0");

    // Verify no duplicates
    const db = new Database(testDbPath);
    const count = db.prepare("SELECT COUNT(*) as count FROM captures").get() as { count: number };
    db.close();
    expect(count.count).toBe(1);
  });

  it("round-trips data without loss (export then import)", async () => {
    const backend = new SQLiteBackend(testDbPath);
    const entries = [
      makeEntry({ content: "Decision one.", type: "decision", tags: ["arch", "storage"] }),
      makeEntry({ content: "Learning one.", type: "learning", tags: ["search"] }),
      makeEntry({ content: "Error fix.", type: "error", tags: ["bug"] }),
    ];
    for (const entry of entries) {
      await backend.put(entry);
    }
    backend.close();

    // Export
    exportData(testDbPath, exportPath);

    // Import into a fresh database
    const newDbPath = join(testDir, "roundtrip.db");
    importData(newDbPath, exportPath);

    // Verify all 3 captures are present with correct data
    const db = new Database(newDbPath);
    const rows = db.prepare("SELECT * FROM captures ORDER BY created_at").all() as Array<{
      id: string;
      type: string;
      content: string;
      tags: string;
    }>;
    db.close();

    expect(rows.length).toBe(3);
    expect(rows[0].content).toBe("Decision one.");
    expect(JSON.parse(rows[0].tags)).toEqual(["arch", "storage"]);
    expect(rows[1].content).toBe("Learning one.");
    expect(rows[2].content).toBe("Error fix.");
  });

  it("handles empty export gracefully", async () => {
    const backend = new SQLiteBackend(testDbPath);
    backend.close();

    exportData(testDbPath, exportPath);

    const data = JSON.parse(readFileSync(exportPath, "utf-8"));
    expect(data.count).toBe(0);
    expect(data.captures).toEqual([]);
  });

  it("errors on non-existent import file", () => {
    const missingPath = join(testDir, "nonexistent.json");
    expect(() => importData(testDbPath, missingPath)).toThrow();
  });
});
