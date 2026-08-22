# remem-mcp Architecture

High-level system design. Last updated Aug 2026.

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        AI Agent                              │
│                  (Claude Code / Devin / Cursor)              │
└──────────┬──────────────────────────────┬───────────────────┘
           │ MCP JSON-RPC                 │ Hooks (stdin/stdout)
           ▼                              ▼
┌─────────────────────┐          ┌──────────────────────┐
│   MCP Server         │          │  Hook Handlers       │
│   (src/server.ts)    │          │  (src/hook-handlers)  │
│                      │          │                      │
│  45 tools:           │          │  SessionStart        │
│  • recall            │          │  UserPromptSubmit    │
│  • capture           │          │  PreToolUse          │
│  • search            │          │  PostToolUse         │
│  • codegraph_*       │          │  Stop                │
│  • wiki_*            │          │  PostCompact         │
│  • canvas_get        │          │                      │
│  • ref_read          │          │  Inject: L2/L3/skills│
│  • skill_*           │          │  +canvas+skills      │
│  • handoff/adr       │          │  Auto-capture: facts │
│  • proxy (HTTP)      │          │  Offload: refs+canvas│
└──────────┬───────────┘          └─────────┬────────────┘
           │                                 │
           │                                 │ spawn
           │                                 ▼
           │                       ┌──────────────────┐
           │                       │ Background Worker │
           │                       │ (pipeline/worker) │
           │                       │                  │
           │                       │ L0 → L1 → L2 → L3│
           │                       │ Auto-extract     │
           │                       │ Auto-consolidate │
           │                       │ Auto-persona     │
           │                       └────────┬─────────┘
           │                                 │
           ▼                                 ▼
┌─────────────────────────────────────────────────────────────┐
│                     SQLite (memory.db)                       │
│                                                              │
│  ┌─────────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │  Captures   │  │  Atoms   │  │ Scenarios│  │  Persona │ │
│  │  (L0 raw)   │  │  (L1)    │  │  (L2)    │  │  (L3)    │ │
│  └─────────────┘  └──────────┘  └──────────┘  └──────────┘ │
│                                                              │
│  ┌─────────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │  Symbols    │  │  Calls   │  │  Imports  │  │  Skills  │ │
│  │  (CodeGraph)│  │(CodeGraph)│  │(CodeGraph)│  │  (F3)    │ │
│  └─────────────┘  └──────────┘  └──────────┘  └──────────┘ │
│                                                              │
│  ┌─────────────┐  ┌──────────┐  ┌──────────┐               │
│  │ Wiki Pages  │  │   ADRs   │  │  Canvas  │               │
│  └─────────────┘  └──────────┘  │ (F1:     │               │
│                                 │  Mermaid)│               │
│  ┌─────────────┐                └──────────┘               │
│  │  Refs       │  ┌──────────┐                              │
│  │  (F1: *.md) │  │ Persona  │                              │
│  └─────────────┘  └──────────┘                              │
└─────────────────────────────────────────────────────────────┘
```

## Memory Pipeline (L0 → L3)

```
Agent session
    │
    ▼
┌──────────┐     capture()      ┌──────────┐
│  Agent    │──────────────────▶│   L0     │  Raw content + tags
│  writes   │   (with atoms[])  │ Captures │  + optional L1 atoms
└──────────┘                    └────┬─────┘
                                     │
                          Stop hook  │  spawn worker
                                     ▼
                              ┌──────────┐
                              │   L1     │  Distilled facts
                              │  Atoms   │  (confidence, tags)
                              └────┬─────┘
                                   │
                    5+ atoms       │  same topic
                    same topic     ▼
                              ┌──────────┐
                              │   L2     │  Consolidated
                              │ Scenarios│  summaries
                              └────┬─────┘
                                   │
                    repeated tags  │  2+ occurrences
                    in captures    ▼
                              ┌──────────┐
                              │   L3     │  User preferences
                              │ Persona  │  + behavior patterns
                              └──────────┘

Injection (reverse flow):
    SessionStart ──▶ L2 scenarios + L3 persona + skills → agent context
    UserPromptSubmit ──▶ BM25 match → agent context
```

## CodeGraph Pipeline

```
codegraph_index({ path })
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  indexDirectory()                                     │
│                                                       │
│  for each file:                                       │
│    1. detectLanguage() ──── skip if unknown           │
│    2. readFileSync() ────── skip if >3000 lines       │
│    3. tree-sitter parse() ── skip if >200KB           │
│    4. extractSymbols() ──── functions, classes, methods│
│    5. extractCalls() ────── 3-pass regex on body text │
│       ├─ JSX:  <Component/>                           │
│       ├─ Method: obj.method()                         │
│       └─ Simple: foo()                                │
│    6. stdlib filter ────── skip fmt.Printf, console   │
│    7. INSERT symbols + calls + imports                │
│                                                       │
│  after all files:                                     │
│    8. resolveAllCalls() ── 6-strategy cascade         │
└───────────────────────┬──────────────────────────────┘
                        │
                        ▼
              ┌─────────────────┐
              │  6-Strategy     │
              │  Call Resolution│
              │                 │
              │  1. Import map  │── 0.95
              │  2. Import suff │── 0.85
              │  3. Same module │── 0.90
              │  4. Unique name │── 0.75
              │  5. Suffix match│── 0.55
              │  6. Fuzzy       │── 0.35
              └─────────────────┘

