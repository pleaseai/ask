#!/usr/bin/env node

import type { Lock, LockEntry } from './schemas.js'
import type {
  FetchResult,
  GithubSourceOptions,
  LlmsTxtSourceOptions,
  NpmSourceOptions,
  SourceConfig,
  WebSourceOptions,
} from './sources/index.js'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { generateAgentsMd } from './agents.js'
import { runWithConcurrency } from './concurrency.js'
import {
  addDocEntry,
  loadConfig,
  removeDocEntry,
} from './config.js'
import { contentHash, getConfigPath, getLockPath, readLock, upsertLockEntry } from './io.js'
import { migrateLegacyWorkspace } from './migrate-legacy.js'
import { parseDocSpec, parseEcosystem, resolveFromRegistry } from './registry.js'
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
    case 'npm':
      if (!meta.tarball) {
        throw new Error(
          `npm source did not return a tarball URL for ${config.name}@${result.resolvedVersion}. `
          + 'Cannot record lockfile entry without it.',
        )
      }
      return {
        ...base,
        source: 'npm',
        tarball: meta.tarball,
        ...(meta.integrity ? { integrity: meta.integrity } : {}),
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
    spec: { type: 'positional', description: 'Library spec (e.g. zod@3.22 or npm:next@canary)', required: true },
    source: { type: 'string', description: 'Source type: npm, github, web, llms-txt (auto-detected if omitted)', alias: ['s'] },
    repo: { type: 'string', description: 'GitHub repository (for github source)' },
    branch: { type: 'string', description: 'Git branch (for github source)' },
    tag: { type: 'string', description: 'Git tag (for github source)' },
    docsPath: { type: 'string', description: 'Path to docs within the package/repo' },
    url: { type: 'string', description: 'Documentation URL (for web source)' },
    maxDepth: { type: 'string', description: 'Max crawl depth for web source', default: '1' },
    pathPrefix: { type: 'string', description: 'URL path prefix filter for web source' },
  },
  async run({ args }) {
    const projectDir = process.cwd()
    migrateLegacyWorkspace(projectDir)
    const parsed = parseDocSpec(args.spec)
    const { spec: cleanSpec } = parseEcosystem(args.spec)
    let sourceConfig: SourceConfig

    // github fast-path: `owner/repo[@ref]` skips the registry entirely.
    // Only triggered when no explicit --source override was passed.
    if (!args.source && parsed.kind === 'github') {
      const { owner, repo, ref } = parsed
      const repoSpec = `${owner}/${repo}`
      const version = ref ?? 'latest'
      // Stored library name includes the owner so two repos that share a
      // bare name (e.g. `vercel/next.js` and `another/next.js`) don't
      // collide on disk / config / lock. Slash is replaced with `-`
      // because the name is used as a directory segment.
      const libName = `${owner}-${repo}`
      consola.start(`Downloading ${repoSpec}${ref ? `@${ref}` : ''} docs (source: github)...`)
      sourceConfig = {
        source: 'github',
        name: libName,
        version,
        repo: repoSpec,
        // `ref` is opaque — let the github source resolve tag-vs-branch.
        tag: ref,
        docsPath: args.docsPath,
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
      const resolved = await resolveFromRegistry(args.spec, projectDir)
      if (resolved) {
        const { strategy } = resolved
        consola.start(`Downloading ${resolved.name}@${resolved.version} docs (source: ${strategy.source})...`)
        sourceConfig = buildSourceConfig(resolved.name, resolved.version, {
          source: strategy.source,
          repo: strategy.repo,
          docsPath: strategy.docsPath,
          url: strategy.urls ?? (strategy.url ? [strategy.url] : undefined),
          maxDepth: strategy.maxDepth?.toString(),
          pathPrefix: strategy.allowedPathPrefix,
          branch: strategy.branch,
          tag: strategy.tag,
        })
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
  migrateLegacyWorkspace(projectDir)
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
    migrateLegacyWorkspace(projectDir)
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
    migrateLegacyWorkspace(projectDir)
    const { name, version } = parseSpec(args.spec)
    const hasExplicitVersion = args.spec.lastIndexOf('@') > 0
    const ver = hasExplicitVersion ? version : undefined

    removeDocs(projectDir, name, ver)
    removeSkill(projectDir, name)
    removeDocEntry(projectDir, name, ver)
    generateAgentsMd(projectDir)

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

const main = defineCommand({
  meta: {
    name: 'ask',
    version: '0.1.0',
    description: 'Agent Skills Kit - Download version-specific library docs for AI coding agents',
  },
  subCommands: {
    docs: docsCmd,
  },
})

// Only execute the CLI when this module is the program entry point.
// Tests import `runSync` from this file and must NOT trigger CLI execution.
// Use `pathToFileURL` for a cross-platform comparison: a naive
// `file://${process.argv[1]}` template breaks on Windows (backslash paths)
// and on POSIX paths containing spaces or unicode (no URL encoding).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain(main)
}
