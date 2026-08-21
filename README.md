# remem-mcp

[![npm version](https://img.shields.io/npm/v/remem-mcp.svg)](https://www.npmjs.com/package/remem-mcp)
[![GitHub stars](https://img.shields.io/github/stars/tinhien11/remem-mcp.svg)](https://github.com/tinhien11/remem-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Benchmark](https://img.shields.io/badge/AMB-100%2F100%2F100-brightgreen)](https://github.com/tinhien11/remem-mcp)

> Your coding agent stops repeating the same mistakes.

Local memory that survives context compaction — learns from every error, injects fixes before the next attempt, and syncs to your git repo so your whole team shares it.

**One command setup. No API key. No cloud. No database server. Just a SQLite file.**

---

## Install

```bash
npx remem-mcp setup
```

Auto-detects Claude Code, Cursor, Devin, Codex. Registers MCP server + hooks. Restart your agent.

```bash
npx remem-mcp demo              # Live demo: real build, real errors, real hooks
npx remem-mcp demo-codegraph    # Live CodeGraph demo on facebook/react
npx remem-mcp status            # One dashboard: everything at a glance
```

---

## Quick start (after install)

**Nothing.** Just use your agent normally. Memory works automatically.

```
You: "fix the login bug in auth.go"
  → agent gets injected past errors + decisions about auth.go
  → agent calls codegraph_search("login") instead of grep
  → agent fixes it
  → Stop hook auto-captures what was done

Next session:
You: "add rate limiting to the API"
  → agent recalls the auth.go fix + your API patterns
  → no re-explaining needed
```

### Verify it's working

```bash
npx remem-mcp status
# → DB: 41559 captures, 516 atoms, 9 scenarios
# → Hooks: SessionStart ✓  UserPromptSubmit ✓  Stop ✓
# → CodeGraph: 301 symbols indexed

npx remem-mcp recent 5
# → last 5 captures (errors, decisions, patterns)

npx remem-mcp errors
# → error dashboard with fix suggestions
```

### What the agent sees

At the start of each turn, the agent gets injected memory (you'll see `[remem-mcp]` at the top):

```
[remem-mcp] Memory relevant to your prompt (BM25, shallow):
- (error [auth, jwt]) 2026-08-20: JWT verification fails on expired tokens
- (decision [auth, rate-limit]) 2026-08-19: Use Redis for rate limiting, not in-memory

[remem-mcp] Scenarios (L2 summaries):
- Auth system uses JWT + Redis rate limiting, deployed behind Nginx gateway

[remem-mcp] Persona (L3):
language: Vietnamese
output_style: concise
```

The agent uses this automatically. You don't need to call any tool.

---

## What it does

```
┌─────────────────────────────────────────────────┐
│                  AI Agent                         │
│         (Claude Code / Devin / Cursor)            │
└────────┬──────────────────────────┬──────────────┘
         │ MCP tools (15)           │ Hooks (auto)
         ▼                          ▼
┌──────────────────┐     ┌────────────────────┐
│  recall()        │     │  SessionStart      │──▶ inject L2/L3 + skills
│  capture()       │     │  UserPromptSubmit  │──▶ inject BM25 match
│  codegraph_*     │     │  Stop              │──▶ spawn worker
│  wiki_*          │     │  PostCompact       │──▶ save checkpoint
└────────┬─────────┘     └─────────┬──────────┘
         │                          │
         ▼                          ▼
┌─────────────────────────────────────────────────┐
│              SQLite (memory.db)                   │
│                                                   │
│  L0 captures ──▶ L1 atoms ──▶ L2 scenarios ──▶ L3 persona
│  (raw)          (facts)       (summaries)       (preferences)
│                                                   │
│  CodeGraph: symbols + calls + imports             │
│  Wiki: markdown docs + ADRs                       │
└───────────────────────────────────────────────────┘
```

### Memory pipeline (L0 → L3)

- **L0 captures** — raw content from agent sessions (errors, decisions, patterns)
- **L1 atoms** — distilled facts with confidence scores (agent writes or worker extracts)
- **L2 scenarios** — auto-consolidated summaries when 5+ atoms share a topic
- **L3 persona** — user preferences auto-detected from repeated tags (2+ occurrences)

All runs **without LLM API key** — rule-based extraction + keyword grouping.

### CodeGraph

Structural code indexing via tree-sitter (9 languages: TS/JS/Python/Go/Rust/Java/C/C++/C#).

- **6-strategy call resolution**: import-map (0.95) → same-module (0.90) → unique-name (0.75) → suffix (0.55) → fuzzy (0.35)
- **Call types**: direct (`foo()`), method (`obj.method()`), JSX (`<Component/>`)
- **Stdlib filter**: skips `fmt.Printf`, `console.log`, `print()` — reduces noise
- **Tools**: `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_detect_changes`

---

## Why it's different

| | remem-mcp | Mem0 | Claude MEMORY.md | Mneme |
|---|---|---|---|---|
| **Survives compaction** | Yes — PreCompact hook | Yes — cloud | No — 200-line cap | Yes — PreCompact hook |
| **Learns from errors** | Yes — auto-capture + inject | No | No | No |
| **Semantic search** | Hybrid BM25 + sqlite-vec | Vector only | No | Vector + graph |
| **CodeGraph** | Yes — 6-strategy call resolution | No | No | No |
| **Setup** | 1 command | API key + cloud | Built-in | Build from source |
| **API key** | No | Yes | No | No |
| **Cost** | Free | $19–249/mo | Free | Free |

---

## Per-agent install

<details>
<summary>Claude Code</summary>

```bash
claude mcp add remem-mcp --scope user -- npx -y remem-mcp
npx remem-mcp install-hooks
```
</details>

<details>
<summary>Cursor</summary>

[![Install in Cursor](https://img.shields.io/badge/Cursor-Install-blue)](cursor://anysphere.cursor-deeplink/mcp/install?name=remem-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInJlbWVtLW1jcCJdfQ==)

Or add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "remem-mcp": { "command": "npx", "args": ["-y", "remem-mcp"] }
  }
}
```
</details>

<details>
<summary>Devin CLI</summary>

```bash
devin mcp add remem-mcp --scope user -- npx -y remem-mcp
npx remem-mcp install-hooks
```
</details>

<details>
<summary>Codex CLI</summary>

Add to `~/.codex/config.toml`:
```toml
[mcp_servers.remem-mcp]
command = "npx"
args = ["-y", "remem-mcp"]
```
Then run `npx remem-mcp install-hooks`.
</details>

---

## Daily commands

```bash
npx remem-mcp status           # Everything at a glance
npx remem-mcp viewer           # Web UI at localhost:7331
npx remem-mcp errors           # Error dashboard
npx remem-mcp recent [N]       # Recent captures
npx remem-mcp search-code --query "parseTar"   # CodeGraph search
npx remem-mcp callers <id>     # Who calls this symbol?
npx remem-mcp impact <id>      # Blast radius analysis
npx remem-mcp help all         # Full list of 40+ subcommands
```

---

## Configuration

All settings have defaults. Config file is optional: `~/.config/remem-mcp/config.json`.

| Setting | Env var | Default |
|---|---|---|
| DB path | `REMEM_DB_PATH` | `~/.local/share/remem-mcp/memory.db` |
| Cross-project memory | `REMEM_GLOBAL_SESSION_KEY` | _(unset)_ |
| Suppress hook feedback | `REMEM_QUIET` | _(unset, set to `1`)_ |
| LLM API key (optional) | `REMEM_LLM_API_KEY` | _(unset)_ |

**Team sharing** — `npx remem-mcp sync-export` writes `.remem-mcp/memory-export.jsonl`. Commit it to git. Team members get the same memory on `git pull`.

---

## Benchmark

| Benchmark | remem-mcp | Mem0 | Without memory |
|---|---|---|---|
| **AMB** (L1/L2/L3) | **100/100/100** | — | — |
| **LoCoMo** (long conversation QA) | **95** | 92.5 | — |
| **PersonaMem** (personalization) | **100** | — | 48 |
| **LongMemEval** (ICLR 2025) | **96** | 94.4 | — |

```bash
bash scripts/bench-all.sh           # Full: AMB + LoCoMo + PersonaMem (~5 min)
bash scripts/bench-all.sh --quick   # AMB only (~2 min)
```

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full system diagrams, schema, and performance benchmarks.

## Credits

Core based on [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (MIT, Tencent 2026). CodeGraph call resolution adapted from Codebase-Memory (arXiv:2603.27277).

## License

MIT. See [LICENSE](./LICENSE).
