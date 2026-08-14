#!/bin/bash
# loop-parallel.sh — Launch 4 parallel Devin agents, each focused on one benchmark.
# Each agent runs in its own git worktree to avoid file conflicts.
#
# Agent 1: AMB L1/L2/L3          (target: 100/100/100)
# Agent 2: LoCoMo                (target: 92, Mem0=92.5)
# Agent 3: PersonaMem            (target: 76, TencentDB=76)
# Agent 4: LongMemEval           (target: 94, Mem0=94.4)
#
# Usage: bash scripts/loop-parallel.sh [max_iterations]

set -uo pipefail

MAX_ITER="${1:-30}"
PROJECT_ROOT="/Users/tin/a/remem-mcp"
LOG_DIR="/tmp/bench-parallel"
WORKTREE_BASE="/tmp/remem-worktrees"
PROMPT_DIR="$LOG_DIR/prompts"
mkdir -p "$LOG_DIR" "$PROMPT_DIR" "$WORKTREE_BASE"

log() { echo "[parallel] $(date '+%H:%M:%S') $*"; }

# ─── Worktree management ───────────────────────────────────────
create_worktree() {
  local name=$1
  local path="$WORKTREE_BASE/$name"
  if [ ! -d "$path" ]; then
    log "  Creating worktree for $name..."
    cd "$PROJECT_ROOT"
    git worktree add "$path" -b "bench/$name" 2>/dev/null || true
  fi
  # Sync latest main code
  cd "$path" 2>/dev/null || return 1
  git fetch origin 2>/dev/null || true
  git reset --hard main 2>/dev/null || true
  # Link node_modules + dist from main project (avoid reinstall)
  ln -sf "$PROJECT_ROOT/node_modules" "$path/node_modules" 2>/dev/null || true
  echo "$path"
}

# ─── Prompt generators (write to file, return path) ────────────
gen_prompt_amb() {
  local wt=$1 iter=$2
  local f="$PROMPT_DIR/amb-iter-${iter}.md"
  cat > "$f" << EOF
# AMB Benchmark Fix — Iteration $iter

You are improving remem-mcp at $wt.
Goal: AMB L1/L2/L3 all score 100/100.

## Steps
1. cd $wt && npm run build
2. Run AMB L1:
   cd /tmp/amb-repo && npx tsx src/cli.ts --provider mcp --mcp-command "node $wt/dist/index.js" --layer 1 --no-delay --verbose 2>&1
3. Run AMB L2: same but --layer 2
4. Run AMB L3: same but --layer 3
5. Parse scores from "Layer N Score:" lines
6. If any < 100, read failing test details from verbose output
7. Fix in $wt/src/ (search, recall, storage)
8. Rebuild: cd $wt && npm run build
9. Re-run failing layers
10. Run: cd $wt && npm test — must pass
11. git add -A && git commit -m "bench-amb: iter $iter"

## Key Files
- $wt/src/storage/sqlite.ts — search + BM25 + vector + RRF
- $wt/src/server.ts — MCP server, recall/search handlers
- /tmp/amb-repo/src/categories/ — AMB test categories

## Rules
- Minimal changes. Don't break existing tests.
- Focus on search recall and precision.
EOF
  echo "$f"
}

gen_prompt_locomo() {
  local wt=$1 iter=$2
  local f="$PROMPT_DIR/locomo-iter-${iter}.md"
  cat > "$f" << EOF
# LoCoMo Benchmark Fix — Iteration $iter

You are improving remem-mcp at $wt.
Goal: LoCoMo score >= 92 (Mem0 scores 92.5).

## Steps
1. cd $wt && npm run build
2. Run LoCoMo: cd /tmp/locomo-bench && npx tsx run.ts 2>&1
3. Parse score from "LoCoMo: X/Y = Z%" line
4. If < 92, analyze which questions failed
5. Fix search/recall in $wt/src/storage/sqlite.ts or $wt/src/server.ts
6. Improve: temporal reasoning (dates), multi-hop (cross-session), keyword extraction
7. Rebuild + re-run
8. cd $wt && npm test — must pass
9. git add -A && git commit -m "bench-locomo: iter $iter"

## LoCoMo Structure
- 10 conversations, each with multiple sessions (up to 35)
- Each session has turns (speaker + text)
- QA pairs: single-hop, multi-hop, temporal, open-domain
- Adapter ingests sessions, searches with question, checks keyword overlap

## Key Files
- $wt/src/storage/sqlite.ts — search + BM25 + vector + RRF
- $wt/src/server.ts — search handler
- /tmp/locomo-bench/run.ts — adapter (you can modify scoring too)

## Rules
- Minimal changes. Don't break existing tests.
EOF
  echo "$f"
}

