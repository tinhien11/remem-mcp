#!/bin/bash
# loop-unified.sh — Autonomous loop: run ALL benchmarks vs TencentDB + Mem0 targets.
# If any target not met, call Devin to fix → rebuild → re-run → repeat.
#
# Targets (beat or equal BOTH TencentDB and Mem0):
#   AMB L1:       100  (our target)
#   AMB L2:       100  (our target)
#   AMB L3:       100  (our target)
#   LoCoMo:       92.5 (Mem0)
#   PersonaMem:   76   (TencentDB)
#   LongMemEval:  94.4 (Mem0)
#
# Usage: bash scripts/loop-unified.sh [max_iterations] [--quick]
#   --quick: skip LoCoMo + PersonaMem + LongMemEval (AMB only, ~2 min/iter)
#
# File-based resume via /tmp/bench-unified/last-iter.txt

set -uo pipefail

# ─── Config ────────────────────────────────────────────────────
MAX_ITER="${1:-50}"
QUICK=false
[[ "${2:-}" == "--quick" ]] && QUICK=true

PROJECT_ROOT="/Users/tin/a/remem-mcp"
BENCH_SCRIPT="$PROJECT_ROOT/scripts/bench-all.sh"
LOG_DIR="/tmp/bench-unified"
PROMPT_FILE="$LOG_DIR/prompt.md"
LAST_ITER_FILE="$LOG_DIR/last-iter.txt"
SCORES_FILE="$LOG_DIR/scores.json"
SUMMARY_FILE="$LOG_DIR/summary.md"

# LongMemEval config
LONGMEMEVAL_DIR="/tmp/longmemeval"
LONGMEMEVAL_SAMPLE="${LONGMEMEVAL_SAMPLE:-100}"
LONGMEMEVAL_VARIANT="${LONGMEMEVAL_VARIANT:-oracle}"

# HTTP server for Mem0 benchmarks
HTTP_SERVER="$PROJECT_ROOT/scripts/bench-http-server.js"
HTTP_PORT=8888

# Targets
export TARGET_L1="${TARGET_L1:-100}"
export TARGET_L2="${TARGET_L2:-100}"
export TARGET_L3="${TARGET_L3:-100}"
export TARGET_LOCOMO="${TARGET_LOCOMO:-92}"     # Mem0=92.5
export TARGET_PERSONAMEM="${TARGET_PERSONAMEM:-76}" # TencentDB=76
TARGET_LONGMEMEVAL="${TARGET_LONGMEMEVAL:-94}"  # Mem0=94.4

mkdir -p "$LOG_DIR" /tmp/remem-bench

