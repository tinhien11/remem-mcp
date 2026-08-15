import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectLanguage,
  findCallees,
  findCallers,
  impactAnalysis,
  indexDirectory,
  indexFile,
  listSymbols,
  searchSymbols,
} from "../../src/codegraph/engine.js";

const TMP = join(process.env.HOME ?? "/tmp", ".local", "share", "remem-mcp", "test-codegraph");

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.exec(readFileSync(join(process.cwd(), "src/storage/schema.sql"), "utf-8"));
  return db;
}

function makeTmpRepo() {
  mkdirSync(TMP, { recursive: true });
  const files: Record<string, string> = {
    "main.ts": `
import { add } from "./math";
import { greet } from "./utils";

export function main() {
  const result = add(1, 2);
  greet(result.toString());
  return result;
}
`,
    "math.ts": `
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export class Calculator {
  multiply(x: number, y: number): number {
    return x * y;
  }
}
`,
    "utils.ts": `
export function greet(name: string): void {
  console.log("Hello, " + name);
}

export function formatResult(value: number): string {
  return "Result: " + value;
}
`,
    "ignored.txt": "This file should be skipped.",
  };

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(TMP, name), content.trim());
  }
}

function cleanup() {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("Integration: CodeGraph engine", () => {
  let db: Database.Database;

  beforeEach(() => {
    cleanup();
    makeTmpRepo();
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it("detects language from file extension", () => {
    expect(detectLanguage("foo.ts")).toBe("typescript");
    expect(detectLanguage("foo.py")).toBe("python");
    expect(detectLanguage("foo.go")).toBe("go");
    expect(detectLanguage("foo.rs")).toBe("rust");
    expect(detectLanguage("foo.java")).toBe("java");
    expect(detectLanguage("foo.c")).toBe("c");
    expect(detectLanguage("foo.cpp")).toBe("cpp");
    expect(detectLanguage("foo.cs")).toBe("csharp");
    expect(detectLanguage("foo.txt")).toBeNull();
    expect(detectLanguage("foo.unknown")).toBeNull();
  });

  it("indexes a single file and extracts symbols", async () => {
    const result = await indexFile(db, join(TMP, "math.ts"), TMP, null);
    expect(result.skipped).toBe(false);
    expect(result.language).toBe("typescript");
    expect(result.symbols).toBe(4); // add, subtract, Calculator, multiply
    expect(result.calls).toBeGreaterThan(0);
  });

  it("skips unsupported file types", async () => {
    const result = await indexFile(db, join(TMP, "ignored.txt"), TMP, null);
    expect(result.skipped).toBe(true);
    expect(result.symbols).toBe(0);
  });

  it("indexes a directory recursively", async () => {
    const results = await indexDirectory(db, TMP, TMP, null, 50);
    // Only supported files are walked (3 .ts files; .txt is skipped by detectLanguage)
    expect(results.length).toBe(3);
    const indexed = results.filter((r) => !r.skipped);
    expect(indexed.length).toBe(3);
  });

  it("searches symbols by name", async () => {
    await indexDirectory(db, TMP, TMP, null, 50);
    const syms = searchSymbols(db, "add");
    expect(syms.length).toBeGreaterThanOrEqual(1);
    expect(syms.some((s) => s.name === "add")).toBe(true);
  });

  it("searches symbols with kind filter", async () => {
    await indexDirectory(db, TMP, TMP, null, 50);
    const classes = searchSymbols(db, "Calculator", { kind: "Class" });
    expect(classes.length).toBe(1);
    expect(classes[0].name).toBe("Calculator");
  });

  it("finds callers of a function", async () => {
    await indexDirectory(db, TMP, TMP, null, 50);
    const addSyms = searchSymbols(db, "add");
    expect(addSyms.length).toBe(1);
    const callers = findCallers(db, addSyms[0].id);
    expect(callers.length).toBeGreaterThanOrEqual(1);
    expect(callers.some((c) => c.caller.name === "main")).toBe(true);
  });

  it("finds callees of a function", async () => {
    await indexDirectory(db, TMP, TMP, null, 50);
    const mainSyms = searchSymbols(db, "main");
    expect(mainSyms.length).toBe(1);
    const callees = findCallees(db, mainSyms[0].id);
    expect(callees.length).toBeGreaterThanOrEqual(2);
    // main calls add and greet
    expect(callees.some((c) => c.calleeName === "add")).toBe(true);
    expect(callees.some((c) => c.calleeName === "greet")).toBe(true);
    // After indexDirectory, cross-file callees should be resolved
    const addCallee = callees.find((c) => c.calleeName === "add");
    expect(addCallee).toBeDefined();
    expect(addCallee?.callee).not.toBeNull();
  });

  it("performs impact analysis", async () => {
    await indexDirectory(db, TMP, TMP, null, 50);
    const addSyms = searchSymbols(db, "add");
    expect(addSyms.length).toBe(1);
    const impact = impactAnalysis(db, addSyms[0].id, { maxDepth: 5 });
    expect(impact.rootSymbol.name).toBe("add");
    // main calls add, so main should be in the impact set
    expect(impact.affected.some((a) => a.symbol.name === "main")).toBe(true);
    expect(impact.affected.length).toBeGreaterThanOrEqual(1);
  });

  it("lists symbols in a file", async () => {
    await indexDirectory(db, TMP, TMP, null, 50);
    const syms = listSymbols(db, "math.ts");
    expect(syms.length).toBe(4);
    expect(syms.some((s) => s.name === "add")).toBe(true);
    expect(syms.some((s) => s.name === "subtract")).toBe(true);
    expect(syms.some((s) => s.name === "Calculator")).toBe(true);
    expect(syms.some((s) => s.name === "multiply")).toBe(true);
  });

  it("re-indexing a file replaces old symbols", async () => {
    // First index
    await indexFile(db, join(TMP, "math.ts"), TMP, null);
    const syms1 = searchSymbols(db, "add");
    expect(syms1.length).toBe(1);

    // Modify the file: remove add function
    writeFileSync(
      join(TMP, "math.ts"),
      `
export function subtract(a: number, b: number): number {
  return a - b;
}
`,
    );

    // Re-index
    await indexFile(db, join(TMP, "math.ts"), TMP, null);
    const syms2 = searchSymbols(db, "add");
    expect(syms2.length).toBe(0); // add should be gone
    const syms3 = searchSymbols(db, "subtract");
    expect(syms3.length).toBe(1); // subtract still there
  });

  it("isolates symbols by team_id", async () => {
    await indexFile(db, join(TMP, "math.ts"), TMP, "team-a");
    await indexFile(db, join(TMP, "math.ts"), TMP, "team-b");

    const teamA = searchSymbols(db, "add", { teamId: "team-a" });
    const teamB = searchSymbols(db, "add", { teamId: "team-b" });
    const all = searchSymbols(db, "add");

    expect(teamA.length).toBe(1);
    expect(teamB.length).toBe(1);
    expect(teamA[0].id).not.toBe(teamB[0].id);
    expect(all.length).toBe(2);
  });

  it("handles Python files", async () => {
    writeFileSync(
      join(TMP, "app.py"),
      `
def greet(name: str) -> str:
    return f"Hello, {name}"

class Engine:
    def start(self):
        return "started"
`,
    );
    const result = await indexFile(db, join(TMP, "app.py"), TMP, null);
    expect(result.skipped).toBe(false);
    expect(result.language).toBe("python");
    expect(result.symbols).toBeGreaterThanOrEqual(2);
    const syms = listSymbols(db, "app.py");
    expect(syms.some((s) => s.name === "greet")).toBe(true);
    expect(syms.some((s) => s.name === "Engine")).toBe(true);
  });

  it("handles Go files", async () => {
    writeFileSync(
      join(TMP, "main.go"),
      `
package main

import "fmt"

func Add(a, b int) int {
    return a + b
}
`,
    );
    const result = await indexFile(db, join(TMP, "main.go"), TMP, null);
    expect(result.skipped).toBe(false);
    expect(result.language).toBe("go");
    const syms = listSymbols(db, "main.go");
    expect(syms.some((s) => s.name === "Add")).toBe(true);
  });

  it("returns empty results for non-existent symbol", async () => {
    await indexDirectory(db, TMP, TMP, null, 50);
    const callers = findCallers(db, "NONEXISTENT_ID");
    expect(callers).toEqual([]);
    const callees = findCallees(db, "NONEXISTENT_ID");
    expect(callees).toEqual([]);
  });

  it("impact analysis throws for non-existent symbol", async () => {
    await indexDirectory(db, TMP, TMP, null, 50);
    expect(() => impactAnalysis(db, "NONEXISTENT_ID")).toThrow("Symbol not found");
  });
});
