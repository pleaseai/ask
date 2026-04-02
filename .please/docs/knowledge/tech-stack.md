# Tech Stack — ASK

## Monorepo

- **Build system**: Turborepo
- **Package manager**: bun (workspaces)
- **Workspaces**: `packages/*`, `apps/*`

## CLI (`packages/cli` — `@pleaseai/ask`)

| Category | Technology |
|---|---|
| Runtime | Node.js (Pure ESM, `"type": "module"`) |
| Language | TypeScript 5.7+ |
| CLI framework | citty (unjs) |
| Logging | consola |
| HTML→Markdown | node-html-markdown |
| Linting | ESLint 10 + @pleaseai/eslint-config (@antfu/eslint-config) |

## Registry (`apps/registry` — `@pleaseai/ask-registry`)

| Category | Technology |
|---|---|
| Framework | Nuxt 4 |
| Content | Nuxt Content v3 |
| UI | Nuxt UI v4 |
| Styling | Tailwind CSS v4 |
| Deployment | Cloudflare Pages |
| Linting | ESLint 10 + @pleaseai/eslint-config |

## Key Constraints

- All CLI imports must use `.js` extensions (Pure ESM)
- 2-space indent, single quotes, no semicolons (ESLint config)
- Use `consola` for all user-facing output, never raw `console.log`
- Import `process` from `node:process` explicitly
