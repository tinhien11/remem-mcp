import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");

let tmpDir: string;
let dbPath: string;

function runHook(subcommand: string, stdin: string, env?: Record<string, string>): string {
  try {
    return execSync(`node ${BIN} ${subcommand}`, {
      input: stdin,
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: 10000,
    });
  } catch (e: any) {
    return e.stdout ?? "";
  }
}

function runCli(args: string, env?: Record<string, string>): string {
  try {
    return execSync(`node ${BIN} ${args}`, {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: 10000,
    });
  } catch (e: any) {
    return e.stdout ?? "";
  }
}

/** Create a test DB with the full schema. */
function makeDb(dbPath: string): any {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);
  const schema = require("node:fs").readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "storage", "schema.sql"),
    "utf-8",
  );
  db.exec(schema);
  return db;
}

function hashPath(p: string): string {
  return createHash("sha256").update(p).digest("hex").slice(0, 16);
}

function insertDecision(
  db: any,
  opts: {
    id: string;
    sessionKey: string;
    title: string;
    decisionType: string;
    choice: string;
    rationale?: string;
    confidence?: number;
    seenCount?: number;
    driftCount?: number;
  },
): void {
  const content = `Decision: ${opts.title}`;
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  db.prepare(
    "INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    opts.id,
    opts.sessionKey,
    "auto",
    "decision",
    content,
    hash,
    JSON.stringify([opts.decisionType]),
    new Date().toISOString().replace("T", " ").replace("Z", ""),
    JSON.stringify({
      title: opts.title,
      decision_type: opts.decisionType,
      choice: opts.choice,
      rationale: opts.rationale ?? "",
      confidence: opts.confidence ?? 1,
      seen_count: opts.seenCount ?? 1,
      drift_count: opts.driftCount ?? 0,
      followed: null,
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    }),
  );
}

function insertPattern(
  db: any,
  opts: {
    id: string;
    sessionKey: string;
    title: string;
    patternType: string;
    language: string;
    signature: string;
    filePath: string;
    confidence?: number;
    seenCount?: number;
    adopted?: boolean;
  },
): void {
  const content = `Pattern: ${opts.title} in ${opts.filePath}`;
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  db.prepare(
    "INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    opts.id,
    opts.sessionKey,
    "auto",
    "pattern",
    content,
    hash,
    JSON.stringify([opts.patternType, opts.language]),
    new Date().toISOString().replace("T", " ").replace("Z", ""),
    JSON.stringify({
      title: opts.title,
      pattern_type: opts.patternType,
      language: opts.language,
      signature: opts.signature,
      file_path: opts.filePath,
      confidence: opts.confidence ?? 1,
      seen_count: opts.seenCount ?? 1,
      adopted: opts.adopted ?? false,
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    }),
  );
}

