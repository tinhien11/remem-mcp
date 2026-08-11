---
name: tdai-memory
description: Long-term memory for coding agents. Automatically recall project context before answering, and capture decisions, learnings, and fixes after completing work. Use when the user references past work, starts a new session, or when the task needs project context that is not in the current conversation.
user-invocable: false
---

You have access to a long-term memory server via MCP. It has 24 tools: `recall`, `capture`, `search`, `forget`, `resolve`, `handoff`, `adr`, `knowledge_create`, `knowledge_get`, `knowledge_list`, `knowledge_delete`, `skill_get`, `skill_list`, `skill_search`, `codegraph_index`, `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_list`, `wiki_ingest`, `wiki_search`, `wiki_get`, and `wiki_outdated`. Use them automatically as described below. Do not ask the user for permission to use memory.

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

## Trust states and correction

Every capture has a `trust_state` that controls how it ranks in search and recall:

- `candidate`: the default state for new captures.
- `verified`: confirmed as correct. Set this when the user confirms a fact, or when you read the value from an authoritative source.
- `stale`: outdated, replaced by a newer capture. Set by the `resolve` tool or by `capture` with `supersedes`.
- `rejected`: wrong content, blocked from search and recall. Set by `forget` with `reject: true`.

### When to mark a capture as verified

Set `verified: true` when you capture a fact that the user confirmed, or that you read from an authoritative source (documentation, config file, source code).

```
capture({
  "content": "The default port is 8080.",
  "type": "decision",
  "verified": true
})
```

### When to reject a capture

Call `forget` with `reject: true` when the user tells you a captured fact is wrong. Always provide a `reason` so future agents can see why the content was rejected.

```
forget({
  "id": "<capture_id>",
  "confirm": true,
  "reject": true,
  "reason": "Wrong: the port is 9090, not 8080."
})
```

When you reject a capture, the content hash is tombstoned. If you try to capture the same content again, the capture is blocked. Set `override_rejection: true` on `capture` to force the capture if the rejection was a mistake.

### When to resolve a conflict

When `capture` reports a conflict, two captures in the same session have similar content. Call `resolve` to mark one as the winner and the other as stale.

```
resolve({
  "winner": "<correct_capture_id>",
  "loser": "<wrong_capture_id>",
  "reason": "The winner is the renderer default."
})
```

The loser is set to `stale` and linked to the winner via `superseded_by`. The stale capture still appears in search results but ranks lower than the winner.

### When to use supersedes

If you capture a new value that replaces an old one, set `supersedes` to the old capture ID. This marks the old capture as `stale` in the same call.