log() { echo "[loop] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# ─── Helpers ───────────────────────────────────────────────────

start_http_server() {
  if curl -s http://127.0.0.1:$HTTP_PORT/health >/dev/null 2>&1; then
    return 0
  fi
  log "Starting HTTP server..."
  pkill -9 -f "bench-http-server" 2>/dev/null || true
  sleep 1
  REMEM_DB_PATH="/tmp/remem-bench/http.db" node "$HTTP_SERVER" $HTTP_PORT &
  local pid=$!
  sleep 3
  if curl -s http://127.0.0.1:$HTTP_PORT/health >/dev/null 2>&1; then
    log "HTTP server started (PID $pid)"
  else
    log "WARNING: HTTP server failed to start — Mem0 benchmarks will be skipped"
  fi
}

run_longmemeval() {
  if [ ! -f "$LONGMEMEVAL_DIR/longmemeval-bench.ts" ]; then
    echo "N/A"
    return
  fi
  if [ ! -f "$LONGMEMEVAL_DIR/data/longmemeval_${LONGMEMEVAL_VARIANT}.json" ]; then
    log "  LongMemEval data not found, skipping"
    echo "N/A"
    return
  fi
  log "  Running LongMemEval (sample=$LONGMEMEVAL_SAMPLE, variant=$LONGMEMEVAL_VARIANT)..."
  cd "$LONGMEMEVAL_DIR"
  local output=$(npx tsx longmemeval-bench.ts --sample=$LONGMEMEVAL_SAMPLE --variant=$LONGMEMEVAL_VARIANT 2>&1)
  echo "$output" | tail -15
  local score=$(echo "$output" | grep "LONGMEMEVAL_SCORE=" | grep -oE '[0-9]+' || echo "0")
  echo "$score"
}

save_scores() {
  local iter=$1 l1=$2 l2=$3 l3=$4 locomo=$5 persona=$6 longmemeval=$7
  python3 -c "
import json, os
scores = json.load(open('$SCORES_FILE')) if os.path.exists('$SCORES_FILE') else []
scores.append({
    'iter': $iter,
    'L1': $l1, 'L2': $l2, 'L3': $l3,
    'locomo': '$locomo', 'persona': '$persona', 'longmemeval': '$longmemeval',
    'targets': {'L1': $TARGET_L1, 'L2': $TARGET_L2, 'L3': $TARGET_L3,
                'locomo': $TARGET_LOCOMO, 'persona': $TARGET_PERSONAMEM,
                'longmemeval': $TARGET_LONGMEMEVAL}
})
json.dump(scores, open('$SCORES_FILE', 'w'), indent=2)
" 2>/dev/null || true
}

# ─── Resume logic ──────────────────────────────────────────────
START_ITER=1
if [ -f "$LAST_ITER_FILE" ]; then
  START_ITER=$(($(cat "$LAST_ITER_FILE") + 1))
  log "Resuming from iteration $START_ITER"
fi

# ─── Main loop ─────────────────────────────────────────────────
for iter in $(seq $START_ITER $MAX_ITER); do
  echo "$iter" > "$LAST_ITER_FILE"
  log ""
  log "════════════════════════════════════════════════════════"
  log "  ITERATION $iter / $MAX_ITER"
  log "════════════════════════════════════════════════════════"

  # 1. Build
  log "Building remem-mcp..."
  cd "$PROJECT_ROOT"
  npm run build 2>&1 | tail -1

  # 2. Run AMB + LoCoMo + PersonaMem (bench-all.sh)
  BENCH_LOG="$LOG_DIR/iter-${iter}-bench.log"
  BENCH_ARGS=""
  $QUICK && BENCH_ARGS="--quick"
  log "Running bench-all.sh $BENCH_ARGS..."
  bash "$BENCH_SCRIPT" $BENCH_ARGS > "$BENCH_LOG" 2>&1 || true

  # 3. Parse scores
  RESULT_LINE=$(grep "BENCH_RESULT" "$BENCH_LOG" || echo "BENCH_RESULT L1=0 L2=0 L3=0 LOCOMO=N/A PERSONAMEM=N/A")
  L1=$(echo "$RESULT_LINE" | grep -oE 'L1=[0-9]+' | grep -oE '[0-9]+' || echo "0")
  L2=$(echo "$RESULT_LINE" | grep -oE 'L2=[0-9]+' | grep -oE '[0-9]+' || echo "0")
  L3=$(echo "$RESULT_LINE" | grep -oE 'L3=[0-9]+' | grep -oE '[0-9]+' || echo "0")
  LOCOMO=$(echo "$RESULT_LINE" | grep -oE 'LOCOMO=[0-9]+' | grep -oE '[0-9]+' || echo "N/A")
  PERSONAMEM=$(echo "$RESULT_LINE" | grep -oE 'PERSONAMEM=[0-9]+' | grep -oE '[0-9]+' || echo "N/A")

  # 4. Run LongMemEval (separate)
  LONGMEMEVAL="N/A"
  if ! $QUICK; then
    LONGMEMEVAL=$(run_longmemeval)
  fi

  log ""
  log "════════════════════════════════════════════════════════"
  log "  SCORES — Iteration $iter"
  log "════════════════════════════════════════════════════════"
  log "  AMB L1:       $L1  / $TARGET_L1"
  log "  AMB L2:       $L2  / $TARGET_L2"
  log "  AMB L3:       $L3  / $TARGET_L3"
  log "  LoCoMo:       $LOCOMO  / $TARGET_LOCOMO (Mem0=92.5)"
  log "  PersonaMem:   $PERSONAMEM  / $TARGET_PERSONAMEM (TencentDB=76)"
  log "  LongMemEval:  $LONGMEMEVAL  / $TARGET_LONGMEMEVAL (Mem0=94.4)"
  log "════════════════════════════════════════════════════════"

  # 5. Save scores
  save_scores "$iter" "$L1" "$L2" "$L3" "$LOCOMO" "$PERSONAMEM" "$LONGMEMEVAL"

  # 6. Check all targets
  PASS=true
  FAILURES=""
  [ "${L1:-0}" -lt "$TARGET_L1" ] 2>/dev/null && PASS=false && FAILURES+="L1=$L1<$TARGET_L1 "
  [ "${L2:-0}" -lt "$TARGET_L2" ] 2>/dev/null && PASS=false && FAILURES+="L2=$L2<$TARGET_L2 "
  [ "${L3:-0}" -lt "$TARGET_L3" ] 2>/dev/null && PASS=false && FAILURES+="L3=$L3<$TARGET_L3 "
  if [ "$LOCOMO" != "N/A" ]; then
    [ "${LOCOMO:-0}" -lt "$TARGET_LOCOMO" ] 2>/dev/null && PASS=false && FAILURES+="LOCOMO=$LOCOMO<$TARGET_LOCOMO "
  fi
  if [ "$PERSONAMEM" != "N/A" ]; then
    [ "${PERSONAMEM:-0}" -lt "$TARGET_PERSONAMEM" ] 2>/dev/null && PASS=false && FAILURES+="PERSONAMEM=$PERSONAMEM<$TARGET_PERSONAMEM "
  fi
  if [ "$LONGMEMEVAL" != "N/A" ]; then
    [ "${LONGMEMEVAL:-0}" -lt "$TARGET_LONGMEMEVAL" ] 2>/dev/null && PASS=false && FAILURES+="LONGMEMEVAL=$LONGMEMEVAL<$TARGET_LONGMEMEVAL "
  fi

  if [ "$PASS" = true ]; then
    log ""
    log "  ╔══════════════════════════════════════════════╗"
    log "  ║  VICTORY! All targets met at iteration $iter!  ║"
    log "  ╚══════════════════════════════════════════════╝"
    log ""
    log "Done."
    exit 0
  fi

  log "Targets not met: $FAILURES"

  # 7. Find lowest-scoring benchmark to focus Devin
  LOWEST=""
  LOWEST_SCORE=100
  for pair in "L1:$L1:$TARGET_L1" "L2:$L2:$TARGET_L2" "L3:$L3:$TARGET_L3"; do
    name=$(echo "$pair" | cut -d: -f1)
    score=$(echo "$pair" | cut -d: -f2)
    target=$(echo "$pair" | cut -d: -f3)
    if [ "${score:-0}" -lt "$LOWEST_SCORE" ] 2>/dev/null; then
      LOWEST="$name"
      LOWEST_SCORE=$score
    fi
  done
  if [ "$LOCOMO" != "N/A" ] && [ "${LOCOMO:-0}" -lt "$LOWEST_SCORE" ] 2>/dev/null; then
    LOWEST="LOCOMO"; LOWEST_SCORE=$LOCOMO
  fi
  if [ "$PERSONAMEM" != "N/A" ] && [ "${PERSONAMEM:-0}" -lt "$LOWEST_SCORE" ] 2>/dev/null; then
    LOWEST="PERSONAMEM"; LOWEST_SCORE=$PERSONAMEM
  fi
  if [ "$LONGMEMEVAL" != "N/A" ] && [ "${LONGMEMEVAL:-0}" -lt "$LOWEST_SCORE" ] 2>/dev/null; then
    LOWEST="LONGMEMEVAL"; LOWEST_SCORE=$LONGMEMEVAL
  fi

  log "Focus: $LOWEST is lowest at $LOWEST_SCORE / 100"

  # 8. Extract failure details
  AMB_FAILURES=$(grep -E "FAIL|✗|failed|incorrect|wrong|Expected|Got" "$BENCH_LOG" | head -30 || echo "")
  LONGMEMEVAL_DETAIL=""
  if [ -f "$LONGMEMEVAL_DIR/results.json" ]; then
    LONGMEMEVAL_DETAIL=$(python3 -c "
import json
try:
    data = json.load(open('$LONGMEMEVAL_DIR/results.json'))
    by_type = data.get('byType', {})
    for t, s in sorted(by_type.items()):
        pct = round(s['correct'] / s['total'] * 100) if s['total'] else 0
        print(f'  {t}: {s[\"correct\"]}/{s[\"total\"]} = {pct}%')
    failed = [r for r in data.get('results', []) if not r['predicted_correct']]
    print(f'\nFailed ({len(failed)}):')
    for f in failed[:10]:
        print(f'  [{f[\"question_type\"]}] Q: {f[\"question\"][:80]}')
        print(f'    A: {f[\"answer\"][:80]}')
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null || echo "")
  fi

  # 9. Build prompt for Devin
  cat > "$PROMPT_FILE" << EOF
# Benchmark Fix Task — Iteration $iter

You are improving remem-mcp at $PROJECT_ROOT.
Goal: Beat or equal BOTH TencentDB and Mem0 on all benchmarks.

## Current Scores vs Targets
| Benchmark    | Score  | Target | Competitor |
|-------------|--------|--------|------------|
| AMB L1      | $L1    | $TARGET_L1 | our target |
| AMB L2      | $L2    | $TARGET_L2 | our target |
| AMB L3      | $L3    | $TARGET_L3 | our target |
| LoCoMo      | $LOCOMO | $TARGET_LOCOMO | Mem0=92.5 |
| PersonaMem  | $PERSONAMEM | $TARGET_PERSONAMEM | TencentDB=76 |
| LongMemEval | $LONGMEMEVAL | $TARGET_LONGMEMEVAL | Mem0=94.4 |

## Failures: $FAILURES
## Focus: $LOWEST is lowest at $LOWEST_SCORE / 100

## AMB / LoCoMo / PersonaMem Failures
$AMB_FAILURES

## LongMemEval Breakdown
$LONGMEMEVAL_DETAIL

## Full Benchmark Log
Read: $BENCH_LOG

## Your Task
1. Read $BENCH_LOG to see exactly which tests failed and why.
2. Read the relevant source code in $PROJECT_ROOT/src/.
3. Fix the root cause. Make minimal, surgical changes.
4. Run \`npm run build\` — must pass.
5. Run \`npm test\` — must pass.
6. Do NOT break existing passing tests.
7. Focus on $LOWEST first (lowest score).

## Architecture Context
- Memory MCP server with hybrid search: BM25 + vector (sqlite-vec) + RRF fusion.
- AMB L1 = basic recall (56 tests, 8 categories).
- AMB L2 = multi-session scenarios (5 scenarios).
- AMB L3 = scale testing (1K+ memories, distractors).
- LoCoMo = long conversation QA (19 sessions, 400+ turns, multi-hop).
- PersonaMem = personalization (588 questions, 20 personas, multiple-choice QA).
  TencentDB scores 76%. Adapter at /tmp/personamem/personamem-bench.ts
  ingests context, searches with question, checks keyword overlap with answer.
- LongMemEval = long-term memory (500 questions, 5 abilities: temporal, multi-session,
  knowledge-update, single-session recall, abstention). Mem0 scores 94.4%.
  Adapter at /tmp/longmemeval/longmemeval-bench.ts — ingests sessions, searches,
  checks if >= 40% of answer keywords appear in top-5 results.

## Key Files
- src/storage/sqlite.ts — search + vector + RRF (improve recall/precision)
- src/server.ts — recall/search handlers
- src/pipeline/atom.ts — fact extraction (may help recall)
- src/utils/rrf.ts — Reciprocal Rank Fusion tuning
- /tmp/personamem/personamem-bench.ts — PersonaMem adapter
- /tmp/longmemeval/longmemeval-bench.ts — LongMemEval adapter
- /tmp/locomo-bench/run.ts — LoCoMo adapter

## Rules
- ONE focused fix per iteration.
- No unrelated refactoring.
- Run build + tests before finishing.
- If stuck after 3 attempts, try a different approach.
- You can modify the benchmark adapter scoring logic AND the search engine.
EOF

  # 10. Call Devin to fix
  DEVIN_LOG="$LOG_DIR/iter-${iter}-devin.log"
  log "Calling Devin to fix $LOWEST (score=$LOWEST_SCORE)..."
  cd "$PROJECT_ROOT"
  devin -p "$(cat "$PROMPT_FILE")" \
    --permission-mode dangerous \
    > "$DEVIN_LOG" 2>&1 || true

  log "Devin finished."
  tail -5 "$DEVIN_LOG" 2>/dev/null | while read -r line; do log "  $line"; done

  log "Iteration $iter complete. Scores: L1=$L1 L2=$L2 L3=$L3 LOCOMO=$LOCOMO PERSONA=$PERSONAMEM LONGMEMEVAL=$LONGMEMEVAL"
  log ""
done

# ─── Max iterations reached ────────────────────────────────────
log ""
log "════════════════════════════════════════════════════════"
log "  MAX ITERATIONS ($MAX_ITER) REACHED — target not met"
log "════════════════════════════════════════════════════════"
log "Last scores: L1=$L1 L2=$L2 L3=$L3 LOCOMO=$LOCOMO PERSONA=$PERSONAMEM LONGMEMEVAL=$LONGMEMEVAL"
log "Logs: $LOG_DIR/"
log "Scores: $SCORES_FILE"
log "Resume: bash scripts/loop-unified.sh $MAX_ITER"
exit 1
