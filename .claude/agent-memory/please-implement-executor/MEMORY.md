# Agent Memory — please-implement-executor

- [Test runner: bun run test (not bun test)](feedback_test_runner.md) — use `bun run test` in packages/cli; `bun test` may behave differently
- [Lint: antfu/consistent-list-newline enforced](feedback_lint_array_newline.md) — all array items must have consistent line breaks (either all inline or all on separate lines)
- [Root-level scripts use bun + vitest](feedback_script_testing.md) — scripts in `scripts/` run with bun, tested via `bunx vitest run`
- [import.meta.main guard for scripts](feedback_import_meta_main.md) — always guard top-level execution in scripts to prevent side effects during test import
