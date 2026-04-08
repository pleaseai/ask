# Recovery — when `ask docs add` fails

> Read this **only** when the CLI exited non-zero. The happy path in
> [`../SKILL.md`](../SKILL.md) covers the 95% case where the upfront
> planning in Step 3 picks the correct spec on the first try.

The CLI is **deterministic**: it executes one spec and either succeeds or
exits non-zero with a clear error. It does **not** automatically fall back
between sources. When it fails, the recovery decision is **your job** as
the LLM driving `add-docs` — read the error, decide which alternative is
viable, and re-invoke the CLI with a different spec.

## Hard limits

- **At most 1 retry per CLI invocation.** If the second attempt also
  fails, report both errors verbatim and stop. Do not chain a third try.
- **Never silently change the user's intent.** If the user said
  `next@14.2.0`, the recovery retry must keep the version constraint
  (`vercel/next.js@v14.2.0`). Do not drop or relax it.
- **Always tell the user which path you took.** A one-line summary like
  "npm tarball had no docs, retried via `vercel/next.js` — succeeded" is
  the minimum acceptable verification trail.

## Error classification

When the CLI exits non-zero, classify the error message and act:

| Error pattern | Cause | Action |
|---|---|---|
| `No docs found in <spec>` | npm tarball missing curated docs dir | Find GitHub repo → retry as `<owner>/<repo>` |
| `Docs path "<x>" not found in <spec>` | Wrong `docsPath` in registry/strategy | Same: find repo → retry |
| `not found in registry` / `no resolver for` | Unknown ecosystem name | Find repo → retry |
| `Ambiguous spec '<x>'` (Gate A) | You sent a bare name | Add ecosystem prefix or `owner/repo` and retry — this is a skill bug, not CLI failure |
| `--from-manifest was set but no … manifest entry` | Package not in lockfile | Ask user: install first, or use a different source? |
| Network / DNS / fetch failure | Transient or environment issue | Report verbatim, do **not** retry — second attempt will fail the same way |
| Anything else | Unknown | Report verbatim, do not invent a fix |

## Resource ladder for finding `<owner>/<repo>`

When the action above is "find GitHub repo", try in this order, stopping
as soon as you have a confident answer. Use only resources that exist in
every Claude Code environment — do **not** assume MCP servers
(deepwiki, context_grep, context7, etc.) are installed.

1. **Training knowledge** — Free, instant. Well-known packages
   (`react` → `facebook/react`, `next` → `vercel/next.js`,
   `zod` → `colinhacks/zod`) are already in your training data. Use it
   and skip the rest.

2. **`Read node_modules/<pkg>/package.json`** — Free, disk only.
   Authoritative when the package is installed:
   - `repository: "git+https://github.com/owner/repo.git"` → extract
     `owner/repo`.
   - `repository: { "type": "git", "url": "..." }` → extract from `url`.
   - Strip `git+`, trailing `.git`, leading `https://github.com/` or
     `git@github.com:`.
   - Only accept GitHub URLs. The CLI's github source does not handle
     GitLab / Bitbucket / Codeberg.

3. **`WebFetch https://registry.npmjs.org/<pkg>`** — 1 HTTP call. Returns
   the same `repository` field as step 2 but works when the package is
   not installed locally. Use only when step 2 is not viable and step 1
   was not confident.

4. **`WebSearch "<pkg> npm github repository"`** — 1 search. For
   long-tail or newly published libraries. Trust only a result that
   links to a `github.com/<owner>/<repo>` URL on the first page **and**
   matches the npm package name exactly.

5. **`AskUserQuestion`** — Last resort. Present what you found (or what
   you ruled out) and ask the user to confirm or supply the repo
   directly.

## Worked examples

### Example A — npm tarball missing dist/docs

```
$ bunx @pleaseai/ask docs add npm:foo
…
✖ No docs found in foo@1.2.3. Specify --docs-path …
```

1. Read `node_modules/foo/package.json` → `repository.url = "git+https://github.com/acme/foo.git"`.
2. Extract: `acme/foo`.
3. Retry: `bunx @pleaseai/ask docs add acme/foo`.
4. Report: "npm tarball had no curated docs dir, retried via `acme/foo` — succeeded."

### Example B — package not installed, training knowledge has the repo

```
$ bunx @pleaseai/ask docs add npm:react
…
✖ No docs found in react@19.0.0. Specify --docs-path …
```

1. Training knowledge: `react` → `facebook/react`. High confidence.
2. Skip steps 2–5.
3. Retry: `bunx @pleaseai/ask docs add facebook/react@v19.0.0` (preserve user's resolved version).
4. Report.

### Example C — network error (do not retry)

```
$ bunx @pleaseai/ask docs add npm:foo
…
✖ fetch failed: ETIMEDOUT https://registry.npmjs.org/foo
```

1. Classify: network failure.
2. Do **not** retry.
3. Report verbatim and stop. Suggest the user check their network or
   proxy settings.
