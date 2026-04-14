---
name: Test runner for packages/cli
description: Use bun run test (not bun test) in packages/cli — bun:test imports work with bun run test via the package.json scripts
type: feedback
---

Use `bun run --cwd packages/cli test [filter]` to run tests in the CLI package.
The test files import from `bun:test` which requires running via `bun run test` (script), not `bunx vitest`.

**Why:** The project uses bun's native test runner (bun:test), not vitest, for the CLI package tests.
**How to apply:** When running specific test files: `bun run --cwd /path/to/ask/packages/cli test test/sources/github.test.ts`
