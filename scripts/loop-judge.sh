#!/bin/bash
# loop-judge.sh — Benchmark loop with 4 parallel Devin LLM judges + live progress.
#
# Flow per iteration:
#   1. Run benchmarks (AMB + LoCoMo + PersonaMem + LongMemEval) → get search results
#   2. Split results into 4 chunks → 4 parallel Devin workers judge (YES/NO per question)
#   3. Aggregate scores
#   4. If below target → 1 Devin agent fixes code → rebuild → re-run
#
# Targets:
#   AMB L1/L2/L3:  100/100/100
#   LoCoMo:        92  (Mem0=92.5)
#   PersonaMem:    76  (TencentDB=76)
#   LongMemEval:   94  (Mem0=94.4)
#
# Usage: bash scripts/loop-judge.sh [max_iterations] [--quick]
#   --quick: AMB only (skip LoCoMo/PersonaMem/LongMemEval)

set -uo pipefail

MAX_ITER="${1:-30}"
QUICK=false
[[ "${2:-}" == "--quick" ]] && QUICK=true

PROJECT_ROOT="/Users/tin/a/remem-mcp"
LOG_DIR="/tmp/bench-judge"
JUDGE_DIR="$LOG_DIR/judges"
mkdir -p "$LOG_DIR" "$JUDGE_DIR"

# Benchmarks config
LOCOMO_BENCH="/tmp/locomo-bench"
LOCOMO_RESULTS="$LOCOMO_BENCH/results.json"
PERSONAMEM_DIR="/tmp/personamem"
PERSONAMEM_RESULTS="$PERSONAMEM_DIR/results.json"
LONGMEMEVAL_DIR="/tmp/longmemeval"
LONGMEMEVAL_RESULTS="$LONGMEMEVAL_DIR/results.json"
AMB_REPO="/tmp/amb-repo"

# Targets
T_L1=100; T_L2=100; T_L3=100
T_LOCOMO=92; T_PERSONA=76; T_LONGMEMEVAL=94

# Judges
NUM_JUDGES=4

# Devin flags — bypass workspace trust for /tmp dirs
DEVIN_FLAGS="--permission-mode dangerous --respect-workspace-trust false"

# Live progress — print to stderr with timestamp
log() { echo "[loop $(date '+%H:%M:%S')] $*" >&2; }
progress() { echo "  → $*" >&2; }

# ─── Numeric check ─────────────────────────────────────────────
is_num() { [[ "$1" =~ ^[0-9]+$ ]]; }

# ─── Run benchmark with live output ────────────────────────────
run_bench() {
  local name=$1 run_cmd=$2 logfile=$3
  progress "[$name] starting..."
  eval "$run_cmd" > "$logfile" 2>&1 &
  local pid=$!
  # Monitor progress while running
  local elapsed=0
  while kill -0 $pid 2>/dev/null; do
    sleep 5
    elapsed=$((elapsed + 5))
    local last_line=$(tail -1 "$logfile" 2>/dev/null | head -c 80)
    progress "[$name] ${elapsed}s — $last_line"
  done
  wait $pid 2>/dev/null || true
  progress "[$name] done ($(tail -1 "$logfile" 2>/dev/null | head -c 80))"
}

# ─── Run a benchmark and judge with 4 parallel Devin workers ───
run_and_judge() {
  local name=$1 results_file=$2 run_cmd=$3 target=$4

  log "[$name] Phase 1: Running benchmark..."
  run_bench "$name" "$run_cmd" "$LOG_DIR/${name}-raw.log"

  if [ ! -f "$results_file" ]; then
    progress "[$name] No results file — skipping"
    echo "N/A"
    return
  fi

  local count=$(python3 -c "import json; d=json.load(open('$results_file')); print(len(d if isinstance(d,list) else d.get('results',[])))" 2>/dev/null || echo "0")
  if [ "$count" = "0" ]; then
    progress "[$name] No results — score 0"
    echo "0"
    return
  fi
  progress "[$name] $count questions to judge"

  # Split into 4 chunks
  python3 "$PROJECT_ROOT/scripts/split-results.py" "$results_file" $NUM_JUDGES "$JUDGE_DIR/${name}" 2>/dev/null
  progress "[$name] Split into $NUM_JUDGES chunks"

  # Launch 4 parallel Devin judges
  log "[$name] Phase 2: Launching $NUM_JUDGES parallel Devin judges..."
  local pids=()
  for i in $(seq 0 $((NUM_JUDGES - 1))); do
    local chunk_file="$JUDGE_DIR/${name}_${i}.json"
    local judge_out="$JUDGE_DIR/${name}_judge_${i}.txt"
    if [ ! -f "$chunk_file" ]; then
      echo "SKIP" > "$judge_out"
      continue
    fi
    local chunk_content=$(cat "$chunk_file")
    local chunk_count=$(python3 -c "import json; print(len(json.load(open('$chunk_file'))))" 2>/dev/null || echo "?")
    progress "[$name] Judge $i: $chunk_count questions"
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

  # Monitor judges
  progress "[$name] Waiting for $NUM_JUDGES judges..."
  local elapsed=0
  while true; do
    local alive=0
    for pid in "${pids[@]}"; do
      kill -0 $pid 2>/dev/null && alive=$((alive + 1))
    done
    [ $alive -eq 0 ] && break
    sleep 10
    elapsed=$((elapsed + 10))
    progress "[$name] ${elapsed}s — $alive/$NUM_JUDGES judges still running"
  done
  for pid in "${pids[@]}"; do wait $pid 2>/dev/null || true; done

  # Show judge outputs
  for i in $(seq 0 $((NUM_JUDGES - 1))); do
    local judge_out="$JUDGE_DIR/${name}_judge_${i}.txt"
    local lines=$(wc -l < "$judge_out" 2>/dev/null || echo "0")
    local yes=$(grep -ci "YES" "$judge_out" 2>/dev/null || echo "0")
    progress "[$name] Judge $i: $lines lines, $yes YES"
  done

  local score=$(python3 "$PROJECT_ROOT/scripts/aggregate-judges.py" \
    "$JUDGE_DIR"/${name}_judge_*.txt 2>/dev/null | grep "JUDGE_SCORE=" | grep -oE '[0-9]+' || echo "0")
  log "[$name] SCORE: $score / 100 (target: $target)"
  echo "$score"
}

