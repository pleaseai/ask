---
name: Root-level scripts use bun + vitest
description: How to test scripts in the scripts/ directory at the monorepo root
type: feedback
---

Root-level scripts (in `scripts/`) run with `bun run scripts/<name>.ts`. For tests, use `bunx vitest run scripts/<name>.test.ts` — vitest is available transitively via the workspace. No separate tsconfig is needed at the root level.

**Why:** The root has no tsconfig; scripts are bun-first. CLI package uses `bun test`, registry app uses vitest — but for standalone root scripts, `bunx vitest run` works without any config.

**How to apply:** When writing tests for `scripts/*.ts` files, import from vitest and run with `bunx vitest run <path>`.