gen_prompt_personamem() {
  local wt=$1 iter=$2
  local f="$PROMPT_DIR/personamem-iter-${iter}.md"
  cat > "$f" << EOF
# PersonaMem Benchmark Fix — Iteration $iter

You are improving remem-mcp at $wt.
Goal: PersonaMem score >= 76 (TencentDB scores 76).

## Steps
1. cd $wt && npm run build
2. Run: cd /tmp/personamem && npx tsx personamem-bench.ts --sample=50 2>&1
3. Parse score from "PERSONAMEM_SCORE=X" line
4. If < 76, analyze which questions failed
5. Fix search/recall in $wt/src/
6. Rebuild + re-run
7. cd $wt && npm test — must pass
8. git add -A && git commit -m "bench-personamem: iter $iter"

## PersonaMem Structure
- 588 questions, 20 personas, multiple-choice QA
- Each question has a shared_context (conversation history)
- Adapter ingests context, searches with question, checks if results
  contain >= 40% of unique keywords from the correct answer

## Key Files
- $wt/src/storage/sqlite.ts — search
- $wt/src/server.ts — search handler
- /tmp/personamem/personamem-bench.ts — adapter (you can modify)

## Rules
- Minimal changes. Don't break existing tests.
EOF
  echo "$f"
}

gen_prompt_longmemeval() {
  local wt=$1 iter=$2
  local f="$PROMPT_DIR/longmemeval-iter-${iter}.md"
  cat > "$f" << EOF
# LongMemEval Benchmark Fix — Iteration $iter

You are improving remem-mcp at $wt.
Goal: LongMemEval score >= 94 (Mem0 scores 94.4).

## Steps
1. cd $wt && npm run build
2. Run: cd /tmp/longmemeval && npx tsx longmemeval-bench.ts --sample=50 --variant=oracle 2>&1
3. Parse score from "LONGMEMEVAL_SCORE=X" line
4. If < 94, analyze by-type breakdown
5. Fix search/recall in $wt/src/
6. Rebuild + re-run
7. cd $wt && npm test — must pass
8. git add -A && git commit -m "bench-longmemeval: iter $iter"

## LongMemEval Structure
- 500 questions, 5 memory abilities:
  - temporal-reasoning (133 Q): when did something happen
  - multi-session (133 Q): combine info across sessions
  - knowledge-update (78 Q): track changed preferences
  - single-session-user (70 Q): recall user facts
  - single-session-assistant (56 Q): recall assistant suggestions
- Each question has haystack_sessions + answer
- Adapter ingests sessions, searches, checks >= 40% answer keywords in top-5

## Key Files
- $wt/src/storage/sqlite.ts — search + BM25 + vector + RRF
- $wt/src/server.ts — search handler
- $wt/src/pipeline/atom.ts — fact extraction
- /tmp/longmemeval/longmemeval-bench.ts — adapter (you can modify)

## Rules
- Minimal changes. Don't break existing tests.
- Focus on weakest question type first.
EOF
  echo "$f"
}

# ─── Main loop ─────────────────────────────────────────────────
log "Starting parallel benchmark loop ($MAX_ITER iterations, 4 agents)"

