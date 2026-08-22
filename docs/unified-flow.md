# remem-mcp — Unified Memory Flow Architecture

> Adapted from [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (MIT, Tencent 2026).
> 3 features (F1 Symbolic Short-Term Memory, F2 Memory Proxy, F3 Skill Auto-Extraction) integrated into one continuous flow.

---

## Overview

```
 ┌─────────────────────────────────────────────────────────────┐
 │                    SESSION LIFECYCLE                         │
 │                                                             │
 │  SessionStart ──→ PreToolUse ──→ Tool runs ──→ PostToolUse  │
 │       │              │                          │           │
 │       │              │                          │           │
 │  [memory+skill    [canvas+skill+        [offload→refs       │
 │   +canvas]         danger+errors]        +canvas node       │
 │                                            +error capture]  │
 │       │              │                          │           │
 │       │              │                          ▼           │
 │       │              │                     Stop hook        │
 │       │              │                       │             │
 │       │              │              [auto-capture +         │
 │       │              │               skill extraction]      │
 │       │              │                          │           │
 │       │              │                          ▼           │
 │       │              │                  Next session        │
 │       │              │                  (loop back)         │
 │       │              │                                    │
 │       │              │  PROXY MODE (F2)                   │
 │       │              │  ┌──────────────────────┐          │
 │       │              │  │ POST /v1/chat/...    │          │
 │       │              │  │  inject <remem-mcp>  │          │
 │       │              │  │  memory+skill+canvas │          │
 │       │              │  │  → forward upstream  │          │
 │       │              │  │  → auto-capture resp │          │
 │       │              │  └──────────────────────┘          │
 └─────────────────────────────────────────────────────────────┘
```

---

## Enable the full flow

```bash
# One flag enables F1 (offload) + F3 (skill pipeline)
REMEM_FLOW=full

# F2 (proxy) is separate — start with:
remem-mcp proxy
```

Individual flags (take precedence over REMEM_FLOW):

| Flag | Feature | Default | Effect |
|------|---------|---------|--------|
| `REMEM_FLOW=full` | F1+F3 | (unset) | Enables offload + skill pipeline together |
| `REMEM_OFFLOAD_ENABLED=true` | F1 | `false` | Offload tool outputs to refs + canvas injection |
| `REMEM_PIPELINE=skill` | F3 | `noop` | Auto-extract skills from task captures |
| `REMEM_PIPELINE=mermaid` | F1 | `noop` | Use MermaidPipeline (rule-based canvas) |
| `REMEM_PIPELINE=llm-mermaid` | F1 | `noop` | Use LLMMermaidPipeline (LLM-labeled canvas) |
| `REMEM_PROXY_PORT=8765` | F2 | `8765` | Proxy listen port |
| `REMEM_UPSTREAM_URL` | F2 | `https://api.openai.com` | Upstream LLM URL |
| `REMEM_UPSTREAM_API_KEY` | F2 | (from OPENAI_API_KEY) | Upstream API key |
| `REMEM_PROXY_CAPTURE=true` | F2 | `true` | Auto-capture conversations in proxy mode |
| `REMEM_PROXY_INJECT=true` | F2 | `true` | Inject memory into system prompt in proxy mode |

---

## F1 — Symbolic Short-Term Memory (Mermaid + Context Offloading)

### Concept

Agent reasoning over verbose tool logs wastes tokens. Instead:

1. **Bottom layer** — raw tool output → `refs/{sessionKey}/{nodeId}.md` files
2. **Middle layer** — `canvas_nodes` table (node_id, label, seq, ref_path)
3. **Top layer** — Mermaid graph (cached in `canvases.mermaid_text`)

Agent sees only the Mermaid graph (~100 tokens for 5 steps). Drills down via `ref_read(node_id)` when details are needed.

### Token reduction

| Metric | Raw tool logs | Mermaid canvas | Reduction |
|--------|--------------|----------------|-----------|
| 5 tool calls (~1000 chars each) | 1291 tokens | 100 tokens | **92.3%** |
| TencentDB WideSearch benchmark | — | — | 61% |
| TencentDB SWE-bench benchmark | — | — | 33% |

### Data flow

```
PostToolUse hook
  │
  ├─ offloadToolOutput()
  │    ├─ writeRef(nodeId, rawOutput)  →  refs/{sessionKey}/{nodeId}.md
  │    ├─ appendCanvasNode(nodeId, label, seq, refPath)
  │    └─ appendCanvasEdge(prevNodeId → nodeId, edgeLabel)
  │
  └─ renderCanvasMermaid()  →  update canvases.mermaid_text

PreToolUse hook
  │
  └─ getCanvasContext(dbPath, cwd)
       └─ SELECT mermaid_text, node_count FROM canvases WHERE session_key = ?
            → inject as additionalContext
```

### MCP tools

| Tool | Description |
|------|-------------|
| `canvas_get` | Returns the Mermaid graph for the current session |
| `ref_read(node_id)` | Reads the raw tool output for a specific canvas node |

### Files

| File | Purpose |
|------|---------|
| `src/pipeline/mermaid.ts` | MermaidPipeline + LLMMermaidPipeline |
| `src/storage/refs.ts` | Context offloading (write/read refs/*.md) |
| `src/storage/canvas.ts` | CanvasStorage (SQLite) |
| `src/storage/schema.sql` | `canvases`, `canvas_nodes`, `canvas_edges` tables (schema v9) |

### Schema (v9)

```sql
CREATE TABLE canvases (
  id           TEXT PRIMARY KEY,
  session_key  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  mermaid_text TEXT,          -- cached Mermaid graph
  node_count   INTEGER NOT NULL DEFAULT 0,
  team_id      TEXT
);

CREATE TABLE canvas_nodes (
  id          TEXT PRIMARY KEY,
  canvas_id   TEXT NOT NULL REFERENCES canvases(id),
  node_id     TEXT NOT NULL,   -- ULID for ref_read lookup
  label       TEXT NOT NULL,   -- truncated tool label
  seq         INTEGER NOT NULL,
  ref_path    TEXT,            -- path to refs/*.md file
  tool_name   TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE canvas_edges (
  id          TEXT PRIMARY KEY,
  canvas_id   TEXT NOT NULL REFERENCES canvases(id),
  from_node   TEXT NOT NULL,
  to_node     TEXT NOT NULL,
  label       TEXT             -- e.g. "executed", "ran", "edited"
);
```

---

## F2 — Memory Proxy (HTTP Proxy)

### Concept

Some agents don't support MCP hooks. The Memory Proxy intercepts LLM API calls, injects memory into the system prompt, and auto-captures conversations — zero code changes needed.

### Architecture

```
Agent (any OpenAI/Anthropic client)
  │
  ▼
POST http://localhost:8765/v1/chat/completions
  │
  ├─ SessionStore.getFromHeaders()
  │    └─ x-remem-team, x-remem-agent, x-remem-task, x-remem-user
  │
  ├─ injectMemory()
  │    ├─ storage.search() with teamId/agentId filters
  │    ├─ listAtoms() for top captures
  │    ├─ listScenarios() for team
  │    ├─ readPersona() for user
  │    ├─ searchSkills() for matching skills (F3)
  │    └─ canvas query (F1) if REMEM_OFFLOAD_ENABLED
  │         → builds <remem-mcp> block
  │
  ├─ forwardRequest() → upstream LLM
  │
  └─ captureConversation()
       └─ storage.put() with teamId/agentId binding
```

### Endpoints

| Endpoint | Protocol | Description |
|----------|----------|-------------|
| `POST /v1/chat/completions` | OpenAI | Inject memory → forward → capture |
| `POST /v1/messages` | Anthropic | Inject memory → forward → capture |
| `POST /session/init` | — | Bind team/agent/task to session |
| `GET /health` | — | Health check |

### Session binding

```bash
# Option 1: Headers
curl -H "x-remem-team: my-team" -H "x-remem-agent: dev-agent" ...

# Option 2: Session init
curl -X POST http://localhost:8765/session/init \
  -d '{"teamId":"my-team","agentId":"dev-agent","taskId":"bug-fix"}'
# → {"sessionId":"uuid"}
# Then: curl -H "x-remem-session: <uuid>" ...
```

### Files

| File | Purpose |
|------|---------|
| `src/proxy/server.ts` | HTTP server, routing, upstream forwarding |
| `src/proxy/inject.ts` | Memory query + `<remem-mcp>` block builder |
| `src/proxy/session.ts` | SessionStore (team/agent/task binding) |
| `src/proxy/capture.ts` | Auto-capture conversation after response |

---

## F3 — Skill Auto-Extraction

### Concept

After completing a non-trivial task, the workflow is extracted as a reusable Skill (SOP). Skills are injected into recall when trigger conditions match the current command.

### Extraction pipeline

```
Task capture (type="task")
  │
  ├─ extractSteps()
  │    ├─ Pattern 1: Numbered list (1. 2. 3. or 1) 2) 3))
  │    ├─ Pattern 2: Bullet list (- item or * item)
  │    └─ Pattern 3: "Step N:" patterns
  │
  ├─ extractTriggers()
  │    ├─ From tags (exclude "task")
  │    └─ From first 5 keywords (>4 chars) in content
  │
  ├─ extractValidationRules()
  │    └─ Patterns: verify/check/validate/confirm/success/expected
  │
  └─ putSkill() with:
       ├─ name (from first line or generated)
       ├─ description (first sentence)
       ├─ steps (JSON array)
       ├─ trigger_conditions (JSON array)
       ├─ validation_rules (JSON array)
       ├─ source_capture_ids (traceability)
       └─ version (auto-increment on same name)
```

### Skill injection

| Hook | When | What |
|------|------|------|
| SessionStart | Session begins | Archived skills (always) |
| PreToolUse | Every tool call | Archived skills + matched skills (trigger_conditions overlap with command) |
| Proxy | Every LLM call | searchSkills() with user message as query |

### MCP tools

| Tool | Description |
|------|-------------|
| `skill_create` | Manual skill creation with auto-versioning |
| `skill_archive` | Force always-inject into recall |
| `skill_get` | Read a skill by ID |
| `skill_list` | List skills for a team/agent |
| `skill_search` | Search skills by keyword |

### CLI

```bash
# Batch extract skills from existing task captures
remem-mcp skill-extract
```

### Files

| File | Purpose |
|------|---------|
| `src/pipeline/skill.ts` | SkillExtractionPipeline (rule-based, no LLM) |
| `src/storage/schema.sql` | `skills` table with v9 columns |
| `src/hook-handlers.ts` | `extractSkillFromCapture()` in Stop hook |

### Schema (v9 additions)

```sql
ALTER TABLE skills ADD COLUMN trigger_conditions TEXT;   -- JSON array
ALTER TABLE skills ADD COLUMN steps TEXT;                -- JSON array
ALTER TABLE skills ADD COLUMN validation_rules TEXT;     -- JSON array
ALTER TABLE skills ADD COLUMN source_capture_ids TEXT;   -- JSON array
ALTER TABLE skills ADD COLUMN archived INTEGER DEFAULT 0;
```

---

## Unified Flow — How F1 + F2 + F3 connect

### PreToolUse: contextBlocks merge

The key integration point. PreToolUse no longer early-returns on canvas injection. Instead, it collects all context blocks and merges them:

```typescript
const contextBlocks: string[] = [];

// F1: Canvas
if (REMEM_OFFLOAD_ENABLED) {
  contextBlocks.push(getCanvasContext(dbPath, cwd));
}

// F3: Skills (archived + matched)
contextBlocks.push(getSkillContext(dbPath, command));

// Existing: Danger warning
if (dangerWarning) contextBlocks.push(dangerWarning);

// Existing: Error prediction (Write/Edit)
if (fileErrors.length > 0) contextBlocks.push(errorWarning);

// Existing: Error injection (lint/build/test)
if (decayed.length > 0) contextBlocks.push(errorContext);

// Merge and output
output.additionalContext = contextBlocks.join("\n\n");
```

### SessionStart: triple injection

```
SessionStart
  ├─ [existing] Recent captures (memory)
  ├─ [existing] Persona (L3)
  ├─ [F3] Archived skills (always inject)
  └─ [F1] Canvas from last session (if exists)
```

### Stop hook: auto-extraction

```
Stop hook
  ├─ [existing] captureSessionTranscript()
  └─ [F3] extractSkillFromCapture()
       └─ if capture.type == "task" && steps >= 2
            → auto-create skill with triggers + steps
```

### Proxy: full injection

```
POST /v1/chat/completions
  └─ injectMemory()
       ├─ [existing] recall (hybrid search)
       ├─ [existing] atoms (L1)
       ├─ [existing] scenarios (L2)
       ├─ [existing] persona (L3)
       ├─ [F3] skills (searchSkills)
       └─ [F1] canvas (if offload enabled)
            → <remem-mcp> block in system prompt
```

---

## File map

### New files (F1)

| File | Lines | Purpose |
|------|-------|---------|
| `src/pipeline/mermaid.ts` | ~200 | MermaidPipeline + LLMMermaidPipeline |
| `src/storage/refs.ts` | ~150 | Context offloading (write/read refs/*.md) |
| `src/storage/canvas.ts` | ~100 | CanvasStorage (SQLite) |

### New files (F2)

| File | Lines | Purpose |
|------|-------|---------|
| `src/proxy/server.ts` | ~350 | HTTP server, routing, upstream forwarding |
| `src/proxy/inject.ts` | ~190 | Memory query + `<remem-mcp>` block builder |
| `src/proxy/session.ts` | ~60 | SessionStore (team/agent/task binding) |
| `src/proxy/capture.ts` | ~80 | Auto-capture conversation |

### New files (F3)

| File | Lines | Purpose |
|------|-------|---------|
| `src/pipeline/skill.ts` | ~180 | SkillExtractionPipeline (rule-based) |

### Modified files

| File | Changes |
|------|---------|
| `src/config.ts` | `REMEM_FLOW=full`, `pipeline: "skill"`, schema v9 |
| `src/storage/schema.sql` | `canvases`, `canvas_nodes`, `canvas_edges` tables; `skills` v9 columns |
| `src/storage/sqlite.ts` | `putSkill` v9 fields, `skillRowToEntry` v9 fields, canvas methods |
| `src/storage/types.ts` | `SkillEntry` v9 fields, `MermaidCanvas` interface |
| `src/index.ts` | `proxy` CLI command, `skill-extract` CLI command, pipeline wiring |
| `src/server.ts` | `canvas_get`, `ref_read`, `skill_create`, `skill_archive` MCP tools |
| `src/hook-handlers.ts` | PreToolUse contextBlocks merge, SessionStart canvas+skill injection, Stop hook skill extraction, PostToolUse offload, `getCanvasContext`, `getSkillContext`, `extractSkillFromCapture` |
| `tests/smoke.test.ts` | Updated tool count (40 → 45) |

---

## Test results

| Test | Result |
|------|--------|
| F1: 5 tool calls → canvas 5 nodes, refs 5 files | 92.3% token reduction |
| F1: PreToolUse injects canvas | `canvas=True` |
| F2: Proxy memory injection | `has_memory=True` (2nd turn) |
| F2: Proxy auto-capture | Verified via search after session |
| F3: skill_create + skill_archive | Skill injected into SessionStart |
| F3: Auto-extraction from task capture | 4 steps + 5 triggers extracted |
| Unified: PreToolUse canvas + skill together | `canvas=True skill=True` |
| Smoke tests | 14/14 pass |

---

## Comparison with TencentDB Agent Memory

| Feature | TencentDB | remem-mcp |
|---------|-----------|-----------|
| Mermaid canvas | 61% token reduction (WideSearch) | 92.3% (synthetic test) |
| Memory Proxy | OpenAI + Anthropic dual protocol | Same |
| Skill extraction | LLM-based | Rule-based (no LLM needed) + LLM option |
| Session binding | sessionInit API | Headers + sessionInit |
| Auto-capture | Yes | Yes |
| Schema | SQLite + sqlite-vec | Same |
| MCP-native | No (HTTP only) | Yes (MCP + HTTP proxy) |
| Zero-config | Docker required | No Docker, single binary |
| Global memory | No | Yes (cross-project) |

---

## CLI commands

```bash
# Start MCP server (stdio)
remem-mcp

# Start Memory Proxy (HTTP)
remem-mcp proxy

# Batch extract skills from existing captures
remem-mcp skill-extract

# Hooks (called by Claude Code / Devin CLI automatically)
remem-mcp hook-recall           # SessionStart
remem-mcp hook-user-prompt-submit
remem-mcp hook-pre-tool-use     # PreToolUse (canvas + skills + errors)
remem-mcp hook-post-tool-use    # PostToolUse (offload + canvas node)
remem-mcp hook-stop             # Stop (auto-capture + skill extraction)
remem-mcp hook-pre-compact
remem-mcp hook-post-compaction
```
