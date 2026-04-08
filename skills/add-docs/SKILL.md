---
name: add-docs
description: >
  Download a single library's documentation via the `@pleaseai/ask` CLI and
  wire it into the project so AI agents can read accurate, version-specific
  docs instead of relying on training data. Interprets natural-language
  requests, detects the project ecosystem, auto-detects the installed version
  from the project lockfile (bun.lock / package-lock.json / pnpm-lock.yaml /
  yarn.lock / package.json), assembles a CLI spec, and runs
  `bunx @pleaseai/ask docs add <spec>`. MUST use this skill whenever the user
  asks to add docs for a specific library (e.g. "zod 문서 추가", "add docs for
  next@canary", "ask docs add ..."), introduces a new dependency, or upgrades
  a single package and wants its docs refreshed. Trigger on: "문서 추가",
  "docs 추가", "add docs", "ask docs add", "fetch docs for", "라이브러리 문서
  받아", "auto-detect from lockfile", "use installed version", and any mention
  of pulling a single library's documentation into the project.
---

# add-docs — Add a Single Library's Documentation (CLI-driven)

Call the `@pleaseai/ask` CLI to download docs for one library and register
them so AI agents (Claude Code, Cursor, etc.) can read them via `AGENTS.md`.
The CLI is the **source of truth** for this pipeline — your job is to turn a
natural-language request into a well-formed CLI spec and run the command.

## When to use this skill

- The user names a library (with or without version) and asks to fetch its docs.
- A new dependency was just added and you want its docs available before writing code.
- A single package was upgraded and its docs need to be refreshed.

For batch initial setup of every dependency, use `setup-docs` instead.
For drift detection after lockfile changes, use `sync-docs`.

## Happy path (5 steps)

### Step 1 — Parse the user's intent into a name (and optional version)

Pull the library name out of the request. If the user mentioned an explicit
version (`next@15.0.3`, `zod 3.22`), remember it. Otherwise leave the version
blank — the CLI will resolve it from the project manifest.

### Step 2 — Detect the ecosystem

Inspect the project root for the first marker file that exists:

| File | Ecosystem prefix |
|---|---|
| `package.json` | `npm` |
| `pubspec.yaml` | `pub` |
| `pyproject.toml` / `requirements.txt` | `pypi` |
| `go.mod` | `go` |
| `Cargo.toml` | `crates` |
| `mix.exs` | `hex` |
| `pom.xml` / `build.gradle` / `build.gradle.kts` | `maven` |

If none match, default to `npm`. The user can always override with an
explicit prefix in their request.

> The CLI **rejects bare-name specs** (`ask docs add next` → exit 1). You
> MUST always build an `<ecosystem>:<name>` or `<owner>/<repo>` spec before
> invoking it.

### Step 3 — Pick npm vs GitHub (decision tree)

**Default to npm whenever there is evidence the package is actually
installed in the project.** The CLI's npm source short-circuits to
`node_modules/<name>/<docsPath>` when the local install matches the
requested version, so this is faster, offline-friendly, and version-pinned.
Only fall back to GitHub when there is no manifest evidence.

Decision order:

1. **Manifest hit → use the ecosystem prefix.**
   The package appears in the project's manifest or lockfile (any of:
   `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`,
   `package.json` `dependencies` / `devDependencies`, or the equivalent
   for the detected ecosystem). Build the spec as
   `<ecosystem>:<name>[@<version>]`. Without an explicit version, the CLI
   will read the installed version from the lockfile and then NpmSource
   will satisfy the fetch from `node_modules` with no network call when
   possible.

2. **No manifest hit, user named a known repo → use GitHub shorthand.**
   The package is not installed (e.g. the user is exploring a library
   they have not yet added) but the user mentioned an `owner/repo` form
   or you can resolve it confidently from prior knowledge. Build the
   spec as `<owner>/<repo>[@<ref>]`.

3. **No manifest hit and no known repo → ask.**
   Do not guess. Ask the user whether they want to install the package
   first (so the npm path opens up) or whether they have an
   `owner/repo` to use directly.