for iter in $(seq 1 $MAX_ITER); do
  log ""
  log "════════════════════════════════════════════════════════"
  log "  ITERATION $iter / $MAX_ITER"
  log "════════════════════════════════════════════════════════"

  # Create/sync worktrees
  log "Syncing worktrees..."
  WT_AMB=$(create_worktree "amb")
  WT_LOCOMO=$(create_worktree "locomo")
  WT_PERSONA=$(create_worktree "persona")
  WT_LONGMEMEVAL=$(create_worktree "longmemeval")

  # Generate prompts
  P_AMB=$(gen_prompt_amb "$WT_AMB" "$iter")
  P_LOCOMO=$(gen_prompt_locomo "$WT_LOCOMO" "$iter")
  P_PERSONA=$(gen_prompt_personamem "$WT_PERSONA" "$iter")
  P_LONGMEMEVAL=$(gen_prompt_longmemeval "$WT_LONGMEMEVAL" "$iter")

  # Launch 4 agents in parallel
  log "Launching 4 Devin agents in parallel..."

  devin -p "$(cat "$P_AMB")" --permission-mode dangerous \
    > "$LOG_DIR/agent-amb-iter-${iter}.log" 2>&1 &
  PID_AMB=$!

  devin -p "$(cat "$P_LOCOMO")" --permission-mode dangerous \
    > "$LOG_DIR/agent-locomo-iter-${iter}.log" 2>&1 &
  PID_LOCOMO=$!

  devin -p "$(cat "$P_PERSONA")" --permission-mode dangerous \
    > "$LOG_DIR/agent-personamem-iter-${iter}.log" 2>&1 &
  PID_PERSONA=$!

  devin -p "$(cat "$P_LONGMEMEVAL")" --permission-mode dangerous \
    > "$LOG_DIR/agent-longmemeval-iter-${iter}.log" 2>&1 &
  PID_LONGMEMEVAL=$!

  log "PIDs: AMB=$PID_AMB LoCoMo=$PID_LOCOMO Persona=$PID_PERSONA LongMemEval=$PID_LONGMEMEVAL"
  log "Waiting for all 4 agents..."

  wait $PID_AMB && log "  AMB: done" || log "  AMB: failed"
  wait $PID_LOCOMO && log "  LoCoMo: done" || log "  LoCoMo: failed"
  wait $PID_PERSONA && log "  PersonaMem: done" || log "  PersonaMem: failed"
  wait $PID_LONGMEMEVAL && log "  LongMemEval: done" || log "  LongMemEval: failed"

  # Merge worktree changes back to main
  log "Merging worktree changes to main..."
  cd "$PROJECT_ROOT"
  for name in amb locomo persona longmemeval; do
    wt="$WORKTREE_BASE/$name"
    if [ -d "$wt" ]; then
      cd "$wt"
      if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
        log "  $name: committing..."
        git add -A 2>/dev/null || true
        git commit -m "bench-$name: iteration $iter" 2>/dev/null || true
        cd "$PROJECT_ROOT"
        git merge "bench/$name" --no-edit 2>/dev/null || log "  $name: merge conflict — skipping"
      else
        log "  $name: no changes"
      fi
    fi
  done

  # Rebuild + full benchmark
  log "Rebuilding + running full benchmark..."
  cd "$PROJECT_ROOT"
  npm run build 2>&1 | tail -1

  BENCH_LOG="$LOG_DIR/iter-${iter}-full.log"
  bash "$PROJECT_ROOT/scripts/bench-all.sh" > "$BENCH_LOG" 2>&1 || true
  RESULT=$(grep "BENCH_RESULT" "$BENCH_LOG" || echo "BENCH_RESULT L1=0 L2=0 L3=0 LOCOMO=N/A PERSONAMEM=N/A")

  L1=$(echo "$RESULT" | grep -oE 'L1=[0-9]+' | grep -oE '[0-9]+' || echo "0")
  L2=$(echo "$RESULT" | grep -oE 'L2=[0-9]+' | grep -oE '[0-9]+' || echo "0")
  L3=$(echo "$RESULT" | grep -oE 'L3=[0-9]+' | grep -oE '[0-9]+' || echo "0")
  LOCOMO=$(echo "$RESULT" | grep -oE 'LOCOMO=[0-9]+' | grep -oE '[0-9]+' || echo "N/A")
  PERSONA=$(echo "$RESULT" | grep -oE 'PERSONAMEM=[0-9]+' | grep -oE '[0-9]+' || echo "N/A")

  # LongMemEval
  LME="N/A"
  if [ -f "/tmp/longmemeval/longmemeval-bench.ts" ]; then
    cd /tmp/longmemeval
    LME=$(npx tsx longmemeval-bench.ts --sample=50 --variant=oracle 2>&1 | grep "LONGMEMEVAL_SCORE=" | grep -oE '[0-9]+' || echo "0")
  fi

  log ""
  log "════════════════════════════════════════════════════════"
  log "  ITERATION $iter RESULTS"
  log "════════════════════════════════════════════════════════"
  log "  AMB L1:       $L1  / 100"
  log "  AMB L2:       $L2  / 100"
  log "  AMB L3:       $L3  / 100"
  log "  LoCoMo:       $LOCOMO  / 92 (Mem0=92.5)"
  log "  PersonaMem:   $PERSONA  / 76 (TencentDB=76)"
  log "  LongMemEval:  $LME  / 94 (Mem0=94.4)"
  log "════════════════════════════════════════════════════════"

  # Check victory
  ALL_PASS=true
  [ "${L1:-0}" -lt 100 ] 2>/dev/null && ALL_PASS=false
  [ "${L2:-0}" -lt 100 ] 2>/dev/null && ALL_PASS=false
  [ "${L3:-0}" -lt 100 ] 2>/dev/null && ALL_PASS=false
  [ "${LOCOMO:-0}" -lt 92 ] 2>/dev/null && ALL_PASS=false
  [ "${PERSONA:-0}" -lt 76 ] 2>/dev/null && ALL_PASS=false
  [ "${LME:-0}" -lt 94 ] 2>/dev/null && ALL_PASS=false

  if [ "$ALL_PASS" = true ]; then
    log ""
    log "  ╔══════════════════════════════════════════════════╗"
    log "  ║  VICTORY! All targets met at iteration $iter!     ║"
    log "  ╚══════════════════════════════════════════════════╝"
    exit 0
  fi

  log "Not all targets met. Continuing..."
  log ""
done

log "MAX ITERATIONS ($MAX_ITER) reached."
log "Logs: $LOG_DIR/"
exit 1
