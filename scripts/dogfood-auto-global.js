// dogfood-auto-global.js — auto_global classification test
import { Memory } from "../dist/sdk.js";
import { rmSync } from "fs";

const dbPath = "/tmp/dogfood-auto-global.db";
for (const ext of ["", "-wal", "-shm"]) {
  rmSync(dbPath + ext, { force: true });
}

const m = new Memory({ dbPath, globalSessionKey: "global" });

const cases = [
  ["Always run tests before committing", "learning", "global"],
  ["Never commit secrets to git", "learning", "global"],
  ["Prefer SQLite over Postgres for small projects", "decision", "global"],
  ["Use vitest for testing", "learning", "global"],
  ["Avoid using datetime now in SQL queries", "learning", "global"],
  ["Best practice: wrap migrations in transactions", "decision", "global"],
  ["Fixed bug in src/server.ts line 1418", "task", "project"],
  ["Migration in dist/schema.sql failed", "task", "project"],
  ["Commit abc1234 broke the build", "task", "project"],
  ["Bug hunt found 14 bugs in tests/integration", "task", "project"],
  ["Always check src/index.ts for the entry point", "learning", "project"],
  ["Error: ENOENT at line 42", "error", "project"],
  ["User said hello world", "conversation", "project"],
  ["Pattern: retry on ECONNRESET for HTTP clients", "learning", "global"],
  ["Updated package.json to use better-sqlite3", "task", "project"],
];

let pass = 0, fail = 0;
const fails = [];

for (const [content, type, expected] of cases) {
  const id = await m.capture(content, type, ["dogfood", "auto-global"], { autoGlobal: true });
  if (!id) { fail++; fails.push(`  FAIL: "${content.slice(0,40)}" -> dedup returned null`); continue; }
  const entry = await m.storage.get(id);
  const actualSession = entry.sessionKey === "global" ? "global" : "project";
  if (actualSession === expected) {
    pass++;
  } else {
    fail++;
    fails.push(`  FAIL: "${content.slice(0, 40)}" -> ${actualSession} (expected ${expected})`);
  }
}

// Recall: search for a global term, verify global results appear
const recallResults = await m.recall("run tests before committing");
const hasGlobal = recallResults.some((r) => r.entry.sessionKey === "global");

// Search: project-specific, verify project results
const searchResults = await m.search("src/server.ts bug");
const hasProject = searchResults.some((r) => r.entry.sessionKey !== "global");

console.log(JSON.stringify({ pass, fail, fails, recallHasGlobal: hasGlobal, searchHasProject: hasProject }));

m.close();
for (const ext of ["", "-wal", "-shm"]) {
  rmSync(dbPath + ext, { force: true });
}
