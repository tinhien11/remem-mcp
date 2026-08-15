#!/usr/bin/env bash
# long-run-agents.sh — long-running agent loop that uses remem-mcp on real projects
# Each agent picks a real project, does real work, and exercises remem-mcp tools
# (recall, capture, search, session_start, session_end, checkpoint, health, KPIs).
#
# Usage: bash scripts/long-run-agents.sh [duration_minutes] [num_agents]
# Default: 30 minutes, 3 agents

cd "$(dirname "$0")/.."

DURATION_MIN="${1:-30}"
NUM_AGENTS="${2:-3}"
DURATION_SEC=$((DURATION_MIN * 60))
START_TIME=$(date +%s)

# Real projects to work on (excluding remem-mcp itself)
PROJECTS=(
  "/Users/tin/a/free-way"
  "/Users/tin/a/skill-radar"
  "/Users/tin/a/freqtrade-strategies"
  "/Users/tin/a/fb-marketplace-land"
  "/Users/tin/a/kompakt"
  "/Users/tin/a/getlink"
  "/Users/tin/a/news"
  "/Users/tin/a/orca"
)

# Tasks that exercise remem-mcp memory tools
TASKS=(
  "audit-codebase"
  "fix-bugs"
  "add-tests"
  "improve-docs"
  "refactor"
  "explore-architecture"
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log() { echo -e "${CYAN}[long-run]${NC} $(date '+%H:%M:%S') $1"; }
ok()  { echo -e "${GREEN}  ✓${NC} $1"; }
fail(){ echo -e "${RED}  ✗${NC} $1"; }

echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo "  🐕 LONG-RUN AGENT LOOP — ${DURATION_MIN}min, ${NUM_AGENTS} agents"
echo "  Projects: ${#PROJECTS[@]} available"
echo "  Start: $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════════════════════════════"
echo ""

# Track metrics
CAPTURES_BEFORE=$(node --input-type=module -e "
  import { Memory } from './dist/sdk.js';
  import path from 'path';
        import os from 'os';
  const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
  const db = m.storage.getDatabase();
  const n = db.prepare('SELECT COUNT(*) as n FROM captures WHERE deleted_at IS NULL').get().n;
  console.log(n);
  m.close();
" 2>/dev/null || echo "0")

log "Captures before: $CAPTURES_BEFORE"

ROUND=0
while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START_TIME))
  if [ "$ELAPSED" -ge "$DURATION_SEC" ]; then
    break
  fi
  REMAINING=$(( (DURATION_SEC - ELAPSED) / 60 ))
  ROUND=$((ROUND + 1))

  echo ""
  echo "┌──────────────────────────────────────────────────────────────────┐"
  echo "│ ROUND $ROUND — ${REMAINING}min remaining — $(date '+%H:%M:%S')"
  echo "└──────────────────────────────────────────────────────────────────┘"

  # Pick projects for this round (cycle through)
  PIDS=()
  for i in $(seq 1 "$NUM_AGENTS"); do
    IDX=$(( (ROUND * NUM_AGENTS + i - 1) % ${#PROJECTS[@]} ))
    PROJECT="${PROJECTS[$IDX]}"
    TASK="${TASKS[$(( (ROUND + i) % ${#TASKS[@]} ))]}"

    # Each agent runs in background, does real work + exercises remem-mcp
    (
      PROJECT_NAME=$(basename "$PROJECT")
      LOGFILE="/tmp/long-run-agent-${ROUND}-${i}.log"
      echo "[Agent $i] Project: $PROJECT_NAME, Task: $TASK" > "$LOGFILE"

      # 1. session_start — get recent context
      echo "[Agent $i] session_start..." >> "$LOGFILE"
      node --input-type=module -e "
        import { Memory } from '$PWD/dist/sdk.js';
        import path from 'path';
        import os from 'os';
        import crypto from 'crypto';
        const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
        const db = m.storage.getDatabase();
        const sk = crypto.createHash('sha1').update('$PROJECT').digest('hex').slice(0, 16);
        const recent = db.prepare('SELECT id, type, content FROM captures WHERE deleted_at IS NULL AND session_key = ? ORDER BY created_at DESC LIMIT 3').all(sk);
        console.log('  Recent captures for $PROJECT_NAME:', recent.length);
        m.close();
      " >> "$LOGFILE" 2>&1 || true

      # 2. recall — search for project context
      echo "[Agent $i] recall('$PROJECT_NAME')..." >> "$LOGFILE"
      node --input-type=module -e "
        import { Memory } from '$PWD/dist/sdk.js';
        import path from 'path';
        import os from 'os';
        const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
        const results = await m.recall('$PROJECT_NAME architecture decisions');
        console.log('  Recall results:', results.length);
        if (results.length > 0) console.log('  Top:', results[0].entry.content.slice(0, 80));
        m.close();
      " >> "$LOGFILE" 2>&1 || true

      # 3. Real work — explore the project
      echo "[Agent $i] Exploring $PROJECT_NAME..." >> "$LOGFILE"
      if [ -d "$PROJECT" ]; then
        # Count files
        FILE_COUNT=$(find "$PROJECT" -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.rs' -o -name '*.go' 2>/dev/null | wc -l | tr -d ' ')
        echo "  Files: $FILE_COUNT" >> "$LOGFILE"

        # Find TODOs
        TODO_COUNT=$(grep -r "TODO\|FIXME\|HACK" "$PROJECT/src" "$PROJECT/lib" "$PROJECT/app" 2>/dev/null | wc -l | tr -d ' ' || echo "0")
        echo "  TODOs/FIXMEs: $TODO_COUNT" >> "$LOGFILE"

        # Find tests
        TEST_COUNT=$(find "$PROJECT" -name '*.test.*' -o -name '*_test.*' -o -name 'test_*' 2>/dev/null | wc -l | tr -d ' ')
        echo "  Test files: $TEST_COUNT" >> "$LOGFILE"

        # Check for common issues
        if [ -f "$PROJECT/package.json" ]; then
          echo "  Has package.json" >> "$LOGFILE"
          DEPS=$(node -e "try{const p=require('$PROJECT/package.json');console.log(Object.keys(p.dependencies||{}).length)}catch{console.log(0)}" 2>/dev/null || echo "0")
          echo "  Dependencies: $DEPS" >> "$LOGFILE"
        fi

        # 4. capture — record findings
        echo "[Agent $i] capture findings..." >> "$LOGFILE"
        node --input-type=module -e "
          import { Memory } from '$PWD/dist/sdk.js';
          import path from 'path';
        import os from 'os';
          const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
          const content = 'Audit of $PROJECT_NAME: $FILE_COUNT source files, $TODO_COUNT TODOs/FIXMEs, $TEST_COUNT test files, $DEPS dependencies. Task: $TASK.';
          const id = await m.capture(content, 'task', ['long-run', 'audit', '$PROJECT_NAME', '$TASK']);
          console.log('  Captured:', id);
          m.close();
        " >> "$LOGFILE" 2>&1 || true

        # 5. search — look for similar past audits
        echo "[Agent $i] search for past audits..." >> "$LOGFILE"
        node --input-type=module -e "
          import { Memory } from '$PWD/dist/sdk.js';
          import path from 'path';
        import os from 'os';
          const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
          const results = await m.search('$PROJECT_NAME audit', { limit: 3 });
          console.log('  Search results:', results.length);
          results.forEach(r => console.log('  -', r.entry.type, r.entry.content.slice(0, 60)));
          m.close();
        " >> "$LOGFILE" 2>&1 || true

        # 6. Real work based on task type
        case "$TASK" in
          audit-codebase)
            echo "[Agent $i] Running audit..." >> "$LOGFILE"
            # Check for security issues
            SECRETS=$(grep -r "password\|secret\|api_key\|token" "$PROJECT/src" 2>/dev/null | grep -v "node_modules\|\.test\.\|process\.env\|config\|README\|\.md" | wc -l | tr -d ' ' || echo "0")
            echo "  Potential secrets: $SECRETS" >> "$LOGFILE"
            # Check for error handling
            TRY_CATCH=$(grep -r "try\|catch\|throw" "$PROJECT/src" 2>/dev/null | wc -l | tr -d ' ' || echo "0")
            echo "  Error handling lines: $TRY_CATCH" >> "$LOGFILE"
            ;;
          fix-bugs)
            echo "[Agent $i] Looking for bugs..." >> "$LOGFILE"
            # Find console.log left in production code
            CONSOLE_LOG=$(grep -r "console\.log" "$PROJECT/src" 2>/dev/null | grep -v "node_modules\|test" | wc -l | tr -d ' ' || echo "0")
            echo "  console.log calls: $CONSOLE_LOG" >> "$LOGFILE"
            ;;
          add-tests)
            echo "[Agent $i] Analyzing test coverage..." >> "$LOGFILE"
            if [ "$TEST_COUNT" -lt 5 ]; then
              echo "  LOW test count — needs more tests" >> "$LOGFILE"
              node --input-type=module -e "
                import { Memory } from '$PWD/dist/sdk.js';
                import path from 'path';
        import os from 'os';
                const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
                await m.capture('$PROJECT_NAME has only $TEST_COUNT test files — below threshold. Recommend adding integration tests.', 'error', ['long-run', 'test-gap', '$PROJECT_NAME']);
                m.close();
              " >> "$LOGFILE" 2>&1 || true
            fi
            ;;
          improve-docs)
            echo "[Agent $i] Checking docs..." >> "$LOGFILE"
            HAS_README=$([ -f "$PROJECT/README.md" ] && echo "yes" || echo "no")
            echo "  README: $HAS_README" >> "$LOGFILE"
            ;;
          refactor)
            echo "[Agent $i] Looking for refactor opportunities..." >> "$LOGFILE"
            LARGE_FILES=$(find "$PROJECT/src" -name '*.ts' -o -name '*.js' 2>/dev/null | xargs wc -l 2>/dev/null | sort -rn | head -3 || echo "none")
            echo "  Largest files:" >> "$LOGFILE"
            echo "$LARGE_FILES" >> "$LOGFILE"
            ;;
          explore-architecture)
            echo "[Agent $i] Mapping architecture..." >> "$LOGFILE"
            DIRS=$(find "$PROJECT/src" -type d 2>/dev/null | head -10 || echo "no src dir")
            echo "  Directories:" >> "$LOGFILE"
            echo "$DIRS" >> "$LOGFILE"
            ;;
        esac

        # 7. checkpoint
        echo "[Agent $i] checkpoint..." >> "$LOGFILE"
        node --input-type=module -e "
          import { Memory } from '$PWD/dist/sdk.js';
          import path from 'path';
        import os from 'os';
          const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
          const id = await m.capture('Checkpoint: $TASK on $PROJECT_NAME round $ROUND', 'task', ['checkpoint', 'long-run', '$PROJECT_NAME']);
          console.log('  Checkpoint:', id);
          m.close();
        " >> "$LOGFILE" 2>&1 || true

        # 8. correction KPIs
        echo "[Agent $i] correction_kpis..." >> "$LOGFILE"
        node --input-type=module -e "
          import { Memory } from '$PWD/dist/sdk.js';
          import path from 'path';
        import os from 'os';
          const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
          const k = m.storage.getCorrectionKPIs();
          console.log('  KPIs:', k.totalCorrections, 'corrections, precision=', k.avgPrecision, 'heedRate=', k.heedRate);
          m.close();
        " >> "$LOGFILE" 2>&1 || true
      else
        echo "  Project not found: $PROJECT" >> "$LOGFILE"
      fi

      echo "[Agent $i] DONE" >> "$LOGFILE"
    ) &

    PIDS+=($!)
    log "Agent $i → $PROJECT_NAME ($TASK) [PID $!]"
  done

  # Wait for all agents in this round
  log "Waiting for ${NUM_AGENTS} agents..."
  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  # Show results
  echo ""
  log "Round $ROUND results:"
  for i in $(seq 1 "$NUM_AGENTS"); do
    LOGFILE="/tmp/long-run-agent-${ROUND}-${i}.log"
    if [ -f "$LOGFILE" ]; then
      PROJECT_NAME=$(head -1 "$LOGFILE" | grep -oE 'Project: [a-zA-Z0-9-]+' | cut -d' ' -f2)
      TASK=$(head -1 "$LOGFILE" | grep -oE 'Task: [a-z-]+' | cut -d' ' -f2)
      CAPTURED=$(grep "Captured:" "$LOGFILE" | wc -l | tr -d ' ')
      RECALL=$(grep "Recall results:" "$LOGFILE" | grep -oE "[0-9]+" || echo "0")
      SEARCH=$(grep "Search results:" "$LOGFILE" | grep -oE "[0-9]+" || echo "0")
      CHECKPOINT=$(grep "Checkpoint:" "$LOGFILE" | wc -l | tr -d ' ')
      KPI=$(grep "KPIs:" "$LOGFILE" | head -1 || echo "N/A")

      echo "  Agent $i: $PROJECT_NAME ($TASK)"
      echo "    captures: $CAPTURED, recall: $RECALL results, search: $SEARCH results, checkpoints: $CHECKPOINT"
      echo "    $KPI"
    fi
  done

  # Quick health check
  echo ""
  log "Health check:"
  node --input-type=module -e "
    import { Memory } from '$PWD/dist/sdk.js';
    import path from 'path';
        import os from 'os';
    const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
    const db = m.storage.getDatabase();
    const n = db.prepare('SELECT COUNT(*) as n FROM captures WHERE deleted_at IS NULL').get().n;
    const sessions = db.prepare('SELECT COUNT(DISTINCT session_key) as n FROM captures WHERE deleted_at IS NULL').get().n;
    const k = m.storage.getCorrectionKPIs();
    console.log('  Total captures:', n, '| Sessions:', sessions, '| Corrections:', k.totalCorrections, '| Precision:', k.avgPrecision.toFixed(2));
    m.close();
  " 2>/dev/null || echo "  health check failed"

  # Small delay between rounds
  sleep 2
