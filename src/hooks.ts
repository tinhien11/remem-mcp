import { execFileSync } from "node:child_process";
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
 * - SessionStart: runs `remem-mcp hook-recall` → injects recent memory into agent context
 * - SessionEnd: runs `remem-mcp hook-session-end` → silently captures session summary to memory DB
 */

/**
 * Resolve the best command to invoke remem-mcp hooks.
 * If the binary is globally installed, use it directly (fast, no npx overhead).
 * Fall back to npx --prefer-offline (uses cache, avoids re-download).
 */
function hookCommand(subcommand: string): string {
  try {
    const binPath = execFileSync("which", ["remem-mcp"], { encoding: "utf-8" }).trim();
    if (binPath && existsSync(binPath)) {
      return `${binPath} ${subcommand}`;
    }
  } catch {
    // Binary not found — fall back to npx
  }
  return `npx --prefer-offline -y remem-mcp ${subcommand}`;
}

const CODEX_HOOK_SUBCOMMANDS = [
  "hook-recall",
  "hook-pre-tool-use",
  "hook-post-tool-use",
  "hook-post-compaction",
  "hook-user-prompt",
  "hook-stop",
  "hook-session-end",
];

/**
 * Codex may rewrite config.toml and remove comments, so marker comments are not
 * a reliable installation record. Detect the hook commands themselves.
 */
function hasCodexRememHooks(content: string): boolean {
  return CODEX_HOOK_SUBCOMMANDS.some((subcommand) => content.includes(` ${subcommand}"`));
}