Query tools:
  codegraph_search ──▶ SELECT * FROM symbols WHERE name LIKE
  codegraph_callers ─▶ JOIN calls → symbols (inbound)
  codegraph_callees ─▶ JOIN calls → symbols (outbound)
  codegraph_impact ──▶ BFS traversal, depth N
  codegraph_detect_changes ─▶ git diff → symbols → callers → risk
```

## Hook Lifecycle

```
Session start
    │
    ▼
┌──────────────┐     Inject into agent context:
│ SessionStart │     • L2 scenarios (recent)
│ hook         │     • L3 persona (language, style, prefs)
└──────┬───────┘     • Skills (matched by query)
       │             • Canvas from last session (F1)
       ▼
  Agent receives prompt
       │
       ▼
┌──────────────────┐   Inject into agent context:
│ UserPromptSubmit │   • BM25 memory match (shallow, fast)
│ hook             │   • Auto-capture facts from prompt
└──────┬───────────┘
       │
       ▼
  Agent calls a tool (Bash, Write, Edit, etc.)
       │
       ▼
┌──────────────────┐   Inject into agent context:
│ PreToolUse       │   • Canvas (F1: Mermaid graph, ~100 tokens)
│ hook             │   • Skills (F3: archived + matched by trigger)
└──────┬───────────┘   • Danger warning (npm publish, docker prune...)
       │             • Error prediction (file error history)
       ▼             • Past errors (lint/build/test, decayed)
  Tool executes
       │
       ▼
