#!/usr/bin/env bash
# run-all.sh — Run all Next.js evals in baseline and with-ask modes
#
# Usage:
#   ./run-all.sh [--model <model>] [--only <eval-name>]
#
# Examples:
#   ./run-all.sh                                    # Run all 7 evals, both modes
#   ./run-all.sh --model sonnet                     # Specify model
#   ./run-all.sh --only agent-031-proxy-middleware   # Run single eval

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL="sonnet"
ONLY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --model) MODEL="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    *) shift ;;
  esac
done

EVALS=(
  agent-029-use-cache-directive
  agent-031-proxy-middleware
  agent-032-use-cache-directive
  agent-036-after-response
  agent-038-refresh-settings
  agent-039-indirect-proxy
  agent-040-unstable-instant
)

if [[ -n "$ONLY" ]]; then
  EVALS=("$ONLY")
fi

echo "========================================"
echo " ASK Next.js Canary Eval Suite"
echo " Model: claude-$MODEL"
echo " Evals: ${#EVALS[@]}"
echo "========================================"
echo ""

BASELINE_PASS=0
BASELINE_FAIL=0
ASK_PASS=0
ASK_FAIL=0

for eval in "${EVALS[@]}"; do
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " $eval"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Baseline run
  echo ""
  echo "▸ Baseline (no docs)"
  "$SCRIPT_DIR/run-eval.sh" "$eval" --model "$MODEL" 2>&1 | tail -6
  if grep -q '"tests_failed": 0' "$SCRIPT_DIR/results/$eval/baseline/summary.json" 2>/dev/null; then
    BASELINE_PASS=$((BASELINE_PASS + 1))
  else
    BASELINE_FAIL=$((BASELINE_FAIL + 1))
  fi

  # With-ASK run
  echo ""
  echo "▸ With ASK docs"
  "$SCRIPT_DIR/run-eval.sh" "$eval" --with-ask --model "$MODEL" 2>&1 | tail -6
  if grep -q '"tests_failed": 0' "$SCRIPT_DIR/results/$eval/with-ask/summary.json" 2>/dev/null; then
    ASK_PASS=$((ASK_PASS + 1))
  else
    ASK_FAIL=$((ASK_FAIL + 1))
  fi
done

TOTAL=${#EVALS[@]}
echo ""
echo "========================================"
echo " Final Results"
echo "========================================"
echo ""
echo " Baseline:  $BASELINE_PASS/$TOTAL passed ($((BASELINE_PASS * 100 / TOTAL))%)"
echo " With ASK:  $ASK_PASS/$TOTAL passed ($((ASK_PASS * 100 / TOTAL))%)"
echo " Delta:     +$(( (ASK_PASS - BASELINE_PASS) * 100 / TOTAL ))%"
echo ""

# Write summary
cat > "$SCRIPT_DIR/results/summary.json" << EOF
{
  "model": "claude-$MODEL",
  "total_evals": $TOTAL,
  "baseline": {
    "passed": $BASELINE_PASS,
    "failed": $BASELINE_FAIL,
    "success_rate": $(echo "scale=2; $BASELINE_PASS * 100 / $TOTAL" | bc)
  },
  "with_ask": {
    "passed": $ASK_PASS,
    "failed": $ASK_FAIL,
    "success_rate": $(echo "scale=2; $ASK_PASS * 100 / $TOTAL" | bc)
  },
  "delta": $(echo "scale=2; ($ASK_PASS - $BASELINE_PASS) * 100 / $TOTAL" | bc)
}
EOF

echo "Results written to $SCRIPT_DIR/results/summary.json"
