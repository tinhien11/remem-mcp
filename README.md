# tdai-memory-mcp

> Local-first MCP memory server with TDAI-style layering. No Gateway. No API key is required.

`tdai-memory-mcp` gives your AI coding agent long-term memory. The agent can be Claude Code, Cursor, Codex CLI, Devin CLI, or Trae. The server runs as one stdio process. It embeds SQLite and sqlite-vec. There is no external database. There is no daemon. The default mode does not need an LLM API key.

## Install

```bash
npm install -g tdai-memory-mcp
```

Or run the server without installation:

```bash
npx tdai-memory-mcp
```

## Configure your MCP client

Add this block to the configuration file of your MCP client. For Claude Code, edit `~/.claude.json`. For Cursor, edit `~/.cursor/mcp.json`.

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

For Devin CLI, use the built-in command:

```bash
devin mcp add tdai-memory --scope user -- npx -y tdai-memory-mcp
```

The first run creates the database at `~/.local/share/tdai-memory-mcp/memory.db`. The server creates the schema automatically.

## Install the agent skill

The skill teaches your agent to use memory automatically. It tells the agent when to recall, when to capture, and when to forget. Without the skill, the agent has the tools but does not know when to use them.

```bash
npx tdai-memory-mcp install-skill
```

This command copies the skill file to all supported agent directories:

- `~/.config/devin/skills/tdai-memory/SKILL.md` (Devin CLI)
- `~/.claude/skills/tdai-memory/SKILL.md` (Claude Code)
- `~/.agents/skills/tdai-memory/SKILL.md` (Generic)

After you install the skill, restart your agent. The agent will then recall past context before it answers, and capture decisions and learnings after it completes a task.

## Export and import

The server stores data in a local SQLite file. To move memory between machines, use the export and import commands.

```bash
# Export all captures to a JSON file
npx tdai-memory-mcp export memory-backup.json

# Import captures on another machine
npx tdai-memory-mcp import memory-backup.json
```

The import command skips captures that already exist. It does not overwrite or duplicate data.

### Filters

You can export a subset of your memory:

```bash
# Export only captures from one project
npx tdai-memory-mcp export project.json --session-key <key>

# Export only decisions
npx tdai-memory-mcp export decisions.json --type decision
```

### Pipe to stdout

If you omit the file path, the export command writes to stdout:

```bash
npx tdai-memory-mcp export > memory-backup.json
```

## Stats

Print memory statistics: total captures, breakdown by type, top tags, sessions, agents, and date range.

```bash
npx tdai-memory-mcp stats
```

## Web viewer

Start a local web viewer to browse your memory in the browser.

```bash
npx tdai-memory-mcp viewer
# Open http://localhost:7331
```

The viewer shows all captures with search, type filters, and tags. It runs locally and reads the database in read-only mode.

## Backup

Backup the database and audit log to a timestamped directory.

```bash
# Backup to default location (backups/<timestamp> next to the DB)
npx tdai-memory-mcp backup

# Backup to a specific directory
npx tdai-memory-mcp backup /path/to/backups
```

## Config file

All settings can be configured via environment variables or a JSON config file at `~/.config/tdai-memory-mcp/config.json`:

```json
{
  "storage": "sqlite",
  "pipeline": "noop",
  "dbPath": "~/.local/share/tdai-memory-mcp/memory.db",
  "security": {
    "redactSecrets": true,
    "maxTokensRecall": 4000,
    "maxTokensSearch": 8000,
    "maxContentLength": 50000,
    "auditLog": true
  },
  "llm": {
    "apiKey": "sk-...",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  }
}
```

Environment variables override config file values.

## TypeScript SDK

Use the memory server programmatically in your own application:

```ts
import { Memory } from "tdai-memory-mcp";

const memory = new Memory();
await memory.capture("We chose SQLite for storage.", "decision", ["arch"]);
const results = await memory.recall("storage decision");
```

## Docker

```bash
# Build and run with docker compose
docker compose up -d

# Or build manually
docker build -t tdai-memory-mcp .
docker run -v tdai-data:/data tdai-memory-mcp
```

## Auto-capture hooks

Install hooks that capture session summaries automatically:

```bash
npx tdai-memory-mcp install-hooks
```

This installs hook scripts for Claude Code and Devin CLI. The hooks write session summaries to a file that the agent skill reads on the next session start.

## Handoff: share context between agent sessions

The `handoff` tool lets one agent write a structured context packet for the next agent. This saves 60-85% of tokens compared to re-reading files.

### How it works

1. **Agent A** calls `handoff` at the end of a session
2. **Agent B** calls `recall` at the start of the next session
3. Agent B gets the handoff packet (~500 tokens) instead of re-reading files (~50K tokens)

