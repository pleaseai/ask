# Inline Pipeline — Fallback for add-docs

> ⚠️  **FALLBACK ONLY.** The CLI (`bunx @pleaseai/ask docs add`) is the
> primary path and the source of truth. This document mirrors that pipeline
> for environments where the CLI cannot be used (no network access to fetch
> the package, sandboxed CI without `bunx`, etc.). It may drift from the CLI —
> always prefer the CLI when it is available.

Use this document **only** if you have already tried the CLI and it failed
for a reason you cannot work around (e.g. `bunx: command not found`, network
blocked to npmjs.org for the CLI download, but still usable for tarballs).

Each step below ends with a `<!-- CLI equivalent -->` comment pointing at the
authoritative implementation in `packages/cli/src/`.

---

## Step 1 — Parse the spec

Split off the optional ecosystem prefix at the first `:`. Whatever's left is `name[@version]`.
Take the **last** `@` as the version separator (so scoped npm names like `@scope/pkg@1.2`
still parse correctly). If no version is given, treat it as `latest` and let the source
report the resolved version.

<!-- CLI equivalent: packages/cli/src/registry.ts:parseDocSpec -->

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
| `pom.xml`, `build.gradle`, or `build.gradle.kts` | `maven` |

If none match, default to `npm`. The user can always override by using an explicit prefix.

<!-- CLI equivalent: packages/cli/src/registry.ts:detectEcosystem -->

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

<!-- CLI equivalent: packages/cli/src/registry.ts:resolveFromRegistry + selectBestStrategy -->

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

<!-- CLI equivalent: packages/cli/src/resolvers/{npm,pypi,pub}.ts -->

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

<!-- CLI equivalent: packages/cli/src/sources/{github,npm,web,llms-txt}.ts -->

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

<!-- CLI equivalent: packages/cli/src/storage.ts:saveDocs -->

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

<!-- CLI equivalent: packages/cli/src/config.ts:addDocEntry -->

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
      "repo": "<owner/repo>",
      "ref": "<tag-or-branch>",
      "commit": "<full-sha>",
      "tarball": "<url>",
      "integrity": "<sha512-...>",
      "url": "<url>",
      "fetchedAt": "<ISO-8601 timestamp>",
      "fileCount": <number>,
      "contentHash": "sha256-<hex>"
    }
  }
}
```

`contentHash` is computed by sorting the saved files by relative path, concatenating
`<relpath>\0<bytes>\0` for each, and taking SHA-256 of the whole stream.

<!-- CLI equivalent: packages/cli/src/io.ts:upsertLockEntry + contentHash -->

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
one you added). Use this template per library:

```markdown
## <name> v<version>

> **WARNING:** This version may differ from your training data.
> Read the docs in `.ask/docs/<name>@<version>/` before writing any <name>-related code.

- **Version**: `<version>`
- Documentation: `.ask/docs/<name>@<version>/`
- Index: `.ask/docs/<name>@<version>/INDEX.md`
```

**Critical guardrail**: never touch content outside the markers. Users keep their own
notes there.

<!-- CLI equivalent: packages/cli/src/agents.ts:generateAgentsMd -->

## Step 8 — Ensure `CLAUDE.md` references `AGENTS.md`

Read `CLAUDE.md` (create it if missing). If it does not already contain a line that is
exactly `@AGENTS.md` (or starts with `@AGENTS.md` followed by whitespace), append one.
Do not write anything else into `CLAUDE.md` — the canonical content lives in `AGENTS.md`.

<!-- CLI equivalent: packages/cli/src/agents.ts (CLAUDE.md reference ensured via generateAgentsMd flow) -->
