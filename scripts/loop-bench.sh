#!/bin/bash
# loop-bench.sh — Autonomous loop: run benchmark → if fail, call devin -p → repeat.
# Usage: ./scripts/loop-bench.sh [max_iterations]
#
# No LoopX. File-based resume via last-iter.txt.
#
# Requirements:
#   - devin CLI on PATH
#   - AMB repo at /tmp/amb-repo
#   - LoCoMo data at /tmp/locomo/data/locomo10.json (optional)

set -uo pipefail

# ─── Config ────────────────────────────────────────────────────
MAX_ITER="${1:-50}"
PROJECT_ROOT="/data/projects/tdai-memory-mcp"
BENCH_SCRIPT="$PROJECT_ROOT/scripts/bench-all.sh"
LOG_DIR="/tmp/bench-loop-logs"
PROMPT_FILE="/tmp/bench-loop-prompt.md"
LAST_ITER_FILE="$LOG_DIR/last-iter.txt"

# Targets
export TARGET_L1="${TARGET_L1:-100}"
export TARGET_L2="${TARGET_L2:-100}"
export TARGET_L3="${TARGET_L3:-100}"
export TARGET_LOCOMO="${TARGET_LOCOMO:-76}"
export TARGET_PERSONAMEM="${TARGET_PERSONAMEM:-76}"

