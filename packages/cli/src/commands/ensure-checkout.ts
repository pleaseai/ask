import type { FetchResult, GithubSourceOptions, SourceConfig } from '../sources/index.js'
import type { ParsedSpec } from '../spec.js'
import fs from 'node:fs'
import { npmEcosystemReader } from '../lockfiles/index.js'
import { getResolver } from '../resolvers/index.js'
import { GithubSource } from '../sources/github.js'
import { parseSpec } from '../spec.js'
import { githubStorePath, resolveAskHome } from '../store/index.js'

const DEFAULT_GITHUB_HOST = 'github.com'

export interface EnsureCheckoutOptions {
  /** User-supplied spec, optionally with a trailing `@version` suffix. */
  spec: string
  /** Project root used for lockfile lookups. */
  projectDir: string
  /** When true, return cache hits only and throw `NoCacheError` on miss. */
  noFetch?: boolean
}

export interface EnsureCheckoutResult {
  parsed: ParsedSpec
  owner: string
  repo: string
  ref: string
  resolvedVersion: string
  /** Absolute path to `~/.ask/github/<host>/<owner>/<repo>/<ref>/` (PM-unified store layout). */
  checkoutDir: string
  /**
   * For npm-ecosystem specs, the package name (e.g. `react`, `@vercel/ai`).
   * Used by `ask docs` to additionally walk `node_modules/<pkg>/`.
   * Undefined for github/pypi/pub/etc. specs.
   */
  npmPackageName?: string
}

/**
 * Test seam — production code passes nothing and falls back to the real
 * implementations. Tests inject mocks to avoid filesystem and network I/O.
 */
export interface EnsureCheckoutDeps {
  askHome?: string
  fetcher?: { fetch: (opts: SourceConfig) => Promise<FetchResult> }
  lockfileReader?: { read: (name: string, projectDir: string) => { version: string } | null }
  resolverFor?: (ecosystem: string) => {
    resolve: (name: string, version: string) => Promise<{
      repo: string
      ref: string
      resolvedVersion: string
      fallbackRefs?: string[]
    }>
  } | null
}

/**
 * Thrown by `ensureCheckout` when `noFetch=true` and the requested
 * checkout is not in the cache. Carries enough context for callers to
 * print a helpful error.
 */
export class NoCacheError extends Error {
  constructor(public checkoutDir: string, public spec: string) {
    super(`no cached checkout for ${spec} (expected at ${checkoutDir})`)
    this.name = 'NoCacheError'
  }
}

/**
 * Split a trailing `@version` suffix from a user-supplied spec.
 *
 * The version separator is the LAST `@` in the input. The last `@` is treated
 * as a scope marker (not a version separator) when it is either at position 0
 * (bare scoped name) or immediately follows a `:` (ecosystem-prefix scoped
 * name like `npm:@vercel/ai`).
 *
 * Examples:
 *   - `react`                       → { spec: 'react' }
 *   - `react@18.2.0`                → { spec: 'react', version: '18.2.0' }
 *   - `@vercel/ai`                  → { spec: '@vercel/ai' }
 *   - `@vercel/ai@5.0.0`            → { spec: '@vercel/ai', version: '5.0.0' }
 *   - `npm:react@18.2.0`            → { spec: 'npm:react', version: '18.2.0' }
 *   - `github:facebook/react@v18.2`           → { spec: 'github:facebook/react', version: 'v18.2' }
 *   - `github:facebook/react@release/v1.2.3` → { spec: 'github:facebook/react', version: 'release/v1.2.3' }
 */
export function splitExplicitVersion(input: string): { spec: string, version?: string } {
  const lastAt = input.lastIndexOf('@')
  if (lastAt < 0) {
    return { spec: input }
  }
  if (lastAt === 0 || input[lastAt - 1] === ':') {
    // The `@` is either the very first character (bare scoped name, e.g. `@vercel/ai`)
    // or immediately follows an ecosystem prefix colon (e.g. `npm:@vercel/ai`).
    // In both cases it is a scope marker, not a version separator.
    return { spec: input }
  }
  return { spec: input.slice(0, lastAt), version: input.slice(lastAt + 1) }
}

/**
 * Ensure the GitHub checkout for `spec` exists in the global store and
 * return its absolute path. On cache miss, triggers the existing
 * `GithubSource.fetch()` pipeline (bare clone preferred, tar.gz fallback).
 *
 * This is the shared resolution helper for `ask src` and `ask docs`.
 * Both commands share the same fetch path, version resolution, and cache
 * layout — they only differ in what they print after this returns.
 */
