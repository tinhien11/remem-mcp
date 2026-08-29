# remem-mcp

[![npm version](https://img.shields.io/npm/v/remem-mcp.svg)](https://www.npmjs.com/package/remem-mcp)
[![GitHub stars](https://img.shields.io/github/stars/tinhien11/remem-mcp.svg)](https://github.com/tinhien11/remem-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Benchmark](https://img.shields.io/badge/AMB-100%2F100%2F100-brightgreen)](https://github.com/tinhien11/remem-mcp)

> Your coding agent stops repeating the same mistakes.

Local-first memory that survives context compaction. Learns from every error, injects fixes before the next attempt, and syncs to your git repo so your whole team shares it.

**No API key. No cloud. No database server. Just a SQLite file.**

---

## Install

```bash
npx remem-mcp setup
```

Auto-detects Claude Code, Cursor, Devin, Codex. Registers MCP server + hooks. Restart your agent.

That's it. Use your agent normally — memory works automatically.

```bash
npx remem-mcp status    # verify: hooks ✓, DB ✓, CodeGraph ✓
```

---

## What happens automatically

| When | What |
|---|---|
| Session start | Past errors, decisions, and persona injected into agent context |
| Each prompt | Matching memory injected (you'll see `[remem-mcp]` at the top) |
| Tool calls | Verbose output offloaded to refs, Mermaid canvas injected (92% token cut) |
| Session end | Worker auto-extracts facts, consolidates summaries, updates persona |

You don't run any commands. The agent calls `recall()` before answering and `capture()` after work — the skill tells it to.

---

## How it works

```
AI Agent (Claude Code / Devin / Cursor / Codex)
    │
    ├── MCP tools ──▶ recall, capture, codegraph_*, wiki_*, feedback
    │
    └── Hooks ──▶ SessionStart, UserPromptSubmit, PreToolUse,
                  PostToolUse, Stop, PostCompact
                        │
                        ▼
              SQLite (memory.db)

  L0 captures → L1 atoms → L2 scenarios → L3 persona
  (raw)        (facts)      (summaries)    (preferences)

  CodeGraph: symbols + calls + imports (tree-sitter, 9 languages)
  Memory links: Hebbian co-retrieval (frequently co-retrieved = stronger)
```

**No LLM API key needed** — rule-based extraction + keyword grouping.

---

## CodeGraph

Structural code indexing via tree-sitter. The agent uses `codegraph_search` instead of grep to find symbols.

```bash
npx remem-mcp index --path src              # index a directory
npx remem-mcp search-code --query "parseTar"  # find symbols
npx remem-mcp callers <id>                  # who calls this?
npx remem-mcp impact <id>                   # blast radius
```

9 languages: TS/JS/Python/Go/Rust/Java/C/C++/C#. 6-strategy call resolution (import-map → same-module → unique-name → suffix → fuzzy). Stdlib calls filtered out.

| Repo | Files | Symbols | Calls | Time |
|---|---|---|---|---|
| remem-mcp | 79 | 301 | 6,456 | 3s |
| AZR Go | 455 | 3,417 | 41,603 | 111s |
| Orca TS | 3,000 | 7,632 | 78,981 | 705s |

---

## Why it's different

| | remem-mcp | Mem0 | Claude MEMORY.md | Mneme |
|---|---|---|---|---|
| **Survives compaction** | Yes | Yes — cloud | No — 200-line cap | Yes |
| **Learns from errors** | Yes — auto | No | No | No |
| **Search** | Hybrid BM25 + vector + entities | Vector only | No | Vector + graph |
| **Memory links** | Hebbian co-retrieval | No | No | Graph |
| **Decay/forget** | Yes | No | No | No |
| **CodeGraph** | Yes — 6-strategy call resolution | No | No | No |
| **Token offload** | Yes — Mermaid canvas | No | No | No |
| **Setup** | 1 command | API key + cloud | Built-in | Build from source |
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

## Useful commands

```bash
npx remem-mcp status           # health + hooks + DB + CodeGraph
npx remem-mcp viewer           # web UI at localhost:7331
npx remem-mcp errors           # error dashboard
npx remem-mcp recent [N]       # recent captures
npx remem-mcp help all         # full list of 40+ subcommands
```

---

## Configuration

All settings have defaults. Config file is optional: `~/.config/remem-mcp/config.json`.

| Setting | Env var | Default |
|---|---|---|
| DB path | `REMEM_DB_PATH` | `~/.local/share/remem-mcp/memory.db` |
| Cross-project memory | `REMEM_GLOBAL_SESSION_KEY` | _(unset)_ |
| Unified flow (F1+F2+F3) | `REMEM_FLOW` | _(unset, set to `full`)_ |
| Suppress hook feedback | `REMEM_QUIET` | _(unset, set to `1`)_ |

**Global memory policy** — set `REMEM_GLOBAL_SESSION_KEY` to *read* cross-project memory automatically. Captures stay project-local unless the user explicitly asks to save globally; then use `session_key: "global"`. Do not auto-classify ordinary captures into global.

**Team sharing** — `npx remem-mcp sync-export` writes `.remem-mcp/memory-export.jsonl`. Commit it to git. Team members get the same memory on `git pull`.

**Per-repo capture exclusions** — Drop a `.remem.toml` in any project root:
```toml
[capture]
ignore_paths = ["node_modules", "dist", ".git", "*.min.js"]
```

---

## Benchmark

| Benchmark | remem-mcp | Mem0 | Without memory |
|---|---|---|---|
| **AMB** (L1/L2/L3) | **100/100/100** | — | — |
| **LoCoMo** (long conversation QA) | **95** | 92.5 | — |
| **PersonaMem** (personalization) | **100** | — | 48 |
| **LongMemEval** (ICLR 2025) | **96** | 94.4 | — |

```bash
bash scripts/bench-all.sh --quick   # AMB only (~2 min)
```

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full system diagrams, schema, and performance details.

## Credits

Core based on [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (MIT, Tencent 2026). CodeGraph call resolution adapted from Codebase-Memory (arXiv:2603.27277). Recall boost adapted from [ai-memory](https://github.com/akitaonrails/ai-memory) by Akita On Rails. Contextual retrieval from [Anthropic](https://www.anthropic.com/news/contextual-retrieval) (2024).

## License

MIT. See [LICENSE](./LICENSE).
