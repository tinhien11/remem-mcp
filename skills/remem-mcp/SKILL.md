---
name: remem-mcp
description: Long-term memory for coding agents. Auto-applies at the start of any coding task — recall past context before answering, capture decisions/learnings/fixes after work, use CodeGraph instead of grep for symbol lookup. Invoke when you see [remem-mcp] in your context or when starting any non-trivial coding work.
---

You have a long-term memory server via MCP. Use the tools automatically — do not ask permission.

## Tools

**Core:** `recall` `capture` `search` `forget` `resolve` `handoff` `adr` `update` `consolidate`

**CodeGraph:** `codegraph_search` (auto-indexes on first use) `codegraph_callers` `codegraph_callees` `codegraph_impact` `codegraph_list`

**Wiki:** `wiki_ingest` `wiki_search` `wiki_get` `wiki_outdated`

## Rule 1: Recall before answering

Memory is auto-injected on `UserPromptSubmit` — hooks run BM25-only recall (fast, shallow) and inject top 5 results. But this is a subset of what `recall()` provides.

**MUST call `recall()` at the start of every non-trivial task** — even if memory was injected. The hook uses BM25-only (no vector search, no filters). `recall()` does hybrid search (BM25 + sqlite-vec) with more results, filters, and global memory fallback.

```
recall({ "query": "<user's question or task>", "mode": "hybrid" })
```

If recall returns nothing, proceed normally. Don't mention the empty result.

## Rule 2: Capture after non-trivial work

Call `capture` automatically after completing work. Don't ask.

```
capture({ "content": "Chose SQLite over Postgres for zero-setup MVP.", "type": "decision", "tags": ["arch"] })
```

**Types:** `decision` (chose X over Y, include why) · `learning` (non-obvious fact) · `task` (completed work) · `error` (bug + root cause + fix) · `conversation` (multi-turn, pass `messages`)

**Good:** specific, useful later. **Bad:** "We talked about the database."

## Rule 3: Use CodeGraph instead of grep

For function/class/method definitions, call `codegraph_search` — NOT grep. It auto-indexes `src/` on first use, no setup needed.

```
codegraph_search({ "query": "handleCapture" })
codegraph_callers({ "symbol_id": "<id from search>" })
codegraph_impact({ "symbol_id": "<id>" })  // before modifying a function
```

Use grep only for: string literals, config values, file names.

## Rule 4: Handoff when switching agents

Call `handoff` at session end or before switching agents. Creates a packet the next agent loads via `recall`.

```
handoff({ "task": "Fix auth bug", "status": "in_progress", "progress": "Found root cause", "next_steps": ["Implement fix"] })
```

Skip if task is done or trivial.

## Rule 5: Forget only on explicit request

Call `forget` ONLY when the user asks to delete. Always require `confirm: true`.

```
forget({ "id": "<id>", "confirm": true, "reject": true, "reason": "Wrong: port is 9090 not 8080." })
```

`reject: true` tombstones the content hash — blocks re-capture of wrong info.

## Trust states

- `candidate` (default) → `verified` (confirmed correct) → `stale` (replaced, via `resolve` or `supersedes`) → `rejected` (wrong, via `forget`)
- Use `resolve` when two captures conflict. Use `supersedes` on `capture` to replace an old value.

## ADR for architectural decisions

Use `adr` (not `capture`) for decisions with context, alternatives, and consequences.

```
adr({ "title": "Use SQLite", "context": "Need zero-setup", "decision": "SQLite + FTS5 + sqlite-vec", "alternatives": ["Postgres+pgvector", "DuckDB"], "consequences": "Single-writer, no remote access" })
```

## Search with filters

Use `search` (not `recall`) when you need specific filters:

```
search({ "query": "auth", "filters": { "type": "decision", "tags": ["arch"] } })
```

## Update and consolidate

- `update` — correct a capture's content/tags. Preserves ID and created_at.
- `consolidate` — find and merge duplicates. `consolidate({ "threshold": 0.75 })` to dry-run, add `"confirm": true` to merge.

## Hooks (automatic if installed)

If `npx remem-mcp install-hooks` was run:
- **SessionStart** — recent captures injected automatically
- **UserPromptSubmit** — heuristic recall: memory matching the user's prompt is injected automatically (skips short acks, ~60-80% skip rate). You do NOT need to call `recall` for prompts that match — the context is already in your context window. Only call `recall` for deeper retrieval or when the injected memory is insufficient.
- **PreToolUse** — past errors injected before lint/build/test
- **PostToolUse** — failed commands auto-captured with root cause
- **PreCompact** — saves a checkpoint before context compaction (Claude Code only)
- **PostCompaction** — re-injects memory after context compaction (all agents)
- **Stop** — auto-captures session transcript + reminds to handoff
- **SessionEnd** — session summary auto-captured

You can still call tools manually anytime.

## Multi-tenant

Pass `team_id`, `agent_id`, `user_id`, or `task_id` to isolate memory between teams/projects.

## Global + project memory

Set `REMEM_GLOBAL_SESSION_KEY=global` in MCP config to enable cross-project memory.

**How it works:**
- `recall` and `search` automatically search both project and global memory. Project results appear first, then global.
- `session_start` returns recent captures from both project and global sessions.
- 3 slots are reserved for global results so cross-project knowledge isn't buried when project memory is large.

**When to store global memory:**
- Pass `session_key="global"` to `capture` for: coding conventions, tool preferences, recurring patterns, lessons that apply to any project.
- Or pass `auto_global=true` — server auto-classifies: generic rules/learnings → global, content with file paths/line numbers → project.
- Don't store global: project-specific bugs, file paths, one-off decisions.

**Example:**
```
capture(content="Always run tests before committing", type="learning", auto_global=true)
# → auto-classified as global (no file paths, has "always" signal)

capture(content="Fixed bug in src/server.ts line 1418", type="task", auto_global=true)
# → stays project (has file path)
```

## CLI commands

```bash
npx remem-mcp errors              # Error learning dashboard
npx remem-mcp extract --limit 50  # L1 atom extraction (needs REMEM_LLM_API_KEY)
npx remem-mcp sync-export         # Export memory for team (commit to repo)
npx remem-mcp sync-import         # Import teammate's memory
```
