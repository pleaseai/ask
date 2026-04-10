---
name: add-docs
description: >
  Add a single library's documentation entry to `ask.json` via the
  `@pleaseai/ask` CLI and run `ask install` so AI agents can read accurate,
  version-specific docs instead of relying on training data. Interprets
  natural-language requests, detects the project ecosystem, and runs
  `bunx @pleaseai/ask add <spec>`. The version comes from the project
  lockfile (bun.lock / package-lock.json / pnpm-lock.yaml / yarn.lock /
  package.json) at install time, NOT from this skill. MUST use this skill
  whenever the user asks to add docs for a specific library (e.g. "zod 문서
  추가", "add docs for next", "ask add ..."), introduces a new dependency,
  or upgrades a single package and wants its docs refreshed. Trigger on:
  "문서 추가", "docs 추가", "add docs", "ask add", "fetch docs for",
  "라이브러리 문서 받아", and any mention of pulling a single library's
  documentation into the project.
---

# add-docs — Add a Single Library's Documentation (CLI-driven)

Call the `@pleaseai/ask` CLI to declare a library in `ask.json` and
materialize its docs so AI agents (Claude Code, Cursor, etc.) can read
them via `AGENTS.md`. The CLI is the **source of truth** for this
pipeline — your job is to turn a natural-language request into a
well-formed CLI spec and run the command.

## When to use this skill

- The user names a library and asks to fetch its docs.
- A new dependency was just added and you want its docs available before writing code.
- A single package was upgraded and its docs need to be refreshed (re-run `ask install`).

For batch initial setup of every dependency, use `setup-docs` instead.
For drift detection after lockfile changes, use `sync-docs`.

## Happy path (5 steps)

### Step 1 — Parse the user's intent into a name

Pull the library name out of the request. Versions in the request are
**informational only** for PM-driven entries — the CLI takes the version
from the project's lockfile at install time, not from the spec string.
For standalone github entries the user MUST provide an explicit `--ref`.

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

> The CLI **rejects bare-name specs** (`ask add next` → exit 1). You
> MUST always build an `<ecosystem>:<name>` or `github:<owner>/<repo>`
> spec before invoking it. Note: only `npm:` is wired to a lockfile
> reader in the first phase — other ecosystems will warn-and-skip at
> install time until follow-up tracks land.

### Step 3 — Pick PM-driven (npm) vs standalone github (decision tree)

**Default to a PM-driven `npm:` entry whenever the package is actually
listed in the project's manifest.** The install orchestrator's npm
source short-circuits to `node_modules/<name>/<docsPath>` when the
local install matches the lockfile-resolved version, so this is faster,
offline-friendly, and version-pinned. Only fall back to a standalone
github entry when there is no manifest evidence.

Decision order:

1. **Manifest hit → use the npm prefix.**
   The package appears in `package.json` `dependencies` /
   `devDependencies` (or any of `bun.lock` / `package-lock.json` /
   `pnpm-lock.yaml` / `yarn.lock`). Build the spec as `npm:<name>`.
   `ask install` will read the version from the lockfile and
   `NpmSource` will satisfy the fetch from `node_modules` when
   possible.

2. **No manifest hit, user named a known repo → use a standalone github entry.**
   The package is not installed (e.g. the user is exploring a library
   they have not yet added) but the user mentioned an `owner/repo` form
   or you can resolve it confidently. Build the spec as
   `github:<owner>/<repo>` and pass `--ref <tag-or-branch>`. `--ref`
   is required — there is no default.

3. **No manifest hit and no known repo → ask.**
   Do not guess. Ask the user whether they want to install the package
   first (so the npm path opens up) or whether they have an
   `owner/repo` + `ref` to use directly.

> Why npm-first when installed? `NpmSource` reads
> `node_modules/<pkg>/dist/docs` (or whichever `docsPath` the registry
> entry declares) directly when the installed version matches. Curated
> libraries like `ai`, `@mastra/core`, `@mastra/memory`, and `next`
> ship author-curated agent docs there, and the local read avoids both
> an HTTP call and a tarball extraction.

Examples:

- `package.json` lists `next` → `bunx @pleaseai/ask add npm:next`
- `package.json` lists `@mastra/core` → `bunx @pleaseai/ask add npm:@mastra/core`
- User says "add docs for vercel/next.js v14.2.3" and the project is not a
  Node project at all → `bunx @pleaseai/ask add github:vercel/next.js --ref v14.2.3 --docs-path docs`
- User says "add docs for next" but `next` is not in `package.json` and the
  project has no `node_modules/next` → ask whether they want to add the
  package first or whether they meant `vercel/next.js` with a specific ref.

### Step 4 — Run the CLI

```bash
bunx @pleaseai/ask add <spec> [--ref <git-ref>] [--docs-path <path>]
```

Flags to know:

- `--ref <ref>` — **required** for `github:` specs (tag, branch, or sha).
- `--docs-path <path>` — override the directory inside the package/repo
  that contains the docs. Optional for `npm:` (the registry usually has
  it); recommended for `github:` standalone entries.

`ask add` appends the entry to `ask.json` (or replaces an existing
entry with the same spec) and immediately runs `ask install` for that
single entry. The orchestrator handles every downstream step:
lockfile resolution, registry lookup, source fetch, `.ask/docs/`
write, `.ask/resolved.json` upsert,
`.claude/skills/<name>-docs/SKILL.md` generation, and `AGENTS.md`
marker-block regeneration.

### Step 5 — Verify the result

After the command exits 0, confirm on disk:

- [ ] `ask.json` has an entry whose `spec` matches what you passed
- [ ] `.ask/docs/<name>@<version>/` exists and has at least one `.md` (or similar) file
- [ ] `.ask/docs/<name>@<version>/INDEX.md` exists
- [ ] `.ask/resolved.json` has an `entries.<name>` block with the matching version
- [ ] `AGENTS.md` contains `<!-- BEGIN:ask-docs-auto-generated -->` and the
      block lists `<name> v<version>`
- [ ] `CLAUDE.md` has a `@AGENTS.md` line (append one if missing)

If any check fails, stop and report — do not paper over partial state.
Note: `ask install` is `postinstall`-friendly and exits 0 even when
individual entries fail, so check the warning lines in stderr if a
spec did not materialize.

## Recovery — when the CLI command fails

The CLI is deterministic: it executes one spec and either succeeds or
warns-and-skips. With proper upfront planning in Step 3, recovery is
rare — when it does happen, see
[`references/recovery.md`](./references/recovery.md) for the error
classification table, the resource ladder for finding `<owner>/<repo>`,
and the retry rules (at most 1 retry, preserve user intent, report path
taken).

## Guardrails

- **Never invent a spec.** If you cannot determine a name + ecosystem with
  confidence, ask the user rather than guess.
- **Never invent repo URLs or refs.** `--ref` must be a real tag/branch
  the user told you about or that you verified.
- **Honor explicit user pins.** If the user said `next 14.2.0`, make sure
  the project's lockfile has that exact version before running — do not
  paper over a mismatch.
- **Marker block is sacred.** The CLI owns the content between
  `<!-- BEGIN:ask-docs-auto-generated -->` and `<!-- END:... -->`. Do not
  edit it by hand.

## Fallback — when the CLI cannot be used

If `bunx @pleaseai/ask add ...` fails for a reason you cannot fix
(no network access for the CLI download, `bunx` not installed,
sandboxed CI without package manager access), read
[`references/inline-pipeline.md`](./references/inline-pipeline.md) and execute
the pipeline manually. That document mirrors the CLI flow step-by-step.

The inline pipeline may drift from the CLI — always prefer the CLI when it
is available.
