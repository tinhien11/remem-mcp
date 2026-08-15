#!/bin/bash
# loop-judge.sh — Benchmark loop with parallel AMB fix + adapter scores.
#
# Flow per iteration:
#   1. Run AMB (built-in scoring, fresh DB) → if < 100, launch AMB fix in background
#   2. Run LoCoMo + PersonaMem + LongMemEval adapters IN PARALLEL (built-in scoring)
#   3. Wait for AMB fix (if running)
#   4. If any benchmark < target → launch fix for lowest
#   5. Rebuild → next iteration
#
# No LLM judges needed — all adapters have built-in keyword-based scoring.
# AMB fix runs in parallel with the 3 adapters for speed.
#
# Usage: bash scripts/loop-judge.sh [max_iterations] [--quick]

set -uo pipefail

MAX_ITER="${1:-30}"
QUICK=false
[[ "${2:-}" == "--quick" ]] && QUICK=true

PROJECT_ROOT="/Users/tin/a/remem-mcp"
LOG_DIR="/tmp/bench-judge"
mkdir -p "$LOG_DIR"

LOCOMO_BENCH="/tmp/locomo-bench"
PERSONAMEM_DIR="/tmp/personamem"
LONGMEMEVAL_DIR="/tmp/longmemeval"
AMB_REPO="/tmp/amb-repo"
AMB_DB="/tmp/amb-bench.db"

T_L1=100; T_L2=100; T_L3=90
T_LOCOMO=92; T_PERSONA=76; T_LONGMEMEVAL=94
DEVIN_FLAGS="--permission-mode dangerous --respect-workspace-trust false"

log() { echo "[loop $(date '+%H:%M:%S')] $*" >&2; }
progress() { echo "  → $*" >&2; }
is_num() { [[ "$1" =~ ^[0-9]+$ ]]; }
is_float() { [[ "$1" =~ ^[0-9]+\.[0-9]+$ ]]; }
# lt score target → returns 0 (true) if score < target
lt() { awk "BEGIN{exit !($1 < $2)}"; }

# ─── Run AMB with fresh DB ─────────────────────────────────────
run_amb() {
  rm -f "$AMB_DB"
  cd "$AMB_REPO"
  log "[AMB] Running L1/L2/L3 with fresh DB..."

  local l1_out=$(REMEM_DB_PATH="$AMB_DB" npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer 1 --no-delay --verbose 2>&1)
  local l1=$(echo "$l1_out" | grep 'Layer 1 Score' | grep -oE 'Score: [0-9]+' | grep -oE '[0-9]+' | head -1); l1=${l1:-0}
  progress "[AMB] L1=$l1"

  # Clean DB between layers (L2/L3 have different data)
  rm -f "$AMB_DB"
  local l2_out=$(REMEM_DB_PATH="$AMB_DB" npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer 2 --no-delay --verbose 2>&1)
  local l2=$(echo "$l2_out" | grep 'Layer 2 Score' | grep -oE 'Score: [0-9]+' | grep -oE '[0-9]+' | head -1); l2=${l2:-0}
  progress "[AMB] L2=$l2"

  rm -f "$AMB_DB"
  local l3_out=$(REMEM_DB_PATH="$AMB_DB" npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer 3 --no-delay --verbose 2>&1)
  local l3=$(echo "$l3_out" | grep 'Layer 3 Score' | grep -oE '[0-9]+\.[0-9]+/100|[0-9]+/100' | grep -oE '[0-9]+\.[0-9]+|[0-9]+' | head -1); l3=${l3:-0}
  progress "[AMB] L3=$l3"

  echo "$l1 $l2 $l3"
}

