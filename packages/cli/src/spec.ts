/**
 * Spec parsing helpers for `ask.json` library entries.
 *
 * The spec string is the user-facing identifier; the library name
 * (`name`) is the slug used for `.ask/docs/<name>@<ver>/` and
 * `.claude/skills/<name>-docs/`. Slug derivation:
 *
 *   - `npm:next`              → `next`
 *   - `npm:@mastra/client-js` → `mastra-client-js` (scoped flatten)
 *   - `github:vercel/next.js` → `next.js`
 */

export type ParsedSpec
  = | { kind: 'npm', pkg: string, name: string }
    | { kind: 'github', owner: string, repo: string, name: string }
    | { kind: 'unknown', ecosystem: string, payload: string, name: string }

const SCOPED_PKG_RE = /^@[^/]+\/[^/]+$/

export function parseSpec(spec: string): ParsedSpec {
  const colonIdx = spec.indexOf(':')
  if (colonIdx < 0) {
    return { kind: 'unknown', ecosystem: '', payload: spec, name: spec }
  }
  const ecosystem = spec.slice(0, colonIdx)
  const payload = spec.slice(colonIdx + 1)

  if (ecosystem === 'npm') {
    return {
      kind: 'npm',
      pkg: payload,
      name: slugifyNpmName(payload),
    }
  }

  if (ecosystem === 'github') {
    const slashIdx = payload.indexOf('/')
    if (slashIdx < 0) {
      return { kind: 'unknown', ecosystem, payload, name: payload }
    }
    const owner = payload.slice(0, slashIdx)
    const repo = payload.slice(slashIdx + 1)
    return { kind: 'github', owner, repo, name: repo }
  }

  return { kind: 'unknown', ecosystem, payload, name: payload }
}

export function libraryNameFromSpec(spec: string): string {
  return parseSpec(spec).name
}

/**
 * `@mastra/client-js` → `mastra-client-js`. Scoped npm names are not
 * valid as `.ask/docs/<dir>` or as Claude Code skill dir names, so we
 * flatten them the same way the registry server does.
 */
export function slugifyNpmName(pkgName: string): string {
  if (SCOPED_PKG_RE.test(pkgName)) {
    return pkgName.slice(1).replace('/', '-')
  }
  return pkgName
}