/** Remove remem-mcp hook blocks, including marker-less TOML written by Codex. */
export function removeCodexHooksFromToml(content: string): string {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const match = lines[index].match(/^\[\[hooks\.([A-Za-z]+)\]\]\s*$/);
    if (!match) {
      output.push(lines[index]);
      index++;
      continue;
    }

    const event = match[1];
    const nestedPrefix = `[[hooks.${event}.hooks]]`;
    let end = index + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.startsWith(nestedPrefix)) {
        end++;
        continue;
      }
      if (/^\[./.test(line)) break;
      end++;
    }

    const block = lines.slice(index, end);
    if (CODEX_HOOK_SUBCOMMANDS.some((subcommand) => block.includes(` ${subcommand}"`))) {
      // Remove comments immediately attached to this generated block.
      while (
        output.length > 0 &&
        (output[output.length - 1].trim() === "" ||
          (/^\s*#/.test(output[output.length - 1]) &&
            output[output.length - 1].includes("remem-mcp")))
      ) {
        output.pop();
      }
    } else {
      output.push(...block);
    }

    index = end;
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** Hooks configuration for Devin CLI and Codex CLI.
 *  Note: Devin CLI does NOT support PreCompact — only PostCompaction. */
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
  PreToolUse: [
    {
      matcher: "Bash|exec",
      hooks: [
        {
          type: "command",
          command: hookCommand("hook-pre-tool-use"),
          timeout: 5,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: "Bash|exec",
      hooks: [
        {
          type: "command",
          command: hookCommand("hook-post-tool-use"),
          timeout: 5,
        },
      ],
    },
  ],
  // PostCompaction: re-inject memory after context compaction.
  // Supported by all 3 agents (Claude Code, Devin CLI, Codex CLI).
  // Note: Devin CLI and Codex CLI do NOT support PreCompact — only PostCompaction.
  // Claude Code supports both, but PostCompaction alone is sufficient.
  PostCompaction: [
    {
      hooks: [
        {
          type: "command",
          command: hookCommand("hook-post-compaction"),
          timeout: 10,
        },
      ],
    },
  ],
  // Note: PostToolUseFailure is not supported by Devin CLI.
  // Devin supports: PreToolUse, PostToolUse, UserPromptSubmit, Stop,
  // PostCompaction, SessionStart, SessionEnd, PermissionRequest.
  // Error capture is handled via PostToolUse with exit code 2.
  UserPromptSubmit: [
    {
      hooks: [
        {
          type: "command",
          command: hookCommand("hook-user-prompt"),
          timeout: 5,
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

/** Merge hooks into an existing config object without overwriting other keys.
 * For each hook event, appends our hooks to any existing ones (preserves user hooks).
 */
function mergeHooks(
  config: Record<string, unknown>,
  hooks: Record<string, unknown>,
): Record<string, unknown> {
  const existing = (config.hooks as Record<string, unknown>) ?? {};
  const merged: Record<string, unknown> = { ...existing };

  for (const [event, newEntries] of Object.entries(hooks)) {
    const existingEntries = (existing[event] as unknown[]) ?? [];
    // Filter out any previous remem-mcp hooks for this event (avoid duplicates on re-install)
    const filtered = existingEntries.filter((entry) => {
      const hooks = (entry as { hooks?: { command?: string }[] })?.hooks;
      if (!hooks) return true;
      return !hooks.some((h) => h?.command?.includes("remem-mcp"));
    });
    merged[event] = [...filtered, ...(newEntries as unknown[])];
  }

  return {
    ...config,
    hooks: merged,
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

/** Install hooks for Claude Code.
 *  Claude Code supports PreCompact (before compaction) in addition to PostCompaction. */
function installClaudeCodeHooks(): boolean {
  const settingsPath = join(homedir(), ".claude", "settings.json");

  // Check if Claude Code is installed
  const claudeDir = join(homedir(), ".claude");
  if (!existsSync(claudeDir)) {
    return false;
  }

  // Claude Code supports PreCompact (before) and PostCompact (after) — not PostCompaction.
  // Remap PostCompaction → PostCompact for Claude Code, and add PreCompact on top.
  const { PostCompaction: _omit, ...baseWithoutPostCompaction } = HOOKS_CONFIG;
  const claudeHooksConfig = {
    ...baseWithoutPostCompaction,
    PreCompact: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("hook-pre-compact"),
            timeout: 10,
          },
        ],
      },
    ],
    PostCompact: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("hook-post-compaction"),
            timeout: 10,
          },
        ],
      },
    ],
  };

  const config = readJsonConfig(settingsPath);
  const updated = mergeHooks(config, claudeHooksConfig);
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

  // Check if remem-mcp hooks are already installed
  if (hasCodexRememHooks(content)) {
    console.log(`  Codex CLI: Hooks already installed in ${configPath}`);
    return true;
  }

  // Append remem-mcp hooks to the TOML config
  const hooksToml = `
# >>> remem-mcp SessionStart >>>
[[hooks.SessionStart]]
matcher = "startup|resume|clear|compact"

[[hooks.SessionStart.hooks]]
type = "command"
command = "${hookCommand("hook-recall")}"
timeout = 10
# <<< remem-mcp SessionStart <<<

# >>> remem-mcp PreToolUse >>>
[[hooks.PreToolUse]]
matcher = "Bash|exec"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "${hookCommand("hook-pre-tool-use")}"
timeout = 5
# <<< remem-mcp PreToolUse <<<

# >>> remem-mcp PostToolUse >>>
[[hooks.PostToolUse]]
matcher = "Bash|exec"

[[hooks.PostToolUse.hooks]]
type = "command"
command = "${hookCommand("hook-post-tool-use")}"
timeout = 5
# <<< remem-mcp PostToolUse <<<

# >>> remem-mcp PostCompaction >>>
[[hooks.PostCompaction]]

[[hooks.PostCompaction.hooks]]
type = "command"
command = "${hookCommand("hook-post-compaction")}"
timeout = 10
# <<< remem-mcp PostCompaction <<<

# >>> remem-mcp UserPromptSubmit >>>
[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "${hookCommand("hook-user-prompt")}"
timeout = 5
# <<< remem-mcp UserPromptSubmit <<<

# >>> remem-mcp Stop >>>
[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "${hookCommand("hook-stop")}"
timeout = 5
# <<< remem-mcp Stop <<<

# >>> remem-mcp SessionEnd >>>
[[hooks.SessionEnd]]

[[hooks.SessionEnd.hooks]]
type = "command"
command = "${hookCommand("hook-session-end")}"
timeout = 10
# <<< remem-mcp SessionEnd <<<
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
  console.log("  UserPromptSubmit → heuristic recall: inject memory matching user prompt");
  console.log("  PreToolUse   → inject past errors before lint/build/test commands");
  console.log("  PostToolUse  → auto-capture failed commands as error memories");
  console.log("  PreCompact   → save checkpoint before compaction (Claude Code only)");
  console.log("  PostCompact  → re-inject memory after compaction (Claude Code)");
  console.log("  PostCompaction → re-inject memory after compaction (Devin CLI, Codex CLI)");
  console.log("  Stop         → auto-capture session transcript + remind to save");
  console.log("  SessionEnd   → silently capture session summary to memory DB");
  console.log("\nRestart your agent for hooks to take effect.");
  console.log("\nTo verify: run /hooks in your agent.");
}

/** Remove hooks from agent config files. */
export async function uninstallHooks(): Promise<void> {
  console.log("Removing lifecycle hooks...\n");

  let removed = 0;
  const rememEvents = [
    "SessionStart",
    "SessionEnd",
    "Stop",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "PostCompaction",
    "UserPromptSubmit",
  ];

  // Remove from Devin CLI
  const devinPath = join(homedir(), ".config", "devin", "config.json");
  if (existsSync(devinPath)) {
    const config = readJsonConfig(devinPath);
    if (config.hooks) {
      const hooks = config.hooks as Record<string, unknown[]>;
      for (const ev of rememEvents) {
        if (hooks[ev]) {
          // Filter out only remem-mcp hooks, preserve user hooks
          hooks[ev] = (hooks[ev] as { hooks?: { command?: string }[] }[]).filter((entry) => {
            const entryHooks = entry?.hooks;
            if (!entryHooks) return true;
            return !entryHooks.some((h) => h?.command?.includes("remem-mcp"));
          });
          if (Array.isArray(hooks[ev]) && hooks[ev].length === 0) {
            delete hooks[ev];
          }
        }
      }
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
      const hooks = config.hooks as Record<string, unknown[]>;
      for (const ev of rememEvents) {
        if (hooks[ev]) {
          hooks[ev] = (hooks[ev] as { hooks?: { command?: string }[] }[]).filter((entry) => {
            const entryHooks = entry?.hooks;
            if (!entryHooks) return true;
            return !entryHooks.some((h) => h?.command?.includes("remem-mcp"));
          });
          if (Array.isArray(hooks[ev]) && hooks[ev].length === 0) {
            delete hooks[ev];
          }
        }
      }
      if (Object.keys(hooks).length === 0) {
        delete config.hooks;
      }
      writeJsonConfig(claudePath, config);
      console.log(`  Claude Code: Hooks removed from ${claudePath}`);
      removed++;
    }
  }

  // Remove from Codex CLI (TOML config)
  const codexPath = join(homedir(), ".codex", "config.toml");
  if (existsSync(codexPath)) {
    let content = readFileSync(codexPath, "utf-8");
    const cleaned = removeCodexHooksFromToml(content);
    if (cleaned !== content) {
      content = cleaned;
      writeFileSync(codexPath, content.trimEnd() + "\n", "utf-8");
      console.log(`  Codex CLI: Hooks removed from ${codexPath}`);
      removed++;
    }
  }

  if (removed === 0) {
    console.log("No hooks found to remove.");
  } else {
    console.log(`\nHooks removed from ${removed} agent(s).`);
  }
}