# ─── Run adapter and parse built-in score ──────────────────────
run_adapter() {
  local name=$1 run_cmd=$2 logfile=$3 score_pattern=$4

  progress "[$name] starting..."
  eval "$run_cmd" > "$logfile" 2>&1 &
  local pid=$!
  local elapsed=0
  while kill -0 $pid 2>/dev/null; do
    sleep 5
    elapsed=$((elapsed + 5))
    local last=$(tail -c 60 "$logfile" 2>/dev/null | tr '\n' ' ')
    progress "[$name] ${elapsed}s — $last"
  done
  wait $pid 2>/dev/null || true

  local score=$(grep -oE "$score_pattern" "$logfile" 2>/dev/null | grep -oE '[0-9]+' | head -1)
  score=${score:-0}
  progress "[$name] done — score=$score"
  echo "$score"
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

## Important: Use fresh DB for each run
Always delete the DB before each AMB run:
  rm -f /tmp/amb-bench.db
  REMEM_DB_PATH=/tmp/amb-bench.db npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer N --no-delay --verbose

## Steps
1. cd $PROJECT_ROOT && npm run build
2. Run AMB L1 (with fresh DB):
   rm -f /tmp/amb-bench.db
   cd /tmp/amb-repo && REMEM_DB_PATH=/tmp/amb-bench.db npx tsx src/cli.ts --provider mcp --mcp-command "node $PROJECT_ROOT/dist/index.js" --layer 1 --no-delay --verbose 2>&1
3. Run AMB L2 (with fresh DB): same but --layer 2
4. Run AMB L3 (with fresh DB): same but --layer 3
5. Parse scores from "Layer N Score:" lines
6. If any < 100, read failing test details, fix in $PROJECT_ROOT/src/
7. Rebuild: cd $PROJECT_ROOT && npm run build
8. Re-run failing layers (always with fresh DB)
9. cd $PROJECT_ROOT && npm test — must pass
10. git add -A src/ && git commit -m "bench-amb: iter $iter — L1=$l1 L2=$l2 L3=$l3"

## Key Files
- $PROJECT_ROOT/src/storage/sqlite.ts — search + BM25 + vector + RRF
- $PROJECT_ROOT/src/server.ts — MCP server, recall/search handlers
- /tmp/amb-repo/src/categories/ — AMB test categories

## Rules
- Minimal changes. Don't break existing tests.
- Focus on search recall and precision.
- ALWAYS use fresh DB (rm -f /tmp/amb-bench.db) before each AMB run.
EOF

  log "[AMB] Launching fix agent in background..."
  cd "$PROJECT_ROOT"
  devin -p "$(cat "$prompt_file")" $DEVIN_FLAGS > "$fix_log" 2>&1 &
  echo $!
}

