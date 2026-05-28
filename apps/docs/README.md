# ASK Docs

Documentation site for [`@pleaseai/ask`](../../packages/cli/), built with the [`docs-please`](https://github.com/pleaseai/docs) Nuxt layer.

## Development

```bash
# From the workspace root
bun install
bun run --cwd apps/docs dev
```

## Build

```bash
# Cloudflare Pages (production)
bun run --cwd apps/docs build

# Local Node preset (no D1 required)
bun run --cwd apps/docs build:node
```

The build target picks the [`@nuxt/content`](https://content.nuxt.com) database backend automatically:

- Cloudflare signals (`NITRO_PRESET=cloudflare_pages`, `CF_PAGES=1`, or `NUXT_CONTENT_DATABASE_TYPE=d1`) → D1 binding `DB`
- Local builds → native `sqlite` connector at `.data/content/contents.sqlite`

## Structure

```
apps/docs/
├── app/
│   └── app.config.ts      # site metadata (title, GitHub repo, UI overrides)
├── content/
│   ├── index.md           # landing page
│   └── docs/
│       └── 1.getting-started/
│           ├── 1.introduction.md
│           └── 2.installation.md
├── public/                # static assets
├── eslint.config.ts
├── nuxt.config.ts
├── package.json
├── tsconfig.json
└── wrangler.jsonc         # Cloudflare Pages config (D1 binding)
```

## Deploy (Cloudflare Pages)

1. Create the D1 database: `wrangler d1 create ask-docs-db`
2. Paste the returned `database_id` into `wrangler.jsonc`
3. Cloudflare Pages project: root = repo root, build command = `bun run --cwd apps/docs build`, output = `apps/docs/dist`
