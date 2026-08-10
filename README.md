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

The project is in the specification and design phase. The implementation has not started.

## License

The license is MIT. See [LICENSE](./LICENSE).

## Acknowledgments

This project adapts architectural patterns from [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (MIT, Tencent 2026). The patterns include L0 to L3 layering, RRF fusion, and the pluggable storage factory.
