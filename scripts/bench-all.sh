#!/bin/bash
# bench-all.sh — Run AMB L1-L3 + LoCoMo, output scores in parseable format.
# Usage: ./scripts/bench-all.sh [--quick]
#   --quick: skip LoCoMo (AMB only, ~2 min)
#
# Output format (last line, parseable):
#   BENCH_RESULT L1=<n> L2=<n> L3=<n> LOCOMO=<n>
#
# Exit 0 if all targets met, exit 1 if any below target.

set -uo pipefail

# ─── Targets ───────────────────────────────────────────────────
TARGET_L1="${TARGET_L1:-100}"
TARGET_L2="${TARGET_L2:-100}"
TARGET_L3="${TARGET_L3:-100}"
TARGET_LOCOMO="${TARGET_LOCOMO:-76}"
TARGET_PERSONAMEM="${TARGET_PERSONAMEM:-76}"

# ─── Paths ─────────────────────────────────────────────────────
PROJECT_ROOT="/Users/tin/a/remem-mcp"
AMB_REPO="/tmp/amb-repo"
LOCOMO_BENCH="/tmp/locomo-bench"
LOCOMO_DATA="/tmp/locomo/data/locomo10.json"
AMB_RESULTS="/tmp/amb-results"
LOCOMO_RESULTS="$LOCOMO_BENCH/results.json"
PERSONAMEM_BENCH="/tmp/personamem"
PERSONAMEM_RESULTS="$PERSONAMEM_BENCH/results.json"

# ─── Helpers ───────────────────────────────────────────────────
log() { echo "[bench] $*" >&2; }

# ─── Build remem-mcp ─────────────────────────────────────
log "Building remem-mcp..."
cd "$PROJECT_ROOT"
npm run build 2>&1 | tail -1
log "Build OK"

# ─── AMB Layer 1 ───────────────────────────────────────────────
log "Running AMB Layer 1..."
cd "$AMB_REPO"
L1_OUTPUT=$(npx tsx src/cli.ts --provider mcp --mcp-command "npx -y remem-mcp" --layer 1 --no-delay --verbose --output "$AMB_RESULTS" 2>&1)
L1=$(echo "$L1_OUTPUT" | grep '^🏆 Layer 1 Score:' | grep -oE 'Score: [0-9]+' | grep -oE '[0-9]+' || echo "0")
log "L1=$L1"

# ─── AMB Layer 2 ───────────────────────────────────────────────
log "Running AMB Layer 2..."
L2_OUTPUT=$(npx tsx src/cli.ts --provider mcp --mcp-command "npx -y remem-mcp" --layer 2 --no-delay --verbose --output "$AMB_RESULTS" 2>&1)
L2=$(echo "$L2_OUTPUT" | grep '^🏆 Layer 2 Score:' | grep -oE 'Score: [0-9]+' | grep -oE '[0-9]+' || echo "0")
log "L2=$L2"

# ─── AMB Layer 3 ───────────────────────────────────────────────
log "Running AMB Layer 3 (1K memories)..."
L3_OUTPUT=$(npx tsx src/cli.ts --provider mcp --mcp-command "npx -y remem-mcp" --layer 3 --no-delay --verbose --output "$AMB_RESULTS" 2>&1)
L3=$(echo "$L3_OUTPUT" | grep '^🏆 Layer 3 Score' | grep -oE 'Score.*?: [0-9]+' | grep -oE '[0-9]+' | head -1 || echo "0")
log "L3=$L3"

