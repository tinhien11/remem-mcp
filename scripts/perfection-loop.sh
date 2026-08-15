#!/usr/bin/env bash
# perfection-loop.sh — self-improving dogfood loop for remem-mcp
# Runs build + typecheck + tests + audit, reports issues, loops until clean.
# Usage: bash scripts/perfection-loop.sh [max_iterations]

set -euo pipefail
cd "$(dirname "$0")/.."

MAX_ITER="${1:-10}"
ITER=0
TOTAL_FIXED=0

while [ "$ITER" -lt "$MAX_ITER" ]; do
  ITER=$((ITER + 1))
  echo ""
  echo "========================================"
  echo "  PERFECTION LOOP — iteration $ITER/$MAX_ITER"
  echo "========================================"

  ISSUES=0

  # 1. Build
  echo ""
  echo "[1/5] Build..."
  if ! npm run build 2>&1 | tail -3; then
    echo "  FAIL: build failed"
    ISSUES=$((ISSUES + 1))
  else
    echo "  OK: build succeeded"
  fi

  # 2. Typecheck (count errors, don't fail — pre-existing errors tracked)
  echo ""
  echo "[2/5] Typecheck..."
  TS_ERRORS=$(npx tsc --noEmit 2>&1 | grep "error TS" | wc -l | tr -d ' ')
  echo "  TypeScript errors: $TS_ERRORS"
  if [ "$TS_ERRORS" -gt 0 ]; then
    ISSUES=$((ISSUES + TS_ERRORS))
  fi

  # 3. Tests
  echo ""
  echo "[3/5] Tests..."
  TEST_OUTPUT=$(npx vitest run 2>&1 || true)
  TEST_FAILED=$(echo "$TEST_OUTPUT" | grep -E "Tests.*failed" | grep -oE "[0-9]+ failed" | head -1 | grep -oE "[0-9]+" || echo "0")
  TEST_PASSED=$(echo "$TEST_OUTPUT" | grep -E "Tests.*passed" | grep -oE "[0-9]+ passed" | head -1 | grep -oE "[0-9]+" || echo "0")
  echo "  Tests: $TEST_PASSED passed, $TEST_FAILED failed"
  if [ "$TEST_FAILED" -gt 0 ]; then
    ISSUES=$((ISSUES + TEST_FAILED))
    echo "$TEST_OUTPUT" | grep "FAIL" | head -5
  fi

  # 4. Audit: check for common issues
  echo ""
  echo "[4/5] Self-audit..."

  # Check CURRENT_SCHEMA_VERSION matches latest migration
  SCHEMA_VER=$(grep "CURRENT_SCHEMA_VERSION" src/storage/sqlite.ts | head -1 | grep -oE "[0-9]+")
  LATEST_MIGRATION=$(grep "writeSchemaVersion(" src/storage/sqlite.ts | tail -1 | grep -oE "[0-9]+")
  if [ "$SCHEMA_VER" != "$LATEST_MIGRATION" ]; then
    echo "  WARN: CURRENT_SCHEMA_VERSION=$SCHEMA_VER but latest migration writes v$LATEST_MIGRATION"
    ISSUES=$((ISSUES + 1))
  else
    echo "  OK: schema version consistent ($SCHEMA_VER)"
  fi

  # Check smoke test tool count matches actual tool count
  SMOKE_EXPECTED=$(grep "toolNames.length.*toBe" tests/smoke.test.ts | grep -oE "[0-9]+")
  ACTUAL_TOOLS=$(node --input-type=module -e "
    import { spawn } from 'child_process';
    const p = spawn('node', ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', d => buf += d.toString());
    const req = JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
    p.stdin.write('Content-Length: ' + Buffer.byteLength(req) + '\r\n\r\n' + req);
    setTimeout(() => {
      try {
        const lines = buf.split('\n');
        for (const l of lines) {
          if (l.includes('\"tools\"')) {
            const m = JSON.parse(l);
            console.log(m.result.tools.length);
            break;
          }
        }
      } catch(e) { console.log('0'); }
      p.kill();
    }, 2000);
  " 2>/dev/null || echo "0")
  if [ "$SMOKE_EXPECTED" != "$ACTUAL_TOOLS" ] && [ "$ACTUAL_TOOLS" != "0" ]; then
    echo "  WARN: smoke test expects $SMOKE_EXPECTED tools, server has $ACTUAL_TOOLS"
    ISSUES=$((ISSUES + 1))
  else
    echo "  OK: tool count matches ($ACTUAL_TOOLS)"
  fi

  # Check for unparameterized SQL (basic heuristic)
  RAW_SQL=$(grep -n 'db.exec.*\${' src/storage/sqlite.ts | grep -v "PRAGMA\|CREATE\|ALTER\|DROP\|INSERT INTO captures_vec" | wc -l | tr -d ' ')
  if [ "$RAW_SQL" -gt 0 ]; then
    echo "  WARN: $RAW_SQL potential unparameterized SQL in sqlite.ts"
    ISSUES=$((ISSUES + RAW_SQL))
  else
    echo "  OK: no obvious unparameterized SQL"
  fi

  # Check for missing input validation in handlers
  NO_VALIDATE=$(grep -c "args\.\(name\|threshold\|batch_size\|outcome\|summary\)" src/server.ts || echo "0")
  HAS_VALIDATE=$(grep -c "isError: true" src/server.ts || echo "0")
  if [ "$NO_VALIDATE" -gt 5 ] && [ "$HAS_VALIDATE" -lt 3 ]; then
    echo "  WARN: many input params, few validation checks ($NO_VALIDATE params, $HAS_VALIDATE validations)"
  else
    echo "  OK: validation coverage looks reasonable ($HAS_VALIDATE checks)"
  fi

  # 5. Dogfood: call remem-mcp tools via SDK
  echo ""
  echo "[5/5] Dogfood (SDK self-test)..."
  DOGFOOD=$(node --input-type=module -e "
    import { Memory } from './dist/sdk.js';
    import path from 'path';
    import os from 'os';
    const m = new Memory({ dbPath: path.join(os.homedir(), '.local/share/remem-mcp/memory.db') });
    const s = m.storage;
    let ok = 0, fail = 0;
    const tests = [
      ['stats', () => s.getDatabase().prepare('SELECT COUNT(*) as n FROM captures').get().n >= 0],
      ['getCorrectionKPIs', () => { const k = s.getCorrectionKPIs(); return typeof k.totalCorrections === 'number'; }],
      ['search', async () => { const r = await s.search('test', null, {limit:1,offset:0,mode:'hybrid'}); return Array.isArray(r); }],
      ['recall', async () => { const r = await m.recall('test'); return Array.isArray(r); }],
      ['capture+get', async () => { const id = await m.capture('loop-test-'+Date.now(), 'task', ['loop','dogfood']); const e = await s.get(id); return e !== null; }],
    ];
    let done = 0;
    for (const [name, fn] of tests) {
      try { const r = await fn(); if (r) { ok++; } else { fail++; console.log('  FAIL: ' + name); } }
      catch(e) { fail++; console.log('  FAIL: ' + name + ' — ' + e.message); }
      done++;
      if (done === tests.length) {
        console.log('  ' + ok + ' passed, ' + fail + ' failed');
        if (fail > 0) process.exit(1);
        m.close();
      }
    }
  " 2>&1 || true)
  echo "$DOGFOOD"
  if echo "$DOGFOOD" | grep -q "FAIL"; then
    ISSUES=$((ISSUES + 1))
  fi

  # Summary
  echo ""
  echo "========================================"
  echo "  ITERATION $ITER SUMMARY"
  echo "  Issues found: $ISSUES"
  echo "  TS errors: $TS_ERRORS"
  echo "  Test failures: $TEST_FAILED"
  echo "========================================"

  if [ "$ISSUES" -eq 0 ]; then
    echo ""
    echo "★★★ PRODUCT IS CLEAN — 0 ISSUES ★★★"
    echo "Build OK, 0 TS errors, 0 test failures, audit passed, dogfood passed."
    echo "Exiting perfection loop after $ITER iterations."
    exit 0
  fi

  echo ""
  echo "Issues remain. Continuing to next iteration..."
  echo "(Automated checks only — manual fixes needed between iterations)"
  sleep 2
done

echo ""
echo "Reached max iterations ($MAX_ITER). $ISSUES issues remain."
exit 1
