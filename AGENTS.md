# Agent Rules

## Always use remem-mcp

You have a long-term memory server (`remem-mcp` MCP). Always prefer it over grep/glob for code navigation and project context.

### Before answering or coding
1. Check for `[remem-mcp]` at the top of the turn — hooks auto-inject matching memory
2. **MUST call `recall()` at the start of every non-trivial task** — even if memory was injected. Injected memory is BM25-only (fast, shallow). `recall()` does hybrid search (BM25 + vector) with more results and filters.
3. Use results to inform your answer — don't repeat what recall already gave you

### Before searching code
1. Call `search` or `recall` first — it searches Memory + CodeGraph + Wiki in one call
2. Only use grep/glob if recall returns nothing relevant

### For code navigation
- Use `search` to find symbols (faster than grep, understands function/class/method structure)
- Use CodeGraph data from recall results for callers/callees/impact analysis
- Only read files directly when you know the exact path

### After completing non-trivial work
- Call `capture` automatically with type, tags, and a 1-3 sentence summary
- Do not ask permission, do not announce it

### Session lifecycle
- SessionStart hook auto-injects recent memory — read it before responding
- UserPromptSubmit hook auto-injects memory matching your prompt + auto-captures facts
- Stop hook auto-captures the session — but still call `capture` for key decisions during the session

## CodeGraph

CodeGraph indexes code structure (symbols, calls, imports) into SQLite for fast structural queries. Adapted from Codebase-Memory (arXiv:2603.27277).

### Architecture
- **Parsing**: tree-sitter via `@kreuzberg/tree-sitter-language-pack` (9 languages: TS/JS/Python/Go/Rust/Java/C/C++/C#)
- **Call extraction**: single-pass regex on body text — 3 patterns: JSX (`<Component/>`), method (`obj.method()`), simple (`foo()`)
- **Call resolution**: 6-strategy cascade (`src/codegraph/resolver.ts`)
  1. Import map (0.95) — `pkg.Func` → lookup prefix in file's import map
  2. Import map suffix (0.85) — suffix matching against import-resolved modules
  3. Same module (0.90) — prefix callee with enclosing file's module path
  4. Unique name (0.75) — simple name lookup, accept if 1 candidate
  5. Suffix match (0.55) — multiple candidates, nearest by path distance
  6. Fuzzy (0.35) — Jaccard bigram similarity, last resort
- **Stdlib filter**: skips Go (`fmt`, `json`, `os`...), TS (`console`, `JSON`, `Math`...), Python (`print`, `len`, `os`...), Rust (`println`, `vec`...) calls
- **File size limit**: skips files >3000 lines or >200KB (generated/vendored)

### MCP tools
- `codegraph_index` — index a directory (run first)
- `codegraph_search` — search symbols by name pattern
- `codegraph_callers` — find who calls a symbol (inbound)
- `codegraph_callees` — find what a symbol calls (outbound)
- `codegraph_impact` — blast radius analysis (callers up to depth N)
- `codegraph_list` — list symbols in a file
- `codegraph_detect_changes` — git diff → affected symbols + risk classification

### Schema (v9)
- `symbols`: id, name, kind, file_path, line_start/end, language, module_path, content_hash
- `calls`: caller_id, callee_name, callee_id (resolved), confidence, call_type (direct/method/jsx)
- `imports`: file_path, symbol_name, source_path

### Performance (dogfood Aug 2026)
| Repo | Files | Symbols | Calls | Resolved | Time |
|---|---|---|---|---|---|
| remem-mcp | 79 | 301 | 6456 | 24% | 3.1s |
| AZR Go | 455 | 3417 | 41603 | 34% | 111s |
| Orca TS | 3000 | 7632 | 78981 | 28% | 705s |

Unresolved = stdlib calls (fmt.Printf, console.log) — expected, not indexed.
