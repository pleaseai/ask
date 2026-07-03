#!/usr/bin/env bash
#
# Differential parity harness for the bun -> Rust port of the ask CLI.
#
# Runs the SAME command through the authoritative TypeScript build and the
# Rust binary against identical fixtures, then byte-diffs the generated files.
# Self-authored Rust unit tests cannot catch template drift (whitespace, a
# stray newline in SKILL.md / AGENTS.md / the nested ignore configs) because the
# test and the code share one mental model. This harness uses the TS output as
# an external oracle, so any diff is a real signal: fix the Rust side to match.
#
# Only *file outputs* are compared, never stdout: consola (TS) and eprintln!
# (Rust) legitimately differ, and the CLAUDE.md gotcha notes consola goes silent
# under a scrubbed/non-TTY environment anyway. The contract is the files.
#
# Usage:
#   scripts/parity-diff.sh                 # build both, run the built-in fixtures
#   scripts/parity-diff.sh --no-build      # skip the builds (reuse existing dist/ + target/)
#
# Requires: bun (to build the TS packages), cargo, node, diff.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS_CLI="$ROOT/packages/cli/dist/cli.js"   # bin entry (runMain), NOT dist/index.js
RS_CLI="$ROOT/target/debug/ask"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

build=1
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$build" == 1 ]]; then
  echo "==> building TS (schema + cli)"
  bun run --cwd "$ROOT/packages/schema" build >/dev/null
  bun run --cwd "$ROOT/packages/cli" build >/dev/null
  echo "==> building Rust (ask-please)"
  cargo build --manifest-path "$ROOT/Cargo.toml" -p ask-please >/dev/null 2>&1
fi

[[ -f "$TS_CLI" ]] || { echo "missing $TS_CLI (build the TS CLI first)" >&2; exit 1; }
[[ -x "$RS_CLI" ]] || { echo "missing $RS_CLI (build the Rust CLI first)" >&2; exit 1; }

fail=0

# run_case <name> <command...> — the fixture is seeded by a `seed_<name>` fn that
# receives the target dir as $1. The command is run in each copy; files diffed.
run_case() {
  local name="$1"; shift
  local ts="$WORK/$name-ts" rs="$WORK/$name-rs"
  mkdir -p "$ts" "$rs"
  "seed_$name" "$ts"
  "seed_$name" "$rs"
  # Scrub env so inherited BUN_*/TTY state cannot perturb either side.
  ( cd "$ts" && env -i PATH="$PATH" HOME="$HOME" NO_COLOR=1 node "$TS_CLI" "$@" >/dev/null 2>&1 ) || true
  ( cd "$rs" && env -i PATH="$PATH" HOME="$HOME" NO_COLOR=1 "$RS_CLI" "$@" >/dev/null 2>&1 ) || true
  if diff -r "$ts" "$rs" >"$WORK/$name.diff" 2>&1; then
    echo "  ok   $name ($*)"
  else
    echo "  FAIL $name ($*)"
    sed 's/^/       /' "$WORK/$name.diff"
    fail=1
  fi
}

# --- fixtures --------------------------------------------------------------

seed_github_only() {
  printf '{\n  "libraries": ["github:vercel/next.js@v15.0.3"]\n}\n' >"$1/ask.json"
}

seed_npm_and_github() {
  printf '{\n  "libraries": ["npm:react", "npm:zod", "github:vercel/next.js@v15.0.3"]\n}\n' >"$1/ask.json"
  printf '{\n  "name": "fixture",\n  "dependencies": { "react": "^18.2.0", "zod": "3.23.8" }\n}\n' >"$1/package.json"
  printf '{\n  "lockfileVersion": 3,\n  "packages": {\n    "node_modules/react": { "version": "18.3.1" },\n    "node_modules/zod": { "version": "3.23.8" }\n  }\n}\n' >"$1/package-lock.json"
  printf '# existing\nnode_modules\ndist\n' >"$1/.gitignore"
  printf 'coverage\n' >"$1/.prettierignore"
  printf 'sonar.projectKey=demo\nsonar.sources=src\n' >"$1/sonar-project.properties"
}

seed_empty() {
  printf '{\n  "libraries": []\n}\n' >"$1/ask.json"
}

# --- cases -----------------------------------------------------------------

echo "==> running parity cases"
run_case github_only install
run_case npm_and_github install
run_case empty install

if [[ "$fail" == 0 ]]; then
  echo "ALL PARITY CASES IDENTICAL"
else
  echo "PARITY DIFFERENCES DETECTED — fix the Rust side to match the TS oracle" >&2
  exit 1
fi