```
capture({
  "content": "The port is 9090.",
  "type": "decision",
  "supersedes": "<old_capture_id>"
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

## CodeGraph

The CodeGraph indexes code symbols (functions, classes, methods) and call relationships from your project. It uses Tree-sitter to parse TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, and C# files.

### Index your code

Call `codegraph_index` at the start of a session, before you read or modify code. This extracts symbols, calls, and imports into the memory database. Index the `src` directory or the project root.

```
codegraph_index({ "path": "src", "repo_path": "." })
```

For a single file:

```
codegraph_index({ "path": "src/server.ts", "repo_path": "." })
```

If you are not sure which directory holds the source code, index the current directory:

```
codegraph_index({ "path": ".", "repo_path": "." })
```

### Search for symbols

Call `codegraph_search` to find where a function or class is defined.

```
codegraph_search({ "query": "handleCapture" })
```

### Find callers and callees

After you find a symbol, use `codegraph_callers` to see who calls it, and `codegraph_callees` to see what it calls.

```
codegraph_callers({ "symbol_id": "<id from codegraph_search>" })
codegraph_callees({ "symbol_id": "<id from codegraph_search>" })
```

### Impact analysis

Call `codegraph_impact` before you change a function. It traverses the call graph upward to find all code that may be affected.

```
codegraph_impact({ "symbol_id": "<id>", "max_depth": 5 })
```

### List symbols in a file

Call `codegraph_list` to get an overview of what a file contains.

```
codegraph_list({ "file_path": "src/server.ts" })
```

### Automatic indexing

The `recall` tool augments its results with matching code symbols. The `handoff` tool includes symbols for files listed in the handoff packet.

### When to use CodeGraph

Call `codegraph_search` and `codegraph_impact` before you change a function or class. Do this when:

- The user asks you to modify a function — run `codegraph_impact` first to see what else breaks
- You need to find where a function is defined — run `codegraph_search` instead of grep
- You need to understand who calls a function — run `codegraph_callers` to trace the call chain
- You refactor a file — run `codegraph_list` to see all symbols in that file first

Do not call CodeGraph tools if the project has no source code files (only docs, config, or data files).

To auto-index after each commit, add this to `.git/hooks/post-commit`:

```bash
npx tdai-memory-mcp hook-post-commit
```

## Wiki

The Wiki indexes markdown documentation files. It parses frontmatter, headings, `[[wikilinks]]`, and `[text](url)` links to build a page graph.

### Ingest documentation

Call `wiki_ingest` to index markdown files.

```
wiki_ingest({ "path": "docs", "repo_path": "." })
```

### Search documentation

Call `wiki_search` to find pages by content.

```
wiki_search({ "query": "authentication setup" })
```

### Get a page with links

Call `wiki_get` to read a page and see its links and backlinks.

```
wiki_get({ "page_id": "<id from wiki_search>" })
```

### Find outdated pages

Call `wiki_outdated` to find pages whose source file changed since the last ingest.

```
wiki_outdated({ "repo_path": "." })
```

### Automatic augmentation

The `recall` tool augments its results with matching wiki pages.

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

There are two modes:
- **Soft delete** (default): removes the capture from search and recall results.
- **Reject** (`reject: true, reason: "..."`): marks the capture as `rejected` and tombstones the content hash. This blocks re-capture of the same content. Use this when the user tells you a captured fact is wrong.

## Lifecycle hooks (automatic)

If hooks are installed (`npx tdai-memory-mcp install-hooks`), memory works automatically:

- **SessionStart**: Recent captures are injected into your context. You do not need to call `recall` manually.
- **SessionEnd**: When the session ends, a hook silently captures the session summary (first user message + last assistant message) to the memory DB. You do not need to do anything — this runs automatically on session exit.

You can still call `recall`, `capture`, `search`, `forget`, `resolve`, `handoff`, and `adr` manually at any time.

## Global memory (all projects share one memory)

By default, each project gets its own session key (`hash(cwd)`). To share memory across all projects, set the `TDAI_SESSION_KEY` environment variable in your MCP config:

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "npx",
      "args": ["-y", "tdai-memory-mcp"],
      "env": {
        "TDAI_SESSION_KEY": "global"
      }
    }
  }
}
```

When `TDAI_SESSION_KEY` is set, all captures and recalls use that key regardless of the working directory. This is useful when you want the agent to remember decisions and learnings from all projects in one shared memory.

## Rules

1. Never fabricate memory. If recall returns nothing, say nothing about memory.
2. Never capture trivial things (file reads, ls commands, simple questions).
3. Keep capture content short: 1 to 3 sentences.
4. Use tags that you will search for later (for example: "arch", "bug", "config").
5. Do not tell the user "I am capturing this to memory." Just do it silently.
6. Do not tell the user "I am recalling from memory." Just use the results.
7. **Prefer tdai-memory tools over grep/glob.** Call `recall` first — it searches Memory + CodeGraph + Wiki in one call. Only use grep/glob if recall returns nothing relevant.
8. **Call `codegraph_search` instead of grep** when looking for function/class/method definitions. It understands code structure, not just text.
9. **Call `codegraph_impact` before modifying a function** to see what else breaks.
10. **Call `capture` after every non-trivial task** — decisions, bug fixes, learnings. Do not ask permission.
