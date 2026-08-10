import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { rmSync, existsSync, readFileSync } from "node:fs";

const testDir = join(homedir(), ".local", "share", "tdai-memory-mcp", "test-smoke");
const dbPath = join(testDir, "memory.db");
const auditPath = join(testDir, "audit.jsonl");
const serverPath = join(process.cwd(), "dist", "index.js");

let proc: ChildProcess;
let msgId = 0;

/** Send a JSON-RPC message to the server stdin. */
function send(method: string, params: unknown = {}): Promise<any> {
  const id = ++msgId;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
    }, 10000);

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
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  proc.stdin?.write(msg);
}

/** Send a tools/call request. */
function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  return send("tools/call", { name, arguments: args });
}

describe("Smoke test: full server over stdio", () => {
  beforeAll(async () => {
    // Clean up any leftover test data
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });

    // Build first
    const { execSync } = await import("node:child_process");
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe" });

    // Start the server process
    proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TDAI_DB_PATH: dbPath,
        TDAI_AUDIT_LOG_PATH: auditPath,
        TDAI_AUDIT_LOG: "true",
        TDAI_REDACT_SECRETS: "true",
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

  it("lists all 4 tools", async () => {
    const response = await send("tools/list", {});
    const toolNames = response.result.tools.map((t: any) => t.name);

    expect(toolNames).toContain("recall");
    expect(toolNames).toContain("capture");
    expect(toolNames).toContain("search");
    expect(toolNames).toContain("forget");
    expect(toolNames.length).toBe(4);
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
      content: "The RRF fusion constant k is 60. This is the standard value from the original paper.",
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
});
