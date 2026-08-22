import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDir = join(homedir(), ".local", "share", "remem-mcp", "test-smoke");
const dbPath = join(testDir, "memory.db");
const auditPath = join(testDir, "audit.jsonl");
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

let proc: ChildProcess;
let msgId = 0;

/** Send a JSON-RPC message to the server stdin. */
function send(method: string, params: unknown = {}): Promise<any> {
  const id = ++msgId;
  const msg = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
    }, 30000);

    const onData = (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            clearTimeout(timeout);
            proc.stdout?.off("data", onData);
            resolve(parsed);
            return;
          }
        } catch {
          // Skip non-JSON lines (stderr noise, logs)
        }
      }
    };

    proc.stdout?.on("data", onData);
    proc.stdin?.write(msg);
  });
}

/** Send a notification (no response expected). */
function notify(method: string, params: unknown = {}): void {
  const msg = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
  proc.stdin?.write(msg);
}

/** Send a tools/call request. */
function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  return send("tools/call", { name, arguments: args });
}

const describeOrSkip = process.env.CI ? describe.skip : describe;

describeOrSkip("Smoke test: full server over stdio", () => {
  beforeAll(async () => {
    // Clean up any leftover test data
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });

    // Build first
    const { execSync } = await import("node:child_process");
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    execSync("npm run build", { cwd: repoRoot, stdio: "pipe" });

    // Start the server process
    proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        REMEM_DB_PATH: dbPath,
        REMEM_AUDIT_LOG_PATH: auditPath,
        REMEM_AUDIT_LOG: "true",
        REMEM_REDACT_SECRETS: "true",
      },
    });

    // Log stderr for debugging
    proc.stderr?.on("data", (data) => {
      const text = data.toString();
      if (!text.includes("Backed up")) {
        console.error(`[server stderr] ${text.trim()}`);
      }
    });

    // Wait a moment for the process to start
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Initialize the MCP connection
    const initResponse = await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.1.0" },
    });

    expect(initResponse.result).toBeDefined();

    // Send the initialized notification
    notify("notifications/initialized");
  }, 30000);

  afterAll(async () => {
    if (proc) {
      proc.kill("SIGTERM");
      proc = null as any;
    }
    // Clean up
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("lists all core tools", async () => {
    const response = await send("tools/list", {});
    const toolNames = response.result.tools.map((t: any) => t.name);

    expect(toolNames).toContain("recall");
    expect(toolNames).toContain("capture");
    expect(toolNames).toContain("search");
    expect(toolNames).toContain("forget");
    expect(toolNames).toContain("handoff");
    expect(toolNames).toContain("adr");
    expect(toolNames).toContain("update");
    expect(toolNames).toContain("consolidate");
    expect(toolNames).toContain("resolve");
    expect(toolNames).toContain("knowledge_create");
    expect(toolNames).toContain("knowledge_get");
    expect(toolNames).toContain("knowledge_list");
    expect(toolNames).toContain("knowledge_delete");
    expect(toolNames).toContain("skill_get");
    expect(toolNames).toContain("skill_list");
    expect(toolNames).toContain("skill_search");
    // Total = 7 core + 1 explain_recall + 1 related + 2 new + 1 stats + 3 confidence + 2 outcome + 4 knowledge + 3 skill + 5 codegraph + 5 wiki = 34
    expect(toolNames).toContain("explain_recall");
    expect(toolNames).toContain("related");
    expect(toolNames).toContain("stats");
    expect(toolNames).toContain("confirm");
    expect(toolNames).toContain("correct");
    expect(toolNames).toContain("supersede");
    expect(toolNames).toContain("record_outcome");
    expect(toolNames).toContain("correction_kpis");
    expect(toolNames).toContain("session_start");
    expect(toolNames).toContain("session_end");
    expect(toolNames).toContain("session_checkpoint");
    expect(toolNames).toContain("health");
    expect(toolNames).toContain("canvas_get");
    expect(toolNames).toContain("ref_read");
    expect(toolNames).toContain("skill_create");
    expect(toolNames).toContain("skill_archive");
    expect(toolNames.length).toBe(45);
  });

  it("captures a decision", async () => {
    const response = await callTool("capture", {
      content: "We decided to use SQLite and sqlite-vec for the storage backend.",
      type: "decision",
      tags: ["arch", "storage"],
    });

    expect(response.result).toBeDefined();
    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).toContain("Captured:");
  });

  it("captures a learning", async () => {
    const response = await callTool("capture", {
      content:
        "The RRF fusion constant k is 60. This is the standard value from the original paper.",
      type: "learning",
      tags: ["search"],
    });

    expect(response.result.isError).toBeFalsy();
    expect(response.result.content[0].text).toContain("Captured:");
  });

  it("captures with a secret and verifies redaction", async () => {
    const response = await callTool("capture", {
      content: "The API key is sk-abcdefghijklmnopqrstuvwxyz123456 for the project.",
      type: "decision",
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).toContain("Captured:");
    expect(text).toContain("redacted");
  });

  it("recalls memory by keyword", async () => {
    const response = await callTool("recall", {
      query: "SQLite storage",
      mode: "keyword",
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).not.toContain("No memory found");
    expect(text).toContain("SQLite");
  });

  it("searches with a type filter", async () => {
    const response = await callTool("search", {
      query: "RRF",
      mode: "keyword",
      filters: { type: "learning" },
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).toContain("RRF");
  });

  it("rejects forget without confirm", async () => {
    // First, capture something to forget
    const captureResponse = await callTool("capture", {
      content: "A temporary decision to delete.",
      type: "decision",
    });
    const captureText = captureResponse.result.content[0].text;
    const id = captureText.match(/Captured:\s+(\S+)/)?.[1];
    expect(id).toBeDefined();

    // Try to forget without confirm
    const response = await callTool("forget", {
      id,
      confirm: false,
    });

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("confirm");
  });

  it("forgets with confirm=true", async () => {
    // Capture something to forget
    const captureResponse = await callTool("capture", {
      content: "Another temporary decision to delete.",
      type: "decision",
    });
    const captureText = captureResponse.result.content[0].text;
    const id = captureText.match(/Captured:\s+(\S+)/)?.[1];
    expect(id).toBeDefined();

    // Forget with confirm
    const response = await callTool("forget", {
      id,
      confirm: true,
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).toContain("Deleted:");
    expect(text).toContain("1 captures");
  });

  it("writes an audit log", async () => {
    // The audit log must exist and contain entries for each tool call.
    expect(existsSync(auditPath)).toBe(true);

    const logContent = readFileSync(auditPath, "utf-8");
    const lines = logContent.trim().split("\n");
    const entries = lines.map((l) => JSON.parse(l));

    // We called capture (3x), recall (1x), search (1x), forget (2x) = 7 entries
    expect(entries.length).toBeGreaterThanOrEqual(7);

    const tools = entries.map((e: any) => e.tool);
    expect(tools).toContain("capture");
    expect(tools).toContain("recall");
    expect(tools).toContain("search");
    expect(tools).toContain("forget");

    // At least one entry must have redacted=true (the secret capture)
    const redactedEntries = entries.filter((e: any) => e.redacted === true);
    expect(redactedEntries.length).toBeGreaterThan(0);

    // The audit log must not contain the raw secret
    expect(logContent).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("explain_recall shows scores and matched keywords for results", async () => {
    // First capture something searchable
    await callTool("capture", {
      content: "We use RRF fusion with k=60 for hybrid search ranking.",
      type: "decision",
      tags: ["search", "rrf"],
    });

    // Now explain why it would be recalled
    const response = await callTool("explain_recall", {
      query: "RRF fusion search",
      mode: "keyword",
      limit: 5,
    });

    expect(response.result).toBeDefined();
    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;

    // Should contain the explanation header
    expect(text).toContain("explain_recall");
    expect(text).toContain("Mode: keyword");
    // Should contain query tokens
    expect(text).toContain("Query tokens:");
    // Should contain at least one result with score
    expect(text).toContain("fused_score:");
    // Should contain matched keywords
    expect(text).toContain("matched_keywords:");
    // Should contain summary
    expect(text).toContain("### Summary");
    expect(text).toContain("keyword_results:");
  });

  it("explain_recall with capture_id explains why specific capture was/was not retrieved", async () => {
    // Capture a memory
    const captureResp = await callTool("capture", {
      content: "PostgreSQL uses MVCC for concurrent transaction isolation.",
      type: "learning",
      tags: ["database"],
    });
    const captureText = captureResp.result.content[0].text;
    const captureId = captureText.match(/Captured:\s*(\S+)/)?.[1];
    expect(captureId).toBeTruthy();

    // Explain why this capture is retrieved for a relevant query
    const response = await callTool("explain_recall", {
      query: "PostgreSQL MVCC",
      capture_id: captureId,
      mode: "keyword",
      limit: 5,
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;

    // Should contain the capture-specific explanation
    expect(text).toContain("Explanation for capture:");
    expect(text).toContain(captureId);
    // Should say it WAS retrieved (relevant query)
    expect(text).toContain("WAS retrieved");
  });

  it("explain_recall with non-existent capture_id says not found", async () => {
    const response = await callTool("explain_recall", {
      query: "anything",
      capture_id: "NONEXISTENT_ID_12345",
      mode: "keyword",
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;

    // Should say capture not found
    expect(text).toContain("NOT in the top");
    expect(text).toContain("capture not found");
  });

  it("related tool finds memories with shared tags", async () => {
    // Capture two memories with shared tags
    const cap1 = await callTool("capture", {
      content: "We chose Vite as the build tool for the frontend.",
      type: "decision",
      tags: ["frontend", "build", "vite"],
    });
    const id1 = cap1.result.content[0].text.match(/Captured:\s*(\S+)/)?.[1];
    expect(id1).toBeTruthy();

    const cap2 = await callTool("capture", {
      content: "Vite config uses esbuild for TS transpilation, not tsc.",
      type: "learning",
      tags: ["frontend", "vite", "config"],
    });
    const id2 = cap2.result.content[0].text.match(/Captured:\s*(\S+)/)?.[1];
    expect(id2).toBeTruthy();

    // Call related with id1 — should find id2 (shared tags: frontend, vite)
    const response = await callTool("related", { id: id1, limit: 5 });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;

    // Should mention the source capture
    expect(text).toContain("Related memories");
    expect(text).toContain(id1);
    // Should find at least one related memory
    expect(text).toContain("Found");
    expect(text.toLowerCase()).toContain("related memor");
    // Should mention the shared tag reason
    expect(text).toContain("tag:");
  });

  it("related tool returns error for non-existent capture", async () => {
    const response = await callTool("related", { id: "NONEXISTENT_ID_99999" });

    expect(response.result.isError).toBe(true);
    const text = response.result.content[0].text;
    expect(text).toContain("not found");
  });
});