### Example

Agent A (end of session):
```
handoff({
  "task": "Fix auth bug in login flow",
  "status": "in_progress",
  "progress": "Found root cause: JWT refresh token not rotating.",
  "decisions": ["Rotate refresh tokens on every use"],
  "files": ["src/auth/jwt.ts:45-60 - refresh token logic"],
  "next_steps": ["Implement rotation logic", "Add test for rotation"]
})
```

Agent B (start of next session):
```
recall({ "query": "auth bug handoff" })
```

### Use cases

- **Switch agents mid-task**: Claude Code → Cursor, or vice versa
- **Multi-agent coordination**: coordinator creates handoffs for workers
- **Session resume**: pick up where you left off after a break
- **Cross-machine**: export from machine A, import on machine B, then recall

### Status values

| Status | Meaning |
|---|---|
| `in_progress` | Task is ongoing, more work needed |
| `blocked` | Task is blocked, waiting on something |
| `needs_review` | Task is done but needs review |
| `done` | Task is complete |
| `assigned` | Task is assigned but not started |

### Programmatic API

```ts
import { Memory } from "tdai-memory-mcp";

const memory = new Memory();
const id = await memory.handoff({
  task: "Fix auth bug",
  status: "in_progress",
  progress: "Found root cause.",
  decisions: ["Rotate refresh tokens"],
  files: ["src/auth/jwt.ts:45-60"],
  nextSteps: ["Implement rotation"],
});
// Next session:
const results = await memory.recall("auth bug handoff");
```

## ADR: Architecture Decision Records

The `adr` tool records structured architectural decisions that future agents should know about.

### Example

```
adr({
  "title": "Use SQLite for local storage",
  "context": "We need zero-setup storage that works offline.",
  "decision": "Use SQLite with FTS5 and sqlite-vec.",
  "alternatives": [
    "Postgres with pgvector — rejected: requires running server",
    "DuckDB — rejected: lacks mature vector search"
  ],
  "consequences": "Single-writer limitation, but zero setup and zero cost.",
  "tags": ["arch", "storage"]
})
```

### When to use adr vs capture

- `adr`: architectural decisions with context, alternatives, consequences
- `capture({type: "decision"})`: simpler decisions that don't need full ADR structure

### Programmatic API

```ts
const id = await memory.adr({
  title: "Use SQLite for local storage",
  context: "We need zero-setup storage.",
  decision: "Use SQLite with FTS5 and sqlite-vec.",
  alternatives: ["Postgres — rejected: requires server"],
  consequences: "Single-writer, but zero setup.",
  tags: ["arch"],
});
```

## Team-shared memory

Share memory with your team by committing a `.tdai-memory/memory-export.json` file to your repo.

### How it works

1. **You** run `sync-export` before committing
2. **Teammates** get the artifact when they clone/pull
3. **Server** auto-imports the artifact on startup

```bash
# Export your memory to .tdai-memory/memory-export.json
npx tdai-memory-mcp sync-export

# Import a teammate's memory (also happens automatically on server startup)
npx tdai-memory-mcp sync-import
```

Add `.tdai-memory/memory-export.json` to git and commit it. When teammates start their agent, the server auto-imports the file.

```bash
git add .tdai-memory/memory-export.json
git commit -m "Share team memory"
```

To ignore team sharing, add `.tdai-memory/` to `.gitignore`.

## Lifecycle hooks

Auto-capture memory without the agent needing to call tools manually.

### Install hooks

```bash
npx tdai-memory-mcp install-hooks
```

This wires two hooks into your agent config:

| Hook | Event | What it does |
|---|---|---|
| `hook-recall` | `SessionStart` | Queries recent captures and injects them into the agent's context automatically |
| `hook-stop` | `Stop` | Reminds the agent to call `handoff` before stopping |

### Supported agents

- **Devin CLI** — `~/.config/devin/config.json`
- **Claude Code** — `~/.claude/settings.json`

### Uninstall

```bash
npx tdai-memory-mcp uninstall-hooks
```

### Verify

Run `/hooks` in your agent to see the installed hooks.

## Database detection

On startup, the server checks if the database file exists at the configured path. The behavior depends on the result.

**If the database does not exist:**
1. The server creates the database file.
2. It creates the full schema.
3. It writes the current schema version to the `schema_version` table.
4. It starts the server.

**If the database exists and the schema version is current:**
1. The server opens the database.
2. It does not change the schema.
3. It keeps all your data.
4. It starts the server.

**If the database exists and the schema version is older:**
1. The server backs up the database to `memory.db.bak`.
2. It runs the migration scripts.
3. It updates the schema version.
4. It starts the server.

