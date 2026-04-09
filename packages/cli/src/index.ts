#!/usr/bin/env node

import type { RegistrySource } from './registry.js'
import type { Lock, LockEntry } from './schemas.js'
import type {
  FetchResult,
  GithubSourceOptions,
  LlmsTxtSourceOptions,
  NpmSourceOptions,
  SourceConfig,
  WebSourceOptions,
} from './sources/index.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { generateAgentsMd } from './agents.js'
import { runWithConcurrency } from './concurrency.js'
import {
  addDocEntry,
  loadConfig,
  removeDocEntry,
} from './config.js'
import { manageIgnoreFiles } from './ignore-files.js'
import { contentHash, getConfigPath, getLockPath, readLock, upsertLockEntry } from './io.js'
import { getReader } from './manifest/index.js'
import { fetchRegistryEntry, parseDocSpec, parseEcosystem, resolveFromRegistry } from './registry.js'
import { getResolver } from './resolvers/index.js'
import { generateSkill, removeSkill } from './skill.js'
import { getSource } from './sources/index.js'
import { listDocs, removeDocs, saveDocs } from './storage.js'

function buildLockEntry(config: SourceConfig, result: FetchResult): LockEntry {
  const base = {
    version: result.resolvedVersion,
    fetchedAt: new Date().toISOString(),
    fileCount: result.files.length,
    contentHash: contentHash(
      result.files.map(f => ({ relpath: f.path, content: f.content })),
    ),
  }
  const meta = result.meta ?? {}
  switch (config.source) {
    case 'github':
      return {
        ...base,
        source: 'github',
        repo: config.repo,
        ref: meta.ref ?? config.tag ?? config.branch ?? 'main',
        ...(meta.commit ? { commit: meta.commit } : {}),
      }
    case 'npm': {
      // Two valid recordings:
      //   - tarball:    network fetch path; record URL (+ integrity if known)
      //   - installPath: local-first read from node_modules; record path
      // The schema requires exactly one of the two; the local-first path was
      // added for npm-tarball-docs-20260408 to make `ask docs add` work
      // offline when the package is already installed.
      if (!meta.tarball && !meta.installPath) {
        throw new Error(
          `npm source did not return a tarball URL or installPath for ${config.name}@${result.resolvedVersion}. `
          + 'Cannot record lockfile entry without one of them.',
        )
      }
      return {
        ...base,
        source: 'npm',
        ...(meta.tarball ? { tarball: meta.tarball } : {}),
        ...(meta.integrity ? { integrity: meta.integrity } : {}),
        ...(meta.installPath ? { installPath: meta.installPath } : {}),
      }
    }
    case 'web':
      return {
        ...base,
        source: 'web',
        urls: meta.urls ?? config.urls,
      }
    case 'llms-txt':
      return {
        ...base,
        source: 'llms-txt',
        url: (meta.urls ?? [])[0] ?? config.url,
      }
  }
}

/**
 * Gate A: reject bare-name specs (`ask docs add next`).
 *
 * Bare names are ambiguous — they give the CLI no ecosystem hint and no
 * explicit source, and silently auto-resolving them (which the old code did)
 * can hand back wrong-looking docs. Instead we force the caller to either use
 * an ecosystem prefix (`npm:next`) or the github shorthand (`owner/repo`).
 *
 * Returns an error message when the spec is ambiguous, or `null` when it is
 * OK to proceed. `hasExplicitSource` lets the caller opt out of the check
 * when `--source` is passed explicitly — an explicit source disambiguates.
 */
export function checkBareNameGate(
  input: string,
  parsedKind: 'github' | 'ecosystem' | 'name',
  hasExplicitSource: boolean,
): string | null {
  if (hasExplicitSource)
    return null
  if (parsedKind !== 'name')
    return null
  return (
    `Ambiguous spec '${input}'. Use one of:\n`
    + `  • npm:<name>[@version]    (or pypi:, pub:, crates:, hex:, go:, maven:)\n`
    + `  • <owner>/<repo>[@ref]    (direct GitHub)\n`
    + `Tip: the add-docs skill auto-resolves bare names from your project manifest.`
  )
}

