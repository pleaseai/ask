---
name: add-docs
description: >
  Download a single library's documentation and wire it into the project so AI agents
  can read accurate, version-specific docs instead of relying on training data. Mirrors
  the `ask docs add <spec>` CLI command but runs entirely as agent steps — no CLI binary
  required. Resolves the best source via the ASK Registry (priority: github > npm > web >
  llms-txt), falls back to package-manager metadata when the registry has no entry, saves
  files to `.ask/docs/<name>@<version>/`, updates `.ask/config.json`, and refreshes
  the auto-generated block in `AGENTS.md`. MUST use this skill whenever the user asks to
  add docs for a specific library (e.g. "zod 문서 추가", "add docs for next@canary",
  "ask docs add ..."), introduces a new dependency, or upgrades a single package and
  wants its docs refreshed. Trigger on: "문서 추가", "docs 추가", "add docs", "ask docs add",
  "라이브러리 문서 받아", "fetch docs for", and any mention of pulling a single library's
  documentation into the project.
---

# add-docs — Add a Single Library's Documentation

Download docs for one library and register them so AI agents (Claude Code, Cursor, etc.)
can read them via `AGENTS.md`. This is the canonical pipeline; `setup-docs` and `sync-docs`
both reuse the steps in this file.

## When to use this skill

- The user names a library (with or without version) and asks to fetch its docs.
- A new dependency was just added and you want its docs available before writing code.
- A single package was upgraded and its docs need to be refreshed.

For batch initial setup of every dependency, use `setup-docs` instead.
For drift detection after lockfile changes, use `sync-docs`.

## Inputs

- **spec** (required) — `<name>[@version]`, optionally with an ecosystem prefix:
  - `zod` — name only, version resolved to `latest` from the chosen source
  - `zod@3.22` — explicit version
  - `npm:next@canary` — explicit ecosystem + tag
  - `pypi:fastapi`, `go:github.com/gin-gonic/gin`, `crates:serde`, `hex:phoenix`, `pub:dio`
- **source override** (optional) — if the user pins one of `github`, `npm`, `web`, `llms-txt`,
  honor it and skip the registry lookup. Otherwise auto-resolve.
- **explicit hints** (optional) — `repo` (for github), `url` (for web/llms-txt), `branch`/`tag`,
  `docsPath`, `maxDepth`, `pathPrefix`. Pass-through to the source step.

## Pipeline overview

```
parse → detect ecosystem → registry lookup → (fallback) → fetch docs
      → save to .ask/docs → update .ask/config.json → update .ask/ask.lock
      → update AGENTS.md (marker block) → ensure CLAUDE.md @AGENTS.md
```

The order matters: each later step assumes the previous one succeeded.

---

## Step 1 — Parse the spec

Split off the optional ecosystem prefix at the first `:`. Whatever's left is `name[@version]`.
Take the **last** `@` as the version separator (so scoped npm names like `@scope/pkg@1.2`
still parse correctly). If no version is given, treat it as `latest` and let the source
report the resolved version.

## Step 2 — Detect ecosystem (only if not explicit)

Look in the project root for the first marker file that exists, in this order:

| File | Ecosystem |
|---|---|
| `package.json` | `npm` |
| `pubspec.yaml` | `pub` |
| `pyproject.toml` or `requirements.txt` | `pypi` |
| `go.mod` | `go` |
| `Cargo.toml` | `crates` |
| `mix.exs` | `hex` |

If none match, default to `npm`. The user can always override by using an explicit prefix.

## Step 3 — Look up the ASK Registry

Fetch the registry entry via WebFetch:

```
https://ask-registry.pages.dev/api/registry/<ecosystem>/<name>
```

If it returns 200 with at least one strategy, pick the **highest-priority** strategy using
this stable order (lower number wins; ties keep registry order):

| source | priority | rationale |
|---|---|---|
| `github` | 0 | Highest signal-to-noise — eval results show best accuracy at lowest cost |
| `npm` | 1 | Reliable, version-pinned, but may miss prose docs |
| `web` | 2 | Crawled HTML; expensive and noisier |
| `llms-txt` | 3 | Last resort — eval scored below baseline on real tasks |

Move on to Step 4 with the chosen strategy. Skip Step 3a entirely.

## Step 3a — Fallback when the registry has no entry

A 404 / empty strategies list does not mean we give up. Most popular packages can be
located via their package manager's own metadata. Try in order, stopping at the first hit:

- **npm**: `bun pm view <name> repository.url homepage` (or `npm view`). Extract a
  GitHub repo from `repository.url` and fall back to `github` source. If no repo, fetch
  the npm tarball and look for a `docs/` or `README.md`.
- **pypi**: `https://pypi.org/pypi/<name>/json` → look in `info.project_urls` for any
  GitHub or "Source" URL → use `github` source.
