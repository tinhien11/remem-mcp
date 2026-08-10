import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** Hook scripts for supported agents. */
const HOOKS = {
  "claude-code": {
    name: "Claude Code",
    path: join(homedir(), ".claude", "hooks", "tdai-memory-hook.sh"),
    content: `#!/bin/bash
# tdai-memory auto-capture hook for Claude Code
# Captures the session summary after each session ends.

CAPTURE_FILE="\${TDAI_CAPTURE_FILE:-/tmp/tdai-memory-capture.txt}"

# Read the last message from stdin
INPUT=$(cat)

# If this is a session end, capture the summary
if echo "$INPUT" | grep -q "session_end\|SessionEnd"; then
  SUMMARY=$(echo "$INPUT" | jq -r '.summary // .messages[-1].content // empty' 2>/dev/null)
  if [ -n "$SUMMARY" ]; then
    echo "$SUMMARY" > "$CAPTURE_FILE"
  fi
fi
`,
  },
  "devin-cli": {
    name: "Devin CLI",
    path: join(homedir(), ".config", "devin", "hooks", "tdai-memory-hook.sh"),
    content: `#!/bin/bash
# tdai-memory auto-capture hook for Devin CLI
# This hook runs after a session ends and captures a summary.

CAPTURE_FILE="\${TDAI_CAPTURE_FILE:-/tmp/tdai-memory-capture.txt}"

INPUT=$(cat)
SUMMARY=$(echo "$INPUT" | jq -r '.summary // .output // empty' 2>/dev/null)

if [ -n "$SUMMARY" ]; then
  echo "$SUMMARY" > "$CAPTURE_FILE"
fi
`,
  },
};

/** Install auto-capture hooks for supported agents. */
export async function installHooks(): Promise<void> {
  let installed = 0;

  for (const [key, hook] of Object.entries(HOOKS)) {
    const dir = dirname(hook.path);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(hook.path, hook.content, "utf-8");
    // Make the hook executable
    const { chmodSync } = await import("node:fs");
    chmodSync(hook.path, 0o755);

    console.log(`  ${hook.name}: Hook installed at ${hook.path}`);
    installed++;
  }

  console.log(`\nHooks installed to ${installed} location(s).`);
  console.log("\nTo enable auto-capture:");
  console.log("  1. Configure your agent to run the hook on session end.");
  console.log("  2. The hook writes a summary to /tmp/tdai-memory-capture.txt.");
  console.log("  3. The agent skill reads this file on the next session start.");
  console.log("\nNote: The skill already handles auto-capture via MCP tools.");
  console.log("Hooks are an additional layer for agents that support them.");
}
