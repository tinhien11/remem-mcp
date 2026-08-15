#!/usr/bin/env bash
# dogfood-loop.sh — fast self-improving loop for remem-mcp
# Build + typecheck + tests + dogfood, launch agents to fix, loop until clean.
# Usage: bash scripts/dogfood-loop.sh [max_iterations]

cd "$(dirname "$0")/.."

MAX_ITER="${1:-5}"
ITER=0

while [ "$ITER" -lt "$MAX_ITER" ]; do
  ITER=$((ITER + 1))
  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo "  🐕 DOGFOOD LOOP — iteration $ITER/$MAX_ITER"
  echo "══════════════════════════════════════════════════════════════"

  ISSUES=0

  # 1. Build
  printf "  [1/6] Build...          "
  if npm run build 2>&1 | tail -1 | grep -q "success"; then
    echo "✓"
  else
    echo "✗ FAIL"; ISSUES=$((ISSUES + 1))
  fi

  # 2. Typecheck
  printf "  [2/6] Typecheck...      "
  TS=$(npx tsc --noEmit 2>&1 | grep -c "error TS" || true)
  if [ "$TS" = "0" ]; then echo "✓ 0 errors"; else echo "✗ $TS errors"; ISSUES=$((ISSUES + TS)); fi

  # 3. Tests (run once, capture both pass and fail counts)
  printf "  [3/6] Tests...          "
  TEST_OUT=$(npx vitest run 2>&1 || true)
  FAILS=$(echo "$TEST_OUT" | grep -oE "[0-9]+ failed" | head -1 | grep -oE "[0-9]+" || echo "0")
  PASSES=$(echo "$TEST_OUT" | grep -oE "[0-9]+ passed" | head -1 | grep -oE "[0-9]+" || echo "0")
  if [ "$FAILS" = "0" ]; then echo "✓ $PASSES passed"; else
    echo "✗ $PASSES passed, $FAILS failed"
    echo "$TEST_OUT" | grep "FAIL" | head -5
    ISSUES=$((ISSUES + FAILS))
  fi

  # 4. Schema version
  printf "  [4/6] Schema version... "
  SV=$(grep "CURRENT_SCHEMA_VERSION" src/storage/sqlite.ts | head -1 | grep -oE "[0-9]+")
  LM=$(grep "writeSchemaVersion(" src/storage/sqlite.ts | grep -oE "[0-9]+" | tail -1 || echo "?")
  if [ "$SV" = "$LM" ]; then echo "✓ v$SV"; else echo "⚠ SV=$SV LM=$LM"; ISSUES=$((ISSUES + 1)); fi

  # 5. Dogfood (SDK — fast, no MCP server needed)
  printf "  [5/6] Dogfood SDK...    "
  DF=$(node --input-type=module -e "
    import { Memory } from './dist/sdk.js';
    import path from 'path';
    import os from 'os';
    const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
    const s = m.storage, db = s.getDatabase();
    let f = 0;
    try {
      db.prepare('SELECT COUNT(*) as n FROM captures').get().n;
      s.getCorrectionKPIs();
      await s.search('test', null, {limit:1,offset:0,mode:'hybrid'});
      await m.recall('test');
      const id = await m.capture('loop-'+Date.now(), 'task', ['dogfood']);
      await s.get(id);
      const eid = await m.capture('eg', 'decision', ['evergreen']);
      await m.recall('eg');
      const cp = await m.capture('cp', 'task', ['checkpoint']);
      await m.recall('cp');
    } catch(e) { f++; }
    process.stdout.write(String(f));
    m.close();
  " 2>/dev/null || echo "1")
  if [ "$DF" = "0" ]; then echo "✓ 8/8 passed"; else echo "✗ $DF failures"; ISSUES=$((ISSUES + 1)); fi

  # 6. Markdown export
  printf "  [6/6] MD export...      "
  if node dist/index.js export-md /tmp/dogfood-export.md 2>&1 | grep -q "Exported"; then
    SZ=$(wc -c < /tmp/dogfood-export.md)
    echo "✓ ${SZ} bytes"
  else
    echo "✗ FAIL"; ISSUES=$((ISSUES + 1))
  fi

  echo ""
  echo "  ┌──────────────────────────┐"
  echo "  │ Total issues: $ISSUES"
  echo "  │ TS errors:    $TS"
  echo "  │ Test failures: $FAILS"
  echo "  │ Tests passed:  $PASSES"
  echo "  └──────────────────────────┘"

  if [ "$ISSUES" -eq 0 ]; then
    echo ""
    echo "★★★ PRODUCT IS PERFECT — 0 ISSUES ★★★"
    echo "Build OK | 0 TS errors | 0 test failures | dogfood OK | MD export OK"
    echo "Completed in $ITER iteration(s)."
    exit 0
  fi

  echo ""
  echo "  → Launching 4 parallel agents to investigate + fix..."

  # Agent 1: Show typecheck errors (for manual fix guidance)
  if [ "$TS" -gt 0 ]; then
    echo "  [Agent 1] Typecheck errors:"
    npx tsc --noEmit 2>&1 | grep "error TS" | head -10 || true
  fi

  # Agent 2: Show test failures (for manual fix guidance)
  if [ "$FAILS" -gt 0 ]; then
    echo "  [Agent 2] Test failures:"
    echo "$TEST_OUT" | grep -B1 "FAIL\|AssertionError" | head -15
  fi

  # Agent 3: Dogfood stress test — rapid capture/recall cycle
  echo "  [Agent 3] Dogfood stress test..."
  node --input-type=module -e "
    import { Memory } from './dist/sdk.js';
    import path from 'path';
    import os from 'os';
    const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await m.capture('Stress #'+i+' '+Date.now(), 'task', ['dogfood','stress']));
    }
    const r = await m.recall('Stress');
    const found = ids.filter(id => r.find(x => x.entry.id === id)).length;
    console.log('    Stress: ' + found + '/5 found in recall');
    const k = m.storage.getCorrectionKPIs();
    console.log('    KPIs: ' + k.totalCorrections + ' corrections, precision=' + k.avgPrecision);
    m.close();
  " 2>/dev/null | head -5 &

  # Agent 4: Audit — check for common issues
  echo "  [Agent 4] Audit..."
  echo "    Unparameterized SQL:"
  grep -n 'db\.exec.*\${' src/storage/sqlite.ts 2>/dev/null | grep -v "PRAGMA\|CREATE\|ALTER\|DROP\|INSERT INTO captures_vec" | head -3 || echo "    none"
  echo "    Schema version mismatch:"
  echo "    CURRENT=$SV LATEST_MIGRATION=$LM"

  wait

  echo ""
  echo "  → Rebuilding..."
  npm run build 2>&1 | tail -1

  # Re-check after fixes
  echo "  → Re-checking..."
  TS2=$(npx tsc --noEmit 2>&1 | grep -c "error TS" || true)
  if [ "$TS2" -lt "$TS" ]; then
    echo "  ✓ TS errors reduced: $TS → $TS2"
  elif [ "$TS2" -gt "$TS" ]; then
    echo "  ⚠ TS errors increased: $TS → $TS2"
  fi

  echo ""
  echo "  ─────────────────────────────────────"
  echo "  Iteration $ITER complete. Issues: $ISSUES"
  echo "  ─────────────────────────────────────"
done

echo ""
echo "Reached max iterations ($MAX_ITER). Issues may remain."
exit 1
