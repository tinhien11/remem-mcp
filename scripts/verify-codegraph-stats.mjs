#!/usr/bin/env node
/**
 * Verify codegraph_stats tool exists in the built server and returns correct stats.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const distPath = join(process.cwd(), "dist", "index.js");

// Create a small test repo with some symbols
const repoDir = mkdtempSync(join(tmpdir(), "cg-stats-"));
const srcDir = join(repoDir, "src");
mkdirSync(srcDir, { recursive: true });
writeFileSync(join(srcDir, "foo.ts"),
  `export function alpha() { return 1; }\n` +
  `export class Beta { gamma() {} }\n`);
writeFileSync(join(srcDir, "bar.ts"),
  `export function delta() { alpha(); }\n`);

const proc = spawn("node", [distPath, "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, REMEM_DB_PATH: join(repoDir, "test.db") },
});

let buf = "";
proc.stdout.on("data", (d) => { buf += d.toString(); });
proc.stderr.on("data", () => {});

function send(msg) { proc.stdin.write(JSON.stringify(msg) + "\n"); }

function waitForId(id, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      for (const line of buf.split("\n")) {
        try {
          const obj = JSON.parse(line);
          if (obj.id === id) { clearInterval(iv); resolve(obj); return; }
        } catch {}
      }
      if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error(`timeout id=${id}`)); }
    }, 50);
  });
}

// 1. Check codegraph_stats is in the tools list
send({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } });
await waitForId(1);
send({ jsonrpc: "2.0", method: "notifications/initialized" });

send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const toolsResp = await waitForId(2);
const toolNames = (toolsResp.result?.tools || []).map(t => t.name);
const hasStats = toolNames.includes("codegraph_stats");

if (!hasStats) {
  console.error("FAIL: codegraph_stats not in tools list");
  console.error("Available tools:", toolNames.join(", "));
  proc.kill();
  try { rmSync(repoDir, { recursive: true }); } catch {}
  process.exit(1);
}
console.log("OK: codegraph_stats is in tools list");

// 2. Index the test repo first
send({ jsonrpc: "2.0", id: 3, method: "tools/call",
  params: { name: "codegraph_index", arguments: { path: srcDir, repo_path: srcDir } } });
await waitForId(3, 30000);

// 3. Call codegraph_stats and verify it returns numbers
send({ jsonrpc: "2.0", id: 4, method: "tools/call",
  params: { name: "codegraph_stats", arguments: { repo_path: srcDir } } });

let failures = 0;
try {
  const resp = await waitForId(4, 15000);
  const text = resp.result?.content?.[0]?.text || "";

  if (text.includes("symbols") && text.includes("calls") && text.includes("files")) {
    console.log("OK: codegraph_stats returns symbols, calls, files");
  } else {
    console.error(`FAIL: codegraph_stats output missing expected fields: ${text.slice(0, 300)}`);
    failures++;
  }

  const files = Number((text.match(/files:\s*(\d+)/) || [])[1] || 0);
  const symbols = Number((text.match(/symbols:\s*(\d+)/) || [])[1] || 0);
  const calls = Number((text.match(/calls:\s*(\d+)/) || [])[1] || 0);
  if (files >= 2 && symbols >= 3 && calls >= 1) {
    console.log(`OK: codegraph_stats is repo-scoped (files=${files}, symbols=${symbols}, calls=${calls})`);
  } else {
    console.error(`FAIL: codegraph_stats stats look wrong: ${text.slice(0, 300)}`);
    failures++;
  }

  // Should not be an error
  if (resp.result?.isError) {
    console.error("FAIL: codegraph_stats returned an error");
    failures++;
  } else {
    console.log("OK: codegraph_stats returned successfully (no error)");
  }

  console.log(`\nStats output: ${text.slice(0, 500)}`);
} catch (err) {
  console.error(`FAIL: codegraph_stats call failed: ${err.message}`);
  failures++;
}

proc.kill();
try { rmSync(repoDir, { recursive: true }); } catch {}

if (failures === 0) {
  console.log("codegraph_stats verification passed");
  process.exit(0);
} else {
  console.error(`${failures} codegraph_stats check(s) failed`);
  process.exit(1);
}