mkdir -p "$LOG_DIR"
log() { echo "[loop] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# ─── Resume logic (file-based) ─────────────────────────────────
START_ITER=1
if [ -f "$LAST_ITER_FILE" ]; then
  START_ITER=$(($(cat "$LAST_ITER_FILE") + 1))
  log "Resuming from iteration $START_ITER"
fi

# ─── Main loop ─────────────────────────────────────────────────
for iter in $(seq $START_ITER $MAX_ITER); do
  echo "$iter" > "$LAST_ITER_FILE"
  log "══════════════════════════════════════════════════════"
  log "  ITERATION $iter / $MAX_ITER"
  log "══════════════════════════════════════════════════════"

  # 1. Run benchmark (full mode — includes LoCoMo + PersonaMem)
  BENCH_LOG="$LOG_DIR/iter-${iter}-bench.log"
  log "Running benchmark..."
  if bash "$BENCH_SCRIPT" > "$BENCH_LOG" 2>&1; then
    log "ALL PASS ✓"
    RESULT_LINE=$(grep "BENCH_RESULT" "$BENCH_LOG" || echo "")
    log "$RESULT_LINE"
    log "Done."
    exit 0
  fi

  # 2. Parse scores
  RESULT_LINE=$(grep "BENCH_RESULT" "$BENCH_LOG" || echo "BENCH_RESULT L1=0 L2=0 L3=0 LOCOMO=N/A PERSONAMEM=N/A")
  L1=$(echo "$RESULT_LINE" | grep -oP 'L1=\K[0-9]+' || echo "0")
  L2=$(echo "$RESULT_LINE" | grep -oP 'L2=\K[0-9]+' || echo "0")
  L3=$(echo "$RESULT_LINE" | grep -oP 'L3=\K[0-9]+' || echo "0")
  LOCOMO=$(echo "$RESULT_LINE" | grep -oP 'LOCOMO=\K[0-9]+' || echo "N/A")
  PERSONAMEM=$(echo "$RESULT_LINE" | grep -oP 'PERSONAMEM=\K[0-9]+' || echo "N/A")

  log "Scores: L1=$L1 L2=$L2 L3=$L3 LOCOMO=$LOCOMO PERSONAMEM=$PERSONAMEM"

  # 3. Extract failures
  FAILURES=$(grep "^FAIL:" "$BENCH_LOG" || echo "")
  if [ -z "$FAILURES" ]; then
    FAILURES="Benchmark exited non-zero. Check $BENCH_LOG."
  fi

  # 4. Extract detailed test failures
  AMB_FAILURES=$(grep -E "FAIL|✗|failed|incorrect|wrong|Expected|Got" "$BENCH_LOG" | head -30 || echo "")

  # 5. Find lowest-scoring layer to focus Devin
  LOWEST_LAYER="L2"
  LOWEST_SCORE=$L2
  if [ "$L3" -lt "$LOWEST_SCORE" ] 2>/dev/null; then LOWEST_LAYER="L3"; LOWEST_SCORE=$L3; fi
  if [ "$LOCOMO" != "N/A" ] && [ "$LOCOMO" -lt "$LOWEST_SCORE" ] 2>/dev/null; then LOWEST_LAYER="LOCOMO"; LOWEST_SCORE=$LOCOMO; fi
  if [ "$PERSONAMEM" != "N/A" ] && [ "$PERSONAMEM" -lt "$LOWEST_SCORE" ] 2>/dev/null; then LOWEST_LAYER="PERSONAMEM"; LOWEST_SCORE=$PERSONAMEM; fi

  # 6. Build prompt for Devin
  cat > "$PROMPT_FILE" << EOF
# Benchmark Fix Task — Iteration $iter

You are working on tdai-memory-mcp at $PROJECT_ROOT.
Goal: Pass ALL benchmarks with scores >= TencentDB.

## Current Scores vs Targets
| Benchmark  | Score | Target |
|------------|-------|--------|
| AMB L1     | $L1   | $TARGET_L1 |
| AMB L2     | $L2   | $TARGET_L2 |
| AMB L3     | $L3   | $TARGET_L3 |
| LoCoMo     | $LOCOMO | $TARGET_LOCOMO |
| PersonaMem | $PERSONAMEM | $TARGET_PERSONAMEM |

## Focus: $LOWEST_LAYER is lowest at $LOWEST_SCORE / 100

## Failures
$FAILURES

## Detailed Test Failures
$AMB_FAILURES

## Full Benchmark Log
Read: $BENCH_LOG

## Your Task
1. Read $BENCH_LOG to see exactly which tests failed and why.
2. Read the relevant source code in $PROJECT_ROOT/src/.
3. Fix the root cause. Make minimal, surgical changes.
4. Run \`npm run build\` — must pass.
5. Run \`npm test\` — must pass.
6. Do NOT break existing passing tests.
7. Focus on $LOWEST_LAYER first (lowest score).

## Architecture Context
- Memory MCP server with hybrid search: BM25 + vector (sqlite-vec) + RRF fusion.
- AMB L1 = basic recall (56 tests, 8 categories).
- AMB L2 = multi-session scenarios (5 scenarios).
- AMB L3 = scale testing (1K+ memories, distractors).
- LoCoMo = long conversation QA (19 sessions, 400+ turns, multi-hop questions).
- PersonaMem = personalization benchmark (588 questions, 20 personas, multiple-choice QA).
  TencentDB scores 76% on PersonaMem. Our adapter at /tmp/personamem/personamem-bench.ts
  ingests conversation context into tdai-memory-mcp, then searches with the question
  and checks if search results contain unique keywords from the correct answer.
  Current score: $PERSONAMEM/100. Target: 76.
- AtomPipeline exists but only runs for decision/learning/error — NOT conversation.
- Search does NOT join atoms table — atoms are stored but never searched.
- TencentDB uses L1/L2/L3 extraction pipeline: extract facts → scenarios → knowledge graph.
- To beat TencentDB: implement fact extraction for conversations + atom-aware search.

## Key Files
- src/pipeline/atom.ts — L1 fact extraction (extend to conversation type)
- src/storage/sqlite.ts — search + vector + RRF (add atom search)
- src/server.ts — recall/search handlers (join atoms into results)
- src/pipeline/types.ts — pipeline interfaces
- /tmp/personamem/personamem-bench.ts — PersonaMem adapter (scoring logic)
- /tmp/personamem/data/questions_32k.csv — PersonaMem questions
- /tmp/personamem/data/shared_contexts_32k.jsonl — PersonaMem contexts

## Rules
- ONE focused fix per iteration.
- No unrelated refactoring.
- Run build + tests before finishing.
- If you're stuck after 3 attempts at the same fix, try a different approach.
EOF

  # 7. Call Devin to fix
  DEVIN_LOG="$LOG_DIR/iter-${iter}-devin.log"
  log "Calling Devin (dangerous mode) to fix $LOWEST_LAYER..."
  log "Prompt: $PROMPT_FILE"
  log "Devin log: $DEVIN_LOG"

  devin -p "$(cat "$PROMPT_FILE")" \
    --permission-mode dangerous \
    > "$DEVIN_LOG" 2>&1 || true

  log "Devin finished."

  # 8. Summary
  DEVIN_SUMMARY=$(tail -5 "$DEVIN_LOG" 2>/dev/null || echo "no output")
  log "Devin output (last 5 lines):"
  echo "$DEVIN_SUMMARY" | while read -r line; do log "  $line"; done

  log "Iteration $iter complete."
  log ""
done

# ─── Max iterations reached ────────────────────────────────────
log "══════════════════════════════════════════════════════"
log "  MAX ITERATIONS ($MAX_ITER) REACHED — target not met"
log "══════════════════════════════════════════════════════"
log "Last scores: L1=$L1 L2=$L2 L3=$L3 LOCOMO=$LOCOMO PERSONAMEM=$PERSONAMEM"
log "Logs: $LOG_DIR/"
log "Resume: bash scripts/loop-bench.sh $MAX_ITER"
exit 1
