# Decision — T-2: Intent display helper exports

**Date:** 2026-04-10
**Task:** T-2 (Inspect Intent display exports)
**Status:** Decided

## Finding

`@tanstack/intent`'s package.json only exports two entrypoints:

- `.` (`./dist/index.mjs`)
- `./intent-library` (`./dist/intent-library.mjs`)

`src/index.ts` re-exports `scanForIntents`, `checkStaleness`, feedback
helpers, `findSkillFiles`, `parseFrontmatter`, `getDeps`, `resolveDepDir`,
setup helpers, and types — but **not** anything from `src/display.ts`.

The display helpers (`printTable`, `printSkillTree`, `computeSkillNameWidth`)
are therefore **not reachable** as a public API from `@tanstack/intent`.

## Decision

**Port** `packages/intent/src/display.ts` into ASK as
`packages/cli/src/display/{table,tree}.ts`, with the following
adjustments:

1. Replace `console.log` with `consola.log`.
2. Split `printTable` into `display/table.ts` and
   `printSkillTree` + `computeSkillNameWidth` into `display/tree.ts`.
3. Attribution header on each ported file (MIT-compatible license) —
   both projects are MIT.
4. Export pure helpers (`formatTable`, `formatSkillTree`) in addition
   to the emitter variants so they are directly unit-testable without
   intercepting consola output.

## Risk / Mitigation

- Port size: ~70 LOC total, well under the 150 LOC timebox.
- Future divergence: display.ts in Intent may evolve; the port is a
  snapshot. Acceptable because the aesthetic is under ASK's control now.
