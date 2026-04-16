# Declarative Workflow (`ask.json` + `ask install`)

Read this when the user wants a checked-in list of libraries the
project's agents should reference, or wants `AGENTS.md` auto-regenerated
with lazy `ask src` / `ask docs` pointers. The one-shot reading
commands (`ask docs` / `ask src` / `ask skills list`) don't persist
anything; this flow does.

`ask install` is **lazy-first**: it resolves versions and writes
`AGENTS.md` plus a per-library `.claude/skills/<name>-docs/SKILL.md`
that tells agents to invoke `ask src <spec>` / `ask docs <spec>` on
demand. No documentation is downloaded during `install` — fetching
happens the first time an agent calls `ask docs` / `ask src`.

## What Gets Written

- `ask.json` — the declarative input. Array of spec strings. Checked
  into git; edited by `ask add` / `ask remove` (or by hand).
- `AGENTS.md` — block between `<!-- BEGIN:ask-docs-auto-generated -->`
  and `<!-- END:ask-docs-auto-generated -->` maintained by `ask`.
- `.claude/skills/<name>-docs/SKILL.md` — one skill per declared
  library, each delegating to `ask docs <spec>` / `ask src <spec>`.
- Ignore files (`.gitignore`, `.prettierignore`, etc.) — patched via
  `# ask:start … # ask:end` marker blocks. Don't hand-edit inside
  those markers; `install` / `remove` overwrite them.

## `ask install`

Reads `ask.json`, resolves each spec to a concrete version, regenerates
per-library skills, and rewrites the `AGENTS.md` block.

```bash
ask install
```

Per-entry behavior:

1. **Version resolution**
   - `npm:` specs → read lockfile chain
     `bun.lock → package-lock.json → pnpm-lock.yaml → yarn.lock →
     package.json` (range fallback). Missing from every lockfile ⇒
     entry skipped with a warning.
   - `github:` specs → the ref encoded in the spec
     (`github:vercel/next.js@v14.2.3`). No lockfile lookup.
   - Explicit `@version` on any spec wins over lockfile resolution.
2. **Skill generation** — writes `.claude/skills/<name>-docs/SKILL.md`.
3. **AGENTS.md regeneration** — rewrites the auto-generated block
   with every resolved library.

`postinstall`-friendly: per-entry failures emit a warning; the overall
exit code is always 0, so an unresolvable entry doesn't break
`bun install`.

## `ask add <spec>` / `ask add` (interactive)

Appends to `ask.json`, then runs install for just that entry.

```bash
ask add npm:next
ask add npm:@mastra/client-js
ask add github:vercel/next.js@v14.2.3
ask add facebook/react           # bare owner/repo → github:facebook/react
ask add                          # interactive picker
```

Bare names without `:` or `/` (e.g. `ask add zod`) are rejected with a
hint listing the two valid forms. Note the asymmetry: the one-shot
`ask docs zod` DOES accept bare names — only `ask add` is strict
because the spec is persisted.

## `ask remove <name>`

Removes from `ask.json`, deletes the generated skill, re-runs install
to regenerate `AGENTS.md`.

```bash
ask remove next
ask remove @mastra/client-js
ask remove npm:next              # also accepts the full spec
```

The `name` match is tried against the full spec, the spec body, and
the derived library slug — so the unscoped name, the full spec, or the
scoped package name all work.

## `ask list [--json]`

Prints declared libraries with their resolved versions. Unresolved
entries (declared in `ask.json` but missing from every lockfile) show
`version: unresolved` so drift is visible.

```bash
ask list
ask list --json | jq '.entries[] | select(.version == "unresolved")'
```

JSON shape (`ListModelSchema`): `{ "entries": [...], "conflicts":
[...], "warnings": [...] }`. Each entry has `name`, `version`,
`format`, `source`, `location`, plus optional `itemCount` / `skills`.

## `ask.json` Shape

Strict array of ecosystem-prefixed spec strings — schema is
`z.array(z.string().regex(/^[a-z][a-z0-9+-]*:.+$/))` with `.strict()`.
Object entries are rejected.

```json
{
  "libraries": [
    "npm:next",
    "npm:@mastra/client-js",
    "npm:zod@3.22.0",
    "github:vercel/next.js@v14.2.3",
    "github:vercel/ai@v5.0.0"
  ]
}
```

- `npm:` specs: append `@<version>` to pin, otherwise the lockfile
  decides.
- `github:` specs: append `@<ref>` to encode the version inside the
  spec string. `github:` without a ref defaults to `latest` in the
  generated output.
- No separate `ref`, `source`, or `docsPath` keys. Per-library
  `docsPath` comes from the ASK Registry when `ask docs` / `ask src`
  actually fetch, not from `ask.json`.

## Intent-Format and Resolved-Cache Notes

Prior versions of `ask` had a `.ask/resolved.json` lockfile, a
`<!-- intent-skills:start -->` block in `AGENTS.md` for
TanStack-intent packages, and a `--allow-mutable-ref` flag. In the
current lazy-first architecture `ask install` does not write
`.ask/resolved.json` and does not populate intent blocks; the
underlying code modules still exist but are not wired into the
install path. Treat the docs, source, and skills commands as the
supported surface, and `ask.json` as a strict spec-string array.