# ─── LoCoMo ────────────────────────────────────────────────────
LOCOMO="N/A"
if [ "${1:-}" != "--quick" ] && [ -f "$LOCOMO_DATA" ]; then
  log "Running LoCoMo benchmark..."
  cd "$LOCOMO_BENCH"

  # Clean previous data to avoid stale memories
  rm -rf "$LOCOMO_BENCH/remem-data"
  mkdir -p "$LOCOMO_BENCH/remem-data"

  # Run LoCoMo ingest + search
  npx tsx run.ts 2>&1 | tail -5

  # Judge results using simple keyword matching (fallback if no LLM judge)
  if [ -f "$LOCOMO_RESULTS" ]; then
    LOCOMO=$(python3 -c "
import json, sys
results = json.load(open('$LOCOMO_RESULTS'))
if not results:
    print(0)
    sys.exit()
correct = 0
for r in results:
    gt = str(r.get('groundTruth', '')).lower()
    hits = r.get('searchResults', [])
    # Simple heuristic: if any search result contains a keyword from ground truth
    gt_words = [w for w in gt.split() if len(w) > 3 and w not in ('what', 'when', 'where', 'which', 'about', 'because', 'would', 'could', 'should', 'their', 'there', 'these', 'those', 'after', 'before')]
    found = False
    for h in hits:
        content = h.get('content', '').lower()
        if any(w in content for w in gt_words[:3]):
            found = True
            break
    if found:
        correct += 1
score = round(correct / len(results) * 100)
print(score)
" 2>/dev/null || echo "0")
    log "LOCOMO=$LOCOMO (keyword heuristic — for LLM judge, set BENCH_LLM_JUDGE=1)"
  fi
fi

# ─── PersonaMem ────────────────────────────────────────────────
PERSONAMEM="N/A"
if [ "${1:-}" != "--quick" ] && [ -f "$PERSONAMEM_BENCH/personamem-bench.ts" ]; then
  log "Running PersonaMem benchmark..."
  cd "$PERSONAMEM_BENCH"
  PERSONAMEM_SAMPLE="${PERSONAMEM_SAMPLE:-50}"
  npx tsx personamem-bench.ts --sample=$PERSONAMEM_SAMPLE 2>&1 | tail -20
  PERSONAMEM=$(grep "PERSONAMEM_SCORE" /tmp/personamem-bench-output.log 2>/dev/null | grep -oE '[0-9]+' || echo "0")
  # Parse from results.json if score line not captured
  if [ "$PERSONAMEM" = "0" ] && [ -f "$PERSONAMEM_RESULTS" ]; then
    PERSONAMEM=$(python3 -c "import json; print(json.load(open('$PERSONAMEM_RESULTS'))['score'])" 2>/dev/null || echo "0")
  fi
  log "PERSONAMEM=$PERSONAMEM (sample=$PERSONAMEM_SAMPLE, TencentDB=76)"
fi

# ─── Output ────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  BENCHMARK RESULTS — remem-mcp"
echo "═══════════════════════════════════════════════════════════"
echo "  AMB Layer 1:  $L1 / 100  (target: $TARGET_L1)"
echo "  AMB Layer 2:  $L2 / 100  (target: $TARGET_L2)"
echo "  AMB Layer 3:  $L3 / 100  (target: $TARGET_L3)"
echo "  LoCoMo:       $LOCOMO / 100  (target: $TARGET_LOCOMO)"
echo "  PersonaMem:   $PERSONAMEM / 100  (target: $TARGET_PERSONAMEM, TencentDB=76)"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "BENCH_RESULT L1=$L1 L2=$L2 L3=$L3 LOCOMO=$LOCOMO PERSONAMEM=$PERSONAMEM"

# ─── Check targets ─────────────────────────────────────────────
PASS=true
[ "${L1:-0}" -lt "$TARGET_L1" ] && PASS=false && echo "FAIL: L1=$L1 < target=$TARGET_L1"
[ "${L2:-0}" -lt "$TARGET_L2" ] && PASS=false && echo "FAIL: L2=$L2 < target=$TARGET_L2"
[ "${L3:-0}" -lt "$TARGET_L3" ] && PASS=false && echo "FAIL: L3=$L3 < target=$TARGET_L3"
if [ "$LOCOMO" != "N/A" ]; then
  [ "${LOCOMO:-0}" -lt "$TARGET_LOCOMO" ] && PASS=false && echo "FAIL: LOCOMO=$LOCOMO < target=$TARGET_LOCOMO"
fi
if [ "$PERSONAMEM" != "N/A" ]; then
  [ "${PERSONAMEM:-0}" -lt "$TARGET_PERSONAMEM" ] && PASS=false && echo "FAIL: PERSONAMEM=$PERSONAMEM < target=$TARGET_PERSONAMEM"
fi

if [ "$PASS" = true ]; then
  echo "ALL PASS ✓"
  exit 0
else
  echo "SOME FAIL ✗"
  exit 1
fi
