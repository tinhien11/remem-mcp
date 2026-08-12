# tdai-memory-mcp

[![npm version](https://img.shields.io/npm/v/tdai-memory-mcp.svg)](https://www.npmjs.com/package/tdai-memory-mcp)
[![GitHub stars](https://img.shields.io/github/stars/tinhien11/tdai-memory-mcp.svg)](https://github.com/tinhien11/tdai-memory-mcp)

> The only memory tool that understands your code. Not just text — symbols, callers, impact, errors, and the decisions behind them.

![Bug fix chain](https://raw.githubusercontent.com/tinhien11/tdai-memory-mcp/main/docs/screenshots/handoff-demo.gif)

*3 sessions, 3 React bugs, 1 memory: Session 1 captures the fix → Session 2 starts with it loaded → Session 3 knows both fixes.*

![Viewer](https://raw.githubusercontent.com/tinhien11/tdai-memory-mcp/main/docs/screenshots/demo.gif)

*Web viewer: Memory + CodeGraph + Wiki in one UI*

---

## Why this exists

Every memory tool stores text. Mem0, Zep, Letta, PMB, Claude Code's MEMORY.md — they all treat code as words. None of them know what a function is, who calls it, or what breaks when it changes.

**tdai-memory-mcp is different.** It has three layers in one SQLite file:

| Layer | What it knows | Example |
|---|---|---|
| **Memory** | Decisions, bugs, learnings, errors | "We chose SQLite over Postgres for local-first storage" |
| **CodeGraph** | Symbols, callers, callees, impact | `useEffect()` is called by 47 components, calls `cleanup()` |
| **Wiki** | Markdown docs, ADRs, outdated detection | "ADR-007 says use SQLite. 3 files still import Postgres." |

One `recall("useEffect")` returns the bug fix you did last week + the function that caused it + who calls it + the ADR that decided the pattern. No other tool does this.

---

## Quick start

```bash
npx tdai-memory-mcp setup
```

That is it. Auto-detects Claude Code, Devin, Cursor, Codex. Registers MCP server + hooks. Restart your agent.

> **Global install** (faster hooks, no npx delay): `npm install -g tdai-memory-mcp` — postinstall auto-runs setup.

### Verify

```bash
npx tdai-memory-mcp doctor
```

---

## Use cases

### Bug fix chain — 3 sessions, 3 React bugs, 1 memory

A React project had 3 bugs in the fiber reconciler. Each session fixed one. The next session started with the previous fix already loaded.

**Session 1** — useState batching:
```
Bug: setState calls in onClick cause 3 re-renders instead of 1
     in concurrent mode. Legacy mode batches fine.
Root cause: ReactFiberBeginWork.ts:842 checks executionContext
     before batching. Lane priority skips the batch boundary.
Fix: always batch inside discrete events. 47/47 tests pass.
```

**Session 2** — useEffect cleanup race:
```
Bug: useEffect cleanup runs after the next effect starts.
     The cleanup aborts a fetch the new effect is waiting on.
Root cause: ReactFiberHooks.ts passive effect queue runs cleanup
     AFTER the next effect by default.
Fix: run cleanup BEFORE the next effect. 23/23 tests pass.
```

**Session 3** — Suspense fallback flash:
```
Bug: Suspense shows fallback for one frame even when data is cached.
Root cause: ReactFiberBeginWork boundary check does not skip
     fallback when the thrown promise is already settled.
Fix: check if promise is resolved before showing fallback. 31/31 tests pass.
```

**How memory helped:** Session 2 started with the batching fix already loaded. The agent said "I see from memory that batching was fixed" and went straight to the cleanup bug. Session 3 knew both fiber fixes, so it looked at Suspense instead of re-investigating hooks.

Without memory: each session reads 500+ lines of `ReactFiberBeginWork.ts` + `ReactFiberHooks.ts` + `ReactFiberThrow.ts` to re-discover the same context. 30 minutes wasted, every time.

### Error pattern across projects

```
Error: SqliteError: no such module: vec0
First seen: tdai-memory-mcp stats command
Root cause: readonly DB connection did not load sqlite-vec extension.
Fix: use openDbWithSchema() instead of new Database(readonly).
```

**How memory helped:** When the same `vec0` error appeared in a different project, the agent recalled the fix before debugging. One `recall("vec0")` call. Zero investigation time.

### SessionStart — rules loaded before first message

```
SessionStart: loaded 2 capture(s)
- (decision [rule]) Always use recall before grep
- (decision [rule]) Use codegraph_search for definitions
```

**How memory helped:** The agent followed project rules from message one. The user did not repeat them. The rules applied to every session, every agent, every project.

---

## What makes it different

### 1. Code-aware recall

`recall("useEffect cleanup")` returns:

- The learning: "cleanup runs after the next effect, causing a race"
- The code: `ReactFiberHooks.ts` passive effect queue ordering
- The impact: 23 components use this hook, 5 tests cover it
- The decision: ADR says run cleanup before the next effect

Other tools return the learning. They do not know which function, which callers, or which tests.

### 2. Error learning

When a command fails, tdai-memory-mcp captures it. Next time you run a similar command, it injects the past error before you hit it again.

- `PostToolUse` hook auto-captures failed commands (exit code != 0)
- `PreToolUse` hook injects past errors before lint/build/test
- Confidence upvotes/downvotes prune stale errors

### 3. Architecture drift detection (planned)

The Wiki layer indexes your ADRs and design docs. The CodeGraph layer indexes your imports. The goal: when they disagree, you get:

> "ADR-007 says use SQLite. 3 files still import Postgres: `db.ts`, `migrate.ts`, `seed.ts`."

Both layers exist today. The cross-layer check is on the roadmap.

### 4. Lifecycle hooks (zero agent cooperation)

- **SessionStart** — injects recent memories before the first message
- **Stop** — auto-captures the session transcript
- **SessionEnd** — captures session summary (Claude Code)
- **PreToolUse** — injects past errors before risky commands
- **PostToolUse** — auto-captures failed commands

The agent does not need to call any tool. Memory just works.

---

## vs other memory tools

| | tdai-memory-mcp | Mem0 | Claude Code MEMORY.md | PMB | OpenViking |
|---|---|---|---|---|---|
| **Code structure** | Tree-sitter, 9 languages | No | No | No | No |
| **Callers/callees** | Yes | No | No | No | No |
| **Impact analysis** | Yes | No | No | No | No |
| **Error learning** | Auto-capture + inject | No | No | No | No |
| **Wiki/ADR ingest** | Yes (drift detection: planned) | No | No | No | No |
| **Setup** | `npx setup` | API key + cloud | Built-in | `pip install` | Plugin install |
| **Data location** | Local SQLite | Cloud | Local markdown | Local SQLite | Local SQLite |
| **API key needed** | No | Yes | No | No | No |
| **Cost** | Free | $19–$249/mo | Free | Free | Free |
| **Cross-agent** | Claude, Cursor, Devin, Codex | Yes | Claude only | Yes | Yes |

**The gap**: every other tool stores code as text. tdai-memory-mcp stores code as structure.

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

### Core vs advanced tools

By default, 9 core tools are exposed: `recall` `capture` `search` `forget` `resolve` `handoff` `adr` `update` `consolidate`.

Set `TDAI_ENABLE_ADVANCED=1` to enable CodeGraph + Wiki + Knowledge tools (17 extra tools).

---

## MCP tools

**Core (always on):** `recall` `capture` `search` `forget` `resolve` `handoff` `adr` `update` `consolidate`

**CodeGraph:** `codegraph_index` `codegraph_search` `codegraph_callers` `codegraph_callees` `codegraph_impact` `codegraph_list`

**Wiki:** `wiki_ingest` `wiki_search` `wiki_get` `wiki_outdated`

**Knowledge:** `knowledge_create` `knowledge_get` `knowledge_list` `knowledge_delete`

**Skill:** `skill_get` `skill_list` `skill_search`

---

## Configuration

All settings have defaults. Config file is optional. Path: `~/.config/tdai-memory-mcp/config.json`.

| Setting | Env var | Default | Description |
|---|---|---|---|
| DB path | `TDAI_DB_PATH` | `~/.local/share/tdai-memory-mcp/memory.db` | SQLite file |
| Global memory | `TDAI_GLOBAL_SESSION_KEY` | _(unset)_ | Cross-project memory session key |
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
