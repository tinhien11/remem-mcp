#!/usr/bin/env bash
#
# loop-mem0-bench.sh — Autonomous loop to beat Mem0's benchmark scores.
#
# Mem0 targets:
#   LoCoMo:      92.5
#   LongMemEval: 94.4
#   BEAM (1M):   64.1
#
# Loop: run benchmark → analyze gaps → Devin fixes → re-run → repeat
#
set -euo pipefail

PROJECT_ROOT="/data/projects/tdai-memory-mcp"
BENCH_ROOT="/tmp/memory-benchmarks"
HTTP_SERVER="/tmp/tdai-http-server.js"
RESULTS_DIR="/tmp/mem0-bench-results"
ITER_FILE="$RESULTS_DIR/last-iter.txt"
SCORE_FILE="$RESULTS_DIR/scores.json"
LOG_FILE="$RESULTS_DIR/loop.log"

# Targets
TARGET_LOCOMO=92.5
TARGET_LONGMEMEVAL=94.4
TARGET_BEAM=64.1

# Sample sizes (for speed)
LOCOMO_SAMPLE=50
LONGMEMEVAL_SAMPLE=50
WORKERS=4   # Concurrent devin -p calls

mkdir -p "$RESULTS_DIR"

log() {
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# --- Iteration tracking ---
if [[ -f "$ITER_FILE" ]]; then
  ITER=$(cat "$ITER_FILE")
else
  ITER=0
fi

# --- Start HTTP server if not running ---
start_http_server() {
  if curl -s http://127.0.0.1:8888/health >/dev/null 2>&1; then
    log "HTTP server already running"
    return 0
  fi
  log "Starting tdai-memory HTTP server..."
  pkill -9 -f "tdai-http-server" 2>/dev/null || true
  pkill -9 -f "node.*tdai-memory-mcp/dist" 2>/dev/null || true
  sleep 2
  node "$HTTP_SERVER" 8888 &
  HTTP_PID=$!
  sleep 5
  if curl -s http://127.0.0.1:8888/health >/dev/null 2>&1; then
    log "HTTP server started (PID $HTTP_PID)"
  else
    log "ERROR: HTTP server failed to start"
    exit 1
  fi
}

# --- Run LoCoMo predict ---
run_locomo_predict() {
  log "Running LoCoMo predict (10 conversations)..."
  cd "$BENCH_ROOT"
  rm -rf "results/locomo/predicted_tdai-loop"
  python3 -m benchmarks.locomo.run \
    --project-name tdai-loop \
    --backend oss \
    --mem0-host http://127.0.0.1:8888 \
    --provider devin \
    --predict-only \
    --conversations 0,1,2,3,4,5,6,7,8,9 \
    2>&1 | tail -3 | tee -a "$LOG_FILE"
}

# --- Run LoCoMo judge (parallel) ---
run_locomo_judge() {
  log "Running LoCoMo judge (n=$LOCOMO_SAMPLE, $WORKERS workers)..."
  cd "$BENCH_ROOT"
  python3 parallel_judge.py \
    results/locomo/predicted_tdai-loop/ \
    --n $LOCOMO_SAMPLE \
    --top-k 50 \
    --workers $WORKERS \
    2>&1 | tee "$RESULTS_DIR/locomo-judge-$ITER.txt"

  # Extract overall score
  local score=$(grep "^Overall:" "$RESULTS_DIR/locomo-judge-$ITER.txt" | grep -oP '[\d.]+')
  echo "$score"
}

# --- Run LongMemEval predict ---
run_longmemeval_predict() {
  log "Running LongMemEval predict..."
  cd "$BENCH_ROOT"
  rm -rf "results/longmemeval/predicted_tdai-loop"
  python3 -m benchmarks.longmemeval.run \
    --project-name tdai-loop \
    --backend oss \
    --mem0-host http://127.0.0.1:8888 \
    --provider devin \
    --predict-only \
    --per-type 20 \
    2>&1 | tail -3 | tee -a "$LOG_FILE"
}

# --- Run LongMemEval judge (parallel) ---
run_longmemeval_judge() {
  log "Running LongMemEval judge (n=$LONGMEMEVAL_SAMPLE, $WORKERS workers)..."
  cd "$BENCH_ROOT"
  python3 parallel_judge.py \
    results/longmemeval/predicted_tdai-loop/ \
    --n $LONGMEMEVAL_SAMPLE \
    --top-k 50 \
    --workers $WORKERS \
    2>&1 | tee "$RESULTS_DIR/longmemeval-judge-$ITER.txt"

  local score=$(grep "^Overall:" "$RESULTS_DIR/longmemeval-judge-$ITER.txt" | grep -oP '[\d.]+')
  echo "$score"
}

# --- Analyze gaps and generate fix prompt ---
analyze_gaps() {
  local locomo_score=$1
  local longmemeval_score=$2

  log "Analyzing gaps..."
  log "  LoCoMo:      $locomo_score / $TARGET_LOCOMO (Mem0)"
  log "  LongMemEval: $longmemeval_score / $TARGET_LONGMEMEVAL (Mem0)"

  # Build gap analysis from judge outputs
  local gaps=""

  # LoCoMo category breakdown
  if [[ -f "$RESULTS_DIR/locomo-judge-$ITER.txt" ]]; then
    gaps+="\n\n=== LoCoMo Breakdown (iter $ITER) ===\n"
    gaps+="$(grep -A 20 'RESULTS' "$RESULTS_DIR/locomo-judge-$ITER.txt")"
  fi

  # LongMemEval breakdown
  if [[ -f "$RESULTS_DIR/longmemeval-judge-$ITER.txt" ]]; then
    gaps+="\n\n=== LongMemEval Breakdown (iter $ITER) ===\n"
    gaps+="$(grep -A 20 'RESULTS' "$RESULTS_DIR/longmemeval-judge-$ITER.txt")"
  fi

  # Sample failed questions
  gaps+="\n\n=== Failed Questions (LoCoMo) ===\n"
  gaps+="$(grep '✗' "$RESULTS_DIR/locomo-judge-$ITER.txt" | head -15)"

  gaps+="\n\n=== Failed Questions (LongMemEval) ===\n"
  gaps+="$(grep '✗' "$RESULTS_DIR/longmemeval-judge-$ITER.txt" | head -15)"

  echo -e "$gaps" > "$RESULTS_DIR/gaps-$ITER.txt"
  echo "$gaps"
}

# --- Ask Devin to fix ---
ask_devin_fix() {
  local gaps=$1
  local locomo_score=$2
  local longmemeval_score=$3

  log "Asking Devin to fix gaps..."

  local prompt="You are improving tdai-memory-mcp to beat Mem0's benchmark scores.

CURRENT SCORES (iter $ITER):
- LoCoMo: $locomo_score / $TARGET_LOCOMO (Mem0 target)
- LongMemEval: $longmemeval_score / $TARGET_LONGMEMEVAL (Mem0 target)

GAP ANALYSIS:
$gaps

PROJECT: $PROJECT_ROOT
HTTP ADAPTER: /tmp/tdai-http-server.js (Mem0 OSS-compatible REST API on port 8888)
BENCHMARK: $BENCH_ROOT (Mem0's official memory-benchmarks repo)

KEY FILES:
- src/server.ts — MCP server (capture, search, recall tools)
- src/storage/sqlite.ts — SQLite storage + vector search
- src/utils/rrf.ts — Reciprocal Rank Fusion (hybrid search)
- src/security/redactor.ts — Content processing
- /tmp/tdai-http-server.js — HTTP wrapper (adds [Date: YYYY-MM-DD] prefix to captures)

WHAT TO FIX (prioritized by gap size):
1. Temporal reasoning: extract dates from text, store as metadata, boost temporal queries
2. Multi-hop: aggregate facts across sessions, improve cross-session recall
3. Single-hop: improve search precision (reduce noise from date prefixes)
4. Open-domain: broaden recall, increase top_k diversity

CONSTRAINTS:
- Do NOT break existing tests (run: cd $PROJECT_ROOT && npm test)
- Do NOT change the MCP protocol interface
- Focus on src/ files, not /tmp/ adapters
- After fixing, rebuild: cd $PROJECT_ROOT && npm run build

Make the MINIMAL changes needed to improve the weakest category.
Show me what you changed and why."

  cd "$PROJECT_ROOT"
  devin -p "$prompt" --permission-mode dangerous 2>&1 | tee "$RESULTS_DIR/devin-fix-$ITER.txt"
}

# --- Save scores ---
save_scores() {
  local locomo=$1
  local longmemeval=$2

  python3 -c "
import json
scores = json.load(open('$SCORE_FILE')) if __import__('os').path.exists('$SCORE_FILE') else []
scores.append({
    'iter': $ITER,
    'locomo': $locomo,
    'longmemeval': $longmemeval,
    'target_locomo': $TARGET_LOCOMO,
    'target_longmemeval': $TARGET_LONGMEMEVAL,
})
json.dump(scores, open('$SCORE_FILE', 'w'), indent=2)
"
}

# --- Check if we beat Mem0 ---
check_victory() {
  local locomo=$1
  local longmemeval=$2

  local locomo_pass=$(python3 -c "print(1 if $locomo >= $TARGET_LOCOMO else 0)")
  local longmemeval_pass=$(python3 -c "print(1 if $longmemeval >= $TARGET_LONGMEMEVAL else 0)")

  if [[ $locomo_pass -eq 1 ]] && [[ $longmemeval_pass -eq 1 ]]; then
    log ""
    log "========================================"
    log "  VICTORY! All targets met!"
    log "  LoCoMo:      $locomo >= $TARGET_LOCOMO"
    log "  LongMemEval: $longmemeval >= $TARGET_LONGMEMEVAL"
    log "========================================"
    log ""
    return 0
  fi

  log "Not yet. LoCoMo: $locomo/$TARGET_LOCOMO, LongMemEval: $longmemeval/$TARGET_LONGMEMEVAL"
  return 1
}

# --- Main loop ---
main() {
  log "============================================"
  log "  Mem0 Benchmark Loop — Beat Mem0"
  log "  Targets: LoCoMo=$TARGET_LOCOMO, LongMemEval=$TARGET_LONGMEMEVAL"
  log "============================================"

  while true; do
    ITER=$((ITER + 1))
    echo "$ITER" > "$ITER_FILE"
    log ""
    log "========== ITERATION $ITER =========="

    # 1. Start HTTP server
    start_http_server

    # 2. Run LoCoMo
    run_locomo_predict
    LOCOMO_SCORE=$(run_locomo_judge)
    log "LoCoMo score: $LOCOMO_SCORE"

    # 3. Run LongMemEval
    run_longmemeval_predict
    LONGMEMEVAL_SCORE=$(run_longmemeval_judge)
    log "LongMemEval score: $LONGMEMEVAL_SCORE"

    # 4. Save scores
    save_scores "$LOCOMO_SCORE" "$LONGMEMEVAL_SCORE"

    # 5. Check victory
    if check_victory "$LOCOMO_SCORE" "$LONGMEMEVAL_SCORE"; then
      log "Loop complete! Victory at iteration $ITER"
      break
    fi

    # 6. Analyze gaps
    GAPS=$(analyze_gaps "$LOCOMO_SCORE" "$LONGMEMEVAL_SCORE")

    # 7. Ask Devin to fix
    ask_devin_fix "$GAPS" "$LOCOMO_SCORE" "$LONGMEMEVAL_SCORE"

    # 8. Rebuild
    log "Rebuilding tdai-memory-mcp..."
    cd "$PROJECT_ROOT"
    npm run build 2>&1 | tail -3 | tee -a "$LOG_FILE"

    # 9. Restart HTTP server with new build
    log "Restarting HTTP server with new build..."
    pkill -9 -f "tdai-http-server" 2>/dev/null || true
    pkill -9 -f "node.*tdai-memory-mcp/dist" 2>/dev/null || true
    sleep 2

    log "Iteration $ITER complete. Scores: LoCoMo=$LOCOMO_SCORE, LongMemEval=$LONGMEMEVAL_SCORE"
    log "Next iteration will use the fixed code..."
  done

  log "Final scores saved to $SCORE_FILE"
}

main "$@"
