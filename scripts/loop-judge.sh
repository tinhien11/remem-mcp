#!/bin/bash
# loop-judge.sh — Benchmark loop with parallel AMB fix + 4 LLM judges.
#
# Flow per iteration:
#   1. Run AMB (built-in scoring, no judges needed)
#   2. If AMB < 100 → launch AMB fix agent in BACKGROUND
#   3. Run LoCoMo + PersonaMem + LongMemEval adapters IN PARALLEL (3 processes)
#   4. Judge each with 4 parallel Devin workers (sequential per benchmark)
#   5. Wait for AMB fix agent (if still running)
#   6. If any LLM-judged benchmark < target → launch fix for lowest
#   7. Rebuild → next iteration
#
# This way AMB fix runs in parallel with the slow LLM-judged benchmarks.
#
# Usage: bash scripts/loop-judge.sh [max_iterations] [--quick]

set -uo pipefail

MAX_ITER="${1:-30}"
QUICK=false
[[ "${2:-}" == "--quick" ]] && QUICK=true

PROJECT_ROOT="/Users/tin/a/remem-mcp"
LOG_DIR="/tmp/bench-judge"
JUDGE_DIR="$LOG_DIR/judges"
mkdir -p "$LOG_DIR" "$JUDGE_DIR"

LOCOMO_BENCH="/tmp/locomo-bench"
LOCOMO_RESULTS="$LOCOMO_BENCH/results.json"
PERSONAMEM_DIR="/tmp/personamem"
PERSONAMEM_RESULTS="$PERSONAMEM_DIR/results.json"
LONGMEMEVAL_DIR="/tmp/longmemeval"
LONGMEMEVAL_RESULTS="$LONGMEMEVAL_DIR/results.json"
AMB_REPO="/tmp/amb-repo"

T_L1=100; T_L2=100; T_L3=100
T_LOCOMO=92; T_PERSONA=76; T_LONGMEMEVAL=94
NUM_JUDGES=4
DEVIN_FLAGS="--permission-mode dangerous --respect-workspace-trust false"

log() { echo "[loop $(date '+%H:%M:%S')] $*" >&2; }
progress() { echo "  → $*" >&2; }
is_num() { [[ "$1" =~ ^[0-9]+$ ]]; }

# ─── Run benchmark in background with progress monitoring ──────
run_bench_bg() {
  local name=$1 run_cmd=$2 logfile=$3
  progress "[$name] starting..."
  eval "$run_cmd" > "$logfile" 2>&1 &
  local pid=$!
  local elapsed=0
  while kill -0 $pid 2>/dev/null; do
    sleep 5
    elapsed=$((elapsed + 5))
    local last_line=$(tail -c 80 "$logfile" 2>/dev/null | tr '\n' ' ')
    progress "[$name] ${elapsed}s — $last_line"
  done
  wait $pid 2>/dev/null || true
  progress "[$name] done"
}

# ─── Judge a benchmark with 4 parallel Devin workers ───────────
judge_benchmark() {
  local name=$1 results_file=$2 target=$3

  if [ ! -f "$results_file" ]; then
    progress "[$name] No results file"
    echo "N/A"
    return
  fi

  local count=$(python3 -c "import json; d=json.load(open('$results_file')); print(len(d if isinstance(d,list) else d.get('results',[])))" 2>/dev/null || echo "0")
  if [ "$count" = "0" ]; then
    progress "[$name] No results"
    echo "0"
    return
  fi
  progress "[$name] $count questions → $NUM_JUDGES judges"

  python3 "$PROJECT_ROOT/scripts/split-results.py" "$results_file" $NUM_JUDGES "$JUDGE_DIR/${name}" 2>/dev/null

  log "[$name] Launching $NUM_JUDGES judges..."
  local pids=()
  for i in $(seq 0 $((NUM_JUDGES - 1))); do
    local chunk_file="$JUDGE_DIR/${name}_${i}.json"
    local judge_out="$JUDGE_DIR/${name}_judge_${i}.txt"
    if [ ! -f "$chunk_file" ]; then
      echo "SKIP" > "$judge_out"
      continue
    fi
    local chunk_content=$(cat "$chunk_file")
    cd "$PROJECT_ROOT"
    devin -p "You are an LLM judge evaluating a memory retrieval system.

For each question below, check if the search results contain enough information to answer the question correctly. The ground-truth answer is provided for reference.

Reply with ONE LINE per question in format: \"INDEX: YES\" or \"INDEX: NO\"
- YES = the search results contain the key information needed to answer correctly
- NO = the search results do NOT contain enough information

Questions and results (JSON array):
$chunk_content

Reply with ONLY the YES/NO verdicts, one per line." \
      $DEVIN_FLAGS \
      > "$judge_out" 2>&1 &
    pids+=($!)
  done

  # Monitor
  local elapsed=0
  while true; do
    local alive=0
    for pid in "${pids[@]}"; do kill -0 $pid 2>/dev/null && alive=$((alive + 1)); done
    [ $alive -eq 0 ] && break
    sleep 10
    elapsed=$((elapsed + 10))
    progress "[$name] ${elapsed}s — $alive/$NUM_JUDGES judges running"
  done
  for pid in "${pids[@]}"; do wait $pid 2>/dev/null || true; done

  local score=$(python3 "$PROJECT_ROOT/scripts/aggregate-judges.py" \
    "$JUDGE_DIR"/${name}_judge_*.txt 2>/dev/null | grep "JUDGE_SCORE=" | grep -oE '[0-9]+' || echo "0")
  log "[$name] SCORE: $score / 100 (target: $target)"
  echo "$score"
}