┌──────────────────┐   1. Offload tool output to refs/*.md (F1)
│ PostToolUse      │   2. Append node to Mermaid canvas (F1)
│ hook             │   3. Capture errors/patterns/decisions (L0)
└──────┬───────────┘   4. Skill extraction if task capture (F3)
       │
       ▼
┌──────────┐   1. Capture session transcript (L0)
│ Stop     │   2. Spawn background worker
│ hook     │   3. Worker: L0 → L1 atoms → L2 scenarios → L3 persona
└──────────┘   4. Auto-extract skills from task captures (F3)
```

## Unified Flow (F1 + F2 + F3)

Three features integrated into one continuous flow. Enable with `REMEM_FLOW=full`.

### F1 — Symbolic Short-Term Memory (Mermaid Canvas)

Replaces verbose tool logs with a compact Mermaid graph. PostToolUse offloads raw output to `refs/{sessionKey}/{nodeId}.md` and appends a node to the canvas. PreToolUse injects the Mermaid graph (~100 tokens for 5 steps). Drill down via `ref_read(node_id)`.

**92% token reduction** vs. raw tool logs.

```
PostToolUse                    PreToolUse
  │                              │
  ├─ writeRef(nodeId, raw)       └─ getCanvasContext()
  │   → refs/{sessionKey}/*.md       → SELECT mermaid_text FROM canvases
  ├─ appendCanvasNode()              → inject as additionalContext
  └─ renderCanvasMermaid()
      → update canvases.mermaid_text
```

Tools: `canvas_get`, `ref_read`. Files: `src/pipeline/mermaid.ts`, `src/storage/refs.ts`, `src/storage/canvas.ts`.

### F2 — Memory Proxy (HTTP)

For agents without MCP hook support. Intercepts OpenAI/Anthropic API calls, injects memory into system prompt, auto-captures conversations.

```
Agent → POST :8765/v1/chat/completions
         ├─ injectMemory() → <remem-mcp> block (recall + skills + canvas)
         ├─ forwardRequest() → upstream LLM
         └─ captureConversation() → storage.put()
```

Endpoints: `POST /v1/chat/completions` (OpenAI), `POST /v1/messages` (Anthropic), `POST /session/init`, `GET /health`. Files: `src/proxy/server.ts`, `src/proxy/inject.ts`, `src/proxy/session.ts`, `src/proxy/capture.ts`.

### F3 — Skill Auto-Extraction

Stop hook detects step-by-step task captures and auto-creates reusable Skills with trigger conditions, steps, and validation rules. Skills are injected into PreToolUse when triggers match the current command.

```
Task capture (type="task")
  └─ extractSkillFromCapture()
       ├─ extractSteps() — numbered/bullet/"Step N:" patterns
       ├─ extractTriggers() — from tags + content keywords
       ├─ extractValidationRules() — verify/check/validate patterns
       └─ putSkill() with auto-versioning
```

Tools: `skill_create`, `skill_archive`, `skill_get`, `skill_list`, `skill_search`. CLI: `remem-mcp skill-extract`. Files: `src/pipeline/skill.ts`.

See [docs/unified-flow.md](docs/unified-flow.md) for full architecture.

## File Layout

```
src/
├── index.ts              # Entry: CLI + MCP server + proxy CLI
├── server.ts             # MCP tool dispatcher (45 tools)
├── hooks.ts              # Hook entry point (stdin → handler)
├── hook-handlers.ts      # SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop logic
├── install-skill.ts      # Auto-install SKILL.md to agent config
│
├── codegraph/
│   ├── engine.ts         # Index, search, callers, callees, impact
│   └── resolver.ts       # 6-strategy call resolution cascade
│
├── pipeline/
│   ├── atom.ts           # L0 → L1 atom extraction
│   ├── worker.ts         # Background: L1 → L2 → L3 auto-consolidation
│   ├── mermaid.ts        # F1: MermaidPipeline + LLMMermaidPipeline
│   └── skill.ts          # F3: SkillExtractionPipeline (rule-based)
│
├── proxy/                # F2: Memory Proxy (HTTP)
│   ├── server.ts         # HTTP server, routing, upstream forwarding
│   ├── inject.ts         # Memory query + <remem-mcp> block builder
│   ├── session.ts        # SessionStore (team/agent/task binding)
│   └── capture.ts        # Auto-capture conversation
│
├── storage/
│   ├── sqlite.ts         # DB wrapper + schema migrations (v1→v9)
│   ├── schema.sql        # DDL: captures, atoms, symbols, calls, canvases, skills...
│   ├── canvas.ts         # F1: CanvasStorage (Mermaid nodes + edges)
│   ├── refs.ts           # F1: Context offloading (write/read refs/*.md)
│   └── types.ts          # TypeScript interfaces
│
└── cli/
    ├── consolidate.ts    # Manual L1→L2 consolidation
    ├── extract.ts        # Manual L0→L1 extraction
    ├── persona.ts        # View/update L3 persona
    └── worker.ts         # CLI: remem-mcp worker-run
```

## Schema (v9)

```
captures (L0)          atoms (L1)           scenarios (L2)
┌──────────────┐       ┌──────────────┐     ┌──────────────┐
│ id           │       │ id           │     │ id           │
│ type         │       │ capture_id   │──▶   │ title        │
│ content      │       │ content      │     │ summary      │
│ tags (JSON)  │       │ confidence   │     │ atom_ids     │
│ content_hash │       │ tags (JSON)  │     │ topic        │
│ team_id      │       │ team_id      │     │ team_id      │
│ trust_state  │       └──────────────┘     └──────────────┘
│ access_count │
│ ...          │       persona (L3)        skills (F3)
└──────────────┘       ┌──────────────┐     ┌──────────────┐
                       │ key          │     │ id           │
symbols (CodeGraph)    │ value        │     │ name         │
┌──────────────┐       │ team_id      │     │ trigger_cond │
│ id           │       │ user_id      │     │ steps (JSON) │
│ name         │       └──────────────┘     │ validation   │
│ kind         │                            │ source_ids   │
│ file_path    │       calls (CodeGraph)     │ archived     │
│ line_start   │       ┌──────────────┐     │ team_id      │
│ line_end     │       │ caller_id    │──▶ symbols.id     └──────────────┘
│ language     │       │ callee_name  │
│ module_path  │       │ callee_id    │──▶ symbols.id (resolved)
│ content_hash │       │ confidence   │    (0.0-1.0)
│ team_id      │       │ call_type    │    (direct/method/jsx)
└──────────────┘       │ line         │
                       │ team_id      │     canvases (F1)
                       └──────────────┘     ┌──────────────┐
                                            │ id           │
                                            │ session_key  │
                                            │ mermaid_text │ (cached graph)
                                            │ node_count   │
                                            │ team_id      │
                                            └──────┬───────┘
                                                   │
                                            canvas_nodes        canvas_edges
                                            ┌──────────────┐    ┌──────────────┐
                                            │ id           │    │ id           │
                                            │ canvas_id    │──▶ │ canvas_id    │
                                            │ node_id      │    │ from_node    │
                                            │ label        │    │ to_node      │
                                            │ seq          │    │ label        │
                                            │ ref_path     │    └──────────────┘
                                            │ tool_name    │
                                            └──────────────┘
```

## Performance (Aug 2026 dogfood)

```
Repo          Files   Symbols   Calls    Resolved   Time
────────────  ─────   ───────   ─────    ────────   ────
remem-mcp        79      301    6,456       24%      3.1s
AZR Go          455    3,417   41,603       34%      111s
Orca TS       3,000    7,632   78,981       28%      705s

Bottleneck: tree-sitter parsing (~300ms/file on large TS files)
Unresolved calls: stdlib (fmt.Printf, console.log, JSON.stringify)
```