- **go**: if the module path itself is `github.com/<owner>/<repo>/...`, use that directly
  with `github` source. Otherwise check `https://pkg.go.dev/<name>` for a "Repository" link.
- **crates**: `https://crates.io/api/v1/crates/<name>` → `crate.repository` → `github`.
- **hex**: `https://hex.pm/api/packages/<name>` → `meta.links.GitHub` (or any `github.com` URL).
- **pub**: `https://pub.dev/api/packages/<name>` → `latest.pubspec.repository` (or `homepage`).
- **llms.txt sniff**: if the package has a homepage, HEAD `<homepage>/llms.txt` and
  `<homepage>/llms-full.txt`. If either responds 200, use `llms-txt` source on it.
- **Give up cleanly**: if nothing works, stop and ask the user for an explicit
  `source` + `repo`/`url`. **Do not invent a repo URL.** Wrong docs are worse than no docs.

## Step 4 — Fetch the docs

Each source produces a list of `{ path, content }` files plus a `resolvedVersion`.

### github
1. Build the archive URL:
   - tag: `https://github.com/<repo>/archive/refs/tags/<tag>.tar.gz`
   - branch: `https://github.com/<repo>/archive/refs/heads/<branch>.tar.gz`
2. `curl -L -o /tmp/<name>.tar.gz <url>` then extract into a temp dir.
3. From the extracted root, look for the first existing directory in:
   `docs/`, `doc/`, `documentation/`, `guide/`, `guides/` (or honor an explicit `docsPath`).
4. Recursively collect every file with extension `.md`, `.mdx`, `.txt`, `.rst`. Preserve
   the relative path under the docs dir.
5. `resolvedVersion` is the tag (strip a leading `v`) or the branch's commit sha — when
   you only have the branch, use the branch name.

### npm
1. `bun pm view <name>@<version> dist.tarball version` (or the equivalent `npm view`).
   Use the printed `dist.tarball` URL and the printed exact `version` as `resolvedVersion`.
2. Download with `curl -L`, extract.
3. Same docs-folder discovery as github (`docs/`, `doc/`, ...).
4. Same extension filter (`.md`, `.mdx`, `.txt`, `.rst`).

### web
1. Start from the user-supplied `url`(s). Use WebFetch to retrieve each page as Markdown.
2. Follow same-origin links up to `maxDepth` (default `1`). Respect `pathPrefix` if given.
3. Skip assets (`.png`, `.jpg`, `.css`, `.js`, `.woff*`) and auth-ish paths
   (`/api`, `/auth`, `/login`, `/signup`, `/search`).
4. Derive each output filename from the URL path (`/docs/guide.html` → `docs/guide.md`).
5. `resolvedVersion` falls back to today's date (`YYYY-MM-DD`) when the source has no
   version concept.

### llms-txt
1. WebFetch the single URL.
2. Save as one file; derive the filename from the URL path, ensuring a `.md` or `.txt`
   extension.
3. `resolvedVersion`: today's date if not otherwise known.

If a fetch yields **zero files**, stop and report. Don't write an empty docs directory.

## Step 5 — Save to `.ask/docs/`

Target directory: `.ask/docs/<name>@<resolvedVersion>/`

1. If the directory already exists, **delete it first** so a stale partial fetch can't
   linger. This is the same behavior as the CLI's `storage.ts`.
2. Create the directory and write each file, preserving subdirectories.
3. Generate `INDEX.md` listing every file as a relative Markdown link, sorted by path.
   Example:
   ```markdown
   # <name> v<resolvedVersion> — Documentation Index

   - [README.md](./README.md)
   - [guide/getting-started.md](./guide/getting-started.md)
   ```

## Step 6 — Update `.ask/config.json`

Read the file (create `{ "docs": [] }` if missing). The `docs` array stores entries that
`sync-docs` later replays. Each entry is the `SourceConfig` you used in Step 4:

```json
{
  "docs": [
    {
      "name": "zod",
      "version": "3.22.4",
      "source": "github",
      "repo": "colinhacks/zod",
      "tag": "v3.22.4",
      "docsPath": "docs"
    }
  ]
}
```

If an entry with the same `name` already exists, **replace it** (not append). Match on
name only — version changes should overwrite, not duplicate. Write the file back as
pretty-printed JSON (2-space indent) with a trailing newline.

## Step 6.5 — Record the fetch in `.ask/ask.lock`

