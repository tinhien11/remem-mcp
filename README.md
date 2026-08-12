# tdai-memory-mcp

[![npm version](https://img.shields.io/npm/v/tdai-memory-mcp.svg)](https://www.npmjs.com/package/tdai-memory-mcp)
[![GitHub stars](https://img.shields.io/github/stars/tinhien11/tdai-memory-mcp.svg)](https://github.com/tinhien11/tdai-memory-mcp)

> Local-first memory for coding agents. One SQLite file. No API key, no cloud.

![Bug fix chain](https://raw.githubusercontent.com/tinhien11/tdai-memory-mcp/main/docs/screenshots/handoff-demo.gif)

![Viewer](https://raw.githubusercontent.com/tinhien11/tdai-memory-mcp/main/docs/screenshots/demo.gif)

---

## What this is

A memory server for coding agents. Runs as an MCP server on SQLite.

| Layer | Stores | Example |
|---|---|---|
| **Memory** | Decisions, bugs, learnings, errors | "We chose SQLite over Postgres for local-first storage" |
| **CodeGraph** | Symbols, callers, callees, impact | `useEffect()` is called by 47 components, calls `cleanup()` |
| **Wiki** | Markdown docs, ADRs, outdated detection | "ADR-007 says use SQLite. 3 files still import Postgres." |

---

## Error learning system

When a command fails, it's captured automatically. Next time you run a similar command, the past error and proven fix are injected before it runs.

```
Command fails → PostToolUse captures (error type, anti-pattern, root cause, git context)
                                    ↓
Similar command → PreToolUse injects past error + proven fix + rollback plan
                                    ↓
Command succeeds → error upvoted, fix recorded, provenance tagged
                                    ↓
Error recurs → downvoted, escalated, auto-annotated, pruned at confidence=0
```

### Features

All automatic. No user action needed.

| Feature | What it does | CLI |
|---|---|---|
| **Auto-capture** | Captures failed commands with error type, anti-pattern, root cause | — |
| **Proven fix injection** | Injects top 2 past fixes before similar commands | — |
| **Harm gate** | Blocks fixes that previously caused regressions | — |
| **A/B validation** | Only promotes fixes with clean success output | — |
| **Semantic matching** | Normalizes line numbers, variables, paths before hashing | — |
| **Confidence decay** | Ebbinghaus curve (`0.95^days`), prune at 0 | — |
| **Cross-project patterns** | Alerts when same error occurs in 2+ projects | — |
| **Pre-action matchers** | Warns before `git push --force`, `rm -rf`, `DROP TABLE`, etc. | — |
| **Error prediction** | Proactive warning before editing files with error history | — |
| **Severity classification** | blocker/critical/major/minor, injects blockers first | `errors severity` |
| **Fix templates** | Extracts generalizable pattern from 3+ similar fixes | `errors templates` |
| **Error correlations** | Tracks E1→E2 sequences within 10 min | `errors correlations` |
| **Fix attempt counter** | Tracks stubborn errors (3+ attempts) in retro | — |
| **Recovery playbooks** | 4-step playbook: identify → avoid → apply → verify | `errors playbooks` |
| **Fix staleness** | Tags fixes older than 180 days as `[STALE]` | `errors stale` |
| **Error escalation** | Auto-escalates at 3/5/7 recurrences (ELEVATED/CRITICAL/BLOCKER) | `errors escalations` |
| **Error context** | Captures git branch, commits, changed files at error time | `errors context` |
| **Cross-project fix inheritance** | Auto-inherits validated fixes from other projects | `errors inherited` |
| **Auto-annotation** | System-generated notes: recurrence, severity, drift, validation | — |
| **Fix rollback plan** | Auto-generates undo instructions (git checkout/revert) | — |
| **Fix provenance** | Tags: auto_captured / inherited / template_extracted | `errors provenance` |
| **Mermaid lineage** | Renders E1→F1→E2→F2 as Mermaid graph | `errors lineage` |
| **Error persona** | Auto-builds error profile per project (types, branches, severity) | `errors persona` |
| **Session retrospective** | Failure loops, wasted effort, drift, MTBF, scorecard | `errors retro` |
| **Drift detection** | Detects when injected warnings are ignored | `errors drift` |
| **Fix lineage chains** | Tracks E1→F1→E2→F2 regression chains | `errors lineage` |
| **Goal-linked errors** | Tags errors with goal ID | `errors by-goal` |
| **Action item tracker** | Verified/open/recurring fixes | `errors actions` |
| **Error dashboard** | Patterns, resolution rate, confidence distribution | `errors` |

#### Moat 2: Decision Learning

| Feature | What it does | CLI |
|---|---|---|
| **Decision auto-capture** | Captures dependency choices, config decisions, commit-encoded decisions | — |
| **Decision injection** | Injects past decisions before `npm install`, `git commit`, etc. | — |
| **Decision confidence** | Upvotes decisions seen multiple times (re-chose same thing) | — |
| **Decision retro** | Follow rate, repeated decisions, drifted decisions | `decisions retro` |
| **Decision dashboard** | Top decisions by confidence, type breakdown | `decisions` |

#### Moat 3: Pattern Learning

| Feature | What it does | CLI |
|---|---|---|
| **Pattern auto-capture** | Captures function/component/class/import patterns from Write/Edit | — |
| **Pattern injection** | Injects same-language patterns before editing files | — |
| **Pattern confidence** | Upvotes patterns seen multiple times (widely used) | — |
| **Pattern retro** | Adoption rate, most seen patterns | `patterns retro` |
| **Pattern dashboard** | Top patterns by confidence, type/language breakdown | `patterns` |

### Observability

`explain_recall` tool shows BM25 score, vector score, RRF fused score, matched/missed keywords for any recall.

---

## Quick start

```bash
npx tdai-memory-mcp setup
```

Auto-detects Claude Code, Devin, Cursor, Codex. Registers MCP server + hooks. Restart your agent.

> **Global install** (faster hooks): `npm install -g tdai-memory-mcp` — postinstall auto-runs setup.

### Verify

```bash
npx tdai-memory-mcp doctor
```

---

## vs other memory tools

| | tdai-memory-mcp | Mem0 | Claude Code MEMORY.md | PMB |
|---|---|---|---|---|
| **Code structure** | Tree-sitter, 9 languages | No | No | No |
| **Callers/callees** | Yes | No | No | No |
| **Impact analysis** | Yes | No | No | No |
| **Error learning** | 27 features (capture, inject, drift, lineage, MTBF, severity, templates, correlations, playbooks, staleness, escalation, context, inheritance, auto-notes, rollback, provenance) | No | No | No |
| **Pre-action matchers** | Yes (git push --force, rm -rf, DROP TABLE) | No | No | No |
| **Session retrospective** | Yes (`errors retro`) | No | No | No |
| **Drift detection** | Yes (`errors drift`) | Partial | No | No |
| **Wiki/ADR ingest** | Yes | No | No | No |
| **Observability** | Yes (`explain_recall`) | No | No | No |
| **Setup** | `npx setup` | API key + cloud | Built-in | `pip install` |
| **Data location** | Local SQLite | Cloud | Local markdown | Local SQLite |
| **API key needed** | No | Yes | No | No |
| **Cost** | Free | $19–$249/mo | Free | Free |
| **Cross-agent** | Claude, Cursor, Devin, Codex | Yes | Claude only | Yes |

---

## Install per agent

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

> MCP tools require `sandbox_mode = "danger-full-access"`. SessionStart hooks work with `workspace-write`.
</details>

---

## CLI commands

```bash
# Setup
npx tdai-memory-mcp setup              # Register MCP server + hooks + test capture
npx tdai-memory-mcp doctor             # Verify setup
npx tdai-memory-mcp install-skill      # Optional: skill file for mid-session recall/capture
npx tdai-memory-mcp install-hooks      # Wire hooks into agent configs
npx tdai-memory-mcp uninstall-hooks    # Remove hooks

# Memory
npx tdai-memory-mcp stats              # Memory statistics (by type, trust, size)
npx tdai-memory-mcp recent [N]         # Show N most recent captures (default: 20)
npx tdai-memory-mcp viewer             # Web viewer at http://localhost:7331
npx tdai-memory-mcp export [file]      # Export captures to JSON
npx tdai-memory-mcp import <file>      # Import captures from JSON

# Error learning
npx tdai-memory-mcp errors             # Error dashboard
npx tdai-memory-mcp errors retro       # Session retrospective
npx tdai-memory-mcp errors drift       # Drift report
npx tdai-memory-mcp errors lineage     # Fix lineage chains
npx tdai-memory-mcp errors by-goal     # Error distribution by goal
npx tdai-memory-mcp errors actions     # Action items from resolved errors
npx tdai-memory-mcp errors severity    # Severity distribution
npx tdai-memory-mcp errors templates   # Fix templates
npx tdai-memory-mcp errors correlations # Sequential error patterns
npx tdai-memory-mcp errors playbooks   # Recovery playbooks
npx tdai-memory-mcp errors stale       # Fix staleness report
npx tdai-memory-mcp errors escalations # Auto-escalated errors
npx tdai-memory-mcp errors context     # Error context (git branch, commits)
npx tdai-memory-mcp errors inherited   # Cross-project fix inheritance
npx tdai-memory-mcp errors provenance  # Fix provenance chain
npx tdai-memory-mcp errors persona     # Error profile per project

# Decision learning (Moat 2)
npx tdai-memory-mcp decisions          # Decision dashboard
npx tdai-memory-mcp decisions retro    # Decision retrospective (follow rate, drift)

# Pattern learning (Moat 3)
npx tdai-memory-mcp patterns           # Pattern dashboard
npx tdai-memory-mcp patterns retro     # Pattern retrospective (adoption rate)

# CodeGraph (opt-in: set TDAI_ENABLE_ADVANCED=1)
npx tdai-memory-mcp index --path src --repo .          # Index code (Tree-sitter, 9 languages)
npx tdai-memory-mcp search-code --query <name>         # Search symbols by name
npx tdai-memory-mcp callers <symbol_id>                # Who calls this symbol?
npx tdai-memory-mcp callees <symbol_id>                # What does this symbol call?
npx tdai-memory-mcp impact <symbol_id>                 # What breaks if this changes?
npx tdai-memory-mcp list-code <file_path>              # List symbols in a file

# Wiki (opt-in)
npx tdai-memory-mcp wiki ingest --path docs --repo .   # Index markdown documentation
npx tdai-memory-mcp wiki search <query>                # Search wiki pages
npx tdai-memory-mcp wiki outdated [--repo .]           # Find outdated wiki pages
```

---

## MCP tools

**Core (always on):** `recall` `capture` `search` `explain_recall` `forget` `resolve` `handoff` `adr` `update` `consolidate`

**CodeGraph:** `codegraph_index` `codegraph_search` `codegraph_callers` `codegraph_callees` `codegraph_impact` `codegraph_list`

**Wiki:** `wiki_ingest` `wiki_search` `wiki_get` `wiki_outdated`

**Knowledge:** `knowledge_create` `knowledge_get` `knowledge_list` `knowledge_delete`

**Skill:** `skill_get` `skill_list` `skill_search`

Set `TDAI_ENABLE_ADVANCED=1` to enable CodeGraph + Wiki + Knowledge tools (17 extra tools).

---

## Lifecycle hooks

All automatic. The agent does not need to call any tool.

- **SessionStart** — injects recent memories before the first message
- **Stop** — auto-captures the session transcript
- **SessionEnd** — captures session summary (Claude Code)
- **PreToolUse** — injects past errors + warns before dangerous commands
- **PostToolUse** — auto-captures failed commands

---

## Configuration

All settings have defaults. Config file is optional. Path: `~/.config/tdai-memory-mcp/config.json`.

| Setting | Env var | Default | Description |
|---|---|---|---|
| DB path | `TDAI_DB_PATH` | `~/.local/share/tdai-memory-mcp/memory.db` | SQLite file |
| Global memory | `TDAI_GLOBAL_SESSION_KEY` | _(unset)_ | Cross-project memory session key |
| Global errors | `TDAI_GLOBAL_ERRORS` | _(unset)_ | Set to `1` to inject errors from all projects |
| Retro window | `TDAI_RETRO_DAYS` | `7` | Days to analyze in `errors retro` |
| Goal ID | `TDAI_GOAL_ID` | _(unset)_ | Tag new errors with a goal ID |
| Predictive errors | `TDAI_PREDICTIVE_ERRORS` | _(unset)_ | Set to `1` for proactive file-edit warnings |
| Fix staleness | `TDAI_FIX_STALENESS_DAYS` | `180` | Days before a fix is tagged `[STALE]` |
| Escalation threshold | `TDAI_ESCALATION_THRESHOLD` | `3` | Recurrences before auto-escalation |
| Advanced tools | `TDAI_ENABLE_ADVANCED` | _(unset)_ | Set to `1` to enable CodeGraph + Wiki |
| LLM key | `TDAI_LLM_API_KEY` | _(unset)_ | LLM API key for pipeline features |
| LLM URL | `TDAI_LLM_BASE_URL` | `https://api.openai.com/v1` | LLM endpoint |
| LLM model | `TDAI_LLM_MODEL` | `gpt-4o-mini` | LLM model name |
| Pipeline | `TDAI_PIPELINE` | `noop` | `noop`, `atom`, `scenario`, or `mermaid` |
| Redact secrets | `TDAI_REDACT_SECRETS` | `true` | Redact secrets on capture |
| Recall tokens | `TDAI_MAX_TOKENS_RECALL` | `4000` | Token cap per recall |
| Search tokens | `TDAI_MAX_TOKENS_SEARCH` | `8000` | Token cap per search |

### Global memory (cross-project)

Set `TDAI_GLOBAL_SESSION_KEY=global` to share rules and decisions across all projects. `recall` searches both global and project-specific memory, merged with dedup.

---

## TypeScript SDK

```ts
import { Memory } from "tdai-memory-mcp";

const memory = new Memory();
await memory.capture("We chose SQLite for storage.", "decision", ["arch"]);
const results = await memory.recall("storage decision");
```

---

## Security

- Secret redaction on every `capture` call. Patterns for OpenAI, Anthropic, GitHub, Slack, AWS, private keys, plus a high-entropy detector.
- Read quotas: `recall` capped at 4000 tokens, `search` at 8000 tokens.
- Audit log at `~/.local/share/tdai-memory-mcp/audit.jsonl`.

---

## Credits

Core based on [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (MIT, Tencent 2026). Replaces the cloud backend with embedded SQLite + sqlite-vec + FTS5. Adds CodeGraph, Wiki, error learning, and lifecycle hooks.

## License

MIT. See [LICENSE](./LICENSE).
