#!/bin/bash
# loop-longmemeval.sh — Autonomous loop: run LongMemEval → if fail, call devin -p → repeat.
# Usage: ./scripts/loop-longmemeval.sh [max_iterations] [--variant oracle|s]
#
# File-based resume via last-iter.txt.

set -uo pipefail

# ─── Config ────────────────────────────────────────────────────
MAX_ITER="${1:-30}"
VARIANT="${2:-oracle}"
PROJECT_ROOT="/Users/tin/a/remem-mcp"
BENCH_SCRIPT="/tmp/longmemeval/longmemeval-bench.ts"
LOG_DIR="/tmp/longmemeval-loop-logs"
PROMPT_FILE="/tmp/longmemeval-loop-prompt.md"
LAST_ITER_FILE="$LOG_DIR/last-iter.txt"
SAMPLE_SIZE="${SAMPLE_SIZE:-100}"
TARGET="${TARGET_LONGMEMEVAL:-80}"

mkdir -p "$LOG_DIR"
log() { echo "[loop] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# ─── Resume logic ──────────────────────────────────────────────
START_ITER=1
if [ -f "$LAST_ITER_FILE" ]; then
  START_ITER=$(($(cat "$LAST_ITER_FILE") + 1))
  log "Resuming from iteration $START_ITER"
fi

# ─── Main loop ─────────────────────────────────────────────────
for iter in $(seq $START_ITER $MAX_ITER); do
  echo "$iter" > "$LAST_ITER_FILE"
  log "══════════════════════════════════════════════════════"
  log "  ITERATION $iter / $MAX_ITER  (variant: $VARIANT)"
  log "══════════════════════════════════════════════════════"

  # 1. Run benchmark
  BENCH_LOG="$LOG_DIR/iter-${iter}-bench.log"
  log "Running LongMemEval benchmark (sample=$SAMPLE_SIZE, variant=$VARIANT)..."
  cd /tmp/longmemeval
  npx tsx longmemeval-bench.ts --sample=$SAMPLE_SIZE --variant=$VARIANT > "$BENCH_LOG" 2>&1
  BENCH_EXIT=$?

  # 2. Parse score
  SCORE=$(grep "LONGMEMEVAL_SCORE" "$BENCH_LOG" | grep -oE '[0-9]+' || echo "0")
  log "LongMemEval score: $SCORE / 100  (target: $TARGET)"

  # 3. Check pass
  if [ "$SCORE" -ge "$TARGET" ]; then
    log "ALL PASS ✓ — LongMemEval=$SCORE >= $TARGET"
    grep "LONGMEMEVAL_SCORE" "$BENCH_LOG"
    log "Done."
    exit 0
  fi

  # 4. Extract failures
  FAILURES=$(grep "✗" "$BENCH_LOG" | head -20 || echo "")
  BY_TYPE=$(grep "=" "$BENCH_LOG" | grep "%" || echo "")
  RESULT_DETAIL=$(python3 -c "
import json
try:
    data = json.load(open('/tmp/longmemeval/results.json'))
    by_type = data.get('byType', {})
    for t, s in sorted(by_type.items()):
        pct = round(s['correct'] / s['total'] * 100) if s['total'] else 0
        print(f'  {t}: {s[\"correct\"]}/{s[\"total\"]} = {pct}%')
    # Show failed questions
    failed = [r for r in data.get('results', []) if not r['predicted_correct']]
    print(f'\\nFailed questions ({len(failed)}):')
    for f in failed[:10]:
        print(f'  [{f[\"question_type\"]}] Q: {f[\"question\"][:80]}')
        print(f'    A: {f[\"answer\"][:80]}')
        print(f'    Matched: {f[\"matched_keywords\"]}')
        print()
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null || echo "Could not parse results")

  # 5. Build prompt
  cat > "$PROMPT_FILE" << EOF
# LongMemEval Fix Task — Iteration $iter

You are working on remem-mcp at $PROJECT_ROOT.
Goal: Pass LongMemEval benchmark with score >= $TARGET.

## Current Score
LongMemEval ($VARIANT variant): $SCORE / 100  (target: $TARGET)

## Score by Question Type
$BY_TYPE

## Failed Questions Detail
$RESULT_DETAIL

## Full Benchmark Log
Read: $BENCH_LOG

## Your Task
1. Read $BENCH_LOG to see which questions failed.
2. Read /tmp/longmemeval/results.json for detailed results.
3. Read the benchmark adapter at /tmp/longmemeval/longmemeval-bench.ts to understand scoring.
4. Read the relevant source code in $PROJECT_ROOT/src/.
5. Fix the root cause — improve search recall or scoring logic.
6. Run \`npm run build\` — must pass.
7. Run \`npm test\` — must pass.
8. Do NOT break existing passing tests.

## Architecture Context
- Memory MCP server with hybrid search: BM25 + vector (sqlite-vec) + RRF fusion.
- LongMemEval tests 5 long-term memory abilities:
  - temporal-reasoning: when did something happen (133 questions)
  - multi-session: combine info across sessions (133 questions)
  - knowledge-update: track changed preferences (78 questions)
  - single-session-user: recall user facts (70 questions)
  - single-session-assistant: recall assistant suggestions (56 questions)
  - single-session-preference: recall preferences (30 questions)
- Each question has haystack_sessions (chat history) + answer (ground truth).
- Adapter ingests sessions, searches with question, checks if search results
  contain keywords from the ground-truth answer.
- Scoring: correct if >= 40% of answer keywords found in top-5 search results.

## Key Files
- src/storage/sqlite.ts — search + vector + RRF (improve recall)
- src/server.ts — search handler (check query expansion, filtering)
- src/pipeline/atom.ts — fact extraction (may help recall)
- /tmp/longmemeval/longmemeval-bench.ts — benchmark adapter (scoring logic)
- /tmp/longmemeval/data/longmemeval_${VARIANT} — dataset

## Rules
- ONE focused fix per iteration.
- No unrelated refactoring.
- Run build + tests before finishing.
- If stuck after 3 attempts, try a different approach.
- You can modify the benchmark adapter scoring logic AND the search engine.
EOF

  # 6. Call Devin
  DEVIN_LOG="$LOG_DIR/iter-${iter}-devin.log"
  log "Calling Devin to fix LongMemEval (score=$SCORE < $TARGET)..."
  cd "$PROJECT_ROOT"
  devin -p "$(cat "$PROMPT_FILE")" \
    --permission-mode dangerous \
    > "$DEVIN_LOG" 2>&1 || true

  log "Devin finished."
  tail -5 "$DEVIN_LOG" 2>/dev/null | while read -r line; do log "  $line"; done

  log "Iteration $iter complete."
  echo ""
done

# ─── Max iterations ────────────────────────────────────────────
log "══════════════════════════════════════════════════════"
log "  MAX ITERATIONS ($MAX_ITER) REACHED — target $TARGET not met"
log "══════════════════════════════════════════════════════"
log "Last score: $SCORE / 100"
log "Logs: $LOG_DIR/"
log "Resume: bash scripts/loop-longmemeval.sh $MAX_ITER $VARIANT"
exit 1
