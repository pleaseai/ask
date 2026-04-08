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

The CLI is **deterministic**: it executes one spec and either succeeds or
exits non-zero with a clear error. It does **not** automatically fall back
between sources. When `bunx @pleaseai/ask docs add <spec>` fails, the
recovery decision is **your job** as the LLM driving this skill — read the
error, decide which alternative is viable, and re-invoke the CLI with a
different spec.

This recovery loop applies, for example, when the user said "add docs for
foo", you tried `npm:foo` because `foo` is in `package.json`, and the npm
tarball did not actually ship a `dist/docs` directory — the CLI errors out
and you need to retry with the GitHub repo.

### Recovery resources (always available)

You may use only resources that exist in every Claude Code environment.
Do **not** assume MCP servers (deepwiki, context_grep, context7, etc.) are
installed.

| Resource | Cost | Use for |
|---|---|---|
| **Training knowledge** | free | Well-known repos (`react`→`facebook/react`, `next`→`vercel/next.js`, `zod`→`colinhacks/zod`). |
| **Read** `node_modules/<pkg>/package.json` | free, disk only | The `repository.url` field — the most authoritative source when the package is installed. |
| **WebFetch** `https://registry.npmjs.org/<pkg>` | 1 HTTP call | Same `repository.url` field, when the package is not installed locally. |
| **WebSearch** `<pkg> github repository` | 1 search | Long-tail or newly published libraries. Verify the result before using it. |
| **AskUserQuestion** | user time | Last resort when everything above is ambiguous or contradictory. |

### Recovery decision tree

When the CLI exits non-zero, classify the error and act accordingly:

1. **Error mentions "No docs found in <spec>" or "Docs path \"<x>\" not
   found in <spec>"** (npm tarball is missing the curated docs directory):
   - This is the case where the curated `dist/docs` did not actually ship.
   - Find the GitHub repo using the resource ladder below, then retry with
     the GitHub shorthand: `bunx @pleaseai/ask docs add <owner>/<repo>`.

2. **Error mentions "not found in registry" or "no resolver for"**:
   - The bare ecosystem prefix did not resolve. The user likely needs an
     `<owner>/<repo>` form. Find the repo and retry as in case 1.

3. **Error mentions network / DNS / fetch failure**:
   - Do **not** retry blindly — the second attempt will fail the same way.
     Report the failure to the user verbatim and stop.

4. **Error mentions "Ambiguous spec" (Gate A)**:
   - You sent a bare name. Add the ecosystem prefix or `owner/repo` form
     and retry. This is a skill bug, not a CLI bug — fix your spec.

5. **Error mentions "--from-manifest was set but no … manifest entry"**:
   - The package is genuinely not in the project's lockfile. Ask the user
     whether they want to install it first or use a different source.

6. **Any other error**:
   - Report verbatim to the user. Do not invent a fix.

### Resource ladder for finding `<owner>/<repo>` (cheapest first)

Try in this order, stopping as soon as you have a confident answer:

1. **Training knowledge** — If the package is well-known (top-1k npm,
   widely cited in your training data), you already know the repo. Use it.
   Skip the rest.

2. **`node_modules/<pkg>/package.json`** — Read the file directly. Look at
   the `repository` field:
   - If it is a string like `git+https://github.com/owner/repo.git`,
     extract `owner/repo`.
   - If it is an object `{ "type": "git", "url": "..." }`, extract from `url`.
   - Strip `git+`, `.git`, leading `https://github.com/` / `git@github.com:`.
   - Only accept GitHub URLs — reject GitLab / Bitbucket / Codeberg for
     this skill (the CLI's github source only handles GitHub).

3. **WebFetch the npm registry metadata** — `https://registry.npmjs.org/<pkg>`
   returns JSON with the same `repository` field. Use only when step 2 is
   not viable (package not installed) and step 1 was not confident.

4. **WebSearch** — Query `<pkg> npm github repository`. Only trust a
   result that links to a `github.com/<owner>/<repo>` URL on the first
   page and matches the npm package name.

5. **AskUserQuestion** — Present what you found and ask for confirmation,
   or ask for the repo directly when nothing above worked.

### Recovery loop limits

- **At most 1 retry per CLI invocation.** If the GitHub retry also fails,
  report both errors to the user. Do not chain a third attempt.
- **Never silently change the user's intent.** If the user said
  `next@14.2.0`, the recovery retry must keep the version constraint
  (`vercel/next.js@v14.2.0`) — do not drop it.
- **Always tell the user which path you took.** "npm tarball had no docs,
  retried via vercel/next.js — succeeded" is the minimum acceptable
  summary so the user can verify the source.

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