done

# Final summary
echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo "  LONG-RUN COMPLETE — $ROUND rounds in ${DURATION_MIN}min"
echo "══════════════════════════════════════════════════════════════════════"
echo ""

CAPTURES_AFTER=$(node --input-type=module -e "
  import { Memory } from '$PWD/dist/sdk.js';
  import path from 'path';
        import os from 'os';
  const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
  const db = m.storage.getDatabase();
  const n = db.prepare('SELECT COUNT(*) as n FROM captures WHERE deleted_at IS NULL').get().n;
  console.log(n);
  m.close();
" 2>/dev/null || echo "0")

NEW_CAPTURES=$((CAPTURES_AFTER - CAPTURES_BEFORE))

echo "  Captures before: $CAPTURES_BEFORE"
echo "  Captures after:  $CAPTURES_AFTER"
echo "  New captures:    $NEW_CAPTURES"
echo "  Rounds:          $ROUND"
echo "  Agents per round: $NUM_AGENTS"
echo "  Total agent runs: $((ROUND * NUM_AGENTS))"
echo ""

# Show what was captured
echo "  Recent captures from this run:"
node --input-type=module -e "
  import { Memory } from '$PWD/dist/sdk.js';
  import path from 'path';
        import os from 'os';
  const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
  const results = await m.search('long-run audit', { limit: 10 });
  results.forEach((r, i) => {
    console.log('  ' + (i+1) + '. [' + r.entry.type + '] ' + r.entry.content.slice(0, 80));
  });
  m.close();
" 2>/dev/null || echo "  (failed to query)"

echo ""
echo "Done."
