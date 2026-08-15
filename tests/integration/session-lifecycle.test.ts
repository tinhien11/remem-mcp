import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDir = join(homedir(), ".local", "share", "remem-mcp", "test-session-lifecycle");
const dbPath = join(testDir, "memory.db");
const auditPath = join(testDir, "audit.jsonl");
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");

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

describeOrSkip("Session lifecycle MCP tools (stdio)", () => {
  beforeAll(async () => {
    // Clean up any leftover test data
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });

    // Build first
    const { execSync } = await import("node:child_process");
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    execSync("npm run build", { cwd: repoRoot, stdio: "pipe" });

    // Start the server process
    proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        REMEM_DB_PATH: dbPath,
        REMEM_AUDIT_LOG_PATH: auditPath,
        REMEM_AUDIT_LOG: "true",
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
      clientInfo: { name: "session-lifecycle-test", version: "0.1.0" },
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
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("session_start returns recentCaptures, correctionAlignment, and sessionKey", async () => {
    // Seed a capture so recentCaptures has something to show
    await callTool("capture", {
      content: "Seeded capture for session_start test.",
      type: "decision",
      tags: ["seed"],
    });

    const response = await callTool("session_start", {});

    expect(response.result).toBeDefined();
    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.sessionKey).toBeTruthy();
    expect(typeof parsed.sessionKey).toBe("string");
    expect(Array.isArray(parsed.recentCaptures)).toBe(true);
    expect(parsed.recentCaptures.length).toBeGreaterThan(0);
    expect(parsed.recentCaptures[0]).toHaveProperty("id");
    expect(parsed.recentCaptures[0]).toHaveProperty("type");
    expect(parsed.recentCaptures[0]).toHaveProperty("preview");
    expect(typeof parsed.correctionAlignment).toBe("object");
    expect(parsed.correctionAlignment).toHaveProperty("totalCorrections");
    expect(parsed.correctionAlignment).toHaveProperty("heedRate");
    expect(parsed.correctionAlignment).toHaveProperty("alignment");
  });

  it("session_start with context_query returns contextResults array", async () => {
    // Seed a capture relevant to the query
    await callTool("capture", {
      content: "We chose SQLite with sqlite-vec for vector storage and hybrid search.",
      type: "decision",
      tags: ["arch", "search"],
    });

    const response = await callTool("session_start", {
      context_query: "SQLite vector storage",
    });

    expect(response.result.isError).toBeFalsy();
    const parsed = JSON.parse(response.result.content[0].text);

    expect(Array.isArray(parsed.contextResults)).toBe(true);
    expect(parsed.contextResults.length).toBeGreaterThan(0);
    expect(typeof parsed.contextResults[0]).toBe("string");
  });

  it("session_end with summary captures the summary and returns a capture ID", async () => {
    const summaryText = "Implemented session lifecycle tests covering start, end, and checkpoint.";
    const response = await callTool("session_end", {
      summary: summaryText,
      tags: ["test", "session-end"],
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).toContain("Session ended. Summary captured:");
    const id = text.match(/Summary captured:\s+(\S+)/)?.[1];
    expect(id).toBeTruthy();
  });

  it("session_end without summary returns a no-summary message", async () => {
    const response = await callTool("session_end", {});

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).toContain("No summary provided");
  });

  it("session_checkpoint creates a checkpoint with a name and returns a checkpoint ID", async () => {
    const response = await callTool("session_checkpoint", {
      name: "pre-merge-checkpoint",
      summary: "About to merge the feature branch.",
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).toContain("Checkpoint");
    expect(text).toContain("pre-merge-checkpoint");
    expect(text).toContain("created:");
    const id = text.match(/created:\s+(\S+)/)?.[1]?.replace(/\.$/, "");
    expect(id).toBeTruthy();
  });

  it("session_checkpoint is searchable via recall('checkpoint <name>')", async () => {
    const checkpointName = "milestone-alpha";
    await callTool("session_checkpoint", {
      name: checkpointName,
      summary: "Reached alpha milestone for the lifecycle tools.",
    });

    const response = await callTool("recall", {
      query: `checkpoint ${checkpointName}`,
      mode: "keyword",
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).not.toContain("No memory found");
    expect(text).toContain(checkpointName);
    expect(text).toContain("Checkpoint");
  });

  it("consolidate with batch_size=5 mentions batch_size in the response", async () => {
    // Seed enough captures that batch_size is meaningful; use distinct content
    // so no duplicates are found (we just want to verify the batch_size echo).
    for (let i = 0; i < 8; i++) {
      await callTool("capture", {
        content: `Unique consolidate-batch capture number ${i} about topic ${i}.`,
        type: "learning",
        tags: ["consolidate-batch"],
      });
    }

    const response = await callTool("consolidate", {
      batch_size: 5,
      confirm: false,
      session_key: "all",
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    // The handler echoes batch_size when > 0 (in the no-duplicates branch).
    expect(text).toContain("batch_size");
    expect(text).toContain("5");
  });
});
