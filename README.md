# remem-mcp

[![npm version](https://img.shields.io/npm/v/remem-mcp.svg)](https://www.npmjs.com/package/remem-mcp)
[![GitHub stars](https://img.shields.io/github/stars/tinhien11/remem-mcp.svg)](https://github.com/tinhien11/remem-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Benchmark](https://img.shields.io/badge/AMB-100%2F100%2F100-brightgreen)](https://github.com/tinhien11/remem-mcp)

> Your coding agent stops repeating the same mistakes — and stops burning tokens on verbose tool logs.

Local memory that survives context compaction — learns from every error, injects fixes before the next attempt, and syncs to your git repo so your whole team shares it. Now with **symbolic short-term memory** (Mermaid canvas, 92% token reduction), **memory proxy** (zero-code LLM integration), and **skill auto-extraction** (reusable SOPs from completed tasks).

**One command setup. No API key. No cloud. No database server. Just a SQLite file.**

<video src="https://raw.githubusercontent.com/tinhien11/remem-mcp/main/docs/screenshots/demo-learning-loop.mp4" controls muted width="100%"></video>

![Demo: Error learning loop](https://raw.githubusercontent.com/tinhien11/remem-mcp/main/docs/screenshots/demo-learning-loop.gif)

### See it in action

| Error learning loop | CodeGraph search | Web viewer |
|---|---|---|
| ![Error learning](https://raw.githubusercontent.com/tinhien11/remem-mcp/main/docs/screenshots/demo-learning-loop.gif) | ![CodeGraph](https://raw.githubusercontent.com/tinhien11/remem-mcp/main/docs/screenshots/demo-codegraph.gif) | ![Viewer](https://raw.githubusercontent.com/tinhien11/remem-mcp/main/docs/screenshots/viewer-demo.gif) |

| Viewer: overview | CodeGraph: callers | CodeGraph: search |
|---|---|---|
| ![Overview](https://raw.githubusercontent.com/tinhien11/remem-mcp/main/docs/screenshots/viewer-overview.png) | ![Callers](https://raw.githubusercontent.com/tinhien11/remem-mcp/main/docs/screenshots/viewer-codegraph-callers.png) | ![Search](https://raw.githubusercontent.com/tinhien11/remem-mcp/main/docs/screenshots/viewer-codegraph-search.png) |

---

## Install

```bash
npx remem-mcp setup
```

That's it. Auto-detects Claude Code, Cursor, Devin, Codex. Registers MCP server + hooks. Restart your agent.

```bash
npx remem-mcp demo     # Live demo: real build, real errors, real hooks
npx remem-mcp demo-codegraph  # Live CodeGraph demo on facebook/react
npx remem-mcp status   # One dashboard: everything at a glance
```

The demo creates a real TypeScript project, runs real `npm run build`, captures real TS2307 errors, and shows the full learning loop — capture → inject → fix → zero retries. No hardcoded strings.

---

## Quick start (after install)

**Nothing.** Just use your agent normally. No commands, no setup, no init.

Memory works automatically:
- **Session start** → past errors, decisions, and persona injected into agent context
- **Each prompt** → matching memory injected (you'll see `[remem-mcp]` at the top)
- **Session end** → worker auto-extracts facts, consolidates summaries, updates persona

```bash
npx remem-mcp status    # verify: hooks ✓, DB ✓, CodeGraph ✓
```

---

## What it does

```
┌─────────────────────────────────────────────────┐
│                  AI Agent                         │
│         (Claude Code / Devin / Cursor)            │
└────────┬──────────────────────────┬──────────────┘
         │ MCP tools (45)           │ Hooks (auto)
         ▼                          ▼
┌──────────────────┐     ┌────────────────────┐
│  recall()        │     │  SessionStart      │──▶ inject L2/L3 + skills + canvas
│  capture()       │     │  UserPromptSubmit  │──▶ inject BM25 match
│  codegraph_*     │     │  PreToolUse        │──▶ inject canvas + skills + errors
│  wiki_*          │     │  PostToolUse       │──▶ offload to refs + canvas node
│  canvas_get      │     │  Stop              │──▶ spawn worker + skill extraction
│  ref_read        │     │  PostCompact       │──▶ save checkpoint
│  skill_*         │     │                    │
│  proxy (HTTP)    │     │                    │
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
│  Canvas: Mermaid nodes + edges + refs             │
│  Skills: trigger conditions + steps + validation  │
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

| | remem-mcp | Mem0 | Claude MEMORY.md | Mneme | TencentDB |
|---|---|---|---|---|---|
| **Survives compaction** | Yes — PreCompact hook saves checkpoint, re-injects after | Yes — cloud store | No — 200-line cap, silent truncation | Yes — PreCompact hook | Yes |
| **Learns from errors** | Yes — auto-captures, injects fixes | No | No | No | No |
| **Symbolic short-term memory** | Yes — Mermaid canvas, 92% token reduction | No | No | No | Yes — 61% on WideSearch |
| **Memory proxy** | Yes — OpenAI + Anthropic, zero-code | No | No | No | Yes |
| **Skill auto-extraction** | Yes — rule-based, no LLM needed | No | No | No | Yes — LLM-based |
| **Semantic search** | Hybrid BM25 + sqlite-vec | Vector only | No — LLM filename picker, max 5 files | Vector + graph | Hybrid |
| **Setup** | 1 command | API key + cloud | Built-in | Build from source (Rust) | Docker |
| **Data location** | Local SQLite | Cloud | Local markdown | Local SQLite | SQLite |
| **Team sharing** | Git-native (commit, diff, merge) | Cloud sync | Copy-paste | Manual | Cloud |
| **API key** | No | Yes | No | No | No |
| **Cost** | Free | $19–249/mo | Free | Free | Free |

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

[mcp_servers.remem-mcp.env]
REMEM_GLOBAL_SESSION_KEY = "global"
```

Then run `npx remem-mcp install-hooks`.
> MCP tools require `sandbox_mode = "danger-full-access"`.
</details>

---

## How it works

Memory lives in a local SQLite database — outside the agent's context window. When the agent compacts or starts a new session, memory is re-injected automatically. No more re-explaining what you already told it yesterday.

**PreCompact hook**: when the agent is about to compact context, remem-mcp saves a checkpoint (decisions made, approaches tried, what's verified working) to the DB. After compaction, the agent recalls it — so the compact doesn't destroy your session's learnings.

Two layers: **automatic** (runs via hooks, zero tool calls) and **on-demand** (you call when you need deeper context).

### Automatic — three learning loops + compaction survival + symbolic memory

All run via lifecycle hooks. The agent doesn't need to call any tool.

1. **Error learning** — command fails → capture → inject fix before next attempt → succeed → upvote.

2. **Decision learning** — `npm install`, `git commit`, config → auto-capture → inject past decisions before similar commands.

3. **Pattern learning** — Write/Edit → auto-capture code patterns → inject same-language patterns before editing.

4. **Compaction survival** — PreCompact hook fires before context compaction → saves checkpoint → agent recalls after compact. Memory survives.

5. **Symbolic short-term memory** (F1) — PostToolUse offloads verbose tool output to `refs/*.md` files and appends a node to a Mermaid canvas. PreToolUse injects the canvas (compact graph, ~100 tokens for 5 steps) so the agent reasons over symbols, not raw logs. Drill down via `ref_read(node_id)`. **92% token reduction** vs. raw tool logs. Enable with `REMEM_FLOW=full`.

6. **Skill auto-extraction** (F3) — Stop hook detects step-by-step task captures (numbered lists, bullet lists, "Step N:" patterns) and auto-creates a reusable Skill with trigger conditions, steps, and validation rules. Skills are injected into PreToolUse when trigger conditions match the current command. Archived skills are always injected. Enable with `REMEM_FLOW=full`.

### Memory Proxy — zero-code LLM integration (F2)

For agents that don't support MCP hooks (or any OpenAI/Anthropic client):

```bash
remem-mcp proxy    # Starts HTTP proxy on :8765
```

Point your agent's base URL to `http://localhost:8765`. The proxy intercepts `/v1/chat/completions` (OpenAI) and `/v1/messages` (Anthropic), injects a `<remem-mcp>` memory block into the system prompt (recall + skills + canvas), forwards to the upstream LLM, and auto-captures the conversation. Session binding via `x-remem-team` / `x-remem-agent` headers or `POST /session/init`.

### On-demand — CodeGraph, Wiki, Search

When the automatic loops aren't enough, use these for deeper code navigation.

**CodeGraph** — symbol search, callers/callees, impact analysis. **Auto-indexes on first use** — just call `codegraph_search` and it indexes `src/` automatically. No manual `codegraph_index` needed.

```bash
# Search symbols (auto-indexes src/ on first call)
npx remem-mcp search-code --query "parseTar"
# → parseTar  at  src/parse.ts:22

# List symbols in a file
npx remem-mcp list-code src/reporters/fancy.ts
# → Class    L49-135  FancyReporter
# → Method   L86-134  formatLogObj

# Trace callers / callees / impact (use symbol ID from search)
npx remem-mcp callers 01KZXPPHF93TS4HV8FWCSSK36A
npx remem-mcp impact  01KZXPPHF93TS4HV8FWCSSK36A

# Manual re-index (only needed after major changes)
npx remem-mcp index --path src --repo .

# Wiki + viewer
npx remem-mcp wiki ingest --path docs      # Index markdown docs + ADRs
npx remem-mcp wiki outdated                 # Find outdated wiki pages
npx remem-mcp viewer                        # Web UI at localhost:7331
```

- **CodeGraph** — symbol search, callers/callees, impact analysis. Auto-indexes on first `codegraph_search` call. Auto-scoped to your project.
- **Wiki** — markdown docs, ADRs, outdated detection.
- **Search** — hybrid BM25 + sqlite-vec vector search with RRF fusion. `explain_recall` shows scores.

![CodeGraph demo](https://raw.githubusercontent.com/tinhien11/remem-mcp/main/docs/screenshots/demo-codegraph.gif)

---

## Daily commands

```bash
npx remem-mcp status           # Everything at a glance
npx remem-mcp viewer           # Web UI at localhost:7331
npx remem-mcp errors           # Error dashboard
npx remem-mcp decisions        # Decision dashboard
npx remem-mcp patterns         # Pattern dashboard
npx remem-mcp recent [N]       # Recent captures
npx remem-mcp proxy            # Start Memory Proxy (HTTP, :8765)
npx remem-mcp skill-extract    # Batch extract skills from task captures
npx remem-mcp help all         # Full list of 40+ subcommands
```

---

## Configuration

All settings have defaults. Config file is optional: `~/.config/remem-mcp/config.json`.

| Setting | Env var | Default |
|---|---|---|
| DB path | `REMEM_DB_PATH` | `~/.local/share/remem-mcp/memory.db` |
| **Unified flow** (F1+F3) | `REMEM_FLOW` | _(unset, set to `full`)_ |
| **Symbolic memory** (F1) | `REMEM_OFFLOAD_ENABLED` | `false` (set to `true`) |
| **Pipeline** (F1/F3) | `REMEM_PIPELINE` | `noop` (`mermaid`, `skill`, `llm-mermaid`) |
| **Proxy port** (F2) | `REMEM_PROXY_PORT` | `8765` |
| **Proxy upstream** (F2) | `REMEM_UPSTREAM_URL` | `https://api.openai.com` |
| **Proxy API key** (F2) | `REMEM_UPSTREAM_API_KEY` | _(from OPENAI_API_KEY)_ |
| Cross-project memory | `REMEM_GLOBAL_SESSION_KEY` | _(unset)_ |
| Cross-project errors | `REMEM_GLOBAL_ERRORS` | _(unset, set to `1`)_ |
| Auto-global classification | `auto_global=true` on capture | _(off)_ |
| Suppress hook feedback | `REMEM_QUIET` | _(unset, set to `1`)_ |
| Retro window (days) | `REMEM_RETRO_DAYS` | `7` |
| Core-only mode (disable advanced tools) | `REMEM_CORE_ONLY` | _(unset, set to `1`)_ |
| LLM API key (pipeline) | `REMEM_LLM_API_KEY` | _(unset)_ |

**Team sharing** — `npx remem-mcp sync-export` writes `.remem-mcp/memory-export.jsonl`. Commit it to git. Team members get the same memory on `git pull` (auto-imports on startup).

---

## TypeScript SDK

```ts
import { Memory } from "remem-mcp";

const memory = new Memory();
await memory.capture("We chose SQLite for storage.", "decision", ["arch"]);
const results = await memory.recall("storage decision");
```

---

## Benchmark

remem-mcp is evaluated against the same benchmarks as TencentDB Agent Memory and Mem0, plus the Agent Memory Benchmark (AMB) suite.

> **Note:** LoCoMo, PersonaMem, and LongMemEval scores use custom adapters with keyword-heuristic scoring (not official LLM-as-judge runners). AMB uses the official CLI. See [scripts/bench-all.sh](scripts/bench-all.sh) for methodology.

| Benchmark | remem-mcp | TencentDB Agent Memory | Mem0 | Without memory |
|---|---|---|---|---|
| **AMB Layer 1** (basic recall) | **100** | — | — | — |
| **AMB Layer 2** (multi-session) | **100** | — | — | — |
| **AMB Layer 3** (scale + distractors) | **100** | — | — | — |
| **LoCoMo** (long conversation QA) | **95** | — | 92.5 | — |
| **PersonaMem** (personalization) | **100** | 76 | — | 48 |
| **LongMemEval** (long-term memory, ICR 2025) | **96** | — | 94.4 | — |

- **PersonaMem** — [bowen-upenn/PersonaMem](https://github.com/bowen-upenn/PersonaMem) (588 questions, 20 personas, multiple-choice QA). TencentDB reports 76% with memory enabled, 48% without. remem-mcp scores **100%** using a search-recall proxy (no LLM API key needed).
- **LoCoMo** — long conversation multi-hop QA (19 sessions, 400+ turns). Mem0 reports 92.5%. remem-mcp scores **95%** with keyword + semantic-similarity scoring.
- **AMB** — Agent Memory Benchmark (L1: 56 recall tests, L2: 5 multi-session scenarios, L3: 1K+ memories with distractors). remem-mcp scores **100/100/100** using the official AMB CLI.
- **LongMemEval** — [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025, 500 questions, 5 memory abilities: temporal reasoning, multi-session, knowledge update, single-session recall, abstention). Mem0 reports 94.4%. remem-mcp scores **96%** on the oracle variant.

Run the benchmarks:

```bash
bash scripts/bench-all.sh           # Full: AMB + LoCoMo + PersonaMem (~5 min)
bash scripts/bench-all.sh --quick   # AMB only (~2 min)
```

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full system diagrams, schema, and performance benchmarks. See [docs/unified-flow.md](docs/unified-flow.md) for the F1/F2/F3 unified flow architecture.

## Credits

Core based on [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (MIT, Tencent 2026). Replaces the cloud backend with embedded SQLite + sqlite-vec + FTS5. Adds error/decision/pattern learning loops, lifecycle hooks, symbolic short-term memory (Mermaid canvas + context offloading), memory proxy (OpenAI/Anthropic dual protocol), and skill auto-extraction (rule-based, no LLM required). See [docs/unified-flow.md](docs/unified-flow.md) for the full architecture.

## License

MIT. See [LICENSE](./LICENSE).
