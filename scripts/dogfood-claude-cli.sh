#!/usr/bin/env bash
# dogfood-claude-cli.sh — dogfood remem-mcp using Claude CLI as the agent
# Claude CLI gets remem-mcp as its MCP server, then works on remem-mcp's own codebase.
# Memory persists across iterations — Claude recalls past errors/fixes from previous runs.
#
# Usage: bash scripts/dogfood-claude-cli.sh [max_iterations] [model]
# Example: bash scripts/dogfood-claude-cli.sh 3 sonnet

set -euo pipefail
cd "$(dirname "$0")/.."

MAX_ITER="${1:-3}"
MODEL="${2:-sonnet}"
REPO_DIR="$(pwd)"
TMP_DIR="/tmp/remem-dogfood"
mkdir -p "$TMP_DIR"

# MCP config — point Claude CLI at the locally built remem-mcp
MCP_CONFIG="$TMP_DIR/mcp-config.json"
cat > "$MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "remem-mcp": {
      "command": "node",
      "args": ["$REPO_DIR/dist/index.js"],
      "env": {
        "REMEM_DB_PATH": "$HOME/.local/share/remem-mcp/memory.db",
        "REMEM_GLOBAL_SESSION_KEY": "global",
        "REMEM_AUTO_GLOBAL": "true"
      }
    }
  }
}
EOF

echo "══════════════════════════════════════════════════════════════"
echo "  🐕 DOGFOOD WITH CLAUDE CLI"
echo "  Repo:     $REPO_DIR"
echo "  MCP:      $MCP_CONFIG"
echo "  Model:    $MODEL"
echo "  Iterations: $MAX_ITER"
echo "══════════════════════════════════════════════════════════════"
echo ""

# Build first
echo "[build] Compiling..."
npm run build 2>&1 | tail -1
echo ""

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

  # 2. Capture errors to feed Claude context
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

  ERR_COUNT=$(grep -c "error\|fail\|FAIL" "$ERR_FILE" || echo "0")
  echo "  Error file: $ERR_FILE ($ERR_COUNT lines with errors)"

  # 3. Run Claude CLI with remem-mcp as MCP server
  echo ""
  echo "[2/4] Launching Claude CLI (model=$MODEL)..."

  PROMPT="You are working on the remem-mcp codebase (a local MCP memory server).

Current state:
- TypeScript errors: $TS_ERRS
- Test failures: $TEST_FAILS (out of $TEST_PASSES passed)

Error details from this iteration:
$(cat "$ERR_FILE")

Your tasks:
1. Use recall to check if we've seen these errors before and how we fixed them.
2. Fix the TypeScript errors and test failures shown above.
3. After fixing, run \`npm run build\` and \`npx vitest run\` to verify.
4. Use capture to store what you fixed and how, so future sessions can recall it.
5. If everything passes, look for edge cases or potential bugs in the codebase and fix them.

Focus on real fixes, not workarounds. Check src/ for the relevant code."

  claude -p "$PROMPT" \
    --model "$MODEL" \
    --mcp-config "$MCP_CONFIG" \
    --add-dir "$REPO_DIR" \
    --allowedTools "Bash(npm *),Bash(npx *),Bash(node *),Bash(git *),Bash(cat *),Bash(grep *),Bash(ls *),Bash(wc *),Bash(head *),Bash(tail *),Edit,Read,Write,Grep,Glob" \
    --output-format text \
    --max-turns 30 \
    2>&1 | tee "$TMP_DIR/claude-output-iter-$ITER.log" || true

  echo ""
  echo "[3/4] Claude CLI finished. Output saved to $TMP_DIR/claude-output-iter-$ITER.log"

  # 4. Re-check state after Claude's fixes
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
    echo "Claude CLI + remem-mcp dogfood iteration $ITER succeeded."
    break
  fi
done

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  DOGFOOD COMPLETE — $ITER iteration(s)"
echo "  Logs: $TMP_DIR/"
echo "══════════════════════════════════════════════════════════════"