/**
 * Gate B: manifest-based version resolution.
 *
 * When the user writes `npm:next` with no version, consult the project
 * lockfile/manifest and try to use the installed version — this guarantees
 * the downloaded docs match what's actually in the project.
 *
 * Resolution policy:
 *   - lockfile exact hit → override version, log provenance
 *   - manifest range hit → override version, log provenance (resolver will
 *     later normalize the range)
 *   - no hit + `--from-manifest` → error (user explicitly required manifest)
 *   - no hit otherwise       → leave version as `'latest'` and fall through
 *     to the existing resolver pipeline
 *
 * Returns `{ kind: 'ok', version? }` with the override version (or undefined
 * if no override applied) or `{ kind: 'error', message }` when `--from-manifest`
 * required a hit but we got none.
 *
 * The `readerFactory` argument is injectable so tests can supply mock readers
 * without creating real lockfiles on disk.
 */
export type ManifestGateResult
  = | { kind: 'ok', version?: string, source?: string }
    | { kind: 'error', message: string }

export function runManifestGate(
  ecosystem: string,
  name: string,
  version: string,
  projectDir: string,
  opts: { noManifest: boolean, fromManifest: boolean },
  readerFactory: (eco: string) => { readInstalledVersion: (n: string, d: string) => { version: string, source: string, exact: boolean } | null } | undefined = getReader,
): ManifestGateResult {
  if (opts.noManifest)
    return { kind: 'ok' }
  if (version !== 'latest')
    return { kind: 'ok' }

  const reader = readerFactory(ecosystem)
  const hit = reader?.readInstalledVersion(name, projectDir) ?? null

  if (!hit) {
    if (opts.fromManifest) {
      return {
        kind: 'error',
        message:
          `--from-manifest was set but no ${ecosystem} manifest entry found for '${name}'. `
          + `Ensure the package is listed in your lockfile or package.json.`,
      }
    }
    return { kind: 'ok' }
  }

  return { kind: 'ok', version: hit.version, source: hit.source }
}

function parseSpec(spec: string): { name: string, version: string } {
  const lastAt = spec.lastIndexOf('@')
  if (lastAt > 0) {
    return {
      name: spec.substring(0, lastAt),
      version: spec.substring(lastAt + 1),
    }
  }
  return { name: spec, version: 'latest' }
}

/**
 * Adapt a registry API `RegistrySource` (the fetch recipe the server
 * returned) into the internal `SourceConfig` shape the rest of the CLI
 * operates on. The two types carry the same information in slightly
 * different layouts — `type` vs `source`, `path` vs `docsPath` — per
 * ADR-0001 (see `.please/docs/decisions/0001-*.md`).
 */
function sourceConfigFromRegistrySource(
  name: string,
  version: string,
  source: RegistrySource,
): SourceConfig {
  const base = { name, version }
  switch (source.type) {
    case 'npm':
      return {
        ...base,
        source: 'npm',
        package: source.package,
        docsPath: source.path,
      } satisfies NpmSourceOptions
    case 'github':
      return {
        ...base,
        source: 'github',
        repo: source.repo,
        branch: source.branch,
        tag: source.tag,
        docsPath: source.path,
      } satisfies GithubSourceOptions
    case 'web':
      return {
        ...base,
        source: 'web',
        urls: source.urls,
        maxDepth: source.maxDepth ?? 1,
        allowedPathPrefix: source.allowedPathPrefix,
      } satisfies WebSourceOptions
    case 'llms-txt':
      return {
        ...base,
        source: 'llms-txt',
        url: source.url,
      } satisfies LlmsTxtSourceOptions
  }
}

function buildSourceConfig(
  name: string,
  version: string,
  opts: { source: string, repo?: string, branch?: string, tag?: string, docsPath?: string, url?: string[], maxDepth?: string, pathPrefix?: string },
): SourceConfig {
  const base = { name, version }

  switch (opts.source) {
    case 'npm':
      return {
        ...base,
        source: 'npm',
        docsPath: opts.docsPath,
      } satisfies NpmSourceOptions

    case 'github':
      if (!opts.repo) {
        throw new Error('--repo is required for github source')
      }
      return {
        ...base,
        source: 'github',
        repo: opts.repo,
        branch: opts.branch,
        tag: opts.tag,
        docsPath: opts.docsPath,
      } satisfies GithubSourceOptions

    case 'web':
      if (!opts.url || opts.url.length === 0) {
        throw new Error('--url is required for web source')
      }
      return {
        ...base,
        source: 'web',
        urls: opts.url,
        maxDepth: Number.parseInt(opts.maxDepth ?? '1', 10),
        allowedPathPrefix: opts.pathPrefix,
      } satisfies WebSourceOptions

    case 'llms-txt':
      if (!opts.url || opts.url.length === 0) {
        throw new Error('--url is required for llms-txt source')
      }
      return {
        ...base,
        source: 'llms-txt',
        url: opts.url[0],
      } satisfies LlmsTxtSourceOptions

    default:
      throw new Error(`Unknown source: ${opts.source}`)
  }
}

