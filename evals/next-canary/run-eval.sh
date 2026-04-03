#!/usr/bin/env bash
# run-eval.sh — Run a single Next.js eval with or without ASK docs
#
# Usage:
#   ./run-eval.sh <eval-dir> [--with-ask] [--model <model>]
#
# Examples:
#   ./run-eval.sh agent-031-proxy-middleware                    # baseline (no docs)
#   ./run-eval.sh agent-031-proxy-middleware --with-ask         # with ASK docs
#   ./run-eval.sh agent-031-proxy-middleware --with-ask --model sonnet
#
# This script:
# 1. Creates a temporary sandbox from the eval fixture
# 2. Installs next@canary
# 3. Optionally runs `ask docs add npm:next` to inject ASK docs
# 4. Launches claude -p with the PROMPT.md
# 5. Runs the EVAL.ts assertions via vitest
# 6. Reports pass/fail

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EVAL_DIR=""
WITH_ASK=false
MODEL="sonnet"

while [[ $# -gt 0 ]]; do
  case $1 in
    --with-ask) WITH_ASK=true; shift ;;
    --model) MODEL="$2"; shift 2 ;;
    *) EVAL_DIR="$1"; shift ;;
  esac
done

if [[ -z "$EVAL_DIR" ]]; then
  echo "Usage: $0 <eval-dir> [--with-ask] [--model <model>]"
  exit 1
fi

EVAL_PATH="$SCRIPT_DIR/$EVAL_DIR"
if [[ ! -d "$EVAL_PATH" ]]; then
  echo "Error: eval directory not found: $EVAL_PATH"
  exit 1
fi

# Create sandbox
SANDBOX=$(mktemp -d)
RESULTS_DIR="$SCRIPT_DIR/results/$EVAL_DIR"
RUN_LABEL="baseline"
[[ "$WITH_ASK" == true ]] && RUN_LABEL="with-ask"
RESULTS_DIR="$RESULTS_DIR/$RUN_LABEL"
mkdir -p "$RESULTS_DIR"

echo "=== Eval: $EVAL_DIR ($RUN_LABEL, model: $MODEL) ==="
echo "Sandbox: $SANDBOX"

# Copy eval fixtures (exclude EVAL.ts — agent must not see it)
rsync -a --exclude='EVAL.ts' "$EVAL_PATH/" "$SANDBOX/"

# Install dependencies
cd "$SANDBOX"
npm install next@canary react react-dom 2>&1 | tail -3
npm install --save-dev typescript @types/react @types/node 2>&1 | tail -3

# If --with-ask, run ASK to inject docs
if [[ "$WITH_ASK" == true ]]; then
  echo "--- Injecting ASK docs ---"
  # Use the ASK CLI to add Next.js docs from the npm package
  ASK_CLI="node $SCRIPT_DIR/../../packages/cli/dist/index.js"
  if [[ -f "$ASK_CLI" ]]; then
    $ASK_CLI docs add npm:next --version canary --docs-path dist/docs 2>&1 | tail -5
  else
    echo "ASK CLI not built. Falling back to manual AGENTS.md..."
    # Fallback: create AGENTS.md pointing to node_modules docs
    cat > AGENTS.md << 'AGENTSEOF'
<!-- BEGIN:nextjs-agent-rules -->
# Next.js Documentation

This project uses Next.js canary with breaking changes from your training data.

**IMPORTANT**: Before writing any code, read the relevant documentation in `node_modules/next/dist/docs/`.

Key docs for common tasks:
- Caching & `use cache`: `node_modules/next/dist/docs/01-app/01-getting-started/08-caching.md`
- Proxy (replaces middleware): `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
- `after()` for post-response work: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`
- `refresh()` from server actions: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/refresh.md`
- `cacheTag()` / `cacheLife()`: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cacheTag.md`
- Instant navigation: `node_modules/next/dist/docs/01-app/02-guides/instant-navigation.md`
- `revalidateTag()`: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidateTag.md`
<!-- END:nextjs-agent-rules -->
AGENTSEOF
    cat > CLAUDE.md << 'EOF'
@AGENTS.md
EOF
  fi
fi

# Read the prompt
PROMPT=$(cat "$EVAL_PATH/PROMPT.md")

# Run claude with the prompt
echo "--- Running claude ($MODEL) ---"
START_TIME=$(date +%s)

claude -p "$PROMPT" \
  --model "$MODEL" \
  --output-format json \
  --max-turns 30 \
  --allowedTools "Edit,Write,Read,Glob,Grep,Bash" \
  > "$RESULTS_DIR/transcript.json" 2>&1 || true

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
echo "Duration: ${DURATION}s"

# Copy EVAL.ts into sandbox as EVAL.test.ts (vitest default include pattern)
cp "$EVAL_PATH/EVAL.ts" "$SANDBOX/EVAL.test.ts"

# Install vitest for grading
npm install --save-dev vitest 2>&1 | tail -2

# Run eval assertions
echo "--- Running EVAL.test.ts assertions ---"
npx vitest run EVAL.test.ts --reporter=json > "$RESULTS_DIR/eval-output.json" 2>&1 || true
npx vitest run EVAL.test.ts 2>&1 | tee "$RESULTS_DIR/eval-output.txt" || true

# Check build
echo "--- Running next build ---"
npx next build > "$RESULTS_DIR/build-output.txt" 2>&1 && BUILD_PASS=true || BUILD_PASS=false

# Summarize
EVAL_PASS=$(grep -c "✓\|PASS" "$RESULTS_DIR/eval-output.txt" 2>/dev/null || echo 0)
EVAL_FAIL=$(grep -c "✗\|FAIL" "$RESULTS_DIR/eval-output.txt" 2>/dev/null || echo 0)

cat > "$RESULTS_DIR/summary.json" << SUMMARYEOF
{
  "eval": "$EVAL_DIR",
  "mode": "$RUN_LABEL",
  "model": "$MODEL",
  "duration_seconds": $DURATION,
  "build_passed": $BUILD_PASS,
  "tests_passed": $EVAL_PASS,
  "tests_failed": $EVAL_FAIL,
  "sandbox": "$SANDBOX"
}
SUMMARYEOF

echo ""
echo "=== Results ==="
echo "Build: $( [[ $BUILD_PASS == true ]] && echo 'PASS' || echo 'FAIL' )"
echo "Tests: $EVAL_PASS passed, $EVAL_FAIL failed"
echo "Duration: ${DURATION}s"
echo "Results saved to: $RESULTS_DIR"
echo "Sandbox: $SANDBOX (not cleaned up for inspection)"