`config.json` is **intent** ("track this library"); `ask.lock` is **fact** ("here is
exactly what we last downloaded"). The lock is what makes drift detection in `sync-docs`
reliable, especially when the user tracks `latest` instead of a pinned version.

Read `.ask/ask.lock` (create with `{ "lockfileVersion": 1, "entries": {} }` if missing),
then upsert the entry for this library by name:

```json
{
  "lockfileVersion": 1,
  "generatedAt": "<ISO-8601 timestamp>",
  "entries": {
    "<name>": {
      "version": "<resolvedVersion>",
      "source": "<github|npm|web|llms-txt>",
      "repo": "<owner/repo>",          // github only
      "ref": "<tag-or-branch>",         // github only
      "commit": "<full-sha>",           // github only, when known
      "tarball": "<url>",               // npm only
      "integrity": "<sha512-...>",      // npm only, from `dist.integrity`
      "url": "<url>",                   // web/llms-txt only
      "fetchedAt": "<ISO-8601 timestamp>",
      "fileCount": <number>,
      "contentHash": "sha256-<hex>"
    }
  }
}
```

`contentHash` is computed by sorting the saved files by relative path, concatenating
`<relpath>\0<bytes>\0` for each, and taking SHA-256 of the whole stream. This makes any
file addition, removal, rename, or content change visible without listing the tree.

For `github`, capture the commit sha by checking the `Location` header of
`https://github.com/<repo>/archive/refs/{tags|heads}/<ref>.tar.gz` (it redirects to a
URL containing the sha) or by hitting
`https://api.github.com/repos/<repo>/commits/<ref>`. If neither works, omit `commit`
rather than guessing.

For `npm`, pull `dist.integrity` from the same `bun pm view` / `npm view` call you
already made in Step 4.

Update `generatedAt` at the top of the file. Write back as pretty JSON.

**Lock is committed.** It plays the same role for ASK that `bun.lock` plays for bun:
the source of truth for "what's actually installed".

## Step 7 — Update `AGENTS.md`

`AGENTS.md` is the file AI agents read first. ASK manages a single auto-generated block
inside it, fenced by HTML comment markers:

```
<!-- BEGIN:ask-docs-auto-generated -->
...managed content...
<!-- END:ask-docs-auto-generated -->
```

**Read `AGENTS.md` first** (if it exists) and decide:

- **File missing**: create it with just the marker block.
- **Markers present**: replace everything **between** the markers, leaving the markers
  themselves and all surrounding content untouched.
- **File exists, no markers**: append the marker block at the end with one blank line
  before it.

The block content lists **every entry currently in `.ask/config.json`** (not just the
one you added — this keeps the block coherent after multiple `add-docs` calls). Use this
template:

```markdown
<!-- BEGIN:ask-docs-auto-generated -->
# Documentation References

The libraries in this project may have APIs and patterns that differ from your training
data. **Always read the relevant documentation before writing code.**

## <name> v<version>

> **WARNING:** This version may differ from your training data.
> Read the docs in `.ask/docs/<name>@<version>/` before writing any <name>-related code.
> Heed deprecation notices and breaking changes.

- **Version**: `<version>` — use `"^<major>"` in package.json (NOT older major versions)
- Documentation: `.ask/docs/<name>@<version>/`
- Index: `.ask/docs/<name>@<version>/INDEX.md`

[... repeat per library, in the order they appear in config.json ...]
<!-- END:ask-docs-auto-generated -->
```

The "use `^<major>`" line only makes sense for npm — omit it for non-npm ecosystems.

**Critical guardrail**: never touch content outside the markers. Users keep their own
notes there.

## Step 8 — Ensure `CLAUDE.md` references `AGENTS.md`

Read `CLAUDE.md` (create it if missing). If it does not already contain a line that is
exactly `@AGENTS.md` (or starts with `@AGENTS.md` followed by whitespace), append one.
Do not write anything else into `CLAUDE.md` — the canonical content lives in `AGENTS.md`.

---

## Guardrails (apply to every step)

- **Always Read before Write.** Inspect existing `.ask/config.json`, `AGENTS.md`,
  `CLAUDE.md`, and the target docs directory before changing them.
- **Never invent versions.** If a source returns no version, propagate that and either
  use `latest` or the date stamp. Don't guess.
- **Never invent repo URLs.** If Step 3a fails to find a real source, stop and ask.
- **Marker block is sacred.** Content outside `<!-- BEGIN:... -->` / `<!-- END:... -->`
  is owned by the user.
- **Honor explicit user overrides.** If the user pins `--source github --repo foo/bar`,
  skip the registry and the fallback chain entirely.
- **Failure must be loud.** Stop and report instead of writing partial state.

## Verification checklist

After completing the pipeline for a library, confirm:

- [ ] `.ask/docs/<name>@<version>/` exists and contains at least one doc file
- [ ] `.ask/docs/<name>@<version>/INDEX.md` exists and links every file
- [ ] `.ask/config.json` has exactly one entry for `<name>` with the new version
- [ ] `.ask/ask.lock` `entries.<name>` matches the version, source, fileCount, and contentHash you just wrote
- [ ] `AGENTS.md` contains the marker block, and the block lists `<name> v<version>`
- [ ] `CLAUDE.md` contains a `@AGENTS.md` line
- [ ] Nothing outside the marker block in `AGENTS.md` was modified

If any item fails, fix it before reporting success.
