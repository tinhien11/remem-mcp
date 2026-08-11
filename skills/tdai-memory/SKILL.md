---
name: tdai-memory
description: Long-term memory for coding agents. Automatically recall project context before answering, and capture decisions, learnings, and fixes after completing work. Use when the user references past work, starts a new session, or when the task needs project context that is not in the current conversation.
user-invocable: false
---

You have access to a long-term memory server via MCP. It has 13 tools: `recall`, `capture`, `search`, `forget`, `handoff`, `adr`, `knowledge_create`, `knowledge_get`, `knowledge_list`, `knowledge_delete`, `skill_get`, `skill_list`, and `skill_search`. Use them automatically as described below. Do not ask the user for permission to use memory.

## When to recall

Call `recall` at the start of a session, or when the user references past work. Do this BEFORE you answer or start coding.

```
recall({ "query": "<the user's question or task summary>", "mode": "hybrid" })
```

If the user says any of these, call `recall` first:
- "do you remember"
- "last time we"
- "what did we decide about"
- "have we seen this error before"
- "continue from where we left off"
- any reference to a previous session or past decision

If recall returns results, use them to inform your answer. If recall returns "No memory found", proceed normally. Do not mention that recall returned nothing.

## Multi-tenant isolation

If the user works in a team context, pass `team_id`, `agent_id`, `user_id`, or `task_id` to isolate memory. When you set `team_id`, all queries filter by that value. This lets multiple teams share one database without cross-contamination.

```
recall({ "query": "auth bug", "team_id": "team-a", "user_id": "user-1" })
capture({ "content": "Decision", "type": "decision", "team_id": "team-a", "task_id": "task-42" })
```

## When to capture

Call `capture` AFTER you complete a non-trivial task. Do this automatically. Do not ask the user.

Capture when:
- You make an architectural decision
- You fix a bug and found the root cause
- You learn something non-obvious about the codebase
- You complete a feature that took multiple steps

### L0: Raw capture

Always capture the raw summary first:

```
capture({
  "content": "<a short summary of the decision, learning, or fix>",
  "type": "decision" | "learning" | "task" | "error" | "conversation",
  "tags": ["<relevant tags>"]
})
```

### L0: Conversation capture

To capture a multi-turn conversation with role-based messages, pass `messages` instead of `content`. The tool flattens the messages into a single text for search, and stores the original messages for retrieval.

```
capture({
  "type": "conversation",
  "messages": [
    { "role": "user", "content": "How do I fix the auth bug?" },
    { "role": "assistant", "content": "The root cause is a missing JWT refresh." }
  ]
})
```

### L1: Atom extraction

After the L0 capture, extract 1-3 atomic facts from it. Each atom is a single, self-contained fact that is useful on its own. Capture each atom separately with `type: "atom"` and tag it `L1`. Link it back to the L0 capture by including the L0 id in the content.

```
// After capturing L0 with id 01KZNVN77XPQYAT9EXS2R1T68Y:
capture({
  "content": "Chose SQLite over Postgres because zero-setup is a requirement. [source: 01KZNVN77XPQYAT9EXS2R1T68Y]",
  "type": "atom",
  "tags": ["L1", "arch", "storage"]
})
```

Rules for atoms:
- Each atom is ONE fact, not a paragraph.
- An atom is self-contained. A reader can understand it without the L0 context.
- Include `[source: <L0 id>]` at the end so atoms can be traced back.
- Extract atoms only for `decision`, `learning`, and `error` types. Skip for `task` and `conversation`.
- Do not extract more than 3 atoms per L0 capture.
- If the L0 capture is too simple to yield atoms, skip L1.

You can also run atom extraction on existing captures via the CLI:
```bash
npx tdai-memory-mcp extract --team-id <id> --limit 50
```
This requires `TDAI_LLM_API_KEY` to be set.

### What to capture

Good captures (specific, useful later):
- "We chose SQLite over Postgres for the MVP because zero-setup is a requirement."
- "The FTS5 trigger must use content_rowid, not content_rowid = captures.rowid."
- "The RRF constant k=60 is the standard value from the original paper."

Bad captures (too vague, not useful later):
- "We talked about the database."
- "I fixed a bug."
- "The user asked a question."

### Types

- `decision`: A choice between alternatives. Include what was chosen and why.
- `learning`: A non-obvious fact about the codebase, a library, or a tool.
- `task`: A completed task with a known outcome.
- `error`: A bug with a known root cause and fix.
- `conversation`: A general note or multi-turn conversation that does not fit the other types.
- `atom`: An atomic fact extracted from a L0 capture. Always tag with `L1` and include `[source: <L0 id>]`.

## When to search

Call `search` when `recall` is too broad and you need specific facts with filters.

```
search({
  "query": "<specific query>",
  "mode": "hybrid",
  "filters": { "type": "decision", "tags": ["arch"], "team_id": "team-a" }
})
```

## When to handoff

