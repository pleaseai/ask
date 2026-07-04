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
  # Each remaining arg is ONE command line (word-split here), run in order in
  # both copies — supports sequences like `install` then `remove react`.
  # Scrub env so inherited BUN_*/TTY state cannot perturb either side.
  #
  # Capture and COMPARE exit codes rather than blanket-`|| true`. A blanket
  # ignore lets the harness false-pass when BOTH sides error (e.g. both crash
  # on the same regression and write nothing → identical empty trees). By
  # requiring the exit codes to agree, an asymmetric success/failure — the
  # exact divergence a byte-diff of generated files can miss — is caught even
  # when the files happen to match. The file diff below still runs on top.
  local cmd rc_ts rc_rs
  for cmd in "$@"; do
    if ( cd "$ts" && env -i PATH="$PATH" HOME="$HOME" NO_COLOR=1 node "$TS_CLI" $cmd >/dev/null 2>&1 ); then rc_ts=0; else rc_ts=$?; fi
    if ( cd "$rs" && env -i PATH="$PATH" HOME="$HOME" NO_COLOR=1 "$RS_CLI" $cmd >/dev/null 2>&1 ); then rc_rs=0; else rc_rs=$?; fi
    if [[ "$rc_ts" != "$rc_rs" ]]; then
      echo "  FAIL $name ($cmd): exit code mismatch (ts=$rc_ts rs=$rc_rs)"
      fail=1
    fi
  done
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

# Reuse the same seeds for the install-then-remove sequences.
seed_npm_and_github_rm() { seed_npm_and_github "$1"; }
seed_github_only_rm() { seed_github_only "$1"; }

# `ask add` fixtures. A package.json + lockfile let the npm entry resolve its
# version offline (lazy-first install never downloads). The object-entry
# serialization ({ "spec", "docsPaths" }) is the drift-prone bit this exercises.
seed_add_docs_paths() {
  printf '{\n  "libraries": []\n}\n' >"$1/ask.json"
  printf '{\n  "name": "fixture",\n  "dependencies": { "react": "^18.2.0" }\n}\n' >"$1/package.json"
  printf '{\n  "lockfileVersion": 3,\n  "packages": {\n    "node_modules/react": { "version": "18.3.1" }\n  }\n}\n' >"$1/package-lock.json"
}
seed_add_clear() {
  printf '{\n  "libraries": [{ "spec": "npm:react", "docsPaths": ["docs"] }]\n}\n' >"$1/ask.json"
  printf '{\n  "name": "fixture",\n  "dependencies": { "react": "^18.2.0" }\n}\n' >"$1/package.json"
  printf '{\n  "lockfileVersion": 3,\n  "packages": {\n    "node_modules/react": { "version": "18.3.1" }\n  }\n}\n' >"$1/package-lock.json"
}
seed_add_github_bare() {
  printf '{\n  "libraries": []\n}\n' >"$1/ask.json"
}

# --- cases -----------------------------------------------------------------

echo "==> running parity cases"
run_case github_only install
run_case npm_and_github install
run_case empty install
# Sequences: install then remove — exercises skill teardown + AGENTS.md regen.
run_case npm_and_github_rm install "remove react"
run_case github_only_rm install "remove next.js"
# `ask add` non-interactive contract: CSV override (object entry), downgrade,
# and bare owner/repo → github normalization.
run_case add_docs_paths "add npm:react --docs-paths docs,api"
run_case add_clear "add npm:react --clear-docs-paths"
run_case add_github_bare "add vercel/next.js@v15.0.3"

# `ask skills install` — needs a bespoke harness (not run_case) for three
# reasons the advisor flagged: (1) a pre-warmed checkout under a shared ASK_HOME
# so ensureCheckout is a cache hit with no network; (2) skills-lock.json embeds
# a volatile `installedAt` timestamp that must be normalized before diffing;
# (3) the agent symlink's relative target is compared structurally by `diff -r`
# (both sides create the identical relative link, so it collapses to equal).
skills_install_parity() {
  local name="skills_install"
  local ts="$WORK/$name-ts" rs="$WORK/$name-rs" home="$WORK/$name-home"
  # Shared store: install only READS the checkout, so both CLIs can point at it.
  local checkout="$home/github/github.com/o/r/v1.0.0"
  mkdir -p "$ts" "$rs" "$checkout/skills/my-skill"
  printf '# my-skill\n\nProducer-side skill.\n' >"$checkout/skills/my-skill/SKILL.md"
  local d
  for d in "$ts" "$rs"; do
    printf '{\n  "libraries": []\n}\n' >"$d/ask.json"
    mkdir -p "$d/.claude"
    printf 'node_modules\n' >"$d/.gitignore"
  done
  # Exit codes are intentionally NOT compared for this case (only the files are).
  # The TS `skills` parent command (commands/skills/index.ts) declares BOTH
  # `subCommands` AND its own `run()` with a positional `spec`, so citty runs the
  # `install` subcommand AND then fires the parent run() with spec="install",
  # which calls runSkillsList → "no skills/ directory found for install" → exit 1.
  # That double-dispatch is a TS bug; the Rust router dispatches `skills install`
  # to install ONLY (exit 0). Both produce byte-identical files (verified below) —
  # replicating the spurious exit 1 in Rust would mean porting the bug, so we do
  # not. (run_case still compares exit codes for the non-skills commands.)
  ( cd "$ts" && env -i PATH="$PATH" HOME="$HOME" ASK_HOME="$home" NO_COLOR=1 node "$TS_CLI" skills install github:o/r@v1.0.0 --agent claude >/dev/null 2>&1 ) || true
  ( cd "$rs" && env -i PATH="$PATH" HOME="$HOME" ASK_HOME="$home" NO_COLOR=1 "$RS_CLI" skills install github:o/r@v1.0.0 --agent claude >/dev/null 2>&1 ) || true
  for d in "$ts" "$rs"; do
    if [[ -f "$d/.ask/skills-lock.json" ]]; then
      sed -i.bak 's/"installedAt": "[^"]*"/"installedAt": "NORM"/' "$d/.ask/skills-lock.json"
      rm -f "$d/.ask/skills-lock.json.bak"
    fi
  done
  if diff -r "$ts" "$rs" >"$WORK/$name.diff" 2>&1; then
    echo "  ok   $name (skills install --agent claude; lock installedAt normalized)"
  else
    echo "  FAIL $name"
    sed 's/^/       /' "$WORK/$name.diff"
    fail=1
  fi
}
skills_install_parity

if [[ "$fail" == 0 ]]; then
  echo "ALL PARITY CASES IDENTICAL"
else
  echo "PARITY DIFFERENCES DETECTED — fix the Rust side to match the TS oracle" >&2
  exit 1
fi