const addCmd = defineCommand({
  meta: { name: 'add', description: 'Download documentation for a library' },
  args: {
    'spec': { type: 'positional', description: 'Library spec (e.g. zod@3.22 or npm:next@canary)', required: true },
    'source': { type: 'string', description: 'Source type: npm, github, web, llms-txt (auto-detected if omitted)', alias: ['s'] },
    'repo': { type: 'string', description: 'GitHub repository (for github source)' },
    'branch': { type: 'string', description: 'Git branch (for github source)' },
    'tag': { type: 'string', description: 'Git tag (for github source)' },
    'docsPath': { type: 'string', description: 'Path to docs within the package/repo' },
    'url': { type: 'string', description: 'Documentation URL (for web source)' },
    'maxDepth': { type: 'string', description: 'Max crawl depth for web source', default: '1' },
    'pathPrefix': { type: 'string', description: 'URL path prefix filter for web source' },
    'no-manifest': { type: 'boolean', description: 'Do not consult project manifest/lockfile for version resolution' },
    'from-manifest': { type: 'boolean', description: 'Require manifest/lockfile to supply the version; error if absent' },
  },
  async run({ args }) {
    const projectDir = process.cwd()
    let effectiveSpec = args.spec
    const parsed = parseDocSpec(effectiveSpec)
    const { spec: cleanSpec } = parseEcosystem(effectiveSpec)
    let sourceConfig: SourceConfig

    // Gate A — reject bare-name specs (ambiguous, no ecosystem hint).
    const gateAError = checkBareNameGate(effectiveSpec, parsed.kind, Boolean(args.source))
    if (gateAError) {
      consola.error(gateAError)
      process.exit(1)
      return // unreachable
    }

    // Gate B — manifest-based version resolution. Only applies to ecosystem
    // specs with no explicit version (`npm:next` / `pypi:fastapi`).
    if (parsed.kind === 'ecosystem') {
      const gateB = runManifestGate(
        parsed.ecosystem,
        parsed.name,
        parsed.version,
        projectDir,
        {
          // citty exposes kebab-case flags under the original key as defined in args.
          noManifest: Boolean(args['no-manifest']),
          fromManifest: Boolean(args['from-manifest']),
        },
      )
      if (gateB.kind === 'error') {
        consola.error(gateB.message)
        process.exit(1)
        return // unreachable
      }
      if (gateB.version) {
        consola.info(`Using version ${gateB.version} from ${gateB.source}`)
        // Mutation is intentional: the ecosystem resolver fallback at line ~365
        // calls resolver.resolve(parsed.name, parsed.version) directly, so
        // parsed.version must reflect the manifest override.
        parsed.version = gateB.version
        // Also rebuild effectiveSpec so resolveFromRegistry (which re-parses
        // from the raw spec string) picks up the override version.
        effectiveSpec = `${parsed.ecosystem}:${parsed.name}@${gateB.version}`
      }
    }

    // github fast-path: `owner/repo[@ref]` — try registry for docsPath,
    // then fall back to bare repo download.
    // Only triggered when no explicit --source override was passed.
    if (!args.source && parsed.kind === 'github') {
      const { owner, repo, ref } = parsed
      const repoSpec = `${owner}/${repo}`
      const version = ref ?? 'latest'
      const libName = `${owner}-${repo}`

      // Enrich with registry metadata (github source `path`) when available.
      // Direct owner/repo lookup returns the entry's single package on
      // single-package entries and 409 on monorepo entries — we only act
      // on the single-package case.
      let docsPath = args.docsPath
      if (!docsPath) {
        const entry = await fetchRegistryEntry(owner, repo)
        if (entry) {
          consola.info(`Found ${entry.name} in registry`)
          const githubSource = entry.sources.find(s => s.type === 'github')
          if (githubSource && githubSource.type === 'github') {
            docsPath = githubSource.path
          }
        }
      }

      consola.start(`Downloading ${repoSpec}${ref ? `@${ref}` : ''} docs (source: github)...`)
      sourceConfig = {
        source: 'github',
        name: libName,
        version,
        repo: repoSpec,
        tag: ref,
        docsPath,
      } satisfies GithubSourceOptions
    }
    else if (args.source) {
      // Explicit source — use manual config
      const { name, version } = parseSpec(cleanSpec)
      const urls = args.url ? [args.url] : undefined
      consola.start(`Downloading ${name}@${version} docs (source: ${args.source})...`)
      sourceConfig = buildSourceConfig(name, version, {
        source: args.source,
        repo: args.repo,
        branch: args.branch,
        tag: args.tag,
        docsPath: args.docsPath,
        url: urls,
        maxDepth: args.maxDepth,
        pathPrefix: args.pathPrefix,
      })
    }
    else {
      // Auto-detect from registry
      const resolved = await resolveFromRegistry(effectiveSpec, projectDir)
      if (resolved) {
        const { source } = resolved
        consola.start(`Downloading ${resolved.name}@${resolved.version} docs (source: ${source.type})...`)
        sourceConfig = sourceConfigFromRegistrySource(resolved.name, resolved.version, source)
      }
      else if (parsed.kind === 'ecosystem' && parsed.ecosystem === 'npm') {
        // Registry miss with explicit `npm:` prefix → honor the user's
        // intent and fetch the single npm tarball directly. Falling back to
        // the ecosystem resolver here would download the whole GitHub
        // monorepo (e.g. `mastra-ai/mastra` for `@mastra/client-js`), which
        // is exactly the surprise the user is trying to avoid.
        //
        // Scoped names (`@scope/pkg`) are not valid as `.ask/docs/<dir>` or
        // as Claude Code skill names, so slugify the same way the registry
        // server does: `@mastra/client-js` → `mastra-client-js`.
        const libName = parsed.name.startsWith('@')
          ? parsed.name.slice(1).replace('/', '-')
          : parsed.name
        consola.info(`Registry miss — fetching npm tarball for ${parsed.name}@${parsed.version}...`)
        sourceConfig = {
          source: 'npm',
          name: libName,
          version: parsed.version,
          package: parsed.name,
          docsPath: args.docsPath,
        } satisfies NpmSourceOptions
      }
      else if (parsed.kind === 'ecosystem') {
        // Registry miss with ecosystem prefix → try ecosystem resolver
        const resolver = getResolver(parsed.ecosystem)
        if (!resolver) {
          consola.error(
            `'${args.spec}' not found in registry and no resolver for '${parsed.ecosystem}'. `
            + `Use --source to specify manually.`,
          )
          process.exit(1)
          return // unreachable — hints TS that control flow ends
        }
        consola.info(`Registry miss — resolving via ${parsed.ecosystem} package metadata...`)
        const resolveResult = await resolver.resolve(parsed.name, parsed.version)
        consola.start(`Downloading ${parsed.name}@${resolveResult.resolvedVersion} docs (source: github via ${parsed.ecosystem} resolver)...`)
        sourceConfig = {
          source: 'github',
          name: parsed.name,
          version: resolveResult.resolvedVersion,
          repo: resolveResult.repo,
          tag: resolveResult.ref,
          docsPath: args.docsPath,
        } satisfies GithubSourceOptions
      }
      else {
        consola.error(`'${args.spec}' not found in registry. Use --source to specify manually.`)
        process.exit(1)
        return // unreachable — hints TS that control flow ends
      }
    }

    const source = getSource(sourceConfig.source)
    const result = await source.fetch(sourceConfig)
    const libName = sourceConfig.name

    consola.info(`Fetched ${result.files.length} doc files (resolved version: ${result.resolvedVersion})`)

    const docsDir = saveDocs(projectDir, libName, result.resolvedVersion, result.files)
    consola.info(`Docs saved to: ${docsDir}`)

    const configEntry = { ...sourceConfig, version: result.resolvedVersion }
    addDocEntry(projectDir, configEntry)
    consola.info(`Config updated: ${path.relative(projectDir, getConfigPath(projectDir))}`)

    const lockEntry = buildLockEntry(sourceConfig, result)
    upsertLockEntry(projectDir, libName, lockEntry)
    consola.info(`Lock updated: ${path.relative(projectDir, getLockPath(projectDir))}`)

    const skillPath = generateSkill(
      projectDir,
      libName,
      result.resolvedVersion,
      result.files.map(f => f.path),
    )
    consola.info(`Skill created: ${skillPath}`)

    const agentsPath = generateAgentsMd(projectDir)
    consola.info(`AGENTS.md updated: ${agentsPath}`)

    manageIgnoreFiles(projectDir, 'install')

    consola.success(`Done! ${libName}@${result.resolvedVersion} docs are ready for AI agents.`)
  },
})

