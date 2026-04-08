import type { ManifestHit, ManifestReader } from './index.js'
import fs from 'node:fs'
import path from 'node:path'

const RE_REGEX_META = /[.*+?^${}()|[\]\\]/g

/**
 * Escape a string for safe use inside a dynamically-constructed regex.
 */
function escapeRegex(input: string): string {
  return input.replace(RE_REGEX_META, '\\$&')
}

/**
 * Read a text file, returning null if it does not exist or cannot be read.
 */
function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  }
  catch {
    return null
  }
}

/**
 * Parse a `bun.lock` file to find the installed version of `name`.
 *
 * bun.lock is a text-based TOML-ish format. Dependencies appear as lines like:
 *
 *     "next@15.0.3": {
 *     "next": ["next@15.0.3", ...],
 *
 * We look for a quoted `"<name>@<version>"` token anywhere in the file — the
 * first match wins. Scoped names (`@scope/pkg@1.2.3`) are handled by allowing
 * an optional leading `@` in the name and taking the LAST `@` as the version
 * separator within the quoted token.
 */
function readBunLock(content: string, name: string): string | null {
  // Match "<name>@<version>" where <version> has no `"` in it.
  // For scoped names, the `@` in `@scope/pkg` is part of the name — so we
  // escape the full name literally and then require `@<semver-ish>` after it.
  const escaped = escapeRegex(name)
  const re = new RegExp(`"${escaped}@([^"@][^"]*)"`)
  const match = content.match(re)
  return match ? match[1] : null
}

/**
 * Parse a `package-lock.json` (npm v2/v3 format).
 *
 * Looks under `packages["node_modules/<name>"].version` first (lockfileVersion
 * 2+), then under `dependencies.<name>.version` (v1).
 */
function readNpmLock(content: string, name: string): string | null {
  try {
    const json = JSON.parse(content) as {
      packages?: Record<string, { version?: string }>
      dependencies?: Record<string, { version?: string }>
    }
    const pkgKey = `node_modules/${name}`
    const fromPackages = json.packages?.[pkgKey]?.version
    if (fromPackages)
      return fromPackages
    const fromDeps = json.dependencies?.[name]?.version
    if (fromDeps)
      return fromDeps
    return null
  }
  catch {
    return null
  }
}

/**
 * Parse a `pnpm-lock.yaml` file (best-effort, regex-based).
 *
 * pnpm lockfiles are real YAML, but the shape we care about is regular:
 * under `importers: '.': dependencies: <name>: ... version: <ver>` or
 * the `packages:` map keyed as `'/<name>@<version>'`. YAML parsing without a
 * dependency is fragile, so we scan for the `/<name>@<version>:` package key
 * which is the most stable form across pnpm versions.
 *
 * LIMITATION: monorepo importers other than `.` are ignored. See the track
 * spec (out-of-scope: "monorepo 워크스페이스별 별도 lockfile 처리").
 */
function readPnpmLock(content: string, name: string): string | null {
  const escaped = escapeRegex(name)
  // Match `  /<name>@1.2.3:` or `  '/<name>@1.2.3':` possibly with a suffix
  // like `_peerhash` which pnpm appends for peer-dep disambiguation.
  const re = new RegExp(`^\\s*'?/${escaped}@([^():\\s_]+)`, 'm')
  const match = content.match(re)
  return match ? match[1] : null
}

/**
 * Parse a `yarn.lock` file (Yarn classic v1 format).
 *
 * Entries look like:
 *
 *     "next@^15.0.0", next@15.0.3:
 *       version "15.0.3"
 *
 * We locate a line mentioning `<name>@` (either quoted or bare) and then take
 * the nearest following `version "<ver>"`.
 */
function readYarnLock(content: string, name: string): string | null {
  const escaped = escapeRegex(name)
  // Find an entry header that mentions this package, then capture the next
  // `version "<ver>"` within the following block.
  const re = new RegExp(
    `(?:^|[",\\s])${escaped}@[^\\n]*:\\s*\\n(?:\\s+[^\\n]*\\n)*?\\s+version\\s+"([^"]+)"`,
    'm',
  )
  const match = content.match(re)
  return match ? match[1] : null
}

/**
 * Parse `package.json` for a dependency range (not exact — callers should
 * mark `exact: false` so that `NpmResolver` gets a chance to interpret it).
 */
function readPackageJson(content: string, name: string): string | null {
  try {
    const json = JSON.parse(content) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    return (
      json.dependencies?.[name]
      ?? json.devDependencies?.[name]
      ?? json.peerDependencies?.[name]
      ?? json.optionalDependencies?.[name]
      ?? null
    )
  }
  catch {
    return null
  }
}

/**
 * Lockfile / manifest reader for the npm ecosystem.
 *
 * Lookup order (first hit wins):
 *   1. bun.lock            (exact)
 *   2. package-lock.json   (exact)
 *   3. pnpm-lock.yaml      (exact)
 *   4. yarn.lock           (exact)
 *   5. package.json        (range — `exact: false`)
 *
 * Only the root project's files are consulted — workspace-specific lockfiles
 * are out of scope for this track.
 */
export class NpmManifestReader implements ManifestReader {
  readInstalledVersion(name: string, projectDir: string): ManifestHit | null {
    const candidates: Array<{
      file: string
      parser: (content: string, name: string) => string | null
      exact: boolean
    }> = [
      { file: 'bun.lock', parser: readBunLock, exact: true },
      { file: 'package-lock.json', parser: readNpmLock, exact: true },
      { file: 'pnpm-lock.yaml', parser: readPnpmLock, exact: true },
      { file: 'yarn.lock', parser: readYarnLock, exact: true },
      { file: 'package.json', parser: readPackageJson, exact: false },
    ]

    for (const { file, parser, exact } of candidates) {
      const content = readFileSafe(path.join(projectDir, file))
      if (content == null)
        continue
      const version = parser(content, name)
      if (version) {
        return { version, source: file, exact }
      }
    }

    return null
  }
}
