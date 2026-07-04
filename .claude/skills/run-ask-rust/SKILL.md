---
name: run-ask-rust
description: Build, run, test, and smoke-test the Rust port of the ask CLI (crates/ask, binary `ask`). Use when asked to run the Rust CLI, verify a command works end-to-end, run the smoke driver, run cargo tests, or check TS↔Rust parity with the differential harness.
---

# Run the ask CLI (Rust port)

The Rust port of `@pleaseai/ask` lives in `crates/ask` (crate name **`ask-please`**,
binary **`ask`**, lib name `ask`). It is a plain CLI — no server, no GUI. The
agent path is the committed smoke driver, which builds the binary and drives the
full user flow (add → fetch → src/docs/search → remove) in an isolated temp
project + temp `ASK_HOME` with per-step assertions.

All paths below are relative to the repo root (the directory with `Cargo.toml`).

## Prerequisites

- Rust toolchain — pinned by `rust-toolchain.toml` (1.94.1); `cargo` on PATH is enough.
- `git` on PATH (`ask fetch` shells out to `git clone --depth 1`).
- Network access for the fetch/src/docs steps (use `SMOKE_OFFLINE=1` without it).
- `bun` only for the parity harness (it builds the TS oracle), not for the Rust CLI.

## Build

```bash
cargo build --release --locked -p ask-please
./target/release/ask --version   # → ask 0.4.8
```

Takes ~70s clean (release profile has lto + codegen-units=1). For iteration,
`cargo build -p ask-please` (debug) is much faster; the parity harness uses
`target/debug/ask`.

## Run (agent path) — smoke driver

```bash
.claude/skills/run-ask-rust/smoke.sh              # cargo build + 11-step full flow
.claude/skills/run-ask-rust/smoke.sh --no-build   # reuse existing target/release/ask
SMOKE_OFFLINE=1 .claude/skills/run-ask-rust/smoke.sh --no-build   # 6 steps, no network
```

Success ends with `SMOKE PASS (11 steps)` (6 offline). Steps covered: `--version`,
`add` (github spec → ask.json + AGENTS.md marker + `.claude/skills/<name>-docs/SKILL.md`),
`list`, `fetch` (real shallow clone of `tj/commander.js@v12.1.0`), `src --json`,
`docs`, `search` (no-csp fallback recipe), `add --docs-paths` (object entry),
`remove`, `add npm:...` (package.json range fallback), `cache ls --json`.
Everything runs in a `mktemp -d` — nothing touches your real `~/.ask` or project.

## Run (manual, ad-hoc)

To poke a single command, isolate the store with `ASK_HOME` and work in a temp dir:

```bash
export ASK_HOME=$(mktemp -d)
cd $(mktemp -d) && echo '{"name":"demo","version":"0.0.0"}' > package.json
/path/to/repo/target/release/ask add 'github:tj/commander.js@v12.1.0'
/path/to/repo/target/release/ask fetch 'github:tj/commander.js@v12.1.0'
/path/to/repo/target/release/ask docs  'github:tj/commander.js@v12.1.0'
```

## Direct invocation (most PRs touch internals)

Logic lives in the lib (`crates/ask/src/`), fully unit-tested offline (HTTP via
`MockClient`, git via local bare repos). For a PR touching one module, the right
handle is the module's test filter, not the binary:

```bash
cargo test -p ask-please                    # full suite (285 tests, <1s after build)
cargo test -p ask-please lockfiles::        # one module
```

## Parity harness (the real oracle)

Rust unit tests share a mental model with the code; the TS build is the external
oracle. **Re-run after changing any command's file output:**

```bash
bash scripts/parity-diff.sh            # builds TS (bun) + Rust debug, 9 cases
bash scripts/parity-diff.sh --no-build # reuse dist/ + target/debug
```

Success ends with `ALL PARITY CASES IDENTICAL`. It byte-diffs generated files
only (never stdout — consola vs eprintln legitimately differ). Requires `bun`.

## Gotchas

- **Crate name ≠ binary name.** `cargo run -p ask-please -- <args>`; the binary
  is `target/{debug,release}/ask`. `cargo run -p ask` fails.
- **`ask install`/`ask add` never download docs** (lazy-first design). `ask list`
  shows `Version: unresolved … (not installed — run ask install)` even right
  after a successful `add` — that's normal. Actual fetching happens in the lazy
  commands (`fetch`/`src`/`docs`).
- **`ask add npm:<pkg>` needs the dep declared.** Version comes from
  lockfile → package.json range fallback; if the package isn't in either you get
  `not found in any lockfile — skipping` (exit still 0, entry still added).
- **github specs need an explicit tag ref** (`@v12.1.0`); mutable refs like
  `main` are rejected by strict validation at install time.
- **Stream split:** progress/warnings go to **stderr**, data (`src --json`,
  `docs`, `cache ls --json`, recipe from `search`) to **stdout**. When asserting
  on progress lines, capture `2>&1`.
- **Don't pipe ask straight into `grep -q` under `set -o pipefail`** — grep
  exits on first match and SIGPIPE (141) kills the pipeline intermittently.
  Capture into a variable first (the smoke driver does this everywhere).
- **`ask search` without csp is exit 0** — it prints the checkout path + a
  shell-quoted `csp search …` recipe instead of failing.
- **Parity harness entrypoint trap:** the TS side runs `packages/cli/dist/cli.js`
  (runMain), NOT `dist/index.js` (silent no-op). Already encoded in the script.

## Troubleshooting

- `FAIL: npm resolve` in an older smoke run / `file exists: package.json` in an
  interactive zsh → zsh noclobber; use `printf > file` from bash or `>|` in zsh.
- `error: package 'ask' not found` → use `-p ask-please`.
- Fetch hangs or fails → network/GitHub reachability; re-run with
  `SMOKE_OFFLINE=1` to confirm the rest of the CLI is healthy.
