#!/usr/bin/env bash
# bug-hunt-loop.sh — autonomous bug-hunting loop for remem-mcp
#
# Each iteration:
#   1. Build + typecheck + tests (baseline)
#   2. Run N parallel bug-hunt agents (each explores a different area)
#   3. Collect findings, dedup against known issues
#   4. Auto-fix P0/P1 bugs found, leave P2 for review
#   5. Re-run tests to verify fixes don't break anything
#   6. Capture findings to remem-mcp memory
#   7. Loop until 0 new bugs found
#
# Usage: bash scripts/bug-hunt-loop.sh [max_iterations] [agents_per_iter]
# Default: 5 iterations, 3 agents per iteration

set -uo pipefail
cd "$(dirname "$0")/.."

MAX_ITER="${1:-5}"
AGENTS_PER_ITER="${2:-3}"
LOG_DIR="/tmp/bug-hunt"
PROMPT_DIR="$LOG_DIR/prompts"
mkdir -p "$LOG_DIR" "$PROMPT_DIR"

log() { echo "[bug-hunt] $(date '+%H:%M:%S') $*"; }

# ─── Bug-hunt areas (rotated each iteration) ───────────────────
AREAS=(
  "Error handling: scan all async handlers in src/server.ts for uncaught promises, missing try/catch on embed/putVector/supersede calls. Check every 'await' outside a try block."
  "SQL safety: audit src/storage/sqlite.ts for SQL injection, missing parameterization, LIKE pattern escaping, race conditions between check-and-insert."
  "Data integrity: verify capture→embed→putVector→FTS-index flow is atomic. Check if update/reject/forget leave orphaned vectors or FTS entries."
  "Edge cases: empty content, 1-char content, very long content (>10k chars), unicode/emoji, special chars in tags, null/undefined args."
  "Cross-session isolation: verify session_key filtering in recall/search/conflict-detection. Can a capture leak across sessions? Test global session fallback."
  "CodeGraph: check symbol indexing, callers/callees/impact traversal, path matching, auto-index trigger, large repo handling."
  "Wiki: check ingest parsing (frontmatter, wikilinks, markdown links), FTS search, outdated detection, large directory handling."
  "Hooks: audit src/hook-handlers.ts for stdin parsing, error recovery, exit codes, memory leaks from event listeners."
  "SDK: verify src/sdk.ts Memory class methods match server handler behavior. Check close() cleanup, concurrent access."
  "Pipeline: check src/pipeline/ for atom extraction, persona pipeline, noop fallback, error isolation."
  "Schema migrations: verify src/storage/schema.sql + sqlite.ts migrations are idempotent, handle partial failures, backfill correctly."
  "Redactor: check src/security/audit.ts + redactor for secret detection gaps, false positives, performance on large content."
)

# ─── Known issues (skip if already fixed) ──────────────────────
KNOWN_FIXED=$(git log --oneline --grep="fix:" | head -20)

is_known() {
  local desc="$1"
  # Check if this bug was already fixed in recent commits
  for kw in "re-embed" "session_end" "session_checkpoint" "supersede" "threshold" "fuzzy dedup"; do
    if echo "$desc" | grep -qi "$kw" && echo "$KNOWN_FIXED" | grep -qi "$kw"; then
      return 0
    fi
  done
  return 1
}