# ─── Run AMB (built-in scoring) ────────────────────────────────
run_amb() {
  cd "$AMB_REPO"
  log "[AMB] Running L1/L2/L3..."
  local l1_out=$(npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer 1 --no-delay --verbose 2>&1)
  local l1=$(echo "$l1_out" | grep 'Layer 1 Score' | grep -oE '[0-9]+' | head -1); l1=${l1:-0}
  progress "[AMB] L1=$l1"

  local l2_out=$(npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer 2 --no-delay --verbose 2>&1)
  local l2=$(echo "$l2_out" | grep 'Layer 2 Score' | grep -oE '[0-9]+' | head -1); l2=${l2:-0}
  progress "[AMB] L2=$l2"

  local l3_out=$(npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer 3 --no-delay --verbose 2>&1)
  local l3=$(echo "$l3_out" | grep 'Layer 3 Score' | grep -oE '[0-9]+' | head -1); l3=${l3:-0}
  progress "[AMB] L3=$l3"

  echo "$l1 $l2 $l3"
}

# ─── Launch AMB fix agent in background ────────────────────────
launch_amb_fix() {
  local iter=$1 l1=$2 l2=$3 l3=$4
  local fix_log="$LOG_DIR/amb-fix-iter-${iter}.log"
  local prompt_file="$LOG_DIR/amb-fix-prompt-${iter}.md"

  cat > "$prompt_file" << EOF
# AMB Fix — Iteration $iter

You are improving remem-mcp at $PROJECT_ROOT.
Goal: AMB L1/L2/L3 all score 100/100.

## Current AMB Scores
- L1: $l1 / 100
- L2: $l2 / 100
- L3: $l3 / 100

## Steps
1. cd $PROJECT_ROOT && npm run build
2. Run AMB L1: cd /tmp/amb-repo && npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer 1 --no-delay --verbose 2>&1
3. Run AMB L2: same but --layer 2
4. Run AMB L3: same but --layer 3
5. Parse scores from "Layer N Score:" lines
6. If any < 100, read failing test details, fix in $PROJECT_ROOT/src/
7. Rebuild: cd $PROJECT_ROOT && npm run build
8. Re-run failing layers
9. cd $PROJECT_ROOT && npm test — must pass
10. git add -A src/ && git commit -m "bench-amb: iter $iter — L1=$l1 L2=$l2 L3=$l3"

## Key Files
- $PROJECT_ROOT/src/storage/sqlite.ts — search + BM25 + vector + RRF
- $PROJECT_ROOT/src/server.ts — MCP server, recall/search handlers
- /tmp/amb-repo/src/categories/ — AMB test categories

## Rules
- Minimal changes. Don't break existing tests.
- Focus on search recall and precision.
EOF

  log "[AMB] Launching fix agent in background..."
  cd "$PROJECT_ROOT"
  devin -p "$(cat "$prompt_file")" $DEVIN_FLAGS > "$fix_log" 2>&1 &
  echo $!
}

# ─── Monitor a background Devin agent ──────────────────────────
monitor_agent() {
  local pid=$1 label=$2 logfile=$3
  local elapsed=0
  while kill -0 $pid 2>/dev/null; do
    sleep 15
    elapsed=$((elapsed + 15))
    local last=$(tail -c 100 "$logfile" 2>/dev/null | tr '\n' ' ')
    progress "[$label] ${elapsed}s — $last"
  done
  wait $pid 2>/dev/null || true
  progress "[$label] finished (${elapsed}s)"
}

