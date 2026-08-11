#!/usr/bin/env node
/**
 * Postinstall script — runs automatically after `npm install -g tdai-memory-mcp`.
 * Auto-registers MCP server + hooks in detected agent configs.
 * Silent on failure (don't block npm install). Only runs on global install.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Only auto-setup on global install (npm_config_global === "true")
// Skip in CI, tests, and local dev installs
const isGlobal = process.env.npm_config_global === "true";
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

if (!isGlobal || isCI) {
  // Silent skip — not a global install or running in CI
  process.exit(0);
}

// Check if at least one agent config directory exists
const agentDirs = [
  join(homedir(), ".claude"),
  join(homedir(), ".config", "devin"),
  join(homedir(), ".cursor"),
  join(homedir(), ".codex"),
];

const hasAgent = agentDirs.some((d) => existsSync(d));
if (!hasAgent) {
  // No agent installed — silent skip
  process.exit(0);
}

// Run setup silently
// postinstall.js is in scripts/, dist/index.js is the built binary
const distIndex = join(new URL(".", import.meta.url).pathname, "..", "dist", "index.js");

// Don't run if dist/ doesn't exist yet (e.g. during npm ci in CI/Docker before build)
if (!existsSync(distIndex)) {
  process.exit(0);
}

const child = spawn(process.execPath, [distIndex, "setup"], {
  stdio: "inherit",
  env: { ...process.env, TDAI_QUIET: "1" },
});

child.on("error", () => process.exit(0)); // Don't block npm install
child.on("exit", () => process.exit(0));
