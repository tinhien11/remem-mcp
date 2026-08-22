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
│  15 tools:           │          │  SessionStart        │
│  • recall            │          │  UserPromptSubmit    │
│  • capture           │          │  Stop                │
│  • search            │          │  PostCompact         │
│  • codegraph_*       │          │                      │
│  • wiki_*            │          │  Inject: L2/L3/skills│
│  • handoff/adr       │          │  Auto-capture: facts │
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
│  │  (CodeGraph)│  │(CodeGraph)│  │(CodeGraph)│  │          │ │
│  └─────────────┘  └──────────┘  └──────────┘  └──────────┘ │
│                                                              │
│  ┌─────────────┐  ┌──────────┐                               │
│  │ Wiki Pages  │  │   ADRs   │                               │
│  └─────────────┘  └──────────┘                               │
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
       │
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
  Agent works (calls MCP tools: recall, capture, codegraph_*)
       │
       ▼
┌──────────┐   1. Capture session transcript (L0)
│ Stop     │   2. Spawn background worker
│ hook     │   3. Worker: L0 → L1 atoms → L2 scenarios → L3 persona
└──────────┘
```

## File Layout

```
src/
├── index.ts              # Entry: CLI + MCP server
├── server.ts             # MCP tool dispatcher (15 tools)
├── hooks.ts              # Hook entry point (stdin → handler)
├── hook-handlers.ts      # SessionStart/UserPromptSubmit/Stop logic
├── install-skill.ts      # Auto-install SKILL.md to agent config
│
├── codegraph/
│   ├── engine.ts         # Index, search, callers, callees, impact
│   └── resolver.ts       # 6-strategy call resolution cascade
│
├── pipeline/
│   ├── atom.ts           # L0 → L1 atom extraction
│   └── worker.ts         # Background: L1 → L2 → L3 auto-consolidation
│
├── storage/
│   ├── sqlite.ts         # DB wrapper + schema migrations (v1→v9)
│   ├── schema.sql        # DDL: captures, atoms, symbols, calls...
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
│ ...          │       persona (L3)        skills
└──────────────┘       ┌──────────────┐     ┌──────────────┐
                       │ key          │     │ id           │
symbols (CodeGraph)    │ value        │     │ name         │
┌──────────────┐       │ team_id      │     │ trigger      │
│ id           │       │ user_id      │     │ instructions │
│ name         │       └──────────────┘     │ team_id      │
│ kind         │                            └──────────────┘
│ file_path    │       calls (CodeGraph)
│ line_start   │       ┌──────────────┐
│ line_end     │       │ caller_id    │──▶ symbols.id
│ language     │       │ callee_name  │
│ module_path  │       │ callee_id    │──▶ symbols.id (resolved)
│ content_hash │       │ confidence   │    (0.0-1.0)
│ team_id      │       │ call_type    │    (direct/method/jsx)
└──────────────┘       │ line         │
                       │ team_id      │
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
