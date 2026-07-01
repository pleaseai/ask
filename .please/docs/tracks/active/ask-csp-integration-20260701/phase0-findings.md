# Phase 0 Findings — csp CLI Surface (ground truth)

> Track: ask-csp-integration-20260701
> Sources: `crates/csp-cli/src/main.rs` (clap defs), `crates/csp/src/indexing/cache.rs`
> (cache keying), README. Verified 2026-07-01 against pleaseai/code-search@main.

## csp `search` — exact surface (clap)

```rust
Search {
    query: String,               // positional #1
    path: Option<String>,        // positional #2, AFTER query; defaults to "." ; may be a dir OR a git URL
    top_k: Option<usize>,        // --top-k / -k
    content: Vec<ContentFilter>, // --content (repeatable) : code(default) | docs | config | all
    index: Option<String>,       // --index <path>  → use a prebuilt index, BYPASS auto-cache
    git_ref: Option<String>,     // --ref <ref>
}
```

Invocation ask will emit: **`csp search "<query>" <checkoutDir> [--content <c>] [--top-k <n>]`**

## csp `index` — exact surface (clap)

```rust
Index {
    path: Option<String>,        // positional, defaults "."
    out: Option<String>,         // --out / -o  (declared optional, ENFORCED required in code)
    content: Vec<ContentFilter>, // --content
}
```

`csp index` is **only for explicit persistence** to a custom path (`-o` required). It is **not**
needed on the normal path — see auto-cache below.

## Index cache — location & keying (`indexing/cache.rs`)

- Stored at **`~/.csp/index/<key>/`** where `<key>` = first 32 hex chars of a SHA256.
- Key payload (hashed): `{ source_id: normalize_source(path|url), content: <sorted content types>, git_ref }`.
- **`csp search` auto-indexes** into this cache on first run for a `(source, content, ref)` triple and
  reuses it afterward. `--index <path>` bypasses the auto-cache.
- Auto-invalidation on file-content change is **NOT guaranteed by the reviewed code** — the key is
  derived from the *source identity string* (+content+ref), not a hash of file bytes; the excerpt
  notes rebuild orchestration "lands in T016" (a future csp task).

## Resolutions

### OQ-2 (path: positional vs flag) → **RESOLVED: positional, after the query.**
Corrects spec FR-B1, which wrongly said `--path <checkoutDir>`. Correct: positional
`csp search "<query>" <checkoutDir>`. Also `--limit` → **`--top-k`/`-k`**.

### OQ-3 (index identity: path vs content) → **RESOLVED: content-addressed by SOURCE IDENTITY,
not file bytes.** Key = normalized path + content-selection + git_ref, hashed. Consequence:

- **Pinned refs (the common ask case):** ask's `checkoutDir` = `~/.ask/github/.../<ref>/` is unique
  per version AND its content is stable (ask's `ensureCheckout` reuses an existing checkout without
  in-place mutation — `ensure-checkout.ts` returns early on `fs.existsSync(checkoutDir)`). csp's
  key (distinct path per ref) therefore maps 1:1 to a stable corpus → **index built once, reused**.
  FR-C2 holds **without** any csp change.
- **Simplification:** the default `ask search` flow does **NOT** need to call `csp index` first —
  `csp search` auto-caches. Drop the explicit index step from FR-B1/FR-C1.

### R2 (mutable-ref staleness) → **LOW risk, bounded.**
`ask src`/`ask docs` allow branch refs (e.g. `main`); `ask.json` strict validation does not. For a
branch ref the store path is stable but a *re-fetch after `ask cache gc`* could give new content
under the same path — and csp (keying on path, no byte-hash invalidation yet) could serve a stale
index. Since ask never mutates a `checkoutDir` in place, this only bites across an explicit
clean+re-fetch cycle. Mitigation (FR-C3): on `ask cache gc` of a `checkoutDir`, note that its
csp index may be stale; advanced users can `csp clear index` or ask can pass `--index`/force. No
change needed for the pinned-ref happy path.

## Spec deltas to apply

1. **FR-B1:** flow becomes `ensureCheckout` → `csp search "<query>" <checkoutDir> [--content][--top-k]`.
   Remove the mandatory `csp index` call; path is **positional**; `--limit` → `--top-k`.
2. **FR-C1:** reframe — rely on csp auto-cache (`~/.csp/index/<sha256>`); ask does not pre-index by
   default. Optional pre-warm (`csp index <dir> -o`) is a non-default nicety only.
3. **FR-C2:** keep, now justified by cache.rs (distinct pinned-ref path ⇒ distinct stable key).
4. **OQ-2 / OQ-3:** mark resolved (this doc).
5. **Recipe (FR-B3/FR-D1):** update to `csp search "<question>" <dir>` (no separate index step).
6. Note csp `path` also accepts a **git URL** — ask deliberately passes the **local** checkoutDir to
   honor INV-2 (ask owns acquisition; csp gets an on-disk corpus).