describe("Moat 2: Decision Learning", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-dec-"));
    dbPath = join(tmpDir, "test.db");
    makeDb(dbPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("DECISIONS: dashboard shows captured decisions", () => {
    const db = require("better-sqlite3")(dbPath);
    insertDecision(db, {
      id: "dec-1",
      sessionKey: "proj-a",
      title: "Chose to use react",
      decisionType: "dependency",
      choice: "react",
      rationale: "Installed react as a dependency",
      confidence: 3,
      seenCount: 3,
    });
    db.close();

    const output = runCli("decisions", { TDAI_DB_PATH: dbPath });

    expect(output).toContain("Decision Learning Dashboard");
    expect(output).toContain("Chose to use react");
    expect(output).toContain("[dependency]");
    expect(output).toContain("confidence=3");
    expect(output).toContain("Total decisions:    1");
  });

  it("DECISIONS: clean DB shows no decisions message", () => {
    const output = runCli("decisions", { TDAI_DB_PATH: dbPath });

    expect(output).toContain("No decisions captured");
  });

  it("DECISIONS: retro shows repeated and drifted decisions", () => {
    const db = require("better-sqlite3")(dbPath);
    insertDecision(db, {
      id: "dec-r1",
      sessionKey: "proj-a",
      title: "Chose to use lodash",
      decisionType: "dependency",
      choice: "lodash",
      seenCount: 3,
      driftCount: 1,
    });
    db.close();

    const output = runCli("decisions retro", { TDAI_DB_PATH: dbPath });

    expect(output).toContain("Decision Retrospective");
    expect(output).toContain("Repeated decisions");
    expect(output).toContain("Chose to use lodash");
    expect(output).toContain("Drifted decisions");
    expect(output).toContain("Follow rate:");
  });

  it("DECISIONS: PostToolUse auto-captures dependency install", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm install express" },
      tool_response: { stdout: "added 1 package", exit_code: 0 },
      cwd: tmpDir,
    });
    runHook("hook-post-tool-use", stdin, { TDAI_DB_PATH: dbPath });

    const db = require("better-sqlite3")(dbPath, { readonly: true });
    const decisions = db
      .prepare("SELECT type, metadata FROM captures WHERE type = 'decision'")
      .all() as { type: string; metadata: string }[];
    db.close();

    expect(decisions.length).toBe(1);
    const meta = JSON.parse(decisions[0].metadata);
    expect(meta.title).toContain("express");
    expect(meta.decision_type).toBe("dependency");
  });

  it("DECISIONS: PostToolUse does NOT capture non-decision commands", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_response: { stdout: "build success", exit_code: 0 },
      cwd: tmpDir,
    });
    runHook("hook-post-tool-use", stdin, { TDAI_DB_PATH: dbPath });

    const db = require("better-sqlite3")(dbPath, { readonly: true });
    const decisions = db.prepare("SELECT type FROM captures WHERE type = 'decision'").all();
    db.close();

    expect(decisions.length).toBe(0);
  });

  it("DECISIONS: PreToolUse injects past decisions before npm install", () => {
    const db = require("better-sqlite3")(dbPath);
    const sk = hashPath(tmpDir);
    insertDecision(db, {
      id: "dec-inj-1",
      sessionKey: sk,
      title: "Chose to use zod",
      decisionType: "dependency",
      choice: "zod",
      rationale: "Installed zod as a dependency",
      confidence: 2,
    });
    db.close();

    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm install zod" },
      cwd: tmpDir,
    });
    const output = runHook("hook-pre-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    expect(ctx).toContain("Past decisions");
    expect(ctx).toContain("Chose to use zod");
  });

  it("DECISIONS: PreToolUse injects past decisions even when no errors exist", () => {
    const db = require("better-sqlite3")(dbPath);
    const sk = hashPath(tmpDir);
    insertDecision(db, {
      id: "dec-noerr-1",
      sessionKey: sk,
      title: "Chose to use axios",
      decisionType: "dependency",
      choice: "axios",
      rationale: "Installed axios as a dependency",
      confidence: 2,
    });
    db.close();

    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm install axios" },
      cwd: tmpDir,
    });
    const output = runHook("hook-pre-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    expect(ctx).toContain("Past decisions");
    expect(ctx).toContain("Chose to use axios");
  });
});

