# Agent Rules

## Always use remem-mcp

You have a long-term memory server (`remem-mcp` MCP). Always prefer it over grep/glob for code navigation and project context.

### Before answering or coding
1. Check for `[remem-mcp]` at the top of the turn — hooks auto-inject matching memory
2. **MUST call `recall()` at the start of every non-trivial task** — even if memory was injected. Injected memory is BM25-only (fast, shallow). `recall()` does hybrid search (BM25 + vector) with more results and filters.
3. Use results to inform your answer — don't repeat what recall already gave you

### Before searching code
1. For non-trivial code work, call `codegraph_index({ path: "src" })` once per session. It is idempotent and incrementally updates changed files.
2. Call `search` or `recall` first — it searches Memory + CodeGraph + Wiki in one call
3. Use `codegraph_search` for function/class/method symbols; reserve grep/glob for strings, config values, and file names

### For code navigation
- Prefer `codegraph_search` over grep; it understands function/class/method structure
- Use `search` to find symbols (faster than grep, understands function/class/method structure)
- Use CodeGraph data from recall results for callers/callees/impact analysis
- Only read files directly when you know the exact path

### After completing non-trivial work
- Call `capture` automatically with type, tags, and a 1-3 sentence summary
- Do not ask permission, do not announce it

### Session lifecycle
- SessionStart hook auto-injects recent memory — read it before responding
- UserPromptSubmit hook auto-injects memory matching your prompt + auto-captures facts
- PreToolUse hook injects canvas (F1) + skills (F3) + danger warnings + error predictions
- PostToolUse hook offloads tool output to refs (F1) + captures errors/patterns/decisions
- Stop hook auto-captures the session + extracts skills (F3) — but still call `capture` for key decisions during the session

## Unified Flow (F1 + F2 + F3)

Enable with `REMEM_FLOW=full`. Three features integrated into one continuous flow.

### F1 — Symbolic Short-Term Memory (Mermaid Canvas)

PostToolUse offloads verbose tool output to `refs/*.md` files and appends a node to a Mermaid canvas. PreToolUse injects the canvas (~100 tokens for 5 steps) so the agent reasons over symbols, not raw logs. **92% token reduction.**

- `canvas_get({ "format": "mermaid" })` — get the Mermaid graph for the current session
- `ref_read({ "node_id": "01MT..." })` — drill down to raw tool output for a specific node
- Enable: `REMEM_FLOW=full` or `REMEM_OFFLOAD_ENABLED=true` + `REMEM_PIPELINE=mermaid`

### F2 — Memory Proxy (HTTP)

For agents without MCP hook support. Start with `remem-mcp proxy` (port 8765). Point your agent's base URL to `http://localhost:8765`. The proxy injects memory into the system prompt and auto-captures conversations. Supports OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) protocols.

Session binding via headers: `x-remem-team`, `x-remem-agent`, `x-remem-task`, `x-remem-user`. Or `POST /session/init`.

### F3 — Skill Auto-Extraction

Stop hook detects step-by-step task captures (numbered lists, bullet lists, "Step N:" patterns) and auto-creates reusable Skills with trigger conditions, steps, and validation rules. Skills are injected into PreToolUse when triggers match the current command. Archived skills are always injected.

- `skill_create({ "name", "description", "steps", "trigger_conditions", "validation_rules" })` — manual skill creation
- `skill_archive({ "id" })` — force always-inject into recall
- `skill_search({ "query" })` — search skills by keyword
- CLI: `remem-mcp skill-extract` — batch extract from existing task captures
- Enable: `REMEM_FLOW=full` or `REMEM_PIPELINE=skill`

See [docs/unified-flow.md](docs/unified-flow.md) for full architecture.

## Capture Exclusions

Per-repository capture exclusions via `.remem.toml` marker file. Drop a `.remem.toml` in any project root to prevent auto-capture of noise from build artifacts, dependencies, etc.

### Format
```toml
[capture]
ignore_paths = ["node_modules", "dist", ".git", "*.min.js"]
```

### Matching
- **Path segment**: `node_modules` matches any path containing `node_modules` as a component (e.g. `/project/node_modules/foo.js`)
- **Glob suffix**: `*.min.js` matches any path ending with `.min.js`
- **Bash commands**: patterns are checked against command text — if a command references an ignored path, the error/pattern capture is skipped

### Behavior
- Marker file is searched from `cwd` upward through ancestors (first match wins)
- Exclusions are checked **before** any DB write — dropped events never enter storage
- Applied to both Write/Edit (pattern capture) and Bash (error capture) in PostToolUse hook
- No marker file = no exclusions = capture everything (default behavior)

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

### Schema (v13)
- `symbols`: id, name, kind, file_path, line_start/end, language, module_path, content_hash
- `calls`: caller_id, callee_name, callee_id (resolved), confidence, call_type (direct/method/jsx)
- `imports`: file_path, symbol_name, source_path
- `captures`: + tier (rule/decision/episodic/test), salience (decay score), expires_at (TTL), feedback_salience (0.1–2.0 multiplier)
- `entities`: capture_id, entity (≤10 nouns per capture for entity-assisted recall)
- `memory_links`: from_id, to_id, link_type, auto, weight (v13 — Hebbian co-retrieval weight)
- `capture_feedback`: capture_id, signal (helpful/not_helpful/stale/wrong), reason, agent_id, created_at (v12)
- `mutation_log`: action, capture_id, details (JSON), agent_id, created_at (v12 — every storage mutation)

### Performance (dogfood Aug 2026)
| Repo | Files | Symbols | Calls | Resolved | Time |
|---|---|---|---|---|---|
| remem-mcp | 79 | 301 | 6456 | 24% | 3.1s |
| AZR Go | 455 | 3417 | 41603 | 34% | 111s |
| Orca TS | 3000 | 7632 | 78981 | 28% | 705s |

