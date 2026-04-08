---
name: ask-registry
description: >
  Create, list, and manage library entries in the ASK Registry (apps/registry/content/registry/).
  Each entry is a Markdown file with YAML frontmatter defining how the CLI downloads docs
  for a library (npm, pypi, go, crates, pub, hex, nuget ecosystems).
  MUST use this skill when the user wants to: add/register/create a new library in the registry,
  view existing registry entries, write a registry .md file, configure doc download strategies
  (npm tarball, GitHub repo, web crawl, llms-txt), or asks about registry YAML frontmatter format.
  Trigger on: "registry에 추가", "라이브러리 등록", "add to registry", "register library",
  "content/registry", "registry entry", "doc source strategy", "등록해줘", "넣어줘",
  "registry 목록", "list registry", and any mention of adding packages to ASK registry.
---

# ASK Registry Entry Creator

Create registry entries for the ASK Registry — the source of truth that tells the `@pleaseai/ask` CLI where and how to download documentation for a given library.

## Registry Entry Location

```
apps/registry/content/registry/<github-owner>/<repo-name>.md
```

Directories are named after the GitHub owner (e.g. `vercel/`, `facebook/`, `colinhacks/`).

## Entry Format

Every entry is a Markdown file with YAML frontmatter validated by `apps/registry/content.config.ts`:

```yaml
---
name: <display-name>
description: <one-line description>
repo: <owner>/<repo>           # required — GitHub repo in "owner/name" form
docsPath: <path>               # optional — docs directory inside repo
homepage: <url>                # optional
license: <spdx-id>             # optional
aliases:                       # optional — ecosystem lookup aliases
  - ecosystem: <npm|pypi|pub|go|crates|hex|nuget|maven>
    name: <package-name>
strategies:                    # optional — explicit fetch strategies
  - source: <npm|github|web|llms-txt>
    # source-specific fields (see below)
tags: [tag1, tag2]
---
```

When `strategies` is omitted, the CLI auto-generates a `github` strategy from `repo` + `docsPath`.

The Markdown body below the frontmatter provides human-readable context: what the library is, version notes, and any special instructions for the CLI.

## Strategy Source Types

Each strategy tells the CLI how to fetch documentation. A library can have multiple strategies listed in priority order.

### `npm` — Download docs from npm tarball

```yaml
- source: npm
  package: next          # optional, defaults to entry name
  docsPath: dist/docs    # optional, path inside the package
```

Use when the npm package ships documentation files (`.md`, `.mdx`, `.txt`, `.rst`) inside the tarball. Check by running `npm view <pkg> dist.tarball` and inspecting the contents.

### `github` — Download docs from GitHub repository

```yaml
- source: github
  repo: owner/repo       # required
  branch: main           # optional, default: main
  tag: v1.0.0            # optional, takes precedence over branch
  docsPath: docs         # optional, auto-detected from: docs, doc, documentation, guide, guides
```

The most common strategy. Use when docs live in the repo's `docs/` directory (or similar).

### `web` — Crawl documentation website

```yaml
- source: web
  urls:                   # required, array of start URLs
    - https://example.com/docs
  maxDepth: 2             # optional, default: 1
  allowedPathPrefix: /docs  # optional, restricts crawl scope
```

Use as a fallback when docs are not available via npm or GitHub. Converts HTML to Markdown.

### `llms-txt` — Fetch llms.txt file (planned)

```yaml
- source: llms-txt
  url: https://example.com/llms.txt  # required
```

Note: `llms-txt` is supported by the CLI source adapter but NOT yet in the `content.config.ts` schema enum. If adding an entry with this source, also update `content.config.ts` to include `'llms-txt'` in the source enum, or list it alongside another strategy.

## How to Create an Entry

### 1. Research the library

Before writing the entry, gather this information:

- **Official description**: Check the package registry (npmjs.com, pypi.org) or GitHub repo
- **Documentation location**: Where do the docs live?
  - In the npm package itself? → use `npm` source
  - In a GitHub repo `docs/` directory? → use `github` source
  - Only on a website? → use `web` source
  - Has an `llms.txt` endpoint? → use `llms-txt` source (check `<domain>/llms.txt`)
