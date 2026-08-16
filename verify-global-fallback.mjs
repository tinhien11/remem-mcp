import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { rmSync, readFileSync } from "node:fs";
import sqliteVec from "sqlite-vec";

const dbPath = "/tmp/remem-verify-global.db";
rmSync(dbPath, { force: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const schema = readFileSync("/Users/tin/a/remem-mcp/src/storage/schema.sql", "utf-8");
db.exec(schema);
sqliteVec.load(db);

const projectKey = createHash("sha256").update("/tmp/test-project").digest("hex").slice(0, 16);
const globalKey = "global";

const insertCapture = db.prepare(
  "INSERT INTO captures (id, session_key, agent_id, type, content, content_hash, tags, created_at, trust_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate')"
);

// 15 project captures (more than limit=10)
for (let i = 0; i < 15; i++) {
  insertCapture.run(`proj-${i}`, projectKey, "test", "decision",
    `Project decision #${i}: use SQLite for storage`,
    `hash-proj-${i}`, JSON.stringify(["test"]), Date.now() - i * 1000);
}

// 3 global captures
for (let i = 0; i < 3; i++) {
  insertCapture.run(`global-${i}`, globalKey, "test", "learning",
    `Global learning #${i}: always run tests before committing`,
    `hash-global-${i}`, JSON.stringify(["test"]), Date.now() - i * 1000);
}

const limit = 10;
const projectResults = db.prepare(
  "SELECT id, session_key, type, content FROM captures WHERE session_key = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?"
).all(projectKey, limit);

// OLD: remaining = limit - projectResults.length
const oldRemaining = limit - projectResults.length;
console.log("=== OLD LOGIC (buggy) ===");
console.log(`Project: ${projectResults.length}, remaining: ${oldRemaining}, global searched: ${oldRemaining > 0 ? "YES" : "NO"}`);
console.log();

// NEW: globalLimit = Math.max(3, remaining)
const globalLimit = Math.max(3, limit - projectResults.length);
const globalResults = db.prepare(
  "SELECT id, session_key, type, content FROM captures WHERE session_key = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?"
).all(globalKey, globalLimit);

const seen = new Set(projectResults.map(r => r.id));
const merged = [...projectResults, ...globalResults.filter(r => !seen.has(r.id))].slice(0, limit);

console.log("=== NEW LOGIC (fixed) ===");
console.log(`Project: ${projectResults.length}, globalLimit: ${globalLimit}, global results: ${globalResults.length}`);
console.log(`Merged: ${merged.length}, global in output: ${merged.filter(r => r.session_key === globalKey).length}`);
console.log();

const globalInOutput = merged.filter(r => r.session_key === globalKey);
if (globalInOutput.length > 0) {
  console.log("=== PROOF: Global captures appear in recall ===");
  for (const r of globalInOutput) {
    console.log(`  [${r.type}] ${r.content.slice(0, 60)}... (id: ${r.id})`);
  }
  console.log("\nVERIFIED: fix works");
} else {
  console.log("FAILED: no global captures");
  process.exit(1);
}

db.close();
rmSync(dbPath, { force: true });
