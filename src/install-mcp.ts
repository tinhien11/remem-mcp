import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Register the remem-mcp MCP server in agent config files.
 *
 * Config locations:
 * - Claude Code: ~/.claude.json → mcpServers.remem-mcp
 * - Devin CLI:   ~/.config/devin/mcp_config.json → mcpServers.remem-mcp
 * - Cursor:      ~/.cursor/mcp.json → mcpServers.remem-mcp
 * - Codex CLI:   ~/.codex/config.toml → [mcp_servers.remem-mcp] (TOML, skip if no parser)
 */

const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["-y", "remem-mcp"],
};

const MCP_SERVER_ENTRY_WITH_GLOBAL = {
  command: "npx",
  args: ["-y", "remem-mcp"],
  env: {
    REMEM_GLOBAL_SESSION_KEY: "global",
  },
};

interface JsonTarget {
  name: string;
  path: string;
  key: string;
  useGlobal?: boolean;
}

const JSON_TARGETS: JsonTarget[] = [
  {
    name: "Claude Code",
    path: join(homedir(), ".claude.json"),
    key: "mcpServers",
  },
  {
    name: "Devin CLI",
    path: join(homedir(), ".config", "devin", "mcp_config.json"),
    key: "mcpServers",
    useGlobal: true,
  },
  {
    name: "Cursor",
    path: join(homedir(), ".cursor", "mcp.json"),
    key: "mcpServers",
  },
];

/** Register MCP server in a JSON config file. */
function registerJsonServer(target: JsonTarget): boolean {
  let config: Record<string, unknown> = {};

  if (existsSync(target.path)) {
    try {
      config = JSON.parse(readFileSync(target.path, "utf-8"));
    } catch {
      // Corrupt config — don't touch it
      console.log(`  ${target.name}: Config file unreadable, skipping.`);
      return false;
    }
  }

  const servers = (config[target.key] as Record<string, unknown>) || {};
  const entry = target.useGlobal ? MCP_SERVER_ENTRY_WITH_GLOBAL : MCP_SERVER_ENTRY;

  if (JSON.stringify(servers["remem-mcp"]) === JSON.stringify(entry)) {
    console.log(`  ${target.name}: Already registered.`);
    return true;
  }

  servers["remem-mcp"] = entry;
  config[target.key] = servers;

  const dir = dirname(target.path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(target.path, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`  ${target.name}: MCP server registered.`);
  return true;
}

/** Register the MCP server in all supported agent configs. */
export async function installMcpServer(): Promise<void> {
  console.log("\nRegistering MCP server...\n");

  let count = 0;
  for (const target of JSON_TARGETS) {
    // Only register if the config file already exists (agent is installed)
    // or the agent's directory exists.
    // Special case: Cursor stores config in ~/.cursor/mcp.json — create it
    // if the Cursor app directory exists but mcp.json doesn't.
    const agentDir = dirname(target.path);
    if (!existsSync(agentDir)) {
      // Check if Cursor app is installed (macOS)
      if (target.name === "Cursor") {
        const cursorApp = "/Applications/Cursor.app";
        const cursorAppHome = join(homedir(), "Library", "Application Support", "Cursor");
        if (existsSync(cursorApp) || existsSync(cursorAppHome)) {
          // Cursor is installed — create the config directory and file
          mkdirSync(agentDir, { recursive: true });
        } else {
          continue;
        }
      } else {
        continue;
      }
    }

    if (registerJsonServer(target)) {
      count++;
    }
  }

  // Codex uses TOML — check if config exists and append if missing
  const codexConfig = join(homedir(), ".codex", "config.toml");
  if (existsSync(codexConfig)) {
    const content = readFileSync(codexConfig, "utf-8");
    if (content.includes("[mcp_servers.remem-mcp]")) {
      console.log("  Codex CLI: Already registered.");
      count++;
    } else {
      const tomlEntry = `
[mcp_servers.remem-mcp]
command = "npx"
args = ["-y", "remem-mcp"]

[mcp_servers.remem-mcp.env]
REMEM_GLOBAL_SESSION_KEY = "global"
`;
      writeFileSync(codexConfig, content + tomlEntry, "utf-8");
      console.log("  Codex CLI: MCP server registered.");
      count++;
    }
  }

  if (count === 0) {
    console.log("  No agent config files found. MCP server will need manual setup.");
    console.log("  See README for manual config instructions.");
  } else {
    console.log(`\nMCP server registered in ${count} agent config(s).`);
  }
}