Call `handoff` at the end of a session, or before switching to a different agent. This creates a structured packet that the next agent loads via `recall`, saving 60-85% of tokens compared to re-reading files.

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

### When to call handoff

- The user says "I'm switching to Cursor" or "let's continue in Claude Code"
- The session is ending and the task is not done
- You are a worker agent finishing your part of a multi-agent task
- The user says "wrap up" or "save context for next time"

### When NOT to call handoff

- The task is fully done and there is nothing to hand off
- The session was trivial (a quick question, a small fix)
- The user did not ask for a handoff and the task is ongoing

### How the next agent loads the handoff

The next agent calls `recall` at the start of a new session. The handoff packet appears in the results because it is stored as a capture with type `task` and tag `handoff`. The next agent reads the packet and continues without re-reading files.

## When to record an ADR

Call `adr` when you make a technical decision that future agents should know about. This is more structured than a regular `capture` with type `decision`.

```
adr({
  "title": "Use SQLite for local storage",
  "context": "We need a storage backend that requires zero setup and works offline. The MVP must not depend on a running database server.",
  "decision": "Use SQLite with FTS5 for full-text search and sqlite-vec for vector search.",
  "alternatives": [
    "Postgres with pgvector — rejected because it requires a running server",
    "DuckDB — rejected because it lacks mature vector search extensions"
  ],
  "consequences": "Single-writer limitation. No remote access. But zero setup and zero cost.",
  "tags": ["arch", "storage"]
})
```

### When to call adr vs capture

- Use `adr` for architectural decisions with context, alternatives, and consequences.
- Use `capture({type: "decision"})` for simpler decisions that do not need the full ADR structure.
- Use `adr` when the decision will affect future work across multiple sessions.

### When to call adr

- You choose a library, framework, or tool for the project
- You decide on an architectural pattern (e.g., monolith vs microservices)
- You make a data model decision that is hard to reverse
- The user says "let's go with X" after comparing options

### When NOT to call adr

- The decision is trivial (variable naming, file location)
- The decision is easily reversible
- You are just implementing what was already decided

## Knowledge management

Use `knowledge_create` to register a knowledge asset (wiki or code-graph) for the team. The asset metadata is stored locally. The actual content is processed by an external knowledge service.

```
knowledge_create({
  "team_id": "team-1",
  "name": "Project Wiki",
  "type": "wiki",
  "summary": "Internal documentation.",
  "service_url": "http://localhost:8424/v3"
})
```

Use `knowledge_list` to list assets for a team, `knowledge_get` to retrieve one by ID, and `knowledge_delete` to remove assets.

## Skill management

Use `skill_list` to list reusable workflows bound to a team. Use `skill_search` to find skills by keyword. Use `skill_get` to retrieve the full content of a skill.

```
skill_search({ "team_id": "team-1", "agent_id": "agent-x", "query": "deploy" })
```

## Team-shared memory

If the project has a `.tdai-memory/memory-export.json` file, it is automatically imported on server startup. This means teammates can share memory by committing this file to the repo.

To export your memory for the team:
```bash
npx tdai-memory-mcp sync-export
```

To import a teammate's memory:
```bash
npx tdai-memory-mcp sync-import
```

The server auto-imports on startup, so you only need `sync-export` before committing.

## CLI commands for L1-L3 pipeline

The L1-L3 pipeline runs via CLI, not MCP tools. This keeps the MCP interface lean.

```bash
# Run L1 atom extraction on existing captures (requires TDAI_LLM_API_KEY)
npx tdai-memory-mcp extract --team-id <id> --limit 50

# List or search L1 atoms
npx tdai-memory-mcp atoms --team-id <id>
npx tdai-memory-mcp atoms --query "SQLite"

# List L2 scenarios
npx tdai-memory-mcp scenarios --team-id <id>

# Read or write L3 persona
npx tdai-memory-mcp persona --team-id <id> --agent-id <id> --user-id <id>
npx tdai-memory-mcp persona --team-id <id> --agent-id <id> --user-id <id> --write "Prefers concise answers."
```

## When to forget

Call `forget` ONLY when the user explicitly asks to delete memory. Always require `confirm: true`. Never auto-forget.

## Lifecycle hooks (automatic)

If hooks are installed (`npx tdai-memory-mcp install-hooks`), memory works automatically:

- **SessionStart**: Recent captures are injected into your context. You do not need to call `recall` manually.
- **SessionEnd**: When the session ends, a hook silently captures the session summary (first user message + last assistant message) to the memory DB. You do not need to do anything — this runs automatically on session exit.

You can still call `recall`, `capture`, `search`, `forget`, `handoff`, and `adr` manually at any time.

## Rules

1. Never fabricate memory. If recall returns nothing, say nothing about memory.
2. Never capture trivial things (file reads, ls commands, simple questions).
3. Keep capture content short: 1 to 3 sentences.
4. Use tags that you will search for later (for example: "arch", "bug", "config").
5. Do not tell the user "I am capturing this to memory." Just do it silently.
6. Do not tell the user "I am recalling from memory." Just use the results.