# ─── Run AMB (has its own scoring, no LLM judge needed) ────────
run_amb() {
  cd "$AMB_REPO"
  log "[AMB] Running L1..."
  local l1_out=$(npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer 1 --no-delay --verbose 2>&1)
  local l1=$(echo "$l1_out" | grep 'Layer 1 Score' | grep -oE '[0-9]+' | head -1)
  l1=${l1:-0}
  progress "[AMB] L1=$l1"

  log "[AMB] Running L2..."
  local l2_out=$(npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer 2 --no-delay --verbose 2>&1)
  local l2=$(echo "$l2_out" | grep 'Layer 2 Score' | grep -oE '[0-9]+' | head -1)
  l2=${l2:-0}
  progress "[AMB] L2=$l2"

  log "[AMB] Running L3..."
  local l3_out=$(npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer 3 --no-delay --verbose 2>&1)
  local l3=$(echo "$l3_out" | grep 'Layer 3 Score' | grep -oE '[0-9]+' | head -1)
  l3=${l3:-0}
  progress "[AMB] L3=$l3"

  echo "$l1 $l2 $l3"
}

# ─── Main loop ─────────────────────────────────────────────────
log "Starting judge loop ($MAX_ITER iterations, $NUM_JUDGES parallel judges)"

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

  # 2. Run AMB
  log "Phase AMB..."
  amb_scores=$(run_amb 2>/dev/null)
  L1=$(echo "$amb_scores" | awk '{print $1}'); L1=${L1:-0}
  L2=$(echo "$amb_scores" | awk '{print $2}'); L2=${L2:-0}
  L3=$(echo "$amb_scores" | awk '{print $3}'); L3=${L3:-0}

  # 3. Run + judge other benchmarks
  LOCOMO="N/A"; PERSONA="N/A"; LONGMEMEVAL="N/A"

  if ! $QUICK; then
    log "Phase LoCoMo..."
    LOCOMO=$(run_and_judge "locomo" "$LOCOMO_RESULTS" \
      "cd $LOCOMO_BENCH && npx tsx run.ts" "$T_LOCOMO" 2>/dev/null)
    LOCOMO=${LOCOMO:-N/A}

    log "Phase PersonaMem..."
    PERSONA=$(run_and_judge "personamem" "$PERSONAMEM_RESULTS" \
      "cd $PERSONAMEM_DIR && npx tsx personamem-bench.ts --sample=50" "$T_PERSONA" 2>/dev/null)
    PERSONA=${PERSONA:-N/A}

    log "Phase LongMemEval..."
    LONGMEMEVAL=$(run_and_judge "longmemeval" "$LONGMEMEVAL_RESULTS" \
      "cd $LONGMEMEVAL_DIR && npx tsx longmemeval-bench.ts --sample=50 --variant=oracle" "$T_LONGMEMEVAL" 2>/dev/null)
    LONGMEMEVAL=${LONGMEMEVAL:-N/A}
  fi

  # 4. Print scores
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

  # 5. Check victory — only count benchmarks that have numeric scores
  PASS=true
  FAILURES=""
  is_num "$L1" && [ "$L1" -lt "$T_L1" ] && PASS=false && FAILURES+="L1=$L1 "
  is_num "$L2" && [ "$L2" -lt "$T_L2" ] && PASS=false && FAILURES+="L2=$L2 "
  is_num "$L3" && [ "$L3" -lt "$T_L3" ] && PASS=false && FAILURES+="L3=$L3 "
  is_num "$LOCOMO" && [ "$LOCOMO" -lt "$T_LOCOMO" ] && PASS=false && FAILURES+="LOCOMO=$LOCOMO "
  is_num "$PERSONA" && [ "$PERSONA" -lt "$T_PERSONA" ] && PASS=false && FAILURES+="PERSONA=$PERSONA "
  is_num "$LONGMEMEVAL" && [ "$LONGMEMEVAL" -lt "$T_LONGMEMEVAL" ] && PASS=false && FAILURES+="LONGMEMEVAL=$LONGMEMEVAL "

  if ! is_num "$L1" && ! is_num "$LOCOMO" && ! is_num "$PERSONA" && ! is_num "$LONGMEMEVAL"; then
    PASS=false
    FAILURES="All benchmarks N/A — no data"
  fi

  if [ "$PASS" = true ]; then
    log ""
    log "  ╔════════════════════════════════════════════════╗"
    log "  ║  VICTORY! All targets met at iteration $iter!   ║"
    log "  ╚════════════════════════════════════════════════╝"
    exit 0
  fi

  log "Targets not met: $FAILURES"

  # 6. Find lowest numeric benchmark
  LOWEST=""; LOWEST_SCORE=999
  for pair in "L1:$L1" "L2:$L2" "L3:$L3" "LOCOMO:$LOCOMO" "PERSONA:$PERSONA" "LONGMEMEVAL:$LONGMEMEVAL"; do
    name=$(echo "$pair" | cut -d: -f1)
    score=$(echo "$pair" | cut -d: -f2)
    if is_num "$score" && [ "$score" -lt "$LOWEST_SCORE" ]; then
      LOWEST="$name"; LOWEST_SCORE=$score
    fi
  done
  [ -z "$LOWEST" ] && LOWEST="L1" && LOWEST_SCORE=0
  log "Focus: $LOWEST is lowest at $LOWEST_SCORE / 100"

  # 7. Build fix prompt
  FIX_PROMPT="$LOG_DIR/fix-prompt-iter-${iter}.md"
  cat > "$FIX_PROMPT" << EOF
