---
name: Global store atomicity patterns
description: Known race/partial-state windows in packages/cli/src/store and how readers interact with them
type: project
---

Global docs store (`packages/cli/src/store/index.ts`) has two subtle atomicity issues surfaced in PR #60:

1. `writeEntryAtomic` does `rmSync(target)` then `renameSync(tmp, target)`. Between those calls the target does not exist, and **callers check `fs.existsSync(storeDir)` outside the lock** (e.g. `sources/npm.ts`, `sources/web.ts`, `sources/llms-txt.ts`). That existence check is the store-hit fast path, and it can return false mid-swap. The lock is the real source of truth — existence checks are best-effort.

2. `acquireEntryLock` on timeout calls `fs.unlinkSync(lockPath)` with no staleness check (no mtime, no PID file), then throws. A legitimately slow writer can have its live lock deleted by a timed-out peer, and a third process can then acquire the lock while the original writer is still mid-write.

**Why:** PR #60 introduces the global store and this is the first time concurrent writes across projects are possible. The docstring claims `writeEntryAtomic` is atomic; it is not across concurrent readers.

**How to apply:** When reviewing changes to `store/index.ts` or any caller of `writeEntryAtomic`/`acquireEntryLock`, flag any new code that (a) pre-checks `existsSync(entryDir)` outside the lock as authoritative or (b) touches the lock file without a staleness check. If fixing: rename target to `.old-<uuid>` first, then rename tmp, then rm old; add mtime-based staleness to unlink.
