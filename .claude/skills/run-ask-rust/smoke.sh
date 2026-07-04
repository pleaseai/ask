#!/usr/bin/env bash
#
# Smoke driver for the Rust port of the ask CLI (crates/ask, binary `ask`).
#
# Builds the release binary (unless --no-build), then drives the full user
# flow end-to-end in an ISOLATED temp project + temp ASK_HOME:
#   add(github) -> list -> fetch(network clone) -> src --json -> docs ->
#   search(no-csp fallback) -> add --docs-paths -> remove -> add(npm)
# Every step asserts exit code AND a key artifact/output.
#
# Usage:
#   .claude/skills/run-ask-rust/smoke.sh              # build + full run
#   .claude/skills/run-ask-rust/smoke.sh --no-build   # reuse target/release/ask
#   SMOKE_OFFLINE=1 .claude/skills/run-ask-rust/smoke.sh --no-build
#                                                     # skip network steps
set -euo pipefail
# NOTE: every assertion captures output into a variable before grep. Piping
# straight into `grep -q` under pipefail intermittently kills ask with SIGPIPE
# (grep exits on first match) and fails the step even when the output matched.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ASK="$ROOT/target/release/ask"
SPEC='github:tj/commander.js@v12.1.0'   # small repo with a real docs/ dir

build=1
[[ "${1:-}" == "--no-build" ]] && build=0
if [[ "$build" == 1 ]]; then
  echo "==> cargo build --release --locked -p ask-please"
  (cd "$ROOT" && cargo build --release --locked -p ask-please)
fi
[[ -x "$ASK" ]] || { echo "FAIL: $ASK missing — build first"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export ASK_HOME="$WORK/askhome"
PROJ="$WORK/proj"
mkdir -p "$PROJ"
cd "$PROJ"

pass=0
step() { echo "==> $1"; }
ok() { pass=$((pass + 1)); echo "  ok"; }
fail() { echo "  FAIL: $1"; exit 1; }

step "version"
out="$("$ASK" --version)"
grep -Eq '^ask [0-9]' <<<"$out" || fail "version string"
ok

step "add $SPEC"
printf '%s\n' '{"name":"demo","version":"0.0.0"}' > package.json
"$ASK" add "$SPEC" || fail "add exit"
grep -q "$SPEC" ask.json || fail "spec not in ask.json"
grep -q 'BEGIN:ask-docs-auto-generated' AGENTS.md || fail "AGENTS.md marker"
[[ -f .claude/skills/commander.js-docs/SKILL.md ]] || fail "skill file"
ok

step "list"
out="$("$ASK" list 2>&1)"
grep -q 'commander.js' <<<"$out" || fail "list output"
ok

if [[ "${SMOKE_OFFLINE:-0}" != 1 ]]; then
  step "fetch (network: shallow git clone)"
  "$ASK" fetch "$SPEC" || fail "fetch exit"
  [[ -d "$ASK_HOME/github/github.com/tj/commander.js/v12.1.0" ]] || fail "checkout dir"
  ok

  step "src --json"
  out="$("$ASK" src "$SPEC" --json)"
  grep -q '"checkoutDir"' <<<"$out" || fail "src json"
  ok

  step "docs (prints candidate doc paths)"
  out="$("$ASK" docs "$SPEC")"
  grep -q '/commander.js/v12.1.0' <<<"$out" || fail "docs path"
  ok

  step "search (csp absent -> path + recipe, exit 0)"
  out="$(PATH=/usr/bin:/bin "$ASK" search "$SPEC" 'parse options' 2>&1)"
  grep -q 'csp search' <<<"$out" || fail "search recipe"
  ok

  step "add --docs-paths docs (object entry)"
  "$ASK" add "$SPEC" --docs-paths docs || fail "add override exit"
  grep -q '"docsPaths"' ask.json || fail "docsPaths not persisted"
  ok
fi

step "remove"
"$ASK" remove "$SPEC" || fail "remove exit"
grep -q '"libraries": \[\]' ask.json || fail "ask.json not emptied"
[[ ! -e .claude/skills/commander.js-docs ]] || fail "skill not removed"
ok

step "add npm:commander (version from package.json range)"
printf '%s\n' \
  '{"name":"demo","version":"0.0.0","dependencies":{"commander":"^12.1.0"}}' \
  > package.json
out="$("$ASK" add npm:commander 2>&1)"
grep -q 'commander@\^12.1.0' <<<"$out" || fail "npm resolve"
ok

step "cache ls --json"
out="$("$ASK" cache ls --json)"
grep -q '"askHome"' <<<"$out" || fail "cache json"
ok

echo "SMOKE PASS ($pass steps)"
