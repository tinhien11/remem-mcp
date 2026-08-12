import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Memory } from "./sdk.js";

/** Check if a JSON config file has the tdai-memory MCP server registered. */
function checkMcpConfig(name: string, path: string, key: string): { ok: boolean; detail: string } {
  if (!existsSync(path)) {
    return { ok: false, detail: `${name}: config not found at ${path}` };
  }
  try {
    const config = JSON.parse(readFileSync(path, "utf-8"));
    const servers = config[key] || {};
    if (servers["tdai-memory"] || servers["tdai-memory-mcp"]) {
      return { ok: true, detail: `${name}: MCP server registered` };
    }
    return { ok: false, detail: `${name}: MCP server NOT registered` };
  } catch {
    return { ok: false, detail: `${name}: config unreadable` };
  }
}

/** Check if a JSON config file has tdai-memory hooks. */
function checkHooksConfig(name: string, path: string): { ok: boolean; detail: string } {
  if (!existsSync(path)) {
    return { ok: false, detail: `${name}: config not found at ${path}` };
  }
  try {
    const config = JSON.parse(readFileSync(path, "utf-8"));
    const hooks = config.hooks || {};
    const hasTdai = (event: string) =>
      hooks[event]?.some((h: { hooks: { command: string }[] }) =>
        h.hooks?.some((hook: { command: string }) => hook.command?.includes("tdai-memory")),
      );
    const required = ["SessionStart", "Stop"];
    const optional = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionEnd"];
    const missing = required.filter((ev) => !hasTdai(ev));
    const presentOptional = optional.filter((ev) => hasTdai(ev));
    if (missing.length > 0) {
      return { ok: false, detail: `${name}: missing ${missing.join(", ")}` };
    }
    const optStr = presentOptional.length > 0 ? ` + ${presentOptional.join(", ")}` : "";
    return { ok: true, detail: `${name}: hooks wired (SessionStart + Stop${optStr})` };
  } catch {
    return { ok: false, detail: `${name}: config unreadable` };
  }
}

/** Check if the skill file is installed. */
function checkSkill(name: string, path: string): { ok: boolean; detail: string } {
  if (existsSync(path)) {
    return { ok: true, detail: `${name}: skill installed (optional)` };
  }
  return { ok: true, detail: `${name}: skill not installed (optional, run install-skill)` };
}

/** Run all diagnostic checks and print results. */
export async function doctor(): Promise<void> {
  console.log("tdai-memory-mcp doctor\n");
  console.log("Checking setup...\n");

  const checks: { ok: boolean; detail: string }[] = [];
  let pass = 0;
  let fail = 0;

  // 1. Binary
  let binPath = "";
  try {
    binPath = execFileSync("which", ["tdai-memory-mcp"], { encoding: "utf-8" }).trim();
    checks.push({ ok: true, detail: `Binary: ${binPath}` });
  } catch {
    checks.push({ ok: false, detail: "Binary: not in PATH (npx will be used)" });
  }

  // 2. MCP server configs
  checks.push(checkMcpConfig("Claude Code", join(homedir(), ".claude.json"), "mcpServers"));
  checks.push(
    checkMcpConfig(
      "Devin CLI",
      join(homedir(), ".config", "devin", "mcp_config.json"),
      "mcpServers",
    ),
  );

  const cursorConfig = join(homedir(), ".cursor", "mcp.json");
  if (existsSync(cursorConfig)) {
    checks.push(checkMcpConfig("Cursor", cursorConfig, "mcpServers"));
  }

  const codexConfig = join(homedir(), ".codex", "config.toml");
  if (existsSync(codexConfig)) {
    const content = readFileSync(codexConfig, "utf-8");
    if (content.includes("[mcp_servers.tdai-memory]")) {
      checks.push({ ok: true, detail: "Codex CLI: MCP server registered" });
    } else {
      checks.push({ ok: false, detail: "Codex CLI: MCP server NOT registered" });
    }
  }

  // 3. Hooks
  checks.push(checkHooksConfig("Claude Code", join(homedir(), ".claude", "settings.json")));
  checks.push(checkHooksConfig("Devin CLI", join(homedir(), ".config", "devin", "config.json")));

  if (existsSync(codexConfig)) {
    const content = readFileSync(codexConfig, "utf-8");
    if (content.includes("tdai-memory") && content.includes("hook-recall")) {
      checks.push({ ok: true, detail: "Codex CLI: hooks wired" });
    } else {
      checks.push({ ok: false, detail: "Codex CLI: hooks NOT wired" });
    }
  }

  // 4. Skill files (optional)
  checks.push(
    checkSkill("Claude Code", join(homedir(), ".claude", "skills", "tdai-memory", "SKILL.md")),
  );
  checks.push(
    checkSkill(
      "Devin CLI",
      join(homedir(), ".config", "devin", "skills", "tdai-memory", "SKILL.md"),
    ),
  );
  checks.push(
    checkSkill("Generic", join(homedir(), ".agents", "skills", "tdai-memory", "SKILL.md")),
  );

  // 5. Database
  const dbPath =
    process.env.TDAI_DB_PATH ?? join(homedir(), ".local", "share", "tdai-memory-mcp", "memory.db");
  if (existsSync(dbPath)) {
    try {
      const mem = new Memory({ dbPath });
      const results = await mem.recall("test");
      const count = results.length;
      await mem.close();
      checks.push({
        ok: true,
        detail: `Database: ${dbPath} (${count} captures found on test recall)`,
      });
    } catch (err) {
      checks.push({ ok: false, detail: `Database: ${dbPath} (recall failed: ${err})` });
    }
  } else {
    checks.push({ ok: false, detail: `Database: not found at ${dbPath}` });
  }

  // Print results
  for (const check of checks) {
    const icon = check.ok ? "OK" : "FAIL";
    console.log(`  [${icon}] ${check.detail}`);
    if (check.ok) pass++;
    else fail++;
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.log("\nRun `npx tdai-memory-mcp setup` to fix missing configs.");
  } else {
    console.log("\nAll checks passed. Your agent has memory.");
  }
}
