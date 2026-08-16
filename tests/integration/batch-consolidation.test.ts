import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDir = join(homedir(), ".local", "share", "remem-mcp", "test-batch-consolidation");
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

/** Capture content and return the stored capture id. Handles both "Captured:" and "Duplicate:" responses. */
async function captureId(
  content: string,
  sessionKey: string,
  tags: string[] = [],
): Promise<string> {
  const resp = await callTool("capture", {
    content,
    type: "decision",
    tags,
    session_key: sessionKey,
  });
  expect(resp.result.isError).toBeFalsy();
  const text = resp.result.content[0].text;
  // "Captured: <id>" for new captures, "Duplicate: <id>" when content hash already exists.
  const id = text.match(/(?:Captured|Duplicate):\s*(\S+)/)?.[1];
  expect(id).toBeTruthy();
  return id!;
}

const describeOrSkip = process.env.CI ? describe.skip : describe;

describeOrSkip("consolidate MCP tool with batch_size (stdio)", () => {
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
      clientInfo: { name: "batch-consolidation-test", version: "0.1.0" },
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

  it("consolidate with batch_size=0 (default) processes all captures", async () => {
    const sk = "batch-default-all";
    // Seed 3 genuinely unique captures (disjoint vocabularies) so no duplicates
    // are found and the "N captures checked" branch is exercised.
    await callTool("capture", {
      content: "The quantum entanglement experiment yielded unexpected coherence times.",
      type: "decision",
      tags: ["batch-default"],
      session_key: sk,
    });
    await callTool("capture", {
      content: "Migrating the billing pipeline from cron jobs to event-driven lambdas.",
      type: "decision",
      tags: ["batch-default"],
      session_key: sk,
    });
    await callTool("capture", {
      content: "Oolong tea leaves require oxidation between green and black tea processing.",
      type: "decision",
      tags: ["batch-default"],
      session_key: sk,
    });

    const response = await callTool("consolidate", {
      batch_size: 0,
      confirm: false,
      session_key: sk,
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    // All 3 captures were checked; batch_size=0 does not echo the batch_size suffix.
    expect(text).toContain("3 captures checked");
    expect(text).not.toContain("batch_size");
  });

  it("consolidate with batch_size=2 only processes 2 captures (response mentions batch_size: 2)", async () => {
    const sk = "batch-size-two";
    // Seed 4 genuinely unique captures; only the first 2 (most recent) should be processed.
    await callTool("capture", {
      content: "Kangaroo populations fluctuate with seasonal rainfall in the outback.",
      type: "decision",
      tags: ["batch-two"],
      session_key: sk,
    });
    await callTool("capture", {
      content: "The baroque cello suite employs open-string drones for resonance.",
      type: "decision",
      tags: ["batch-two"],
      session_key: sk,
    });
    await callTool("capture", {
      content: "Terraform state locking uses DynamoDB to prevent concurrent applies.",
      type: "decision",
      tags: ["batch-two"],
      session_key: sk,
    });
    await callTool("capture", {
      content: "Sourdough hydration levels above 80 percent demand long cold fermentation.",
      type: "decision",
      tags: ["batch-two"],
      session_key: sk,
    });

    const response = await callTool("consolidate", {
      batch_size: 2,
      confirm: false,
      session_key: sk,
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    // Only 2 captures were checked, and the batch_size is echoed.
    expect(text).toContain("2 captures checked");
    expect(text).toContain("batch_size: 2");
  });

  it("consolidate with negative batch_size returns an error", async () => {
    const response = await callTool("consolidate", {
      batch_size: -1,
      confirm: false,
      session_key: "all",
    });

    expect(response.result.isError).toBe(true);
    const text = response.result.content[0].text;
    expect(text).toContain("batch_size must be non-negative");
  });

  it("consolidate with threshold > 1 returns an error", async () => {
    const response = await callTool("consolidate", {
      threshold: 1.5,
      confirm: false,
      session_key: "all",
    });

    expect(response.result.isError).toBe(true);
    const text = response.result.content[0].text;
    expect(text).toContain("threshold must be between 0 and 1");
  });

  it("consolidate with threshold < 0 returns an error", async () => {
    const response = await callTool("consolidate", {
      threshold: -0.5,
      confirm: false,
      session_key: "all",
    });

    expect(response.result.isError).toBe(true);
    const text = response.result.content[0].text;
    expect(text).toContain("threshold must be between 0 and 1");
  });

  it("consolidate finds actual duplicates (2 near-identical captures seeded)", async () => {
    const sk = "batch-dup-detect";
    // Slightly different content (one word) so capture-time content-hash dedup
    // doesn't block the second one, but Jaccard similarity still exceeds 0.75.
    const content1 =
      "We decided to use PostgreSQL with pgvector for vector storage and hybrid search alpha.";
    const content2 =
      "We decided to use PostgreSQL with pgvector for vector storage and hybrid search beta.";
    const id1 = await captureId(content1, sk, ["dup-detect"]);
    const id2 = await captureId(content2, sk, ["dup-detect"]);
    expect(id1).not.toBe(id2);

    const response = await callTool("consolidate", {
      confirm: false,
      session_key: sk,
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).toContain("Found 1 duplicate group(s)");
    // Both capture ids should be listed in the group.
    expect(text).toContain(id1);
    expect(text).toContain(id2);
  });

  it("consolidate with confirm=true merges duplicates (one is soft-deleted)", async () => {
    const sk = "batch-confirm-merge";
    const content1 =
      "We chose Redis for caching with a TTL of 3600 seconds for session data alpha.";
    const content2 = "We chose Redis for caching with a TTL of 3600 seconds for session data beta.";
    const id1 = await captureId(content1, sk, ["confirm-merge"]);
    const id2 = await captureId(content2, sk, ["confirm-merge"]);
    expect(id1).not.toBe(id2);

    const response = await callTool("consolidate", {
      confirm: true,
      session_key: sk,
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).toContain("Consolidated 1 group(s)");
    expect(text).toContain("merged 1 duplicate(s)");

    // After merge, only 1 non-deleted capture remains in this session.
    // A second consolidate (report-only) should report not enough captures to consolidate.
    const followup = await callTool("consolidate", {
      confirm: false,
      session_key: sk,
    });
    const followupText = followup.result.content[0].text;
    expect(followupText).toContain("Not enough captures to consolidate");
  });

  it("consolidate with confirm=false only reports (both captures still exist)", async () => {
    const sk = "batch-report-only";
    const content1 =
      "We selected FastAPI as the web framework for the Python backend service alpha.";
    const content2 =
      "We selected FastAPI as the web framework for the Python backend service beta.";
    const id1 = await captureId(content1, sk, ["report-only"]);
    const id2 = await captureId(content2, sk, ["report-only"]);
    expect(id1).not.toBe(id2);

    const response = await callTool("consolidate", {
      confirm: false,
      session_key: sk,
    });

    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).toContain("Found 1 duplicate group(s)");
    expect(text).toContain(id1);
    expect(text).toContain(id2);
    // confirm=false must not merge; the message should prompt to set confirm=true.
    expect(text).toContain("Set confirm=true to merge");

    // Both captures still exist: a second report-only consolidate still finds the group.
    const followup = await callTool("consolidate", {
      confirm: false,
      session_key: sk,
    });
    const followupText = followup.result.content[0].text;
    expect(followupText).toContain("Found 1 duplicate group(s)");
    expect(followupText).toContain(id1);
    expect(followupText).toContain(id2);
  });
});
