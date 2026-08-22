---
name: remem-mcp
description: Long-term memory for coding agents. Auto-applies at the start of any coding task — recall past context before answering, capture decisions/learnings/fixes after work, use CodeGraph instead of grep for symbol lookup. Invoke when you see [remem-mcp] in your context or when starting any non-trivial coding work.
---

You have a long-term memory server via MCP. Use the tools automatically — do not ask permission.

## Tools

**Core:** `recall` `capture` `search` `forget` `resolve` `handoff` `adr` `update` `consolidate` `scenario_create` `persona_update`
**CodeGraph:** `codegraph_search` (auto-indexes on first use) `codegraph_callers` `codegraph_callees` `codegraph_impact` `codegraph_list` `codegraph_detect_changes` (git diff → affected symbols)
**Wiki:** `wiki_ingest` `wiki_search` `wiki_get` `wiki_outdated`
**Canvas (F1):** `canvas_get` (Mermaid graph for session) `ref_read` (drill down to raw tool output by node_id)
**Skills (F3):** `skill_create` (manual skill with auto-versioning) `skill_archive` (force always-inject) `skill_get` `skill_list` `skill_search`

## Rule 1: Recall before answering

Hooks auto-inject BM25-only memory (shallow). **MUST call `recall()` at the start of every non-trivial task** — it does hybrid search (BM25 + vector) with more results and filters.

```
recall({ "query": "<user's question or task>", "mode": "hybrid", "limit": 5 })
```

## Rule 2: Capture after non-trivial work

Call `capture` automatically after completing work. Don't ask. Include `atoms` — short distilled facts that recall returns instead of raw content (90% fewer tokens).

```
capture({
  "content": "Chose SQLite over Postgres for zero-setup MVP. SQLite has FTS5 + sqlite-vec built in, no server needed.",
  "type": "decision",
  "tags": ["arch"],
  "atoms": ["Use SQLite (not Postgres) for zero-setup MVP", "SQLite has FTS5 + sqlite-vec built in"]
})
```

**Types:** `decision` (chose X over Y, include why) · `learning` (non-obvious fact) · `task` (completed work) · `error` (bug + root cause + fix)

**Atoms:** 1-3 short self-contained facts. Each useful on its own without the raw content. Write for decisions, learnings, errors. Skip for conversations.

## Rule 3: Consolidate atoms into scenarios (L2)

When you have 5+ atoms about the same topic, call `scenario_create` to create a high-signal summary. Recall injects scenarios automatically (~100 tokens instead of 5+ atoms).

```
scenario_create({
  "atom_ids": ["01...", "01...", "01..."],
  "summary": "Database: SQLite chosen for MVP — FTS5 + sqlite-vec built in, zero setup, no server needed.",
  "persona_tags": ["database", "arch"]
})
```

**When:** After capturing 5+ decisions/learnings about the same topic (e.g., database, hooks, deployment).

**Auto-pipeline:** The Stop hook spawns a background worker that auto-extracts L1 atoms from uncaptured L0 entries, auto-consolidates 5+ atoms on the same topic into L2 scenarios, and auto-updates L3 persona from repeated tags. You don't need to call `scenario_create` or `persona_update` manually — the worker does it. Only call them manually if you want a specific summary the worker wouldn't generate.

## Rule 4: Update persona (L3)

When you notice a user preference or pattern (2+ occurrences), call `persona_update`. SessionStart AND UserPromptSubmit inject persona automatically every turn (~50 tokens).

```
persona_update({ "trait": "language", "value": "Vietnamese" })
persona_update({ "trait": "output_style", "value": "concise" })
```

**When:** User asks for concise output 2+ times, works in a specific language, prefers a framework, uses a specific project.

**Auto-pipeline:** The background worker auto-detects tags appearing 2+ times in captures and appends them to persona. Manual `persona_update` is for explicit user preferences the worker can't detect.

## Rule 5: Use CodeGraph instead of grep

For function/class/method definitions, call `codegraph_search` — NOT grep. Auto-indexes `src/` on first use.

```
codegraph_search({ "query": "handleCapture" })
codegraph_callers({ "symbol_id": "<id from search>" })
codegraph_detect_changes({ "repo_path": "/abs/path" })  // git diff → affected symbols + risk
```

CodeGraph uses 6-strategy call resolution (import-map → same-module → unique-name → suffix → fuzzy) with confidence scoring. JSX components (`<FleetMap/>`) and method calls (`obj.method()`) are captured. Stdlib calls (fmt.Printf, console.log) are filtered out.

Use grep only for: string literals, config values, file names.

## Other tools

- `forget({ "id", "confirm": true })` — only when user asks to delete. `reject: true` blocks re-capture of wrong info.
- `handoff({ "task", "status", "progress", "next_steps" })` — at session end or before switching agents.
- `adr({ "title", "context", "decision", "alternatives", "consequences" })` — for architectural decisions.
- `search({ "query", "filters": { "type", "tags" } })` — when you need specific filters.
- `resolve` — when two captures conflict. `supersedes` on `capture` replaces old values.
- `update` — correct a capture's content/tags.
- `consolidate({ "threshold": 0.75 })` — merge duplicate captures. `scenario_create({ "atom_ids", "summary" })` — create L2 scenario. `persona_update({ "trait", "value" })` — update L3 persona.

## Global + project memory

Set `REMEM_GLOBAL_SESSION_KEY=global` to enable cross-project memory. `recall`/`search` search both. Pass `auto_global=true` to `capture` for auto-classification (generic → global, file paths → project).

## Unified Flow (F1 + F2 + F3)

Enable with `REMEM_FLOW=full`. Three features work as one continuous flow:

### F1 — Symbolic Short-Term Memory (Mermaid Canvas)

PostToolUse offloads verbose tool output to `refs/*.md` files and appends a node to a Mermaid canvas. PreToolUse injects the canvas (~100 tokens for 5 steps) so you reason over symbols, not raw logs. **92% token reduction.**

- `canvas_get({ "format": "mermaid" })` — get the Mermaid graph for the current session
- `canvas_get({ "format": "json" })` — get structured nodes/edges
- `ref_read({ "node_id": "01MT..." })` — drill down to raw tool output for a specific node

Enable: `REMEM_FLOW=full` or `REMEM_OFFLOAD_ENABLED=true` + `REMEM_PIPELINE=mermaid`.

### F2 — Memory Proxy (HTTP)

For agents without MCP hook support. Start with `remem-mcp proxy` (port 8765). Point your agent's base URL to `http://localhost:8765`. The proxy injects memory into the system prompt and auto-captures conversations. Supports OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) protocols.

Session binding via headers: `x-remem-team`, `x-remem-agent`, `x-remem-task`, `x-remem-user`. Or `POST /session/init`.

### F3 — Skill Auto-Extraction

Stop hook detects step-by-step task captures (numbered lists, bullet lists, "Step N:" patterns) and auto-creates reusable Skills with trigger conditions, steps, and validation rules. Skills are injected into PreToolUse when triggers match the current command. Archived skills are always injected.

- `skill_create({ "name", "description", "steps", "trigger_conditions", "validation_rules" })` — manual skill creation
- `skill_archive({ "id" })` — force always-inject into recall
- `skill_search({ "query" })` — search skills by keyword
- CLI: `remem-mcp skill-extract` — batch extract from existing task captures

Enable: `REMEM_FLOW=full` or `REMEM_PIPELINE=skill`.
