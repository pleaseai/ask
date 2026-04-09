import { z } from 'zod'

/**
 * Registry entry schema — Entry → Package → Source hierarchy.
 *
 * See ADR-0001 (`.please/docs/decisions/0001-registry-entry-schema-entry-package-source.md`)
 * for the rationale behind this shape.
 *
 * - Entry   : one Markdown file per GitHub repository. Holds repo-level
 *             metadata (name, description, repo, homepage, license, tags).
 * - Package : a documentation target. Single-package libraries have one;
 *             monorepos have N. Owns its aliases and its sources.
 * - Source  : a way to fetch one package's docs. Multiple sources form a
 *             fallback chain in declaration order — the CLI tries them
 *             head-first and falls back on failure.
 */

// ---------------------------------------------------------------------------
// Source — discriminated union on `type`
// ---------------------------------------------------------------------------

const npmSourceSchema = z.object({
  type: z.literal('npm'),
  /** npm package name. Required; we no longer infer from the entry name. */
  package: z.string().min(1),
  /** Path inside the published tarball (e.g. `dist/docs`). */
  path: z.string().optional(),
})

const githubSourceSchema = z.object({
  type: z.literal('github'),
  /** GitHub repo in `owner/name` form. */
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be in "owner/name" form'),
  /** Branch to fetch. Mutually exclusive with `tag`. Defaults to the repo's default branch. */
  branch: z.string().optional(),
  /** Tag or ref to fetch. Mutually exclusive with `branch`. */
  tag: z.string().optional(),
  /** Path inside the repository (e.g. `docs`, `content/docs`). Auto-detected when omitted. */
  path: z.string().optional(),
})

const webSourceSchema = z.object({
  type: z.literal('web'),
  /** Starting URLs for the crawl. */
  urls: z.array(z.string().url()).min(1),
  /** Maximum crawl depth from each start URL. Defaults to 1. */
  maxDepth: z.number().int().positive().optional(),
  /** Restrict the crawl to URLs whose path starts with this prefix. */
  allowedPathPrefix: z.string().optional(),
})

const llmsTxtSourceSchema = z.object({
  type: z.literal('llms-txt'),
  /** Absolute URL to the `llms.txt` file. */
  url: z.string().url(),
})

export const sourceSchema = z.discriminatedUnion('type', [
  npmSourceSchema,
  githubSourceSchema,
  webSourceSchema,
  llmsTxtSourceSchema,
])
  .superRefine((source, ctx) => {
    // GithubSource invariant: `branch` and `tag` are mutually exclusive.
    // The prose contract used to document that `tag` takes precedence,
    // which meant silently dropping a caller-supplied branch. Fail loudly
    // instead — the caller must pick one.
    if (source.type === 'github' && source.branch && source.tag) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tag'],
        message: 'github source: `branch` and `tag` are mutually exclusive',
      })
    }
  })

export type RegistrySource = z.infer<typeof sourceSchema>
export type NpmSource = z.infer<typeof npmSourceSchema>
export type GithubSource = z.infer<typeof githubSourceSchema>
export type WebSource = z.infer<typeof webSourceSchema>
export type LlmsTxtSource = z.infer<typeof llmsTxtSourceSchema>

// ---------------------------------------------------------------------------
// Alias — an (ecosystem, name) pair a user can request
// ---------------------------------------------------------------------------

export const aliasSchema = z.object({
  ecosystem: z.enum(['npm', 'pypi', 'pub', 'go', 'crates', 'hex', 'nuget', 'maven']),
  name: z.string().min(1),
})

export type RegistryAlias = z.infer<typeof aliasSchema>

// ---------------------------------------------------------------------------
// Package — a documentation target inside an entry
// ---------------------------------------------------------------------------

export const packageSchema = z.object({
  /**
   * Canonical package name. Used by the server to derive `resolvedName`
   * (slugified) so different packages in a monorepo land in distinct
   * `.ask/docs/<slug>@<ver>/` directories on the CLI side.
   */
  name: z.string().min(1),
  /** Optional per-package human description. */
  description: z.string().optional(),
  /**
   * Aliases through which this package can be requested. Typically one
   * entry per ecosystem the package is published to (e.g. `npm:@mastra/core`).
   */
  aliases: z.array(aliasSchema).min(1),
  /**
   * Fetch sources in declaration order. The CLI tries the head first and
   * falls back on failure. At least one source is required.
   */
  sources: z.array(sourceSchema).min(1),
})