> Why npm-first when installed? The CLI's NpmSource reads
> `node_modules/<pkg>/dist/docs` (or whichever `docsPath` the registry
> entry declares) directly when the installed version matches. Curated
> libraries like `ai`, `@mastra/core`, `@mastra/memory`, and `next`
> (canary) ship author-curated agent docs there, and the local read
> avoids both an HTTP call and a tarball extraction.

Examples:

- `package.json` lists `next` → `npm:next` (CLI auto-detects version from
  lockfile, and short-circuits to `node_modules/next/dist/docs` when
  installed).
- `package.json` lists `@mastra/core` at `0.5.2` → `npm:@mastra/core` (same).
- `pyproject.toml` lists `fastapi` → `pypi:fastapi`.
- User says "add docs for vercel/next.js@canary" and the project is not a
  Node project at all → `vercel/next.js@canary` (GitHub shorthand).
- User says "add docs for next" but `next` is not in `package.json` and the
  project has no `node_modules/next` → ask whether they want to add the
  package first or whether they meant `vercel/next.js`.

### Step 4 — Run the CLI

```bash
bunx @pleaseai/ask docs add <spec>
```

Flags to know (use sparingly — defaults are correct for the common case):

- `--no-manifest` — skip the lockfile/manifest lookup and fetch the ecosystem
  `latest` tag instead. Use when the user explicitly wants the newest release.
- `--from-manifest` — require the manifest to supply the version; the CLI
  errors out if no lockfile/manifest entry exists. Use when you want to fail
  loudly rather than silently falling back to `latest`.
- `--source <type>` + `--repo`/`--url`/`--docsPath` — explicit source override
  (github / npm / web / llms-txt). Only needed when the registry + resolvers
  can't find the library.

The CLI handles every downstream step: registry lookup, ecosystem resolver
fallback, source fetch, `.ask/docs/` write, `.ask/config.json` upsert,
`.ask/ask.lock` upsert, `.claude/skills/<name>-docs/SKILL.md` generation, and
`AGENTS.md` marker-block regeneration. You do not need to do any of that work
yourself when the CLI runs successfully.

### Step 5 — Verify the result

After the command exits 0, confirm on disk:

- [ ] `.ask/docs/<name>@<version>/` exists and has at least one `.md` (or similar) file
- [ ] `.ask/docs/<name>@<version>/INDEX.md` exists
- [ ] `.ask/config.json` has an entry for `<name>` with the new version
- [ ] `.ask/ask.lock` has an `entries.<name>` block matching the version
- [ ] `AGENTS.md` contains `<!-- BEGIN:ask-docs-auto-generated -->` and the
      block lists `<name> v<version>`
- [ ] `CLAUDE.md` has a `@AGENTS.md` line (append one if missing)

If any check fails, stop and report — do not paper over partial state.

## Recovery — when the CLI command fails

The CLI is deterministic: it executes one spec and either succeeds or
exits non-zero. It does not auto-fallback between sources. With proper
upfront planning in Step 3, recovery is rare — when it does happen, see
[`references/recovery.md`](./references/recovery.md) for the error
classification table, the resource ladder for finding `<owner>/<repo>`,
and the retry rules (at most 1 retry, preserve user intent, report path
taken).

## Guardrails

- **Never invent a spec.** If you cannot determine a name + ecosystem with
  confidence, ask the user rather than guess.
- **Never invent repo URLs** when passing `--source github --repo ...` as an
  override.
- **Honor explicit user pins.** If the user said `next@14.2.0`, use that
  version verbatim — do not let the manifest lookup override an explicit ask.
- **Marker block is sacred.** The CLI owns the content between
  `<!-- BEGIN:ask-docs-auto-generated -->` and `<!-- END:... -->`. Do not
  edit it by hand.

## Fallback — when the CLI cannot be used

If `bunx @pleaseai/ask docs add ...` fails for a reason you cannot fix
(no network access to npmjs.org for the CLI download, `bunx` not installed,
sandboxed CI without package manager access), read
[`references/inline-pipeline.md`](./references/inline-pipeline.md) and execute
the pipeline manually. That document mirrors the CLI flow step-by-step and
lists the authoritative CLI source file for each step.

The inline pipeline may drift from the CLI — always prefer the CLI when it
is available.