Unresolved = stdlib calls (fmt.Printf, console.log) — expected, not indexed.

## v10: Decay/Forget Sweep + Authority Tiers + Entity-Assisted Recall

Three features adapted from `akitaonrails/ai-memory` research.

### Decay/Forget Sweep
Soft-deletes old captures with low salience score. Adapted from ai-memory's retention formula.

**Salience formula:**
```
salience = exp(-lambda * age_days) + sigma * log(1 + access_count) * exp(-mu * days_since_access)
```
- `lambda = 0.01` (age decay, ~70 day half-life)
- `sigma = 0.3` (access frequency weight)
- `mu = 0.02` (access recency decay, ~35 day half-life)

**Exemptions:** evergreen tags, tier=rule/decision, verified captures (floor 0.3).
**Default threshold:** 0.05. **Default max age:** 365 days.

Call via `db.forgetSweep({ dryRun, threshold, maxAgeDays })`.

### Authority-Aware Ranking
Bounded multiplier (0.5x–1.5x) applied after RRF fusion, before final sort.

**Tier auto-assignment on capture:**
- `type=decision` → tier=decision
- `type=pattern` → tier=rule
- Tag overrides: `canonical`/`rule` → rule, `decision` → decision, `test` → test
- Default: episodic

**Boosts:**
- Positive: tier=rule (+0.2), tier=decision (+0.15), tags `canonical`/`active`/`source-of-truth`/`pinned` (+0.1 each)
- Negative: tier=test (-0.1), tags `superseded`/`historical`/`test-fixture`/`do-not-answer-from` (-0.15 each)
- Clamped to [0.5, 1.5] — never an absolute filter

### Entity-Assisted Recall
Extracts ≤10 significant nouns per capture (capitalized words, acronyms, hyphenated terms, words >4 chars). Stored in `entities` table. Third RRF stream in hybrid search — finds pages even when body uses different wording than query.

**Extraction:** `extractEntities(text)` — lexical only, no NLP dependency.
**Search:** `searchByEntities(entities, limit, sessionKey, filters)` — respects multi-tenant filters.

## v11: Memory Links + Raw Fallback + Write Queue

### Memory-to-Memory Links
Auto-links captures on `put()` based on shared tags, shared entities, and session proximity (≤5min). Manual links via `linkCaptures(fromId, toId, type)`. Link-neighbor expansion (1-hop) in hybrid search — expands top results to linked captures with 0.5x decayed score.

**Auto-link types:** `shared-tag`, `shared-entity`, `session-proximity` (auto=1)
**Manual link types:** `related`, `cause-effect`, `supersedes`, `prerequisite` (auto=0)
**Expansion:** `expandByLinks(ids, limit)` — 1-hop, filters deleted/rejected/superseded, 0.5x RRF score

### Raw Observation Fallback
When hybrid search returns 0 results, fallback to broader FTS5 search that includes stale/rejected captures (but still excludes deleted/superseded). Catches cases where trust_state filtering is too aggressive.

**Trigger:** `results.length === 0 && mode === "hybrid"`
**Filter:** `deleted_at IS NULL AND superseded_by IS NULL` (no trust_state filter)

### WriteQueue
Async mutex for serializing write operations. Available as `src/utils/write-queue.ts` for future async backends. Currently not used in SQLiteBackend (better-sqlite3 is synchronous, `db.transaction()` already provides serialization).

## v12: Feedback + Explain + TTL + Mutation Log

### Feedback Flywheel
MCP tool `feedback(capture_id, signal, reason?)` records quality signals after using recall results. Adjusts `feedback_salience` multiplier (applied in search ranking after authority multiplier):
- `helpful` → +0.1 (max 2.0)
- `not_helpful` → -0.1 (min 0.1)
- `stale` → floor at 0.3
- `wrong` → floor at 0.1

**SKILL.md rule:** After using recall, call `feedback` for the most useful result.

### Explain Mode
`search(explain=true)` attaches `scoreDetails` per hit: `bm25_rank`, `bm25_score`, `vector_rank`, `vector_score`, `entity_rank`, `entity_matches`, `authority_multiplier`, `feedback_salience`, `link_provenance`, `raw_fallback`. Zero-LLM debugging for ranking.

### TTL expires_at
Captures can have `expires_at` (timestamp). `forgetSweep` hard-deletes TTL-expired captures regardless of salience/tier. Time-sensitive data (config values, API endpoints, version numbers) auto-expires.

### Mutation Log
`mutation_log` table records every storage mutation (put/delete/reject/supersede/feedback/link/forget). `recordAudit(action, captureId, details, agentId)` called from within write transactions. `queryAudit({action?, captureId?, since?, limit?})` for forensics.

## v13: Adaptive Links + Contextual Retrieval + Auto-Feedback

### Adaptive Memory Links (Hebbian)
When search returns ≥2 results, `strengthenLinksOnCoRetrieval()` creates/increments `co-retrieval` links between all pairs (top 10). Weight starts at 1.0, +0.1 per co-retrieval. `expandByLinks` uses weight to scale expansion score.

**Effect:** Frequently co-retrieved memories become stronger linked — the graph self-organizes based on usage patterns.

### Contextual Retrieval
Before embedding, a preamble `[type]. tags: tag1, tag2.` is prepended to content. FTS5 sees raw content; vector sees enriched text. Improves vector search precision for typed/tagged captures.

**Source:** Anthropic's contextual retrieval technique (2024).

### Auto-Feedback from Corrections
`confirm()` MCP tool now auto-records `helpful` feedback. `correct()` auto-records `wrong` feedback. Closes the feedback flywheel without requiring explicit `feedback()` calls.