# ─── Main loop ─────────────────────────────────────────────────
log "Starting judge loop ($MAX_ITER iterations, $NUM_JUDGES parallel judges + parallel AMB fix)"

for iter in $(seq 1 $MAX_ITER); do
  log ""
  log "════════════════════════════════════════════════════════"
  log "  ITERATION $iter / $MAX_ITER"
  log "════════════════════════════════════════════════════════"

  # 1. Build
  log "Building remem-mcp..."
  cd "$PROJECT_ROOT"
  npm run build 2>&1 | tail -1
  progress "Build OK"

  # 2. Run AMB (built-in scoring, no judges)
  log "Phase 1: AMB (built-in scoring)..."
  amb_scores=$(run_amb 2>/dev/null)
  L1=$(echo "$amb_scores" | awk '{print $1}'); L1=${L1:-0}
  L2=$(echo "$amb_scores" | awk '{print $2}'); L2=${L2:-0}
  L3=$(echo "$amb_scores" | awk '{print $3}'); L3=${L3:-0}
  log "AMB: L1=$L1 L2=$L2 L3=$L3"

  # 3. If AMB < 100, launch fix agent IN BACKGROUND
  AMB_FIX_PID=""
  if is_num "$L1" && [ "$L1" -lt "$T_L1" ]; then
    AMB_FIX_PID=$(launch_amb_fix "$iter" "$L1" "$L2" "$L3")
    progress "AMB fix agent launched (PID $AMB_FIX_PID) — running in background"
  fi

  # 4. Run benchmark adapters IN PARALLEL (3 processes, separate DBs)
  LOCOMO="N/A"; PERSONA="N/A"; LONGMEMEVAL="N/A"

  if ! $QUICK; then
    log "Phase 2: Running 3 benchmark adapters in parallel..."

    # Launch all 3 adapters in parallel
    eval "cd $LOCOMO_BENCH && npx tsx run.ts" > "$LOG_DIR/locomo-raw.log" 2>&1 &
    PID_LOCOMO_RUN=$!
    eval "cd $PERSONAMEM_DIR && npx tsx personamem-bench.ts --sample=50" > "$LOG_DIR/personamem-raw.log" 2>&1 &
    PID_PERSONA_RUN=$!
    eval "cd $LONGMEMEVAL_DIR && npx tsx longmemeval-bench.ts --sample=50 --variant=oracle" > "$LOG_DIR/longmemeval-raw.log" 2>&1 &
    PID_LONGMEMEVAL_RUN=$!

    # Monitor all 3 + AMB fix (if running) simultaneously
    progress "Waiting for 3 adapters + AMB fix (if running)..."
    _elapsed=0
    while true; do
      _alive=0
      kill -0 $PID_LOCOMO_RUN 2>/dev/null && _alive=$((_alive + 1))
      kill -0 $PID_PERSONA_RUN 2>/dev/null && _alive=$((_alive + 1))
      kill -0 $PID_LONGMEMEVAL_RUN 2>/dev/null && _alive=$((_alive + 1))
      [ -n "$AMB_FIX_PID" ] && kill -0 $AMB_FIX_PID 2>/dev/null && _alive=$((_alive + 1))
      [ $_alive -eq 0 ] && break
      sleep 10
      _elapsed=$((_elapsed + 10))
      _locomo_status="done"; _persona_status="done"; _lme_status="done"; _amb_status="done"
      kill -0 $PID_LOCOMO_RUN 2>/dev/null && _locomo_status="$(tail -c 60 $LOG_DIR/locomo-raw.log 2>/dev/null | tr '\n' ' ')"
      kill -0 $PID_PERSONA_RUN 2>/dev/null && _persona_status="$(tail -c 60 $LOG_DIR/personamem-raw.log 2>/dev/null | tr '\n' ' ')"
      kill -0 $PID_LONGMEMEVAL_RUN 2>/dev/null && _lme_status="$(tail -c 60 $LOG_DIR/longmemeval-raw.log 2>/dev/null | tr '\n' ' ')"
      [ -n "$AMB_FIX_PID" ] && kill -0 $AMB_FIX_PID 2>/dev/null && _amb_status="$(tail -c 60 $LOG_DIR/amb-fix-iter-${iter}.log 2>/dev/null | tr '\n' ' ')"
      progress "${_elapsed}s | locomo:$_locomo_status | persona:$_persona_status | lme:$_lme_status | amb-fix:$_amb_status"
    done
    wait $PID_LOCOMO_RUN 2>/dev/null || true
    wait $PID_PERSONA_RUN 2>/dev/null || true
    wait $PID_LONGMEMEVAL_RUN 2>/dev/null || true
    progress "All 3 adapters done"

    # 5. Judge each benchmark (4 judges each, sequential to avoid 12 parallel Devins)
    log "Phase 3: Judging LoCoMo..."
    LOCOMO=$(judge_benchmark "locomo" "$LOCOMO_RESULTS" "$T_LOCOMO" 2>/dev/null)
    LOCOMO=${LOCOMO:-N/A}

    log "Phase 3: Judging PersonaMem..."
    PERSONA=$(judge_benchmark "personamem" "$PERSONAMEM_RESULTS" "$T_PERSONA" 2>/dev/null)
    PERSONA=${PERSONA:-N/A}

    log "Phase 3: Judging LongMemEval..."
    LONGMEMEVAL=$(judge_benchmark "longmemeval" "$LONGMEMEVAL_RESULTS" "$T_LONGMEMEVAL" 2>/dev/null)
    LONGMEMEVAL=${LONGMEMEVAL:-N/A}
  fi

  # 6. Wait for AMB fix agent if still running
  if [ -n "$AMB_FIX_PID" ]; then
    if kill -0 $AMB_FIX_PID 2>/dev/null; then
      log "Waiting for AMB fix agent to finish..."
      monitor_agent $AMB_FIX_PID "AMB-fix" "$LOG_DIR/amb-fix-iter-${iter}.log"
    else
      wait $AMB_FIX_PID 2>/dev/null || true
      progress "AMB fix already finished"
    fi
    # Rebuild with AMB fix changes
    log "Rebuilding with AMB fix changes..."
    cd "$PROJECT_ROOT"
    npm run build 2>&1 | tail -1
    # Re-run AMB to get updated scores
    log "Re-running AMB with fixes..."
    amb_scores=$(run_amb 2>/dev/null)
    L1=$(echo "$amb_scores" | awk '{print $1}'); L1=${L1:-0}
    L2=$(echo "$amb_scores" | awk '{print $2}'); L2=${L2:-0}
    L3=$(echo "$amb_scores" | awk '{print $3}'); L3=${L3:-0}
    log "AMB after fix: L1=$L1 L2=$L2 L3=$L3"
  fi

  # 7. Print scores
  log ""
  log "════════════════════════════════════════════════════════"
  log "  SCORES — Iteration $iter"
  log "════════════════════════════════════════════════════════"
  log "  AMB L1:       $L1  / $T_L1"
  log "  AMB L2:       $L2  / $T_L2"
  log "  AMB L3:       $L3  / $T_L3"
  log "  LoCoMo:       $LOCOMO  / $T_LOCOMO (Mem0=92.5)"
  log "  PersonaMem:   $PERSONA  / $T_PERSONA (TencentDB=76)"
  log "  LongMemEval:  $LONGMEMEVAL  / $T_LONGMEMEVAL (Mem0=94.4)"
  log "════════════════════════════════════════════════════════"

  # 8. Check victory
  PASS=true
  FAILURES=""
  is_num "$L1" && [ "$L1" -lt "$T_L1" ] && PASS=false && FAILURES+="L1=$L1 "
  is_num "$L2" && [ "$L2" -lt "$T_L2" ] && PASS=false && FAILURES+="L2=$L2 "
  is_num "$L3" && [ "$L3" -lt "$T_L3" ] && PASS=false && FAILURES+="L3=$L3 "
  is_num "$LOCOMO" && [ "$LOCOMO" -lt "$T_LOCOMO" ] && PASS=false && FAILURES+="LOCOMO=$LOCOMO "
  is_num "$PERSONA" && [ "$PERSONA" -lt "$T_PERSONA" ] && PASS=false && FAILURES+="PERSONA=$PERSONA "
  is_num "$LONGMEMEVAL" && [ "$LONGMEMEVAL" -lt "$T_LONGMEMEVAL" ] && PASS=false && FAILURES+="LONGMEMEVAL=$LONGMEMEVAL "

  if ! is_num "$L1" && ! is_num "$LOCOMO" && ! is_num "$PERSONA" && ! is_num "$LONGMEMEVAL"; then
    PASS=false; FAILURES="All N/A"
  fi

  if [ "$PASS" = true ]; then
    log ""
    log "  ╔════════════════════════════════════════════════╗"
    log "  ║  VICTORY! All targets met at iteration $iter!   ║"
    log "  ╚════════════════════════════════════════════════╝"
    exit 0
  fi

  log "Targets not met: $FAILURES"

  # 9. Find lowest LLM-judged benchmark (AMB already fixed above)
  LOWEST=""; LOWEST_SCORE=999
  for pair in "LOCOMO:$LOCOMO" "PERSONA:$PERSONA" "LONGMEMEVAL:$LONGMEMEVAL"; do
    name=$(echo "$pair" | cut -d: -f1)
    score=$(echo "$pair" | cut -d: -f2)
    if is_num "$score" && [ "$score" -lt "$LOWEST_SCORE" ]; then
      LOWEST="$name"; LOWEST_SCORE=$score
    fi
  done

  # Also check if AMB still needs fixing
  AMB_NEEDS_FIX=false
  is_num "$L1" && [ "$L1" -lt "$T_L1" ] && AMB_NEEDS_FIX=true
  is_num "$L2" && [ "$L2" -lt "$T_L2" ] && AMB_NEEDS_FIX=true
  is_num "$L3" && [ "$L3" -lt "$T_L3" ] && AMB_NEEDS_FIX=true

  if [ -z "$LOWEST" ] && [ "$AMB_NEEDS_FIX" = false ]; then
    log "Nothing to fix — continuing"
    continue
  fi

  if [ -z "$LOWEST" ]; then
    LOWEST="AMB"; LOWEST_SCORE=0
    log "Focus: AMB still needs fixing (L1=$L1 L2=$L2 L3=$L3)"
  else
    log "Focus: $LOWEST is lowest at $LOWEST_SCORE / 100"
  fi

  # 10. Build fix prompt for lowest LLM-judged benchmark
  FIX_PROMPT="$LOG_DIR/fix-prompt-iter-${iter}.md"
  cat > "$FIX_PROMPT" << EOF