**If the database exists but has no `schema_version` table:**
This case means the database is from an older version of the server (before versioning). The server treats it as version 0. It runs all migrations from version 0 to the current version. It backs up the database first.

You do not need to run any command manually. The server detects the state and acts on every startup.

## Optional: enable LLM features

By default, the server stores raw captures (L0) and does hybrid search. Set an LLM API key to unlock atom extraction (L1), scenario grouping (L2), and persona synthesis (L3):

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "npx",
      "args": ["-y", "tdai-memory-mcp"],
      "env": {
        "TDAI_LLM_API_KEY": "sk-...",
        "TDAI_LLM_BASE_URL": "https://api.openai.com/v1",
        "TDAI_LLM_MODEL": "gpt-4o-mini",
        "TDAI_PIPELINE": "atom"
      }
    }
  }
}
```

If you do not set the key, the server runs in `noop` mode. It is still useful, but less distilled.

## Tools

| Tool | What it does | When to call it |
|---|---|---|
| `recall` | Retrieves relevant past memory. Uses hybrid BM25 and vector search. | Before you answer. Use it when the user references past work. |
| `capture` | Saves a decision, a learning, or a task outcome to memory. | After you complete a non-trivial task. |
| `search` | Searches memory by keyword or by semantic similarity. Accepts filters. | Use it when `recall` is too broad. |
| `forget` | Deletes specific memory entries. Requires `confirm: true`. | Use it only when the user requests a deletion. |

Two advanced tools (`layer_extract`, `canvas_get`) appear when you enable a pipeline that is not `noop`.

## Configuration

All configuration values have defaults. A configuration file is not required.

| Setting | Environment variable | Default | Description |
|---|---|---|---|
| Storage | `TDAI_STORAGE` | `sqlite` | Storage backend: `sqlite`, `pgvector`, `file`, or `tdai-gateway` |
| Pipeline | `TDAI_PIPELINE` | `noop` | Pipeline stage: `noop`, `atom`, `scenario`, or `mermaid` |
| Database path | `TDAI_DB_PATH` | `~/.local/share/tdai-memory-mcp/memory.db` | The SQLite database file |
| LLM key | `TDAI_LLM_API_KEY` | _(unset)_ | The LLM API key for pipeline features |
| LLM URL | `TDAI_LLM_BASE_URL` | `https://api.openai.com/v1` | The LLM endpoint |
| LLM model | `TDAI_LLM_MODEL` | `gpt-4o-mini` | The LLM model name |
| Redact secrets | `TDAI_REDACT_SECRETS` | `true` | Redacts API keys and tokens on capture |
| Max tokens for recall | `TDAI_MAX_TOKENS_RECALL` | `4000` | The token cap per recall response |
| Max tokens for search | `TDAI_MAX_TOKENS_SEARCH` | `8000` | The token cap per search response |
| Audit log | `TDAI_AUDIT_LOG` | `true` | Writes the audit log to `audit.jsonl` |

## How it works

The memory is layered, not flat.

```
L0 Conversation  → raw captured text (always, SQLite + FTS5 + sqlite-vec)
L1 Atom          → atomic facts (LLM extraction, optional)
L2 Scenario      → grouped scene blocks (LLM, optional)
L3 Persona       → user profile (LLM, optional, Markdown file)
```

The `recall` tool reads top-down. It reads L3 first, then drills down to L0. The `capture` tool writes bottom-up. It always writes L0. It writes the upper layers when a pipeline runs. Every upper-layer entry links back to its source. You can always trace a distilled fact back to the original text.

The search fuses BM25 (FTS5) and vector (sqlite-vec) results. It uses Reciprocal Rank Fusion in one SQL query.

## Security

- **Secret redaction.** The server redacts secrets on every `capture` call. It has patterns for OpenAI, Anthropic, GitHub, Slack, and AWS keys. It also has patterns for private keys. A high-entropy detector catches unknown secrets.
- **Read quotas.** The `recall` tool is capped at 4000 tokens. The `search` tool is capped at 8000 tokens. This prevents context overflow.
- **Audit log.** The server writes the audit log to `~/.local/share/tdai-memory-mcp/audit.jsonl`. The log records every tool call with a hash of the redacted arguments. The log does not store raw secrets.

## Status

The project is in active development. The MVP is complete: 4 MCP tools, SQLite + sqlite-vec + FTS5 hybrid search, local ONNX embeddings, secret redaction, audit log, database migration, export/import, and 56 tests.

## License

The license is MIT. See [LICENSE](./LICENSE).

## Acknowledgments

This project adapts architectural patterns from [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (MIT, Tencent 2026). The patterns include L0 to L3 layering, RRF fusion, and the pluggable storage factory.
