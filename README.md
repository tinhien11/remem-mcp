# tdai-memory-mcp

[![npm version](https://img.shields.io/npm/v/tdai-memory-mcp.svg)](https://www.npmjs.com/package/tdai-memory-mcp)
[![GitHub stars](https://img.shields.io/github/stars/tinhien11/tdai-memory-mcp.svg)](https://github.com/tinhien11/tdai-memory-mcp)

> Your coding agent stops repeating the same mistakes.

Local memory that learns from every error — and syncs to your git repo so your whole team shares it.

<video src="https://raw.githubusercontent.com/tinhien11/tdai-memory-mcp/main/docs/screenshots/demo-learning-loop.mp4" controls muted width="100%"></video>

![Demo (GIF)](https://raw.githubusercontent.com/tinhien11/tdai-memory-mcp/main/docs/screenshots/demo-learning-loop.gif)

---

## Install

```bash
npx tdai-memory-mcp setup
```

That's it. Auto-detects Claude Code, Cursor, Devin, Codex. Registers MCP server + hooks. Restart your agent.

```bash
npx tdai-memory-mcp demo     # Live demo: real build, real errors, real hooks
npx tdai-memory-mcp status   # One dashboard: everything at a glance
```

The demo creates a real TypeScript project, runs real `npm run build`, captures real TS2307 errors, and shows the full learning loop — capture → inject → fix → upvote → cross-project inheritance. No hardcoded strings.

---

## What it does

**Without tdai-memory:**
```
Day 1: agent errors "Cannot find module './missing'"
Day 2: agent errors "Cannot find module './missing'"  (again)
Day 3: agent errors "Cannot find module './missing'"  (again)
```

**With tdai-memory:**
```
Day 1: agent errors "Cannot find module './missing'"  → auto-captured
Day 2: agent runs same command → tdai-memory injects: "this failed before, fix was X"
Day 3: agent runs same command → gets it right the first time
```

The memory builds up automatically as your agent works. No manual saving.

---

## Why it's different

| | tdai-memory-mcp | Mem0 | Claude MEMORY.md |
|---|---|---|---|
| **Learns from errors** | Yes — auto-captures, injects fixes | No | No |
| **Setup** | 1 command | API key + cloud | Built-in |
| **Data location** | Local SQLite | Cloud | Local markdown |
| **Team sharing** | Git-native (commit, diff, merge) | Cloud sync | Copy-paste |
| **API key** | No | Yes | No |
| **Cost** | Free | $19–249/mo | Free |

---

## Per-agent install

<details>
<summary>Claude Code</summary>

```bash
claude mcp add tdai-memory --scope user -- npx -y tdai-memory-mcp
npx tdai-memory-mcp install-hooks
```
</details>

<details>
<summary>Cursor</summary>

[![Install in Cursor](https://img.shields.io/badge/Cursor-Install-blue)](cursor://anysphere.cursor-deeplink/mcp/install?name=tdai-memory&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInRkYWktbWVtb3J5LW1jcCJdfQ==)

Or add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "tdai-memory": { "command": "npx", "args": ["-y", "tdai-memory-mcp"] }
  }
}
```
</details>

<details>
<summary>Devin CLI</summary>

```bash
devin mcp add tdai-memory --scope user -- npx -y tdai-memory-mcp
npx tdai-memory-mcp install-hooks
```
</details>

<details>
<summary>Codex CLI</summary>

Add to `~/.codex/config.toml`:
```toml
[mcp_servers.tdai-memory]
command = "npx"
args = ["-y", "tdai-memory-mcp"]

[mcp_servers.tdai-memory.env]
TDAI_GLOBAL_SESSION_KEY = "global"
```

Then run `npx tdai-memory-mcp install-hooks`.
> MCP tools require `sandbox_mode = "danger-full-access"`.
</details>

---

## Team memory (git-native)

```bash
npx tdai-memory-mcp sync-export    # Export to .tdai-memory/ in project root
```

Commit `.tdai-memory/memory-export.jsonl` to git. Your team gets the same error fixes, decisions, and patterns — no cloud, no sync conflicts, just `git pull`.

```bash
npx tdai-memory-mcp sync-import    # Import on startup (auto-runs)
```

---

## How it works

Three learning loops, all automatic:

1. **Error learning** — command fails → capture → inject fix next time → succeed → upvote. 41 features: severity, escalation, lineage, drift detection, cross-project inheritance, confidence decay.

2. **Decision learning** — `npm install`, `git commit`, config → auto-capture → inject past decisions before similar commands. Tracks follow rate, drift, conflicts.

3. **Pattern learning** — Write/Edit → auto-capture code patterns → inject same-language patterns before editing. Tracks adoption, drift, template extraction.

All three run via lifecycle hooks. The agent doesn't need to call any tool.

---

## Daily commands

```bash
npx tdai-memory-mcp status           # Everything at a glance
npx tdai-memory-mcp errors           # Error dashboard
npx tdai-memory-mcp decisions        # Decision dashboard
npx tdai-memory-mcp patterns         # Pattern dashboard
npx tdai-memory-mcp recent [N]       # Recent captures
npx tdai-memory-mcp help all         # Full list of 40+ subcommands
```

---

## Configuration

All settings have defaults. Config file is optional: `~/.config/tdai-memory-mcp/config.json`.

| Setting | Env var | Default |
|---|---|---|
| DB path | `TDAI_DB_PATH` | `~/.local/share/tdai-memory-mcp/memory.db` |
| Cross-project memory | `TDAI_GLOBAL_SESSION_KEY` | _(unset)_ |
| Cross-project errors | `TDAI_GLOBAL_ERRORS` | _(unset, set to `1`)_ |
| Retro window (days) | `TDAI_RETRO_DAYS` | `7` |
| Advanced tools (CodeGraph, Wiki) | `TDAI_ENABLE_ADVANCED` | _(unset, set to `1`)_ |
| LLM API key (pipeline) | `TDAI_LLM_API_KEY` | _(unset)_ |

---

## TypeScript SDK

```ts
import { Memory } from "tdai-memory-mcp";

const memory = new Memory();
await memory.capture("We chose SQLite for storage.", "decision", ["arch"]);
const results = await memory.recall("storage decision");
```

---

## Credits

Core based on [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (MIT, Tencent 2026). Replaces the cloud backend with embedded SQLite + sqlite-vec + FTS5. Adds error/decision/pattern learning loops and lifecycle hooks.

## License

MIT. See [LICENSE](./LICENSE).