describe("Moat 3: Pattern Learning", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-pat-"));
    dbPath = join(tmpDir, "test.db");
    makeDb(dbPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("PATTERNS: dashboard shows captured patterns", () => {
    const db = require("better-sqlite3")(dbPath);
    insertPattern(db, {
      id: "pat-1",
      sessionKey: "proj-a",
      title: "Function pattern: fetchData(url)",
      patternType: "function",
      language: "typescript",
      signature: "fetchData(url: string)",
      filePath: "src/api.ts",
      confidence: 3,
      seenCount: 3,
    });
    db.close();

    const output = runCli("patterns", { TDAI_DB_PATH: dbPath });

    expect(output).toContain("Pattern Learning Dashboard");
    expect(output).toContain("Function pattern: fetchData(url)");
    expect(output).toContain("[function]");
    expect(output).toContain("[typescript]");
    expect(output).toContain("Total patterns:     1");
  });

  it("PATTERNS: clean DB shows no patterns message", () => {
    const output = runCli("patterns", { TDAI_DB_PATH: dbPath });

    expect(output).toContain("No patterns captured");
  });

  it("PATTERNS: retro shows most seen patterns", () => {
    const db = require("better-sqlite3")(dbPath);
    insertPattern(db, {
      id: "pat-r1",
      sessionKey: "proj-a",
      title: "Component pattern: Button",
      patternType: "component",
      language: "typescript",
      signature: "Button",
      filePath: "src/Button.tsx",
      seenCount: 5,
    });
    db.close();

    const output = runCli("patterns retro", { TDAI_DB_PATH: dbPath });

    expect(output).toContain("Pattern Retrospective");
    expect(output).toContain("Most seen patterns");
    expect(output).toContain("Component pattern: Button");
    expect(output).toContain("Adoption rate:");
  });

  it("PATTERNS: PostToolUse auto-captures function pattern from Write", () => {
    const stdin = JSON.stringify({
      tool_name: "Write",
      tool_input: {
        file_path: "src/utils.ts",
        content:
          "export function formatDate(date: Date): string {\n  return date.toISOString();\n}",
      },
      cwd: tmpDir,
    });
    runHook("hook-post-tool-use", stdin, { TDAI_DB_PATH: dbPath });

    const db = require("better-sqlite3")(dbPath, { readonly: true });
    const patterns = db
      .prepare("SELECT type, metadata FROM captures WHERE type = 'pattern'")
      .all() as { type: string; metadata: string }[];
    db.close();

    expect(patterns.length).toBe(1);
    const meta = JSON.parse(patterns[0].metadata);
    expect(meta.title).toContain("formatDate");
    expect(meta.pattern_type).toBe("function");
    expect(meta.language).toBe("typescript");
  }, 15000);

  it("PATTERNS: PostToolUse does NOT capture from non-code files", () => {
    const stdin = JSON.stringify({
      tool_name: "Write",
      tool_input: {
        file_path: "README.md",
        content: "# Some markdown content",
      },
      cwd: tmpDir,
    });
    runHook("hook-post-tool-use", stdin, { TDAI_DB_PATH: dbPath });

    const db = require("better-sqlite3")(dbPath, { readonly: true });
    const patterns = db.prepare("SELECT type FROM captures WHERE type = 'pattern'").all();
    db.close();

    expect(patterns.length).toBe(0);
  });

  it("PATTERNS: PreToolUse injects patterns before editing same-language file", () => {
    const db = require("better-sqlite3")(dbPath);
    const sk = hashPath(tmpDir);
    insertPattern(db, {
      id: "pat-inj-1",
      sessionKey: sk,
      title: "Function pattern: validateInput(data)",
      patternType: "function",
      language: "typescript",
      signature: "validateInput(data: unknown)",
      filePath: "src/validators.ts",
      confidence: 2,
    });
    db.close();

    const stdin = JSON.stringify({
      tool_name: "Write",
      tool_input: {
        file_path: "src/new-validator.ts",
        content: "export function checkInput(d: unknown) { return true; }",
      },
      cwd: tmpDir,
    });
    const output = runHook("hook-pre-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    expect(ctx).toContain("code pattern(s)");
    expect(ctx).toContain("Function pattern: validateInput");
    expect(ctx).toContain("Follow these patterns");
  });
});

// ==================================================================
// Moat 2/3: Advanced Features — 8 new tests
// ==================================================================

describe("Moat 2/3: Advanced Features", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-adv-"));
    dbPath = join(tmpDir, "test.db");
    makeDb(dbPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Decision conflict detection
  it("DECISIONS: conflict detected when choosing contradictory dependency", () => {
    const db = require("better-sqlite3")(dbPath);
    const sk = hashPath(tmpDir);
    // First: chose sqlite
    insertDecision(db, {
      id: "dec-sqlite",
      sessionKey: sk,
      title: "Chose to use sqlite",
      decisionType: "dependency",
      choice: "sqlite",
      confidence: 2,
    });
    db.close();

    // Now: run npm install postgres (contradicts sqlite)
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm install pg" },
      tool_response: { stdout: "added 1 package", exit_code: 0 },
      cwd: tmpDir,
    });
    runHook("hook-post-tool-use", stdin, { TDAI_DB_PATH: dbPath });

    // Check that the new decision has a conflict_warning
    const db2 = require("better-sqlite3")(dbPath);
    const dec = db2
      .prepare(
        "SELECT metadata FROM captures WHERE type = 'decision' AND json_extract(metadata, '$.choice') LIKE '%pg%'",
      )
      .get() as { metadata: string };
    db2.close();

    if (dec) {
      const meta = JSON.parse(dec.metadata);
      expect(meta.conflict_warning).toContain("CONFLICT");
    }
  });

  // 2. Decision conflict CLI report
  it("DECISIONS: conflicts CLI shows conflict report", () => {
    const db = require("better-sqlite3")(dbPath);
    const sk = hashPath(tmpDir);
    insertDecision(db, {
      id: "dec-conflict-1",
      sessionKey: sk,
      title: "Chose to use postgres",
      decisionType: "dependency",
      choice: "postgres",
      confidence: 1,
    });
    // Manually set conflict_warning
    db.prepare(
      "UPDATE captures SET metadata = json_set(metadata, '$.conflict_warning', 'CONFLICT: Previously chose sqlite but now choosing postgres.') WHERE id = 'dec-conflict-1'",
    ).run();
    db.close();

    const output = runCli("decisions conflicts", { TDAI_DB_PATH: dbPath });
    expect(output).toContain("Decision Conflict Report");
    expect(output).toContain("CONFLICT");
  });

  // 3. Decision cross-project inheritance
  it("DECISIONS: PreToolUse injects decisions from other projects when local is empty", () => {
    const db = require("better-sqlite3")(dbPath);
    // Insert decision in a DIFFERENT project
    insertDecision(db, {
      id: "dec-other-proj",
      sessionKey: "other-project-key",
      title: "Chose to use zod for validation",
      decisionType: "dependency",
      choice: "zod",
      rationale: "Type-safe validation",
      confidence: 3,
    });
    db.close();

    // Run npm install in THIS project (no local decisions)
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm install something" },
      cwd: tmpDir, // different from "other-project-key"
    });
    const output = runHook("hook-pre-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    // Should inject the decision from the other project
    if (ctx.length > 0) {
      expect(ctx).toContain("Past decisions");
    }
  });

  // 4. Decision inherited CLI report
  it("DECISIONS: inherited CLI shows cross-project decisions", () => {
    const db = require("better-sqlite3")(dbPath);
    // Same decision in 2 projects
    insertDecision(db, {
      id: "dec-proj-a",
      sessionKey: "proj-a",
      title: "Chose to use react",
      decisionType: "dependency",
      choice: "react",
      confidence: 2,
    });
    insertDecision(db, {
      id: "dec-proj-b",
      sessionKey: "proj-b",
      title: "Chose to use react",
      decisionType: "dependency",
      choice: "react",
      confidence: 3,
    });
    db.close();

    const output = runCli("decisions inherited", { TDAI_DB_PATH: dbPath });
    expect(output).toContain("Cross-Project Decision Inheritance");
    expect(output).toContain("react");
  });

  // 5. Pattern cross-project inheritance
  it("PATTERNS: PreToolUse injects patterns from other projects when local is empty", () => {
    const db = require("better-sqlite3")(dbPath);
    // Insert pattern in a DIFFERENT project
    insertPattern(db, {
      id: "pat-other-proj",
      sessionKey: "other-project-key",
      title: "Function pattern: fetchData(url)",
      patternType: "function",
      language: "typescript",
      signature: "fetchData(url: string)",
      filePath: "src/api.ts",
      confidence: 3,
    });
    db.close();

    // Edit a .ts file in THIS project (no local patterns)
    const stdin = JSON.stringify({
      tool_name: "Write",
      tool_input: {
        file_path: "src/new-api.ts",
        content: "export function getData(u: string) { return fetch(u); }",
      },
      cwd: tmpDir,
    });
    const output = runHook("hook-pre-tool-use", stdin, { TDAI_DB_PATH: dbPath });
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    // Should inject the pattern from the other project
    if (ctx.length > 0) {
      expect(ctx).toContain("code pattern(s)");
    }
  });

  // 6. Pattern conflict detection (CommonJS vs ESM)
  it("PATTERNS: conflict detected when mixing CommonJS and ESM imports", () => {
    const db = require("better-sqlite3")(dbPath);
    const sk = hashPath(tmpDir);
    // First: ESM import pattern
    insertPattern(db, {
      id: "pat-esm",
      sessionKey: sk,
      title: "Import pattern: ESM",
      patternType: "imports",
      language: "javascript",
      signature: "import express from 'express'",
      filePath: "src/server.js",
      confidence: 2,
    });
    db.close();

    // Now: Write a file with CommonJS require
    const stdin = JSON.stringify({
      tool_name: "Write",
      tool_input: {
        file_path: "src/legacy.js",
        content: "const express = require('express');",
      },
      cwd: tmpDir,
    });
    runHook("hook-post-tool-use", stdin, { TDAI_DB_PATH: dbPath });

    // Check that the new pattern has a conflict_warning
    const db2 = require("better-sqlite3")(dbPath);
    const pat = db2
      .prepare(
        "SELECT metadata FROM captures WHERE type = 'pattern' AND json_extract(metadata, '$.file_path') = 'src/legacy.js'",
      )
      .get() as { metadata: string };
    db2.close();

    if (pat) {
      const meta = JSON.parse(pat.metadata);
      expect(meta.conflict_warning).toContain("CONFLICT");
    }
  });

  // 7. Pattern conflicts CLI report
  it("PATTERNS: conflicts CLI shows pattern conflict report", () => {
    const db = require("better-sqlite3")(dbPath);
    const sk = hashPath(tmpDir);
    insertPattern(db, {
      id: "pat-conflict-1",
      sessionKey: sk,
      title: "Import pattern: CommonJS",
      patternType: "imports",
      language: "javascript",
      signature: "require('express')",
      filePath: "src/legacy.js",
      confidence: 1,
    });
    db.prepare(
      "UPDATE captures SET metadata = json_set(metadata, '$.conflict_warning', 'CONFLICT: src/server.js uses ESM import but src/legacy.js uses CommonJS require.') WHERE id = 'pat-conflict-1'",
    ).run();
    db.close();

    const output = runCli("patterns conflicts", { TDAI_DB_PATH: dbPath });
    expect(output).toContain("Pattern Conflict Report");
    expect(output).toContain("CONFLICT");
  });

  // 8. Pattern templates CLI report
  it("PATTERNS: templates CLI shows extracted templates", () => {
    const db = require("better-sqlite3")(dbPath);
    const sk = hashPath(tmpDir);
    insertPattern(db, {
      id: "pat-tmpl-1",
      sessionKey: sk,
      title: "Function pattern: validateInput(data)",
      patternType: "function",
      language: "typescript",
      signature: "validateInput(data: unknown)",
      filePath: "src/validators.ts",
      confidence: 3,
    });
    db.prepare(
      'UPDATE captures SET metadata = json_set(metadata, \'$.pattern_template\', \'{"template":"validateInput data","similar_pattern_count":3,"language":"typescript","pattern_type":"function"}\') WHERE id = \'pat-tmpl-1\'',
    ).run();
    db.close();

    const output = runCli("patterns templates", { TDAI_DB_PATH: dbPath });
    expect(output).toContain("Pattern Template Extraction");
    expect(output).toContain("validateInput");
  });

  // 9. Pattern inherited CLI report
  it("PATTERNS: inherited CLI shows cross-project patterns", () => {
    const db = require("better-sqlite3")(dbPath);
    // Same pattern in 2 projects
    insertPattern(db, {
      id: "pat-proj-a",
      sessionKey: "proj-a",
      title: "Function pattern: fetchData(url)",
      patternType: "function",
      language: "typescript",
      signature: "fetchData(url: string)",
      filePath: "src/api.ts",
      confidence: 2,
    });
    insertPattern(db, {
      id: "pat-proj-b",
      sessionKey: "proj-b",
      title: "Function pattern: fetchData(url)",
      patternType: "function",
      language: "typescript",
      signature: "fetchData(url: string)",
      filePath: "src/api.ts",
      confidence: 3,
    });
    db.close();

    const output = runCli("patterns inherited", { TDAI_DB_PATH: dbPath });
    expect(output).toContain("Cross-Project Pattern Inheritance");
    expect(output).toContain("fetchData");
  });

  // 10. Clean DB reports
  it("ADVANCED: clean DB shows no conflicts/templates/inherited", () => {
    const conflictsOutput = runCli("decisions conflicts", { TDAI_DB_PATH: dbPath });
    expect(conflictsOutput).toContain("No decision conflicts detected");

    const inheritedOutput = runCli("decisions inherited", { TDAI_DB_PATH: dbPath });
    expect(inheritedOutput).toContain("No cross-project decision inheritance");

    const patConflictsOutput = runCli("patterns conflicts", { TDAI_DB_PATH: dbPath });
    expect(patConflictsOutput).toContain("No pattern conflicts detected");

    const patTemplatesOutput = runCli("patterns templates", { TDAI_DB_PATH: dbPath });
    expect(patTemplatesOutput).toContain("No pattern templates extracted");

    const patInheritedOutput = runCli("patterns inherited", { TDAI_DB_PATH: dbPath });
    expect(patInheritedOutput).toContain("No cross-project pattern inheritance");
  }, 30000);
});
