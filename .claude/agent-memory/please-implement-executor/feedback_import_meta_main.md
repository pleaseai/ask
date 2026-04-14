---
name: import.meta.main guard for scripts
description: Always wrap top-level execution in scripts with import.meta.main to prevent test side effects
type: feedback
---

Always wrap the top-level `migrate()` / `run()` call in scripts with `if (import.meta.main)` to prevent the function from running when the module is imported by a test.

**Why:** Without this guard, vitest imports the module and triggers side effects (e.g., the migration script deleted all 50 registry .md files during the first test run). `import.meta.main` is true only when the file is executed directly with bun.

**How to apply:** All scripts that perform side effects at module level must use `if (import.meta.main) { run() }` at the bottom.
