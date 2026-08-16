#!/usr/bin/env bash
# dogfood-auto-global.sh — exercise auto_global classification end-to-end
# Usage: bash scripts/dogfood-auto-global.sh [max_iterations]

cd "$(dirname "$0")/.."

MAX_ITER="${1:-3}"
ITER=0
TOTAL_PASS=0
TOTAL_FAIL=0

while [ "$ITER" -lt "$MAX_ITER" ]; do
  ITER=$((ITER + 1))
  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo "  🌐 DOGFOOD AUTO-GLOBAL — iteration $ITER/$MAX_ITER"
  echo "══════════════════════════════════════════════════════════════"

  # 1. Build
  printf "  [1/4] Build...          "
  if npm run build 2>&1 | tail -1 | grep -q "success"; then
    echo "✓"
  else
    echo "✗ FAIL — aborting"
    exit 1
  fi

  # 2. Run classifier test
  printf "  [2/4] Auto-classify...   "
  RESULT=$(REMEM_GLOBAL_SESSION_KEY=global node scripts/dogfood-auto-global.js 2>/dev/null || echo '{"pass":0,"fail":15,"fails":["JS error"],"recallHasGlobal":false,"searchHasProject":false}')

  PASS=$(echo "$RESULT" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).pass" 2>/dev/null || echo "0")
  FAIL=$(echo "$RESULT" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).fail" 2>/dev/null || echo "15")
  RECALL_GLOBAL=$(echo "$RESULT" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).recallHasGlobal" 2>/dev/null || echo "false")
  SEARCH_PROJECT=$(echo "$RESULT" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).searchHasProject" 2>/dev/null || echo "false")

  echo "$PASS/15 classified correctly"
  TOTAL_PASS=$((TOTAL_PASS + PASS))
  TOTAL_FAIL=$((TOTAL_FAIL + FAIL))

  # Show failures
  if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "  Misclassified:"
    echo "$RESULT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); d.fails.forEach(f=>console.log(f))" 2>/dev/null
  fi

  # 3. Recall check
  printf "  [3/4] Recall global...   "
  if [ "$RECALL_GLOBAL" = "true" ]; then
    echo "✓ global results in recall"
  else
    echo "✗ no global results in recall"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi

  # 4. Search check
  printf "  [4/4] Search project...  "
  if [ "$SEARCH_PROJECT" = "true" ]; then
    echo "✓ project results in search"
  else
    echo "✗ no project results in search"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi

  echo ""
  echo "  ─────────────────────────────────────"
  echo "  Iteration $ITER: $PASS/15 correct, recall=$RECALL_GLOBAL, search=$SEARCH_PROJECT"
  echo "  ─────────────────────────────────────"
done

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  SUMMARY: $TOTAL_PASS passed, $TOTAL_FAIL failed ($MAX_ITER iterations)"
echo "══════════════════════════════════════════════════════════════"

if [ "$TOTAL_FAIL" -eq 0 ]; then
  echo "  ★★★ ALL CORRECT — auto_global works ★★★"
  exit 0
else
  echo "  ⚠ $TOTAL_FAIL failures — classifier needs tuning"
  exit 1
fi
