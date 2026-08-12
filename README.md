# tdai-memory-mcp

[![npm version](https://img.shields.io/npm/v/tdai-memory-mcp.svg)](https://www.npmjs.com/package/tdai-memory-mcp)
[![GitHub stars](https://img.shields.io/github/stars/tinhien11/tdai-memory-mcp.svg)](https://github.com/tinhien11/tdai-memory-mcp)

> Local-first memory for coding agents. One SQLite file. Three layers: memory, code graph, wiki. Plus an error learning system that captures failures and injects proven fixes.

![Bug fix chain](https://raw.githubusercontent.com/tinhien11/tdai-memory-mcp/main/docs/screenshots/handoff-demo.gif)

*3 sessions, 3 React bugs, 1 memory: Session 1 captures the fix → Session 2 starts with it loaded → Session 3 knows both fixes.*

![Viewer](https://raw.githubusercontent.com/tinhien11/tdai-memory-mcp/main/docs/screenshots/demo.gif)

*Web viewer: Memory + CodeGraph + Wiki in one UI*

---

## What this is

A memory server for coding agents. Runs as an MCP server on SQLite. No API key, no cloud.

Three layers in one database:

| Layer | Stores | Example |
|---|---|---|
| **Memory** | Decisions, bugs, learnings, errors | "We chose SQLite over Postgres for local-first storage" |
| **CodeGraph** | Symbols, callers, callees, impact | `useEffect()` is called by 47 components, calls `cleanup()` |
| **Wiki** | Markdown docs, ADRs, outdated detection | "ADR-007 says use SQLite. 3 files still import Postgres." |

Plus an error learning system that no other memory tool has.

---

## The error learning system

Most memory tools store text. None of them learn from failures. This one does.

### How it works

```
Command fails → PostToolUse hook captures it (error type, anti-pattern, root cause)
                                    ↓
Next time you run a similar command → PreToolUse hook injects the past error
                                    ↓
Command succeeds → error upvoted, proven fix recorded
                                    ↓
Error keeps recurring → downvoted, pruned at confidence=0
```

### What it captures

Every failed `npm run lint`, `npm run build`, `tsc`, `cargo build`, `pytest` — automatically, with no agent cooperation. The hook fires, extracts the error type, generates an anti-pattern ("don't do X") and a correct approach ("do Y instead"), and stores it.

### What it injects

Before you run a lint/build/test command, the PreToolUse hook injects the top 2 most relevant past errors (by decayed confidence). The agent sees them before it runs the command, so it can fix the issue proactively.

### Safety gates

Two gates prevent bad fixes from being re-injected:

- **Harm gate** — If a proven fix previously caused a regression (`fix_harm_count > 0`), it is blocked.
- **A/B validation** — If the fix's success output contained error indicators (`fix_validated = false`), it is blocked. Only clean successes are promoted.

### Semantic matching

Errors are normalized before hashing: line numbers, variable names, and file paths are replaced with placeholders. So `TypeError: x is undefined at line 42` and `TypeError: y is undefined at line 87` are recognized as the same error pattern, not two new errors.

### Confidence decay

Errors decay via Ebbinghaus forgetting curve (`0.95^days`). Old errors fade. Fresh ones rank higher. Errors that recur get downvoted. At confidence=0, they are pruned.

### Cross-project patterns

When the same error type occurs in 2+ projects, you get an alert. Set `TDAI_GLOBAL_ERRORS=1` to inject errors from all your projects, not just the current one.

### Pre-action matchers

Before dangerous commands, the PreToolUse hook warns:

- `git push --force` (with/without branch — different severity)
- `rm -rf` on critical paths (`/`, `~`, `/home`, `/usr`, `/var`, `/etc`)
- `DROP TABLE` / `DROP DATABASE` / `TRUNCATE`
- `DELETE FROM` without `WHERE`
- `npm publish` (caution level)
- `docker system prune` / `volume rm`
- `kubectl delete namespace`

### Observability

```bash
# Use the explain_recall tool to see why a memory was retrieved:
# - BM25 score, vector score, RRF fused score, rank
# - Matched vs missed keywords
# - With capture_id: why a specific capture was or wasn't retrieved
```

### Session retrospective

```bash
npx tdai-memory-mcp errors retro
```

Analyzes your last 7 days (configurable via `TDAI_RETRO_DAYS`):

- **Failure loops** — same error recurred 3+ times (agent stuck)
- **Wasted effort** — errors captured but never resolved
- **Recurred resolved** — "resolved" errors that came back (fix is wrong)
- **Most expensive commands** — ranked by failure count
- **Harmful fixes** — blocked by harm gate, don't re-apply
- **Drift violations** — errors injected as warnings but agent still failed
- **Fix effectiveness (MTBF)** — most durable fixes (lasted days) vs fragile fixes (recurred within 1 hour)
- **Scorecard + recommendations**

### Drift detection

```bash
npx tdai-memory-mcp errors drift
```

Detects when stored error learnings are NOT being applied. When PreToolUse injects an error warning but the agent still hits the same error, that's a drift violation.

- **Severity**: ● 1 drift, ●● 2 drifts, ●●● 3+ drifts (agent repeatedly ignored warning)
- **Drift rate**: percentage of errors with drift vs total errors
- **Effectiveness assessment**: low (<10%), moderate (10-30%), high (>30%)
- **Scorecard**: total errors, errors with drift, total drift events

This closes the feedback loop: capture → inject → measure if the agent heeded the warning.

### Fix lineage chains

```bash
npx tdai-memory-mcp errors lineage
```

Tracks regression chains: when a fix for error E1 causes a new error E2, and the fix for E2 causes E3. Shows the full chain `E1 → F1 → E2 → F2 → E3` with chain depth and cascade assessment.

- **Chain visualization**: E1 → ↓ fix → E2 → ↓ fix → E3
- **Max chain depth**: deepest regression chain
- **Cascade assessment**: low (1) / moderate (2-4) / high (5+)

Different from harm gate: harm gate *blocks* harmful fixes from re-injection. Lineage *tracks the history* of what happened.

### Goal-linked errors

```bash
# Tag errors with a goal ID
export TDAI_GOAL_ID="auth-feature"

# View error distribution by goal
npx tdai-memory-mcp errors by-goal
```

Links errors to the goals they block (LoopX-inspired). When `TDAI_GOAL_ID` is set, all new errors are tagged. The `by-goal` report shows:

- Error count and resolve rate per goal
- Error types per goal
- Most error-prone goal

### Action item tracker

```bash
npx tdai-memory-mcp errors actions
```

Postmortem action items from resolved errors (SRE pattern):

- **Verified fixes** — clean success, no recurrence (✓)
- **Open action items** — fix applied but not yet validated (⚠)
- **Recurring fixes** — fix recurred, needs a stronger approach (✗)
- **Recommendations** — verify open fixes, replace recurring fixes

### Error prediction (proactive)

```bash
# Enable predictive warnings before file edits
export TDAI_PREDICTIVE_ERRORS=1
```

When enabled, PreToolUse checks if a file being edited (Write/Edit/MultiEdit) has error history. If so, it injects a proactive warning *before* the edit, not after the build fails:

```
[tdai-memory] File has error history — 2 past error(s) on this file:
- 2026-08-12 [build] ✓resolved: Missing import
  Anti-pattern: forgot to import after refactor
  Correct approach: add import at top of file

Avoid repeating these errors when editing this file.
```

### Error dashboard

```bash
npx tdai-memory-mcp errors
```

Shows: top recurring patterns, resolution rate, confidence distribution, proven fixes, recent errors.

---

## Quick start

```bash
npx tdai-memory-mcp setup
```

Auto-detects Claude Code, Devin, Cursor, Codex. Registers MCP server + hooks. Restart your agent.

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

**How memory helped:** Session 2 started with the batching fix already loaded. Session 3 knew both fiber fixes, so it looked at Suspense instead of re-investigating hooks.

Without memory: each session reads 500+ lines of `ReactFiberBeginWork.ts` + `ReactFiberHooks.ts` + `ReactFiberThrow.ts` to re-discover the same context.

### Error pattern across projects

```
Error: SqliteError: no such module: vec0
First seen: tdai-memory-mcp stats command
Root cause: readonly DB connection did not load sqlite-vec extension.
Fix: use openDbWithSchema() instead of new Database(readonly).
```

When the same `vec0` error appeared in a different project, the agent recalled the fix before debugging. One `recall("vec0")` call. Zero investigation time.

### SessionStart — rules loaded before first message

```
SessionStart: loaded 2 capture(s)
- (decision [rule]) Always use recall before grep
- (decision [rule]) Use codegraph_search for definitions
```

The agent followed project rules from message one. The user did not repeat them.

---

## What makes it different

### Code-aware recall

`recall("useEffect cleanup")` returns:

- The learning: "cleanup runs after the next effect, causing a race"
- The code: `ReactFiberHooks.ts` passive effect queue ordering
- The impact: 23 components use this hook, 5 tests cover it
- The decision: ADR says run cleanup before the next effect

Other tools return the learning. They do not know which function, which callers, or which tests.

### Error learning

When a command fails, the PostToolUse hook captures it. Next time you run a similar command, the PreToolUse hook injects the past error before you hit it again.

- Auto-capture failed commands (exit code != 0)
- Inject past errors before lint/build/test
- Confidence upvotes/downvotes prune stale errors
- Harm gate + A/B validation prevent bad fixes from being re-injected
- Semantic matching merges similar errors into patterns

### Lifecycle hooks (zero agent cooperation)

- **SessionStart** — injects recent memories before the first message
- **Stop** — auto-captures the session transcript
- **SessionEnd** — captures session summary (Claude Code)
- **PreToolUse** — injects past errors + warns before dangerous commands
- **PostToolUse** — auto-captures failed commands

The agent does not need to call any tool. Memory just works.

---

## vs other memory tools

| | tdai-memory-mcp | Mem0 | Claude Code MEMORY.md | PMB |
|---|---|---|---|---|
| **Code structure** | Tree-sitter, 9 languages | No | No | No |
| **Callers/callees** | Yes | No | No | No |
| **Impact analysis** | Yes | No | No | No |
| **Error learning** | Auto-capture + inject + harm gate + A/B validation + drift + lineage + MTBF | No | No | No |
| **Pre-action matchers** | Yes (git push --force, rm -rf, DROP TABLE, etc.) | No | No | No |
| **Session retrospective** | Yes (`errors retro`) | No | No | No |
| **Drift detection** | Yes (`errors drift`) | Partial (`sheal drift`) | No | No |
| **Fix lineage chains** | Yes (`errors lineage`) | No | No | No |
| **Fix effectiveness (MTBF)** | Yes (durable vs fragile fixes) | No | No | No |
| **Goal-linked errors** | Yes (`errors by-goal`) | No | No | No |
| **Action item tracker** | Yes (`errors actions`) | No | No | No |
| **Error prediction** | Yes (proactive before file edits) | No | No | No |
| **Observability** | Yes (`explain_recall` tool) | No | No | No |
| **Wiki/ADR ingest** | Yes | No | No | No |
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
npx tdai-memory-mcp errors             # Error dashboard (patterns, fixes, resolution rate)
npx tdai-memory-mcp errors retro       # Session retrospective (failure loops, wasted effort, drift)
npx tdai-memory-mcp errors drift       # Drift report (injected errors that still occurred)
npx tdai-memory-mcp errors lineage     # Fix lineage chains (E1→F1→E2→F2 regression graph)
npx tdai-memory-mcp errors by-goal     # Error distribution by goal (set TDAI_GOAL_ID)
npx tdai-memory-mcp errors actions     # Action items from resolved errors (verified, open, recurring)

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

By default, 10 core tools are exposed: `recall` `capture` `search` `explain_recall` `forget` `resolve` `handoff` `adr` `update` `consolidate`.

Set `TDAI_ENABLE_ADVANCED=1` to enable CodeGraph + Wiki + Knowledge tools (17 extra tools).

---

## MCP tools

**Core (always on):** `recall` `capture` `search` `explain_recall` `forget` `resolve` `handoff` `adr` `update` `consolidate`

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
| Global errors | `TDAI_GLOBAL_ERRORS` | _(unset)_ | Set to `1` to inject errors from all projects |
| Retro window | `TDAI_RETRO_DAYS` | `7` | Days to analyze in `errors retro` |
| Goal ID | `TDAI_GOAL_ID` | _(unset)_ | Tag new errors with a goal ID |
| Predictive errors | `TDAI_PREDICTIVE_ERRORS` | _(unset)_ | Set to `1` to inject warnings before editing files with error history |
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
