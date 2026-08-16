#!/usr/bin/env bash
# dogfood-codex.sh — dogfood remem-mcp using OpenAI Codex CLI as the agent
# Codex CLI gets remem-mcp as its MCP server, then works on remem-mcp's own codebase.
#
# Usage: bash scripts/dogfood-codex.sh [max_iterations] [model]
# Example: bash scripts/dogfood-codex.sh 3 gpt-5-codex

set -euo pipefail
cd "$(dirname "$0")/.."

MAX_ITER="${1:-3}"
MODEL="${2:-gpt-5.5}"
REPO_DIR="$(pwd)"
TMP_DIR="/tmp/remem-dogfood-codex"
mkdir -p "$TMP_DIR"

echo "══════════════════════════════════════════════════════════════"
echo "  🐕 DOGFOOD WITH CODEX CLI"
echo "  Repo:       $REPO_DIR"
echo "  Model:      $MODEL"
echo "  Iterations: $MAX_ITER"
echo "  MCP:        remem-mcp (already configured via 'codex mcp list')"
echo "══════════════════════════════════════════════════════════════"
echo ""

# Build first
echo "[build] Compiling..."
npm run build 2>&1 | tail -1
echo ""

# Verify remem-mcp is configured for Codex
if ! codex mcp list 2>&1 | grep -q "remem-mcp"; then
  echo "⚠ remem-mcp not configured for Codex. Adding it now..."
  codex mcp add remem-mcp \
    --env "REMEM_DB_PATH=$HOME/.local/share/remem-mcp/memory.db" \
    --env "REMEM_GLOBAL_SESSION_KEY=global" \
    --env "REMEM_AUTO_GLOBAL=true" \
    -- node "$REPO_DIR/dist/index.js"
fi

ITER=0
while [ "$ITER" -lt "$MAX_ITER" ]; do
  ITER=$((ITER + 1))
  echo ""
  echo "────────────────────────────────────────────────────────────"
  echo "  ITERATION $ITER/$MAX_ITER"
  echo "────────────────────────────────────────────────────────────"

  # 1. Snapshot current state
  echo ""
  echo "[1/4] State snapshot:"
  TS_ERRS=$(npx tsc --noEmit 2>&1 | grep -c "error TS" | tr -d '[:space:]' || echo "0")
  TEST_OUT=$(npx vitest run 2>&1 || true)
  TEST_FAILS=$(echo "$TEST_OUT" | grep -oE "[0-9]+ failed" | head -1 | grep -oE "[0-9]+" | tr -d '[:space:]' || echo "0")
  TEST_PASSES=$(echo "$TEST_OUT" | grep -oE "[0-9]+ passed" | head -1 | grep -oE "[0-9]+" | tr -d '[:space:]' || echo "0")
  [ -z "$TS_ERRS" ] && TS_ERRS=0
  [ -z "$TEST_FAILS" ] && TEST_FAILS=0
  [ -z "$TEST_PASSES" ] && TEST_PASSES=0
  echo "  TS errors: $TS_ERRS | Tests: $TEST_PASSES passed, $TEST_FAILS failed"

  # 2. Capture errors to feed Codex context
  ERR_FILE="$TMP_DIR/errors-iter-$ITER.txt"
  {
    echo "## Build errors (iteration $ITER)"
    npm run build 2>&1 | grep -i "error\|fail" | head -20 || echo "none"
    echo ""
    echo "## TypeScript errors"
    npx tsc --noEmit 2>&1 | grep "error TS" | head -20 || echo "none"
    echo ""
    echo "## Test failures"
    echo "$TEST_OUT" | grep -B2 "FAIL\|AssertionError\|Error:" | head -30 || echo "none"
  } > "$ERR_FILE" 2>&1

  ERR_COUNT=$(grep -c "error\|fail\|FAIL" "$ERR_FILE" 2>/dev/null || echo "0")
  echo "  Error file: $ERR_FILE ($ERR_COUNT lines with errors)"

  # 3. Run Codex CLI
  echo ""
  echo "[2/4] Launching Codex CLI (model=$MODEL)..."

  PROMPT="You are working on the remem-mcp codebase (a local MCP memory server at $REPO_DIR).

Current state:
- TypeScript errors: $TS_ERRS
- Test failures: $TEST_FAILS (out of $TEST_PASSES passed)

Error details from this iteration:
$(cat "$ERR_FILE")

Your tasks:
1. Use the remem-mcp MCP tools (recall, search) to check if we've seen these errors before and how we fixed them.
2. Fix the TypeScript errors and test failures shown above.
3. After fixing, run \`npm run build\` and \`npx vitest run\` to verify.
4. Use the remem-mcp capture tool to store what you fixed and how, so future sessions can recall it.
5. If everything passes, look for edge cases or potential bugs in the codebase and fix them.

Focus on real fixes, not workarounds. Check src/ for the relevant code."

  codex exec \
    --model "$MODEL" \
    --sandbox workspace-write \
    --dangerously-bypass-approvals-and-sandbox \
    "$PROMPT" \
    2>&1 | tee "$TMP_DIR/codex-output-iter-$ITER.log" || true

  echo ""
  echo "[3/4] Codex CLI finished. Output saved to $TMP_DIR/codex-output-iter-$ITER.log"

  # 4. Re-check state after Codex's fixes
  echo ""
  echo "[4/4] Post-fix state:"
  TS_ERRS_AFTER=$(npx tsc --noEmit 2>&1 | grep -c "error TS" | tr -d '[:space:]' || echo "0")
  TEST_OUT_AFTER=$(npx vitest run 2>&1 || true)
  TEST_FAILS_AFTER=$(echo "$TEST_OUT_AFTER" | grep -oE "[0-9]+ failed" | head -1 | grep -oE "[0-9]+" | tr -d '[:space:]' || echo "0")
  TEST_PASSES_AFTER=$(echo "$TEST_OUT_AFTER" | grep -oE "[0-9]+ passed" | head -1 | grep -oE "[0-9]+" | tr -d '[:space:]' || echo "0")
  [ -z "$TS_ERRS_AFTER" ] && TS_ERRS_AFTER=0
  [ -z "$TEST_FAILS_AFTER" ] && TEST_FAILS_AFTER=0
  [ -z "$TEST_PASSES_AFTER" ] && TEST_PASSES_AFTER=0

  echo "  TS errors: $TS_ERRS → $TS_ERRS_AFTER"
  echo "  Test failures: $TEST_FAILS → $TEST_FAILS_AFTER"
  echo "  Tests passed: $TEST_PASSES → $TEST_PASSES_AFTER"

  # Summary
  echo ""
  echo "┌──────────────────────────────────┐"
  echo "│ Iteration $ITER summary:"
  echo "│   TS errors:    $TS_ERRS → $TS_ERRS_AFTER"
  echo "│   Test fails:   $TEST_FAILS → $TEST_FAILS_AFTER"
  echo "│   Tests passed: $TEST_PASSES → $TEST_PASSES_AFTER"
  echo "└──────────────────────────────────┘"

  if [ "$TS_ERRS_AFTER" -eq 0 ] && [ "$TEST_FAILS_AFTER" -eq 0 ]; then
    echo ""
    echo "★★★ ALL GREEN — 0 TS errors, 0 test failures ★★★"
    echo "Codex CLI + remem-mcp dogfood iteration $ITER succeeded."
    break
  fi
done

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  DOGFOOD COMPLETE — $ITER iteration(s)"
echo "  Logs: $TMP_DIR/"
echo "══════════════════════════════════════════════════════════════"
