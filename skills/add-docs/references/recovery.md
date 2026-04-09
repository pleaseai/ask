# Recovery — when `ask add` / `ask install` fails

> Read this **only** when the CLI exited non-zero or warn-and-skipped a
> single entry. The happy path in [`../SKILL.md`](../SKILL.md) covers
> the 95% case where the upfront planning in Step 3 picks the correct
> spec on the first try.

`ask install` is `postinstall`-friendly: per-entry failures emit a
warning on stderr and the command exits 0. After a run, scan stderr
for `[warn] <spec>: …` lines to see what was skipped. The recovery
decision is **your job** as the LLM driving `add-docs` — read the
warning, decide which alternative is viable, and re-invoke `ask add`
with a different spec.

## Hard limits

- **At most 1 retry per entry.** If the second attempt also fails,
  report both errors verbatim and stop. Do not chain a third try.
- **Never silently change the user's intent.** If the user said
  `next 14.2.0`, the recovery retry must keep the version constraint
  (`github:vercel/next.js --ref v14.2.0`). Do not drop or relax it.
- **Always tell the user which path you took.** A one-line summary like
  "npm tarball had no docs, retried as `github:vercel/next.js --ref v14.2.0` — succeeded"
  is the minimum acceptable verification trail.

## Error classification

When `ask install` warns or `ask add` exits non-zero, classify the
message and act:

| Warning / error pattern | Cause | Action |
|---|---|---|
| `not found in any lockfile` | PM-driven `npm:` entry but the package is not in `bun.lock` / `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `package.json` | Ask user to install the package first, OR retry as a standalone `github:owner/repo --ref <ref>` entry |
| `No docs found in <spec>` | npm tarball missing curated docs dir | Find GitHub repo → retry as `github:owner/repo --ref <ref> --docs-path <path>` |
| `Docs path "<x>" not found in <spec>` | Wrong `docsPath` for the registry strategy | Same: find repo → retry with explicit `--docs-path` |
| `not found in registry` | Unknown library, not in the ASK Registry | Find repo → retry as `github:owner/repo --ref <ref>` |
| `Ambiguous spec '<x>'` | You sent a bare name | Add ecosystem prefix or `github:owner/repo` and retry — this is a skill bug, not CLI failure |
| `github specs require --ref` | Forgot `--ref` for a `github:` spec | Re-run with `--ref <tag-or-branch>` |
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
   you ruled out) and ask the user to confirm or supply the repo + ref
   directly.

## Worked examples

### Example A — npm package not in lockfile

```
$ bunx @pleaseai/ask add npm:foo
…
[warn]   npm:foo: not found in any lockfile (bun.lock / package-lock.json / pnpm-lock.yaml / yarn.lock / package.json) — skipping
```

1. Read `node_modules/foo/package.json` (if installed) → `repository.url = "git+https://github.com/acme/foo.git"`.
2. Extract: `acme/foo`.
3. Pick a release tag from npm or `node_modules/foo/package.json` → `v1.2.3`.
4. Retry: `bunx @pleaseai/ask add github:acme/foo --ref v1.2.3 --docs-path docs`.
5. Report: "npm:foo was not in the lockfile, retried as `github:acme/foo --ref v1.2.3` — succeeded."

### Example B — package installed but tarball has no docs dir

```
$ bunx @pleaseai/ask add npm:bar
…
[warn]   npm:bar: No docs found in bar@2.0.0. Specify --docs-path … — skipping
```

1. Training knowledge or `node_modules/bar/package.json`: `bar` → `acme/bar`.
2. Retry: `bunx @pleaseai/ask add github:acme/bar --ref v2.0.0 --docs-path docs`.
3. Report.

### Example C — network error (do not retry)

```
$ bunx @pleaseai/ask add npm:foo
…
[warn]   npm:foo: fetch failed: ETIMEDOUT https://registry.npmjs.org/foo — skipping
```

1. Classify: network failure.
2. Do **not** retry.
3. Report verbatim and stop. Suggest the user check their network or
   proxy settings.