type SyncStatus = 'drifted' | 'unchanged' | 'failed'

/**
 * Sync a single doc entry: fetch, diff, write. Never throws — failures are
 * captured and returned as `status: 'failed'`. Logs the same lines that the
 * legacy serial loop emitted, so user-facing output is unchanged.
 *
 * The internal write order (saveDocs → addDocEntry → upsertLockEntry →
 * removeDocs(old) → generateSkill) is preserved verbatim from the previous
 * implementation. See the inline comment below for the rationale.
 *
 * Safe to call from `runWithConcurrency` because:
 *   1. Only `source.fetch()` is async (network I/O).
 *   2. All disk writes (`addDocEntry`, `upsertLockEntry`, `saveDocs`,
 *      `removeDocs`, `generateSkill`) are fully synchronous fs operations
 *      with no `await` between read and write — Node's single-threaded event
 *      loop guarantees they execute atomically with respect to each other.
 */
async function syncEntry(
  projectDir: string,
  entry: SourceConfig,
  lock: Lock,
): Promise<SyncStatus> {
  try {
    consola.info(`  ${entry.name} (${entry.source})...`)
    const source = getSource(entry.source)
    const result = await source.fetch(entry)
    const newLockEntry = buildLockEntry(entry, result)
    const previousLock = lock.entries[entry.name]
    const changed = !previousLock
      || previousLock.contentHash !== newLockEntry.contentHash
      || previousLock.version !== newLockEntry.version

    if (!changed) {
      consola.info(`  -> unchanged (v${result.resolvedVersion})`)
      return 'unchanged'
    }

    // Drift confirmed. Order is intentional: every write that can throw
    // (saveDocs, addDocEntry/Zod, upsertLockEntry/Zod) happens BEFORE the
    // destructive removeDocs of the old version. A mid-flow failure
    // leaves both directories on disk and the config/lock pointing at
    // the old version — recoverable on the next sync. Reversing this
    // order would let a failed write leave config pointing at a deleted
    // directory.
    saveDocs(projectDir, entry.name, result.resolvedVersion, result.files)
    addDocEntry(projectDir, { ...entry, version: result.resolvedVersion })
    upsertLockEntry(projectDir, entry.name, newLockEntry)
    if (previousLock && previousLock.version !== result.resolvedVersion) {
      removeDocs(projectDir, entry.name, previousLock.version)
    }
    generateSkill(
      projectDir,
      entry.name,
      result.resolvedVersion,
      result.files.map(f => f.path),
    )
    const fromVersion = previousLock?.version ?? '(new)'
    consola.success(`  ⟳ ${fromVersion} → ${result.resolvedVersion} (${result.files.length} files)`)
    return 'drifted'
  }
  catch (err) {
    consola.error(`  -> Error: ${err instanceof Error ? err.message : err}`)
    return 'failed'
  }
}