export type RegistryPackage = z.infer<typeof packageSchema>

// ---------------------------------------------------------------------------
// Entry — one registry content file
// ---------------------------------------------------------------------------

export const registryEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be in "owner/name" form'),
  homepage: z.string().url().optional(),
  license: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /**
   * Documentation targets. Single-package libraries have exactly one entry;
   * monorepos have one entry per documented package.
   */
  packages: z.array(packageSchema).min(1),
})
  .superRefine((entry, ctx) => {
    // Reject duplicate aliases across packages within the same entry —
    // this would make alias-based routing ambiguous at request time.
    const seen = new Map<string, number>()
    entry.packages.forEach((pkg, pkgIdx) => {
      pkg.aliases.forEach((alias, aliasIdx) => {
        const key = `${alias.ecosystem}:${alias.name}`
        const prev = seen.get(key)
        if (prev !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['packages', pkgIdx, 'aliases', aliasIdx],
            message: `Duplicate alias "${key}" — already declared by packages[${prev}]`,
          })
        }
        else {
          seen.set(key, pkgIdx)
        }
      })
    })

    // Reject duplicate package names within the same entry.
    const nameSeen = new Map<string, number>()
    entry.packages.forEach((pkg, pkgIdx) => {
      const prev = nameSeen.get(pkg.name)
      if (prev !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['packages', pkgIdx, 'name'],
          message: `Duplicate package name "${pkg.name}" — already declared by packages[${prev}]`,
        })
      }
      else {
        nameSeen.set(pkg.name, pkgIdx)
      }
    })

    // Reject slug collisions. Two distinct package names can slugify to the
    // same directory name (e.g. `@a/b-c` and `a-b/c` both → `a-b-c`), which
    // would cause `.ask/docs/<slug>@<ver>/` directory clashes on the CLI
    // side. The `nameSeen` check above does not catch this because the
    // package names differ, only their slugs collide.
    const slugSeen = new Map<string, number>()
    entry.packages.forEach((pkg, pkgIdx) => {
      const slug = slugifyPackageName(pkg.name)
      const prev = slugSeen.get(slug)
      if (prev !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['packages', pkgIdx, 'name'],
          message: `Package name "${pkg.name}" slugifies to "${slug}", colliding with packages[${prev}]`,
        })
      }
      else {
        slugSeen.set(slug, pkgIdx)
      }
    })
  })

export type RegistryEntry = z.infer<typeof registryEntrySchema>

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Find the package inside an entry that matches the given alias.
 * Returns `undefined` when no package declares the alias.
 */
export function findPackageByAlias(
  entry: RegistryEntry,
  ecosystem: RegistryAlias['ecosystem'],
  name: string,
): RegistryPackage | undefined {
  return entry.packages.find(pkg =>
    pkg.aliases.some(a => a.ecosystem === ecosystem && a.name === name),
  )
}

/**
 * True when an entry documents more than one package (a monorepo entry).
 * Direct `owner/repo` lookups against such entries should prompt the caller
 * to disambiguate which package they want.
 */
export function isMonorepoEntry(entry: RegistryEntry): boolean {
  return entry.packages.length > 1
}

/**
 * Slugify a package name into a filesystem- and skill-name-safe identifier.
 *
 * Examples:
 *   - `@mastra/core`     → `mastra-core`
 *   - `@scope/pkg-name`  → `scope-pkg-name`
 *   - `lodash`           → `lodash`
 *
 * The CLI uses the returned slug as both a directory name
 * (`.ask/docs/<slug>@<ver>/`) and a Claude Code skill name. Both surfaces
 * reject `@` and `/`.
 */
export function slugifyPackageName(pkg: string): string {
  if (pkg.startsWith('@')) {
    return pkg.slice(1).replace('/', '-')
  }
  return pkg
}
