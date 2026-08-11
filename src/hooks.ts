import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Wire hooks into agent config files.
 *
 * For Devin CLI: adds hooks to ~/.config/devin/config.json under the "hooks" key.
 * For Claude Code: adds hooks to ~/.claude/settings.json under the "hooks" key.
 *
 * Hooks installed:
 * - SessionStart: runs `tdai-memory-mcp hook-recall` → injects recent memory into agent context
 * - SessionEnd: runs `tdai-memory-mcp hook-session-end` → silently captures session summary to memory DB
 */

/** The npx command to run the hook handler. */
function hookCommand(subcommand: string): string {
  return `npx -y tdai-memory-mcp ${subcommand}`;
}

/** Hooks configuration that gets injected into agent config files. */
const HOOKS_CONFIG = {
  SessionStart: [
    {
      hooks: [
        {
          type: "command",
          command: hookCommand("hook-recall"),
          timeout: 10,
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: hookCommand("hook-stop"),
          timeout: 10,
        },
      ],
    },
  ],
  SessionEnd: [
    {
      hooks: [
        {
          type: "command",
          command: hookCommand("hook-session-end"),
          timeout: 10,
        },
      ],
    },
  ],
};

/** Safely read and parse a JSON config file. Returns {} if file doesn't exist or is invalid. */
function readJsonConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/** Write JSON config file, creating directories as needed. */
function writeJsonConfig(path: string, data: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/** Merge hooks into an existing config object without overwriting other keys. */
function mergeHooks(
  config: Record<string, unknown>,
  hooks: Record<string, unknown>,
): Record<string, unknown> {
  const existing = (config.hooks as Record<string, unknown>) ?? {};
  return {
    ...config,
    hooks: {
      ...existing,
      ...hooks,
    },
  };
}

/** Install hooks for Devin CLI. */
function installDevinHooks(): boolean {
  const configPath = join(homedir(), ".config", "devin", "config.json");

  if (!existsSync(dirname(configPath))) {
    return false;
  }

  const config = readJsonConfig(configPath);
  const updated = mergeHooks(config, HOOKS_CONFIG);
  writeJsonConfig(configPath, updated);

  console.log(`  Devin CLI: Hooks wired into ${configPath}`);
  return true;
}

/** Install hooks for Claude Code. */
function installClaudeCodeHooks(): boolean {
  const settingsPath = join(homedir(), ".claude", "settings.json");

  // Check if Claude Code is installed
  const claudeDir = join(homedir(), ".claude");
  if (!existsSync(claudeDir)) {
    return false;
  }

  const config = readJsonConfig(settingsPath);
  const updated = mergeHooks(config, HOOKS_CONFIG);
  writeJsonConfig(settingsPath, updated);

  console.log(`  Claude Code: Hooks wired into ${settingsPath}`);
  return true;
}

/** Install hooks for Codex CLI (TOML config). */
function installCodexHooks(): boolean {
  const configPath = join(homedir(), ".codex", "config.toml");

  if (!existsSync(configPath)) {
    return false;
  }

  let content = readFileSync(configPath, "utf-8");

  // Check if tdai-memory hooks are already installed
  if (content.includes("tdai-memory SessionStart")) {
    console.log(`  Codex CLI: Hooks already installed in ${configPath}`);
    return true;
  }

  // Append tdai-memory hooks to the TOML config
  const hooksToml = `
# >>> tdai-memory SessionStart >>>
[[hooks.SessionStart]]
matcher = "startup|resume|clear|compact"

[[hooks.SessionStart.hooks]]
type = "command"
command = "${hookCommand("hook-recall")}"
timeout = 10
# <<< tdai-memory SessionStart <<<

# >>> tdai-memory Stop >>>
[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "${hookCommand("hook-stop")}"
timeout = 5
# <<< tdai-memory Stop <<<
`;

  content = content.trimEnd() + "\n" + hooksToml;
  writeFileSync(configPath, content, "utf-8");

  console.log(`  Codex CLI: Hooks wired into ${configPath}`);
  console.log(`    Note: Set sandbox_mode = "danger-full-access" for MCP tools to work.`);
  return true;
}

/** Install auto-capture hooks for supported agents. */
export async function installHooks(): Promise<void> {
  console.log("Installing lifecycle hooks...\n");

  let installed = 0;

  if (installDevinHooks()) installed++;
  if (installClaudeCodeHooks()) installed++;
  if (installCodexHooks()) installed++;

  if (installed === 0) {
    console.log("\nNo supported agents found.");
    console.log("Install Devin CLI, Claude Code, or Codex CLI first, then run this command again.");
    return;
  }

  console.log(`\nHooks wired to ${installed} agent(s).`);
  console.log("\nHooks installed:");
  console.log("  SessionStart → auto-recall recent memory into agent context");
  console.log("  Stop         → prompt agent to save handoff before exit");
  console.log("  SessionEnd   → silently capture session summary to memory DB");
  console.log("\nRestart your agent for hooks to take effect.");
  console.log("\nTo verify: run /hooks in your agent.");
}

/** Remove hooks from agent config files. */
export async function uninstallHooks(): Promise<void> {
  console.log("Removing lifecycle hooks...\n");

  let removed = 0;

  // Remove from Devin CLI
  const devinPath = join(homedir(), ".config", "devin", "config.json");
  if (existsSync(devinPath)) {
    const config = readJsonConfig(devinPath);
    if (config.hooks) {
      const hooks = config.hooks as Record<string, unknown>;
      delete hooks.SessionStart;
      delete hooks.SessionEnd;
      delete hooks.Stop;
      if (Object.keys(hooks).length === 0) {
        delete config.hooks;
      }
      writeJsonConfig(devinPath, config);
      console.log(`  Devin CLI: Hooks removed from ${devinPath}`);
      removed++;
    }
  }

  // Remove from Claude Code
  const claudePath = join(homedir(), ".claude", "settings.json");
  if (existsSync(claudePath)) {
    const config = readJsonConfig(claudePath);
    if (config.hooks) {
      const hooks = config.hooks as Record<string, unknown>;
      delete hooks.SessionStart;
      delete hooks.SessionEnd;
      delete hooks.Stop;
      if (Object.keys(hooks).length === 0) {
        delete config.hooks;
      }
      writeJsonConfig(claudePath, config);
      console.log(`  Claude Code: Hooks removed from ${claudePath}`);
      removed++;
    }
  }

  if (removed === 0) {
    console.log("No hooks found to remove.");
  } else {
    console.log(`\nHooks removed from ${removed} agent(s).`);
  }
}