// Sources that are safe to fetch in parallel. `web` is intentionally excluded
// to remain polite toward upstream documentation servers (we don't know if
// multiple URLs hit the same host, and crawl bursts can trip rate limits).
const PARALLEL_SOURCES = new Set<SourceConfig['source']>(['github', 'npm', 'llms-txt'])
const SYNC_CONCURRENCY = 5

export interface RunSyncOptions {
  /**
   * Override the per-entry sync function. Used by tests; defaults to the
   * real `syncEntry` which performs network fetches and disk writes.
   */
  syncEntryFn?: (projectDir: string, entry: SourceConfig, lock: Lock) => Promise<SyncStatus>
  /**
   * Skip the AGENTS.md regeneration step. Used by tests that don't care
   * about that side effect.
   */
  skipAgentsMd?: boolean
}

export async function runSync(
  projectDir: string,
  options: RunSyncOptions = {},
): Promise<{ drifted: number, unchanged: number, failed: number }> {
  const config = loadConfig(projectDir)
  const lock = readLock(projectDir)

  if (config.docs.length === 0) {
    consola.info('No docs configured in .ask/config.json')
    return { drifted: 0, unchanged: 0, failed: 0 }
  }

  consola.start(`Syncing ${config.docs.length} library docs...`)

  const fn = options.syncEntryFn ?? syncEntry

  const parallel: SourceConfig[] = []
  const serial: SourceConfig[] = []
  for (const entry of config.docs) {
    if (PARALLEL_SOURCES.has(entry.source)) {
      parallel.push(entry)
    }
    else {
      serial.push(entry)
    }
  }

  const parallelResults = await runWithConcurrency(
    parallel,
    SYNC_CONCURRENCY,
    entry => fn(projectDir, entry, lock),
  )

  const serialResults: SyncStatus[] = []
  for (const entry of serial) {
    serialResults.push(await fn(projectDir, entry, lock))
  }

  const counts = { drifted: 0, unchanged: 0, failed: 0 }
  for (const status of [...parallelResults, ...serialResults]) {
    counts[status]++
  }

  if (!options.skipAgentsMd) {
    generateAgentsMd(projectDir)
  }
  // `skipAgentsMd` is specifically about AGENTS.md regeneration; ignore
  // file management always runs so that the project's lint/format/review
  // tooling stays in sync with the current `.ask/docs/` state.
  manageIgnoreFiles(projectDir, 'install')
  consola.success(
    `Sync complete: ${counts.drifted} re-fetched, ${counts.unchanged} unchanged, ${counts.failed} failed. AGENTS.md updated.`,
  )
  return counts
}

