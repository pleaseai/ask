---
name: ESLint antfu/consistent-list-newline rule
description: Array/object items must all be on separate lines if any item is on its own line — no mixing inline and multiline
type: feedback
---

The project uses `@antfu/eslint-config` which enforces `antfu/consistent-list-newline`.

If you start a multi-line array/object, ALL items must be on separate lines:

```typescript
// Correct:
execFileSync('git', [
  'ls-remote',
  '--tags',
  remoteUrl,
], options)

// Wrong — mixing inline and multiline:
execFileSync('git', [
  'ls-remote', '--tags', remoteUrl,
], options)
```

**Why:** ESLint rule `antfu/consistent-list-newline` enforces this consistently.
**How to apply:** When writing array literals that span multiple lines, put each item on its own line.