# Benchmark Fix — Iteration $iter

You are improving remem-mcp at $PROJECT_ROOT.
Goal: Beat TencentDB (PersonaMem=76) and Mem0 (LoCoMo=92.5, LongMemEval=94.4).

## Current Scores
| Benchmark    | Score  | Target |
|-------------|--------|--------|
| AMB L1      | $L1    | 100    |
| AMB L2      | $L2    | 100    |
| AMB L3      | $L3    | 100    |
| LoCoMo      | $LOCOMO | 92    |
| PersonaMem  | $PERSONA | 76   |
| LongMemEval | $LONGMEMEVAL | 94 |

## Focus: $LOWEST (score=$LOWEST_SCORE)

## Your Task
1. Read benchmark logs in $LOG_DIR/ to see what failed.
2. Read $PROJECT_ROOT/src/ — focus on search, recall, storage.
3. Fix the root cause. Minimal changes.
4. cd $PROJECT_ROOT && npm run build && npm test — must pass.
5. git add -A src/ && git commit -m "bench-fix: iter $iter — improve $LOWEST"

## Key Files
- src/storage/sqlite.ts — search + BM25 + vector + RRF
- src/server.ts — MCP server, recall/search handlers
- /tmp/locomo-bench/run.ts — LoCoMo adapter
- /tmp/personamem/personamem-bench.ts — PersonaMem adapter
- /tmp/longmemeval/longmemeval-bench.ts — LongMemEval adapter

## Rules
- ONE focused fix per iteration.
- Don't break existing tests.
- You can modify adapters AND search engine.
EOF

  # 11. Call Devin to fix lowest LLM-judged benchmark
  DEVIN_LOG="$LOG_DIR/fix-iter-${iter}.log"
  log "Calling Devin to fix $LOWEST..."
  cd "$PROJECT_ROOT"
  devin -p "$(cat "$FIX_PROMPT")" $DEVIN_FLAGS > "$DEVIN_LOG" 2>&1 &
  fix_pid=$!
  fix_elapsed=0
  while kill -0 $fix_pid 2>/dev/null; do
    sleep 15
    fix_elapsed=$((fix_elapsed + 15))
    last=$(tail -c 100 "$DEVIN_LOG" 2>/dev/null | tr '\n' ' ')
    progress "Fix $LOWEST: ${fix_elapsed}s — $last"
  done
  wait $fix_pid 2>/dev/null || true

  log "Fix finished."
  tail -3 "$DEVIN_LOG" 2>/dev/null | while read -r line; do progress "$line"; done
  log "Iteration $iter complete."
  log ""
done

log "MAX ITERATIONS ($MAX_ITER) reached."
log "Logs: $LOG_DIR/"
exit 1
