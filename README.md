# tdai-memory-mcp

[![npm version](https://img.shields.io/npm/v/tdai-memory-mcp.svg)](https://www.npmjs.com/package/tdai-memory-mcp)
[![GitHub stars](https://img.shields.io/github/stars/tinhien11/tdai-memory-mcp.svg)](https://github.com/tinhien11/tdai-memory-mcp)

> Your coding agent stops repeating the same mistakes.

Local memory that survives context compaction — learns from every error, injects fixes before the next attempt, and syncs to your git repo so your whole team shares it.

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
npx tdai-memory-mcp demo-codegraph  # Live CodeGraph demo on facebook/react
npx tdai-memory-mcp status   # One dashboard: everything at a glance
```

The demo creates a real TypeScript project, runs real `npm run build`, captures real TS2307 errors, and shows the full learning loop — capture → inject → fix → upvote → cross-project inheritance. No hardcoded strings.

---

## Why it's different

| | tdai-memory-mcp | Mem0 | Claude MEMORY.md | Mneme |
|---|---|---|---|---|
| **Survives compaction** | Yes — PreCompact hook saves checkpoint, re-injects after | Yes — cloud store | No — 200-line cap, silent truncation | Yes — PreCompact hook |
| **Learns from errors** | Yes — auto-captures, injects fixes | No | No | No |
| **Semantic search** | Hybrid BM25 + sqlite-vec | Vector only | No — LLM filename picker, max 5 files | Vector + graph |
| **Setup** | 1 command | API key + cloud | Built-in | Build from source (Rust) |
| **Data location** | Local SQLite | Cloud | Local markdown | Local SQLite |
| **Team sharing** | Git-native (commit, diff, merge) | Cloud sync | Copy-paste | Manual |
| **API key** | No | Yes | No | No |
| **Cost** | Free | $19–249/mo | Free | Free |

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

## How it works

Memory lives in a local SQLite database — outside the agent's context window. When the agent compacts or starts a new session, memory is re-injected automatically. No more re-explaining what you already told it yesterday.

**PreCompact hook**: when the agent is about to compact context, tdai-memory saves a checkpoint (decisions made, approaches tried, what's verified working) to the DB. After compaction, the agent recalls it — so the compact doesn't destroy your session's learnings.

Two layers: **automatic** (runs via hooks, zero tool calls) and **on-demand** (you call when you need deeper context).

### Automatic — three learning loops + compaction survival

All run via lifecycle hooks. The agent doesn't need to call any tool.

1. **Error learning** — command fails → capture → inject fix before next attempt → succeed → upvote.

2. **Decision learning** — `npm install`, `git commit`, config → auto-capture → inject past decisions before similar commands.

3. **Pattern learning** — Write/Edit → auto-capture code patterns → inject same-language patterns before editing.

4. **Compaction survival** — PreCompact hook fires before context compaction → saves checkpoint → agent recalls after compact. Memory survives.

### On-demand — CodeGraph, Wiki, Search

When the automatic loops aren't enough, use these for deeper code navigation.

```bash
# 1. Index your codebase (one-time, rerun after major changes)
npx tdai-memory-mcp index --path src --repo .

# 2. Search symbols (auto-scoped to current directory)
npx tdai-memory-mcp search-code --query "parseTar"
# → parseTar  at  src/parse.ts:22

# 3. List symbols in a file
npx tdai-memory-mcp list-code src/reporters/fancy.ts
# → Class    L49-135  FancyReporter
# → Method   L86-134  formatLogObj

# 4. Trace callers / callees / impact (use symbol ID from step 2)
npx tdai-memory-mcp callers 01KZXPPHF93TS4HV8FWCSSK36A
npx tdai-memory-mcp impact  01KZXPPHF93TS4HV8FWCSSK36A

# Wiki + viewer
npx tdai-memory-mcp wiki ingest --path docs      # Index markdown docs + ADRs
npx tdai-memory-mcp wiki outdated                 # Find outdated wiki pages
npx tdai-memory-mcp viewer                        # Web UI at localhost:7331
```

- **CodeGraph** — symbol search, callers/callees, impact analysis. Auto-scoped to your project — no cross-project contamination.
- **Wiki** — markdown docs, ADRs, outdated detection.
- **Search** — hybrid BM25 + sqlite-vec vector search with RRF fusion. `explain_recall` shows scores.

![CodeGraph demo](https://raw.githubusercontent.com/tinhien11/tdai-memory-mcp/main/docs/screenshots/demo-codegraph.gif)

---

## Daily commands

```bash
npx tdai-memory-mcp status           # Everything at a glance
npx tdai-memory-mcp viewer           # Web UI at localhost:7331
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
| Suppress hook feedback | `TDAI_QUIET` | _(unset, set to `1`)_ |
| Retro window (days) | `TDAI_RETRO_DAYS` | `7` |
| Core-only mode (disable advanced tools) | `TDAI_CORE_ONLY` | _(unset, set to `1`)_ |
| LLM API key (pipeline) | `TDAI_LLM_API_KEY` | _(unset)_ |

**Team sharing** — `npx tdai-memory-mcp sync-export` writes `.tdai-memory/memory-export.jsonl`. Commit it to git. Team members get the same memory on `git pull` (auto-imports on startup).

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
