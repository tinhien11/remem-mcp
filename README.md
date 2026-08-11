# tdai-memory-mcp

[![npm version](https://img.shields.io/npm/v/tdai-memory-mcp.svg)](https://www.npmjs.com/package/tdai-memory-mcp)
[![GitHub stars](https://img.shields.io/github/stars/tinhien11/tdai-memory-mcp.svg)](https://github.com/tinhien11/tdai-memory-mcp)

> Your AI coding agent forgets everything when you close the session. This fixes that.

![Handoff Demo](https://raw.githubusercontent.com/tinhien11/tdai-memory-mcp/main/docs/screenshots/handoff-demo.gif)

*3 sessions, 3 agents, 1 memory: Claude Code captures + Stop hook auto-saves → Devin recalls → Codex recalls. No CLAUDE.md, no copy-paste.*

![Demo](https://raw.githubusercontent.com/tinhien11/tdai-memory-mcp/main/docs/screenshots/demo.gif)

*Viewer: React codebase — Memory + CodeGraph + Wiki*

## The problem

Every time you start a new session with Claude Code, Cursor, or Devin, your agent starts from scratch. It doesn't remember the bug you fixed yesterday, the architecture decision you made last week, or the file structure it already explored.

You re-explain. Re-read files. Re-discover the same context. Every. Single. Session.

## The fix

**One command. No API key. No cloud. No daemon.**

```bash
npx tdai-memory-mcp setup
```

That's it. Your agent now:

- **Remembers** decisions, bugs, learnings — across sessions, automatically
- **Knows your codebase** — Tree-sitter symbol index, callers/callees, impact analysis
- **Reads your docs** — markdown wiki indexed and searchable
- **Auto-captures** — session transcripts saved on exit, zero agent involvement
- **Auto-recalls** — relevant memory injected before the first message

Everything stays in one SQLite file on your machine. No data leaves your computer.

## Quick start

```bash
# 1. Register MCP server + hooks (one command, 0.2s)
npx tdai-memory-mcp setup

# 2. Restart your agent

# 3. Use your agent normally — it remembers automatically
```

Optional: if you want your agent to recall/capture mid-session (not just on start/stop), install the skill file:

```bash
npx tdai-memory-mcp install-skill   # adds ~4K tokens to context
```

### Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "npx",
      "args": ["-y", "tdai-memory-mcp"]
    }
  }
}
```

### Devin CLI

```bash
devin mcp add tdai-memory --scope user -- npx -y tdai-memory-mcp
```

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.tdai-memory]
command = "npx"
args = ["-y", "tdai-memory-mcp"]

[mcp_servers.tdai-memory.env]
TDAI_GLOBAL_SESSION_KEY = "global"
```

Then run `npx tdai-memory-mcp install-hooks` to wire SessionStart + Stop hooks.

> **Codex sandbox note:** MCP tools require `sandbox_mode = "danger-full-access"`. SessionStart hooks work with `workspace-write` — memory is still injected on startup.

## How it works

### Three knowledge layers, one `recall` call

| Layer | What it stores | Example |
|---|---|---|
| **Memory** | Decisions, bugs, learnings, tasks | "We chose SQLite over Postgres for local-first" |
| **CodeGraph** | Symbols, callers, callees, impact | `capture()` is called by `handleCapture()`, `handleRecall()` |
| **Wiki** | Markdown docs, outdated page detection | "DESIGN_GOALS.md covers React Compiler architecture" |

One `recall("storage")` returns matching captures + code symbols + wiki pages.

### Lifecycle hooks (zero agent involvement)

- **SessionStart** — injects recent memories into agent context before the first message
- **Stop** — prompts agent to save a handoff packet, then auto-captures the session transcript
- **SessionEnd** — captures session summary from transcript (Claude Code only)

Works with Claude Code, Devin CLI, and Codex CLI.

## vs other memory solutions

| | tdai-memory-mcp | @modelcontextprotocol/server-memory | mem0 |
|---|---|---|---|
| Setup | `npx tdai-memory-mcp setup` | Manual config | API key + cloud |
| API key needed | No | No | Yes |
| Data location | Local SQLite | In-memory (ephemeral) | Cloud |
| CodeGraph | Tree-sitter, 9 languages | No | No |
| Wiki ingest | Yes | No | No |
| Auto-capture hooks | SessionStart + Stop | No | No |
| Team sharing | Commit JSON export | No | Yes (cloud) |
| Cost | Free | Free | Freemium |

## CLI commands

```bash
# Setup
npx tdai-memory-mcp setup              # Register MCP server + hooks + test capture
npx tdai-memory-mcp install-skill      # Optional: install skill file for mid-session recall/capture
npx tdai-memory-mcp install-hooks      # Wire hooks into agent configs
npx tdai-memory-mcp uninstall-hooks    # Remove hooks

# CodeGraph
npx tdai-memory-mcp index --path src --repo .          # Index code (Tree-sitter, 9 languages)
npx tdai-memory-mcp search-code --query <name>         # Search symbols by name
npx tdai-memory-mcp impact <symbol_id>                 # Impact analysis (what breaks if changed)

# Wiki
npx tdai-memory-mcp wiki ingest --path docs --repo .   # Index markdown documentation
npx tdai-memory-mcp wiki search <query>                # Search wiki pages

# Memory
npx tdai-memory-mcp stats              # Memory statistics
npx tdai-memory-mcp viewer             # Web viewer at http://localhost:7331
npx tdai-memory-mcp export [file]      # Export captures to JSON
npx tdai-memory-mcp import <file>      # Import captures from JSON
```

## MCP tools

`recall` `capture` `search` `forget` `resolve` `handoff` `adr` `knowledge_create` `knowledge_get` `knowledge_list` `knowledge_delete` `skill_get` `skill_list` `skill_search` `codegraph_index` `codegraph_search` `codegraph_callers` `codegraph_callees` `codegraph_impact` `codegraph_list` `wiki_ingest` `wiki_search` `wiki_get` `wiki_outdated`

## Configuration

All settings have defaults. Config file is optional. Path: `~/.config/tdai-memory-mcp/config.json`.

| Setting | Env var | Default | Description |
|---|---|---|---|
| DB path | `TDAI_DB_PATH` | `~/.local/share/tdai-memory-mcp/memory.db` | SQLite file |
| Global memory | `TDAI_GLOBAL_SESSION_KEY` | _(unset)_ | Cross-project memory session key |
| LLM key | `TDAI_LLM_API_KEY` | _(unset)_ | LLM API key for pipeline features |
| LLM URL | `TDAI_LLM_BASE_URL` | `https://api.openai.com/v1` | LLM endpoint |
| LLM model | `TDAI_LLM_MODEL` | `gpt-4o-mini` | LLM model name |
| Pipeline | `TDAI_PIPELINE` | `noop` | `noop`, `atom`, `scenario`, or `mermaid` |
| Redact secrets | `TDAI_REDACT_SECRETS` | `true` | Redact secrets on capture |
| Recall tokens | `TDAI_MAX_TOKENS_RECALL` | `4000` | Token cap per recall |
| Search tokens | `TDAI_MAX_TOKENS_SEARCH` | `8000` | Token cap per search |

### Global memory (cross-project)

Set `TDAI_GLOBAL_SESSION_KEY=global` to share rules and decisions across all projects. `recall` searches both global and project-specific memory, merged with dedup.

## TypeScript SDK

```ts
import { Memory } from "tdai-memory-mcp";

const memory = new Memory();
await memory.capture("We chose SQLite for storage.", "decision", ["arch"]);
const results = await memory.recall("storage decision");
```

## Security

- Secret redaction on every `capture` call. Patterns for OpenAI, Anthropic, GitHub, Slack, AWS, private keys, plus a high-entropy detector.
- Read quotas: `recall` capped at 4000 tokens, `search` at 8000 tokens.
- Audit log at `~/.local/share/tdai-memory-mcp/audit.jsonl`.

## Credits

Core based on [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (MIT, Tencent 2026). Replaces the cloud backend with embedded SQLite + sqlite-vec + FTS5. Adds CodeGraph, Wiki, and lifecycle hooks.

## License

MIT. See [LICENSE](./LICENSE).