const syncCmd = defineCommand({
  meta: { name: 'sync', description: 'Refresh docs from .ask/config.json, using .ask/ask.lock as the drift baseline' },
  async run() {
    await runSync(process.cwd())
  },
})

const listCmd = defineCommand({
  meta: { name: 'list', description: 'List downloaded documentation' },
  run() {
    const projectDir = process.cwd()
    const entries = listDocs(projectDir)

    if (entries.length === 0) {
      consola.info('No docs downloaded yet. Use `ask docs add` to get started.')
      return
    }

    consola.info('Downloaded documentation:')
    for (const { name, version, fileCount } of entries) {
      consola.log(`  ${name}@${version}  (${fileCount} files)`)
    }
  },
})

const removeCmd = defineCommand({
  meta: { name: 'remove', description: 'Remove downloaded documentation' },
  args: {
    spec: { type: 'positional', description: 'Library spec (e.g. zod or zod@3.22)', required: true },
  },
  run({ args }) {
    const projectDir = process.cwd()
    const { name, version } = parseSpec(args.spec)
    const hasExplicitVersion = args.spec.lastIndexOf('@') > 0
    const ver = hasExplicitVersion ? version : undefined

    removeDocs(projectDir, name, ver)
    removeSkill(projectDir, name)
    removeDocEntry(projectDir, name, ver)
    generateAgentsMd(projectDir)

    // If no docs remain, strip all ignore-file artifacts. Otherwise keep
    // them in sync (e.g. a new root .prettierignore added since last add).
    const remaining = listDocs(projectDir)
    manageIgnoreFiles(projectDir, remaining.length === 0 ? 'remove' : 'install')

    consola.success(`Removed docs for ${name}${ver ? `@${ver}` : ' (all versions)'}`)
  },
})

const docsCmd = defineCommand({
  meta: { name: 'docs', description: 'Manage library documentation' },
  subCommands: {
    add: addCmd,
    sync: syncCmd,
    list: listCmd,
    remove: removeCmd,
  },
})

// Read version from package.json at runtime so release-please bumps
// automatically propagate to `--version` output. Using `new URL` with
// `import.meta.url` resolves relative to the compiled file location
// (`dist/index.js` → `../package.json`), which works for both the published
// tarball (where `package.json` sits next to `dist/`) and local dev builds.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

export const main = defineCommand({
  meta: {
    name: 'ask',
    version: pkg.version,
    description: 'Agent Skills Kit - Download version-specific library docs for AI coding agents',
  },
  subCommands: {
    docs: docsCmd,
  },
})

// CLI execution is handled by `./cli.ts` (the `bin` entry). This file is a
// pure library module: importing it must not trigger `runMain`.