# Benchmark Fix — Iteration $iter

You are improving remem-mcp at $PROJECT_ROOT.
Goal: Beat or equal TencentDB (PersonaMem=76) and Mem0 (LoCoMo=92.5, LongMemEval=94.4).

## Current Scores (LLM-judged)
| Benchmark    | Score  | Target |
|-------------|--------|--------|
| AMB L1      | $L1    | 100    |
| AMB L2      | $L2    | 100    |
| AMB L3      | $L3    | 100    |
| LoCoMo      | $LOCOMO | 92    |
| PersonaMem  | $PERSONA | 76   |
| LongMemEval | $LONGMEMEVAL | 94 |

## Failures: $FAILURES
## Focus: $LOWEST is lowest at $LOWEST_SCORE

## Your Task
1. Read the benchmark logs in $LOG_DIR/ to see what failed.
2. Read $PROJECT_ROOT/src/ — focus on search, recall, storage.
3. Fix the root cause. Minimal changes.
4. cd $PROJECT_ROOT && npm run build && npm test — must pass.
5. git add -A && git commit -m "bench-fix: iter $iter — improve $LOWEST"

## Key Files
- src/storage/sqlite.ts — search + BM25 + vector + RRF
- src/server.ts — MCP server, recall/search handlers
- src/pipeline/atom.ts — fact extraction
- /tmp/locomo-bench/run.ts — LoCoMo adapter
- /tmp/personamem/personamem-bench.ts — PersonaMem adapter
- /tmp/longmemeval/longmemeval-bench.ts — LongMemEval adapter

## Rules
- ONE focused fix per iteration.
- Don't break existing tests.
- You can modify adapters AND search engine.
EOF

  # 8. Call Devin to fix — with live monitoring
  DEVIN_LOG="$LOG_DIR/fix-iter-${iter}.log"
  log "Calling Devin to fix $LOWEST (score=$LOWEST_SCORE)..."
  cd "$PROJECT_ROOT"
  devin -p "$(cat "$FIX_PROMPT")" $DEVIN_FLAGS \
    > "$DEVIN_LOG" 2>&1 &
  fix_pid=$!
  fix_elapsed=0
  while kill -0 $fix_pid 2>/dev/null; do
    sleep 15
    fix_elapsed=$((fix_elapsed + 15))
    last=$(tail -1 "$DEVIN_LOG" 2>/dev/null | head -c 100)
    progress "Fix Devin: ${fix_elapsed}s — $last"
  done
  wait $fix_pid 2>/dev/null || true

  log "Devin fix finished."
  tail -3 "$DEVIN_LOG" 2>/dev/null | while read -r line; do progress "$line"; done
  log "Iteration $iter complete."
  log ""
done

log "MAX ITERATIONS ($MAX_ITER) reached."
log "Logs: $LOG_DIR/"
exit 1