- **Tags**: 3-5 relevant tags describing the library's domain and purpose

### 2. Choose strategies

List strategies in preferred order. The CLI uses the first strategy by default. Common patterns:

| Library type | Primary strategy | Fallback |
|---|---|---|
| Docs bundled in npm package | `npm` | `github` |
| Docs in GitHub repo only | `github` | `web` |
| Docs only on website | `web` | — |
| Has llms.txt | `llms-txt` | `github` |

### 3. Write the entry file

Create `apps/registry/content/registry/<github-owner>/<repo-name>.md`:

```markdown
---
name: <Display Name>
description: <one-line description from the official source>
repo: <owner>/<repo>
docsPath: docs
aliases:
  - ecosystem: <npm|pypi|pub|go|crates|hex|nuget|maven>
    name: <package-name>
tags: [relevant, tags, here]
---

# <Display Name>

<Brief description of the library and where its documentation comes from.>

## Version notes
- `latest`: <what the latest version includes>
```

### 4. Validate

Run the registry dev server to confirm the entry parses correctly:

```bash
bun run --cwd apps/registry dev
```

Nuxt Content validates frontmatter against `content.config.ts` at build time — invalid entries will cause build errors.

## Examples

### npm package with bundled docs (file: `vercel/next.js.md`)

```yaml
---
name: Next.js
description: The React framework by Vercel
repo: vercel/next.js
docsPath: docs
homepage: https://nextjs.org
license: MIT
aliases:
  - ecosystem: npm
    name: next
strategies:
  - source: npm
    package: next
    docsPath: dist/docs
  - source: github
    repo: vercel/next.js
    docsPath: docs
tags: [react, framework, ssr, vercel]
---
```

### GitHub-only docs (file: `colinhacks/zod.md`)

```yaml
---
name: Zod
description: TypeScript-first schema validation library
repo: colinhacks/zod
docsPath: docs
aliases:
  - ecosystem: npm
    name: zod
tags: [typescript, validation, schema]
---
```

### Web crawl (file: `tailwindlabs/tailwindcss.md`)

```yaml
---
name: Tailwind CSS
description: Utility-first CSS framework
repo: tailwindlabs/tailwindcss
aliases:
  - ecosystem: npm
    name: tailwindcss
strategies:
  - source: web
    urls:
      - https://tailwindcss.com/docs
    maxDepth: 2
    allowedPathPrefix: /docs
tags: [css, framework, utility]
---
```

### Python package via GitHub (file: `fastapi/fastapi.md`)

```yaml
---
name: FastAPI
description: High-performance Python web framework
repo: fastapi/fastapi
docsPath: docs
aliases:
  - ecosystem: pypi
    name: fastapi
tags: [python, api, async, web]
---
```

## Schema Reference

Validated by `apps/registry/content.config.ts`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Display name (e.g. "Next.js") |
| `description` | string | yes | One-line description |
| `repo` | string | yes | GitHub `owner/name` form (e.g. `vercel/next.js`) |
| `docsPath` | string | no | Docs directory inside the repo |
| `homepage` | string | no | Project homepage URL |
| `license` | string | no | SPDX license identifier |
| `aliases` | array | no | Ecosystem lookup aliases (`{ ecosystem, name }` objects) |
| `strategies` | array | no | Explicit fetch strategies; auto-derived from `repo` if omitted |
| `tags` | string[] | no | Descriptive tags |

### Strategy fields by source

| Field | npm | github | web |
|---|---|---|---|
| `source` | `"npm"` | `"github"` | `"web"` |
| `package` | optional | — | — |
| `repo` | — | **required** | — |
| `branch` | — | optional | — |
| `tag` | — | optional | — |
| `docsPath` | optional | optional | — |
| `urls` | — | — | **required** |
| `maxDepth` | — | — | optional |
| `allowedPathPrefix` | — | — | optional |
