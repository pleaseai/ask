# Cache Management (`ask cache`)

Read this when disk is filling up, a cached entry is stale, or you need
to inspect what `ask` has fetched. The global store lives at `~/.ask/`
by default; set `ASK_HOME` to relocate it. Every `ask install` writes
`<askHome>/STORE_VERSION` (currently `"2"`) as a layout marker.

## Store Layout (v2)

```
<askHome>/
├── npm/<pkg>@<version>/              # npm tarball extractions
├── github/<host>/<owner>/<repo>/<ref>/   # github shallow clones (PM-unified)
├── web/<sha256-of-url>/              # crawled doc sites
├── llms-txt/<sha256>@<version>/      # llms.txt imports
├── STORE_VERSION                     # "2"
└── .quarantine/<ts>-<uuid>/          # corrupt entries, preserved for inspection
```

`host` is currently always `github.com` — the segment exists so
`gitlab.com` / `bitbucket.org` can slot in without a migration.

## `ask cache ls [--kind <kind>]`

List every entry in the store with its size.

```bash
ask cache ls                      # everything
ask cache ls --kind npm           # filter: npm | github | web | llms-txt
```

Entries print as `<kind>/<key>  <size>`. Total size is summarized at
the end. If a legacy (pre-v2) `github/db` or `github/checkouts`
directory exists, its entries are tagged with a `(legacy) ` prefix in
the key — that's the signal to run `ask cache clean --legacy`.

## `ask cache gc [--dry-run] [--older-than <duration>]`

Remove entries that no project references anymore. `gc` discovers
references by walking `$HOME` (or each path in `ASK_GC_SCAN_ROOTS`,
colon-separated) for `.ask/resolved.json` files and treating the
entries listed there as roots.

```bash
ask cache gc                          # remove all unreferenced
ask cache gc --dry-run                # preview only, no deletion
ask cache gc --older-than 30d         # also require age > 30 days
ask cache gc --older-than 12h         # supports d / h / m / s
ASK_GC_SCAN_ROOTS=/repos:/work ask cache gc   # restrict scan
```

Always try `--dry-run` first when `ASK_GC_SCAN_ROOTS` is unset — the
default `$HOME` scan may miss project directories stored elsewhere,
which would mark still-used entries as unreferenced.

## `ask cache clean --legacy`

Remove the pre-v2 github store layout. The flag is required; calling
`ask cache clean` without it exits with a reminder.

```bash
ask cache clean --legacy
```

Deletes:
- `<askHome>/github/db/`        (bare-clone DB from the old shared layout)
- `<askHome>/github/checkouts/` (per-ref worktrees from the old layout)

The v2 layout (`<askHome>/github/<host>/<owner>/<repo>/<ref>/`) is
untouched. Safe to run anytime; it's a no-op when no legacy dirs exist.

## Environment Variables

| Variable              | Purpose                                    | Default        |
|-----------------------|--------------------------------------------|----------------|
| `ASK_HOME`            | Override the global store root             | `~/.ask`       |
| `ASK_GC_SCAN_ROOTS`   | Colon-separated scan roots for `cache gc`  | `$HOME`        |

Both are read at invocation time — set them inline or export per shell.

## Troubleshooting Tips

- "Corrupted store entry … quarantined to …" — `ask install` moved a
  tamper/missing-stamp entry into `.quarantine/`. Re-run the install;
  the fresh fetch replaces it. Delete the quarantine dir manually once
  you've inspected it.
- `ask docs <spec>` prints nothing — the checkout exists but has no
  `/doc/i` subdirs AND the walker can't see the root. Try
  `ask src <spec>` and `ls $(ask src <spec>)` to confirm the checkout
  is populated.
- `gc` removed an entry you still needed — either the project wasn't
  inside `ASK_GC_SCAN_ROOTS`, or `.ask/resolved.json` was missing /
  out of date. Re-run `ask install` in the project to rebuild both.