# ─── Generate agent prompt ─────────────────────────────────────
gen_prompt() {
  local area="$1"
  local iter="$2"
  local f="$PROMPT_DIR/agent-iter-${iter}-$(echo "$area" | head -c 20 | tr ' :/.' '____').md"
  cat > "$f" << EOF
# Bug Hunt — Iteration $iter

You are hunting for bugs in remem-mcp at /Users/tin/a/remem-mcp.

## Focus area
$area

## Instructions
1. Read the relevant source files thoroughly
2. For each bug found, report:
   - File:line
   - Severity: P0 (crash/data loss), P1 (wrong behavior), P2 (UX issue)
   - Root cause (1-2 sentences)
   - Suggested fix (code snippet if possible)
   - Whether existing tests cover this case
3. Do NOT fix anything — just report findings
4. Be thorough but avoid false positives. Only report real bugs.

## Key files
- src/server.ts — MCP server, all tool handlers
- src/storage/sqlite.ts — SQLite storage layer
- src/sdk.ts — SDK Memory class
- src/index.ts — CLI entry
- src/hook-handlers.ts — hook handlers
- src/codegraph/engine.ts — CodeGraph
- src/wiki/engine.ts — Wiki ingest/search
- src/security/audit.ts — audit logger
- src/pipeline/ — atom extraction, persona

## Output format
At the end, output a JSON array:
\`\`\`json
[
  {
    "severity": "P0|P1|P2",
    "file": "src/server.ts",
    "line": 1234,
    "description": "What's wrong",
    "root_cause": "Why it happens",
    "fix": "How to fix it",
    "has_test": false
  }
]
\`\`\`

If no bugs found, output: []
EOF
  echo "$f"
}

# ─── Parse findings from agent log ─────────────────────────────
parse_findings() {
  local log_file="$1"
  # Extract JSON array from log
  python3 -c "
import json, sys, re
text = open('$log_file').read()
# Find JSON array in code block
m = re.search(r'\`\`\`json\s*(\[[^\`\`]*?\])\s*\`\`\`', text, re.DOTALL)
if not m:
    m = re.search(r'(\[[\s\S]*?\])\s*(?:\`\`\`|$)', text)
if m:
    try:
        data = json.loads(m.group(1))
        for b in data:
            print(json.dumps(b))
    except:
        pass
" 2>/dev/null
}

# ─── Apply auto-fix for P0/P1 ──────────────────────────────────
auto_fix() {
  local finding="$1"
  local severity=$(echo "$finding" | python3 -c "import json,sys; print(json.load(sys.stdin).get('severity','P2'))")
  local file=$(echo "$finding" | python3 -c "import json,sys; print(json.load(sys.stdin).get('file',''))")
  local desc=$(echo "$finding" | python3 -c "import json,sys; print(json.load(sys.stdin).get('description',''))")
  local fix=$(echo "$finding" | python3 -c "import json,sys; print(json.load(sys.stdin).get('fix',''))")

  if [ "$severity" = "P2" ]; then
    echo "SKIP (P2 — manual review needed): $desc"
    return
  fi

  if is_known "$desc"; then
    echo "SKIP (already fixed): $desc"
    return
  fi

  echo "AUTO-FIX ($severity): $desc in $file"
  echo "  Fix: $fix"
  # Launch a fix agent
  local fix_prompt="Fix this bug in /Users/tin/a/remem-mcp:
File: $file
Bug: $desc
Fix: $fix

Steps:
1. Read the file and understand the bug
2. Apply the fix with minimal changes
3. Run: cd /Users/tin/a/remem-mcp && npm run build
4. Run: cd /Users/tin/a/remem-mcp && npx vitest run 2>&1 | tail -5
5. If tests pass: git add -A && git commit -m \"fix: $desc\"
6. If tests fail: revert and report why

Do NOT break existing tests. Minimal changes only."

  if command -v devin &>/dev/null; then
    devin -p "$fix_prompt" --permission-mode dangerous 2>&1 | tail -20
  else
    echo "  (devin CLI not available — fix manually)"
    echo "  Prompt saved to $LOG_DIR/fix-prompt.txt"
    echo "$fix_prompt" > "$LOG_DIR/fix-prompt.txt"
  fi
}

# ─── Main loop ─────────────────────────────────────────────────
log "Starting bug-hunt loop: $MAX_ITER iterations, $AGENTS_PER_ITER agents per iteration"
log "Known fixed issues: $(echo "$KNOWN_FIXED" | wc -l | tr -d ' ') commits"

TOTAL_BUGS_FOUND=0
TOTAL_BUGS_FIXED=0

for iter in $(seq 1 $MAX_ITER); do
  log ""
  log "════════════════════════════════════════════════════════"
  log "  BUG HUNT — iteration $iter / $MAX_ITER"
  log "════════════════════════════════════════════════════════"

  # 1. Baseline: build + test
  printf "  [1/4] Build + test baseline... "
  if npm run build 2>&1 | tail -1 | grep -q "success"; then
    TEST_OUT=$(npx vitest run 2>&1 || true)
    FAILS=$(echo "$TEST_OUT" | grep -oE "[0-9]+ failed" | head -1 | grep -oE "[0-9]+" || echo "0")
    PASSES=$(echo "$TEST_OUT" | grep -oE "[0-9]+ passed" | head -1 | grep -oE "[0-9]+" || echo "0")
    if [ "$FAILS" = "0" ]; then
      echo "✓ $PASSES tests pass"
    else
      echo "✗ $FAILS tests fail — fix before hunting"
      echo "$TEST_OUT" | grep "FAIL" | head -5
      continue
    fi
  else
    echo "✗ build failed — fix before hunting"
    continue
  fi

  # 2. Select areas for this iteration (rotate)
  START=$(( (iter - 1) * AGENTS_PER_ITER % ${#AREAS[@]} ))
  SELECTED=()
  for i in $(seq 0 $((AGENTS_PER_ITER - 1))); do
    IDX=$(( (START + i) % ${#AREAS[@]} ))
    SELECTED+=("${AREAS[$IDX]}")
  done

  log "  [2/4] Hunting areas:"
  for area in "${SELECTED[@]}"; do
    log "    → $(echo "$area" | head -c 60)..."
  done

  # 3. Launch agents in parallel
  log "  [3/4] Launching $AGENTS_PER_ITER bug-hunt agents..."
  PIDS=()
  for i in $(seq 0 $((AGENTS_PER_ITER - 1))); do
    area="${SELECTED[$i]}"
    prompt_file=$(gen_prompt "$area" "$iter")
    log_file="$LOG_DIR/agent-iter-${iter}-${i}.log"

    if command -v devin &>/dev/null; then
      devin -p "$(cat "$prompt_file")" --permission-mode dangerous \
        > "$log_file" 2>&1 &
      PIDS+=($!)
      log "    Agent $i: PID $! — $(echo "$area" | head -c 40)..."
    else
      # Fallback: run subagent via node SDK test
      log "    Agent $i: devin CLI not available, using static analysis..."
      # Static bug patterns to check
      python3 << PYEOF > "$log_file" 2>&1
import re, sys

area = """$area"""
findings = []

# Pattern 1: await without try/catch in server.ts
with open('src/server.ts') as f:
    lines = f.readlines()
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        # Check for bare await opts.storage or await opts.embedder outside try
        if 'await opts.' in stripped and 'try' not in stripped:
            # Look back 5 lines for try block
            in_try = False
            for j in range(max(0, i-10), i-1):
                if 'try {' in lines[j] or 'try{' in lines[j]:
                    in_try = True
                    break
                if '} catch' in lines[j] or '}catch' in lines[j]:
                    in_try = False
            if not in_try and 'await opts.storage' in stripped:
                findings.append({
                    "severity": "P1",
                    "file": "src/server.ts",
                    "line": i,
                    "description": f"Uncaught await: {stripped[:80]}",
                    "root_cause": "No try/catch around storage call",
                    "fix": "Wrap in try/catch with console.error",
                    "has_test": False
                })

# Pattern 2: SQL string interpolation
with open('src/storage/sqlite.ts') as f:
    content = f.read()
    for m in re.finditer(r'db\.exec\([^)]*\\\$\{[^}]+\}', content):
        line_no = content[:m.start()].count('\n') + 1
        findings.append({
            "severity": "P2",
            "file": "src/storage/sqlite.ts",
            "line": line_no,
            "description": f"Potential SQL interpolation: {m.group()[:60]}",
            "root_cause": "String interpolation in SQL",
            "fix": "Use parameterized query",
            "has_test": False
        })

# Pattern 3: missing input validation
with open('src/server.ts') as f:
    content = f.read()
    # Find handler functions
    for m in re.finditer(r'async function handle(\w+)\(', content):
        handler = m.group(1)
        # Check if handler has validation
        start = m.start()
        end = content.find('}', content.find('\n', start))
        body = content[start:end]
        if 'isError: true' not in body and handler not in ['Health', 'Stats', 'CorrectionKPIs']:
            findings.append({
                "severity": "P2",
                "file": "src/server.ts",
                "line": content[:start].count('\n') + 1,
                "description": f"Handler handle{handler} has no input validation",
                "root_cause": "No isError checks for required params",
                "fix": "Add validation for required args",
                "has_test": False
            })

# Output findings as JSON
import json
print("```json")
print(json.dumps(findings, indent=2))
print("```")
PYEOF
      log "    Agent $i: static analysis complete"
    fi
  done

  # Wait for all agents
  if [ ${#PIDS[@]} -gt 0 ]; then
    log "    Waiting for ${#PIDS[@]} agents..."
    for pid in "${PIDS[@]}"; do
      wait $pid 2>/dev/null && log "    Agent $pid: done" || log "    Agent $pid: failed"
    done
  fi

  # 4. Collect findings
  log "  [4/4] Collecting findings..."
  ALL_FINDINGS=""
  NEW_BUGS=0
  for i in $(seq 0 $((AGENTS_PER_ITER - 1))); do
    log_file="$LOG_DIR/agent-iter-${iter}-${i}.log"
    if [ -f "$log_file" ]; then
      FINDINGS=$(parse_findings "$log_file")
      if [ -n "$FINDINGS" ]; then
        while IFS= read -r finding; do
          desc=$(echo "$finding" | python3 -c "import json,sys; print(json.load(sys.stdin).get('description',''))" 2>/dev/null)
          sev=$(echo "$finding" | python3 -c "import json,sys; print(json.load(sys.stdin).get('severity','P2'))" 2>/dev/null)
          if ! is_known "$desc"; then
            NEW_BUGS=$((NEW_BUGS + 1))
            ALL_FINDINGS="$ALL_FINDINGS$finding"$'\n'
            log "    [$sev] $desc"
          fi
        done <<< "$FINDINGS"
      fi
    fi
  done

  TOTAL_BUGS_FOUND=$((TOTAL_BUGS_FOUND + NEW_BUGS))
  log ""
  log "  New bugs found this iteration: $NEW_BUGS"
  log "  Total bugs found: $TOTAL_BUGS_FOUND"

  # 5. Auto-fix P0/P1
  if [ $NEW_BUGS -gt 0 ] && [ -n "$ALL_FINDINGS" ]; then
    log ""
    log "  Auto-fixing P0/P1 bugs..."
    FIXED_THIS_ITER=0
    while IFS= read -r finding; do
      if [ -n "$finding" ]; then
        result=$(auto_fix "$finding")
        log "    $result"
        if echo "$result" | grep -q "AUTO-FIX"; then
          FIXED_THIS_ITER=$((FIXED_THIS_ITER + 1))
        fi
      fi
    done <<< "$ALL_FINDINGS"
    TOTAL_BUGS_FIXED=$((TOTAL_BUGS_FIXED + FIXED_THIS_ITER))

    # Re-run tests after fixes
    if [ $FIXED_THIS_ITER -gt 0 ]; then
      log ""
      log "  Re-running tests after fixes..."
      npm run build 2>&1 | tail -1
      TEST_OUT=$(npx vitest run 2>&1 || true)
      FAILS=$(echo "$TEST_OUT" | grep -oE "[0-9]+ failed" | head -1 | grep -oE "[0-9]+" || echo "0")
      PASSES=$(echo "$TEST_OUT" | grep -oE "[0-9]+ passed" | head -1 | grep -oE "[0-9]+" || echo "0")
      if [ "$FAILS" = "0" ]; then
        log "  ✓ $PASSES tests pass after fixes"
      else
        log "  ✗ $FAILS tests fail after fixes — reverting last commit"
        git revert HEAD --no-edit 2>/dev/null || log "  Could not revert — manual fix needed"
      fi
    fi
  fi

  # 6. Capture findings to memory
  if [ $NEW_BUGS -gt 0 ]; then
    log ""
    log "  Capturing findings to memory..."
    node --input-type=module -e "
      import { Memory } from './dist/sdk.js';
      import path from 'path';
      import os from 'os';
      const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
      const summary = 'Bug hunt iteration $iter: $NEW_BUGS new bugs found, $FIXED_THIS_ITER fixed. Areas: ${SELECTED[*]//\'/\\\'}';
      await m.capture(summary, 'task', ['bug-hunt', 'loop', 'iter-$iter']);
      m.close();
    " 2>/dev/null || true
  fi

  # 7. Check victory
  if [ $NEW_BUGS -eq 0 ]; then
    log ""
    log "  ╔══════════════════════════════════════════════════╗"
    log "  ║  CLEAN — 0 new bugs found at iteration $iter!     ║"
    log "  ╠══════════════════════════════════════════════════╣"
    log "  ║  Total bugs found: $TOTAL_BUGS_FOUND                          ║"
    log "  ║  Total bugs fixed: $TOTAL_BUGS_FIXED                          ║"
    log "  ╚══════════════════════════════════════════════════╝"
    exit 0
  fi

  log ""
  log "  ─────────────────────────────────────"
  log "  Iteration $iter complete. $NEW_BUGS bugs found, $FIXED_THIS_ITER fixed."
  log "  ─────────────────────────────────────"
  sleep 3
done

log ""
log "════════════════════════════════════════════════════════"
log "  BUG HUNT COMPLETE — $MAX_ITER iterations"
log "  Total bugs found: $TOTAL_BUGS_FOUND"
log "  Total bugs fixed: $TOTAL_BUGS_FIXED"
log "  Logs: $LOG_DIR/"
log "════════════════════════════════════════════════════════"
exit 0