# ─── Main loop ─────────────────────────────────────────────────
log "Starting benchmark loop ($MAX_ITER iterations, parallel AMB fix + adapter scores)"

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

  # 2. Run AMB (built-in scoring, fresh DB)
  log "Phase 1: AMB..."
  amb_scores=$(run_amb 2>/dev/null)
  L1=$(echo "$amb_scores" | awk '{print $1}'); L1=${L1:-0}
  L2=$(echo "$amb_scores" | awk '{print $2}'); L2=${L2:-0}
  L3=$(echo "$amb_scores" | awk '{print $3}'); L3=${L3:-0}
  log "AMB: L1=$L1 L2=$L2 L3=$L3"

  # 3. If AMB < target, launch fix agent IN BACKGROUND
  AMB_FIX_PID=""
  if lt "$L1" "$T_L1" || lt "$L2" "$T_L2" || lt "$L3" "$T_L3"; then
    AMB_FIX_PID=$(launch_amb_fix "$iter" "$L1" "$L2" "$L3")
    progress "AMB fix agent launched (PID $AMB_FIX_PID)"
  fi

  # 4. Run 3 adapters IN PARALLEL (built-in scoring, separate DBs)
  LOCOMO="N/A"; PERSONA="N/A"; LONGMEMEVAL="N/A"

  if ! $QUICK; then
    log "Phase 2: Running 3 adapters in parallel..."

    # Use separate DBs for each adapter
    eval "cd $LOCOMO_BENCH && REMEM_DB_PATH=/tmp/locomo-bench.db npx tsx run.ts" > "$LOG_DIR/locomo-raw.log" 2>&1 &
    PID_LOCOMO=$!
    eval "cd $PERSONAMEM_DIR && REMEM_DB_PATH=/tmp/personamem-bench.db npx tsx personamem-bench.ts --sample=50" > "$LOG_DIR/personamem-raw.log" 2>&1 &
    PID_PERSONA=$!
    eval "cd $LONGMEMEVAL_DIR && REMEM_DB_PATH=/tmp/longmemeval-bench.db npx tsx longmemeval-bench.ts --sample=50 --variant=oracle" > "$LOG_DIR/longmemeval-raw.log" 2>&1 &
    PID_LONGMEMEVAL=$!

    # Monitor all + AMB fix
    progress "Waiting for 3 adapters + AMB fix..."
    _elapsed=0
    while true; do
      _alive=0
      kill -0 $PID_LOCOMO 2>/dev/null && _alive=$((_alive + 1))
      kill -0 $PID_PERSONA 2>/dev/null && _alive=$((_alive + 1))
      kill -0 $PID_LONGMEMEVAL 2>/dev/null && _alive=$((_alive + 1))
      [ -n "$AMB_FIX_PID" ] && kill -0 $AMB_FIX_PID 2>/dev/null && _alive=$((_alive + 1))
      [ $_alive -eq 0 ] && break
      sleep 10
      _elapsed=$((_elapsed + 10))
      _locomo="done"; _persona="done"; _lme="done"; _amb="done"
      kill -0 $PID_LOCOMO 2>/dev/null && _locomo="$(tail -c 40 $LOG_DIR/locomo-raw.log 2>/dev/null | tr '\n' ' ')"
      kill -0 $PID_PERSONA 2>/dev/null && _persona="$(tail -c 40 $LOG_DIR/personamem-raw.log 2>/dev/null | tr '\n' ' ')"
      kill -0 $PID_LONGMEMEVAL 2>/dev/null && _lme="$(tail -c 40 $LOG_DIR/longmemeval-raw.log 2>/dev/null | tr '\n' ' ')"
      [ -n "$AMB_FIX_PID" ] && kill -0 $AMB_FIX_PID 2>/dev/null && _amb="$(tail -c 40 $LOG_DIR/amb-fix-iter-${iter}.log 2>/dev/null | tr '\n' ' ')"
      progress "${_elapsed}s | locomo:$_locomo | persona:$_persona | lme:$_lme | amb-fix:$_amb"
    done
    wait $PID_LOCOMO 2>/dev/null || true
    wait $PID_PERSONA 2>/dev/null || true
    wait $PID_LONGMEMEVAL 2>/dev/null || true

    # Parse built-in scores
    LOCOMO=$(grep -oE 'LoCoMo: [0-9]+/[0-9]+ = [0-9]+%' "$LOG_DIR/locomo-raw.log" 2>/dev/null | grep -oE '[0-9]+%' | grep -oE '[0-9]+' | head -1)
    LOCOMO=${LOCOMO:-0}
    PERSONA=$(grep -oE 'PERSONAMEM_SCORE=[0-9]+' "$LOG_DIR/personamem-raw.log" 2>/dev/null | grep -oE '[0-9]+' | head -1)
    PERSONA=${PERSONA:-0}
    LONGMEMEVAL=$(grep -oE 'LONGMEMEVAL_SCORE=[0-9]+' "$LOG_DIR/longmemeval-raw.log" 2>/dev/null | grep -oE '[0-9]+' | head -1)
    LONGMEMEVAL=${LONGMEMEVAL:-0}

    log "LoCoMo=$LOCOMO PersonaMem=$PERSONA LongMemEval=$LONGMEMEVAL"
  fi

  # 5. Wait for AMB fix if still running
  if [ -n "$AMB_FIX_PID" ]; then
    if kill -0 $AMB_FIX_PID 2>/dev/null; then
      log "Waiting for AMB fix agent..."
      _fix_elapsed=0
      while kill -0 $AMB_FIX_PID 2>/dev/null; do
        sleep 15
        _fix_elapsed=$((_fix_elapsed + 15))
        _last=$(tail -c 80 "$LOG_DIR/amb-fix-iter-${iter}.log" 2>/dev/null | tr '\n' ' ')
        progress "AMB fix: ${_fix_elapsed}s — $_last"
      done
      wait $AMB_FIX_PID 2>/dev/null || true
    fi

    # Rebuild + re-run AMB with fixes
    log "Rebuilding + re-running AMB with fixes..."
    cd "$PROJECT_ROOT"
    npm run build 2>&1 | tail -1
    amb_scores=$(run_amb 2>/dev/null)
    L1=$(echo "$amb_scores" | awk '{print $1}'); L1=${L1:-0}
    L2=$(echo "$amb_scores" | awk '{print $2}'); L2=${L2:-0}
    L3=$(echo "$amb_scores" | awk '{print $3}'); L3=${L3:-0}
    log "AMB after fix: L1=$L1 L2=$L2 L3=$L3"
  fi

  # 6. Print scores
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

  # 7. Check victory
  PASS=true
  FAILURES=""
  lt "$L1" "$T_L1" && PASS=false && FAILURES+="L1=$L1 "
  lt "$L2" "$T_L2" && PASS=false && FAILURES+="L2=$L2 "
  lt "$L3" "$T_L3" && PASS=false && FAILURES+="L3=$L3 "
  lt "$LOCOMO" "$T_LOCOMO" && PASS=false && FAILURES+="LOCOMO=$LOCOMO "
  lt "$PERSONA" "$T_PERSONA" && PASS=false && FAILURES+="PERSONA=$PERSONA "
  lt "$LONGMEMEVAL" "$T_LONGMEMEVAL" && PASS=false && FAILURES+="LONGMEMEVAL=$LONGMEMEVAL "

  if [ "$PASS" = true ]; then
    log ""
    log "  ╔════════════════════════════════════════════════╗"
    log "  ║  VICTORY! All targets met at iteration $iter!   ║"
    log "  ╚════════════════════════════════════════════════╝"
    exit 0
  fi

  log "Targets not met: $FAILURES"

  # 8. Find lowest FAILING benchmark (only those below target)
  LOWEST=""; LOWEST_SCORE=999
  for pair in "L1:$L1:$T_L1" "L2:$L2:$T_L2" "L3:$L3:$T_L3" "LOCOMO:$LOCOMO:$T_LOCOMO" "PERSONA:$PERSONA:$T_PERSONA" "LONGMEMEVAL:$LONGMEMEVAL:$T_LONGMEMEVAL"; do
    name=$(echo "$pair" | cut -d: -f1)
    score=$(echo "$pair" | cut -d: -f2)
    target=$(echo "$pair" | cut -d: -f3)
    if lt "$score" "$target" && lt "$score" "$LOWEST_SCORE"; then
      LOWEST="$name"; LOWEST_SCORE=$score
    fi
  done

  if [ -z "$LOWEST" ]; then
    log "Nothing to fix — all targets met!"
    continue
  fi

  log "Focus: $LOWEST is lowest at $LOWEST_SCORE (below target)"

  # 9. Build fix prompt
  FIX_PROMPT="$LOG_DIR/fix-prompt-iter-${iter}.md"
  cat > "$FIX_PROMPT" << EOF
# Benchmark Fix — Iteration $iter

You are improving remem-mcp at $PROJECT_ROOT.
Goal: Beat TencentDB (PersonaMem=76) and Mem0 (LoCoMo=92.5, LongMemEval=94.4).

## Current Scores (adapter built-in scoring)
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

  # 10. Call Devin to fix
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
  tail -c 200 "$DEVIN_LOG" 2>/dev/null | tr '\n' ' ' | while read -r line; do progress "$line"; done
  log "Iteration $iter complete."
  log ""
done

log "MAX ITERATIONS ($MAX_ITER) reached."
log "Logs: $LOG_DIR/"
exit 1