export async function ensureCheckout(
  options: EnsureCheckoutOptions,
  deps: EnsureCheckoutDeps = {},
): Promise<EnsureCheckoutResult> {
  const askHome = deps.askHome ?? resolveAskHome()
  const fetcher = deps.fetcher ?? new GithubSource()
  const lockfileReader = deps.lockfileReader ?? npmEcosystemReader
  const resolverFor = deps.resolverFor ?? getResolver

  // 1. Split @version from spec
  const { spec: specBody, version: explicitVersion } = splitExplicitVersion(options.spec)

  // 2. Parse the spec body
  const parsed = parseSpec(specBody)

  // 3. Determine owner, repo, ref, resolvedVersion (and npmPackageName)
  let owner: string
  let repo: string
  let ref: string
  let resolvedVersion: string
  let npmPackageName: string | undefined
  let fallbackRefs: string[] | undefined
  let isFromBranch = false
  // True when the caller supplied a bare `github:owner/repo` with no
  // explicit @ref — we default to 'main' here for the cache-key but must
  // leave BOTH `tag` and `branch` undefined so GithubSource sees the
  // "no preference" state and applies its default-branch fallback chain
  // (main → vmain → master). Passing `branch: 'main'` would lock the
  // source into that literal branch and repos whose default is `master`
  // (e.g. gitbutlerapp/gitbutler) would fail.
  let isImplicitDefaultRef = false

  if (parsed.kind === 'github') {
    // Direct github spec — owner/repo from parse, ref from explicit @version or 'main'
    owner = parsed.owner
    repo = parsed.repo
    ref = explicitVersion ?? 'main'
    resolvedVersion = ref
    isFromBranch = !explicitVersion // 'main' is a branch, explicit refs are tags
    isImplicitDefaultRef = !explicitVersion
  }
  else {
    // npm-prefixed, bare-name, or other ecosystem prefix → resolver dispatch
    const ecosystem
      = parsed.kind === 'npm'
        ? 'npm'
        : parsed.kind === 'unknown' && parsed.ecosystem === ''
          ? 'npm' // bare name — treat as npm
          : (parsed as { ecosystem: string }).ecosystem

    const pkgName
      = parsed.kind === 'npm'
        ? parsed.pkg
        : (parsed as { payload: string }).payload

    if (ecosystem === 'npm') {
      npmPackageName = pkgName
    }

    const resolver = resolverFor(ecosystem)
    if (!resolver) {
      throw new Error(
        `unsupported ecosystem '${ecosystem}' for spec '${options.spec}'. `
        + `Supported ecosystems: npm, pypi, pub, maven`,
      )
    }

    // Version priority: explicit @version > lockfile (npm only) > 'latest'
    let queryVersion = explicitVersion
    if (!queryVersion && ecosystem === 'npm') {
      const hit = lockfileReader.read(pkgName, options.projectDir)
      if (hit) {
        queryVersion = hit.version
      }
    }
    if (!queryVersion) {
      queryVersion = 'latest'
    }

    const result = await resolver.resolve(pkgName, queryVersion)
    const slashIdx = result.repo.indexOf('/')
    if (slashIdx < 0) {
      throw new Error(
        `resolver returned malformed repo '${result.repo}' for spec '${options.spec}'`,
      )
    }
    owner = result.repo.slice(0, slashIdx)
    repo = result.repo.slice(slashIdx + 1)
    ref = result.ref
    resolvedVersion = result.resolvedVersion
    fallbackRefs = result.fallbackRefs
  }

  // 4. Compute the cache directory — PM-unified layout, shared with
  //    `GithubSource.fetch` which writes to the same path. If these two
  //    ever diverge, `ask docs` / `ask src` silently emit no output.
  const checkoutDir = githubStorePath(askHome, DEFAULT_GITHUB_HOST, owner, repo, ref)

  // 5. Cache hit short-circuit
  if (fs.existsSync(checkoutDir)) {
    return { parsed, owner, repo, ref, resolvedVersion, checkoutDir, npmPackageName }
  }

  // 6. Cache miss + noFetch → throw
  if (options.noFetch) {
    throw new NoCacheError(checkoutDir, options.spec)
  }

  // 7. Trigger the fetch via the existing GithubSource pipeline.
  //    For implicit default refs, pass NEITHER `tag` nor `branch` so
  //    GithubSource.fetch can activate its default-branch fallback
  //    chain (main → vmain → master).
  const refOpt: Partial<GithubSourceOptions> = isImplicitDefaultRef
    ? {}
    : isFromBranch ? { branch: ref } : { tag: ref }
  const fetchOpts: GithubSourceOptions = {
    source: 'github',
    name: parsed.name,
    version: resolvedVersion,
    repo: `${owner}/${repo}`,
    ...refOpt,
    ...(fallbackRefs?.length ? { fallbackRefs } : {}),
  }
  const fetchResult = await fetcher.fetch(fetchOpts)

  // 8. Prefer the actual on-disk path reported by the fetcher. When a
  //    `fallbackRef` wins or `cloneAtTag` rescues a non-`v` ref via
  //    `v<ref>`, the store dir is under the WINNING candidate, not the
  //    originally requested `ref`. Silently returning `checkoutDir`
  //    (the primary-ref path) would reproduce the same empty-output bug
  //    on the ref-candidate axis that the PM-unified layout fix closed
  //    on the naming axis.
  const resolvedCheckoutDir = fetchResult?.storePath ?? checkoutDir

  return { parsed, owner, repo, ref, resolvedVersion, checkoutDir: resolvedCheckoutDir, npmPackageName }
}
