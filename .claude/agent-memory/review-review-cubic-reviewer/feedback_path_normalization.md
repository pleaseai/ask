---
name: Cross-platform path normalization — cubic false-positive pattern
description: cubic flags path.normalize for cross-platform issues; fix with path.posix.normalize + replaceAll backslash passes second review cleanly
type: feedback
---

In `sanitizeDocsPath`, cubic (P2) flagged `path.normalize(trimmed)` as producing OS-native separators (Windows `\`) that would be persisted into `ask.json`, breaking portability.

Fix pattern: replace `path.normalize(trimmed)` with `path.posix.normalize(trimmed.replaceAll('\\', '/'))` so stored values always use POSIX forward slashes.

Traversal check becomes: `normalized === '..' || normalized.startsWith('../')` — valid because normalized form is guaranteed POSIX after the fix.

**Why:** `ask.json` is committed to git and shared across platforms. Storing Windows-style backslashes in `docsPaths` would break resolution on Linux/macOS.

**How to apply:** Any time paths destined for committed config files are normalized, always use `path.posix.normalize` + backslash conversion, not `path.normalize`. cubic will flag the bare `path.normalize` pattern again if it reappears.

Second-pass cubic review returned zero issues — fix was accepted as complete.
