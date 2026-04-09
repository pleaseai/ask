#!/usr/bin/env node

import type { DiscoveryResult } from './discovery/index.js'
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
import { removeFromIntentSkillsBlock, upsertIntentSkillsBlock } from './agents-intent.js'
import { generateAgentsMd } from './agents.js'
import { runWithConcurrency } from './concurrency.js'
import {
  addDocEntry,
  loadConfig,
  removeDocEntry,
} from './config.js'
import { runLocalDiscovery } from './discovery/index.js'
import { localIntentAdapter } from './discovery/local-intent.js'
import { manageIgnoreFiles } from './ignore-files.js'
import { contentHash, getConfigPath, getLockPath, readLock, removeLockEntries, upsertLockEntry } from './io.js'
import { getReader } from './manifest/index.js'
import { fetchRegistryEntry, parseDocSpec, parseEcosystem, resolveFromRegistry } from './registry.js'
import { getResolver } from './resolvers/index.js'
import { generateSkill, removeSkill } from './skill.js'
import { getSource } from './sources/index.js'
import { listDocs, removeDocs, saveDocs } from './storage.js'

/**
 * `@mastra/client-js` → `mastra-client-js`. Scoped names are not valid
 * directory names under `.ask/docs/` or Claude Code skill dir names, so
 * we flatten them the same way the registry server does. Extracted into
 * a helper because both the registry-miss path and the local-discovery
 * dispatcher need the same slug to key lock entries.
 */
function slugifyNpmName(pkgName: string): string {
  return pkgName.startsWith('@')
    ? pkgName.slice(1).replace('/', '-')
    : pkgName
}

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

/**
 * Dispatch a local-stage `DiscoveryResult` to the correct write pipeline.
 *
 *   - `kind: 'docs'`          → existing ask pipeline
 *                               (saveDocs + addDocEntry + upsertLockEntry +
 *                               generateSkill + generateAgentsMd + ignore
 *                               files).  When `installPath` is set the
 *                               lock entry records it so `ask docs sync`
 *                               can short-circuit on a version match.
 *   - `kind: 'intent-skills'` → intent pipeline
 *                               (upsertLockEntry with `format:
 *                               'intent-skills'` +
 *                               upsertIntentSkillsBlock).  No
 *                               `.ask/docs/` copy, no
 *                               `.claude/skills/` generation — the
 *                               AGENTS.md marker block is the sole wire-up
 *                               per the Intent format contract.
 *
 * Returns nothing; on failure throws and lets the CLI top-level handler
 * report the error. The caller should `return` after invocation to skip
 * the downstream registry / resolver pipeline.
 */
async function handleLocalDiscovery(
  projectDir: string,
  pkgName: string,
  discovery: DiscoveryResult,
): Promise<void> {
  const libName = slugifyNpmName(pkgName)

  if (discovery.kind === 'intent-skills') {
    // Intent format: hash over the skill entries so `ask docs sync` can
    // detect drift without comparing the actual SKILL.md bytes (which
    // live in node_modules and change with `bun install`). Stable
    // JSON form — order of skill entries is preserved by the adapter.
    const hashable = discovery.skills.map((s, i) => ({
      relpath: `intent-skill-${i}`,
      content: `${s.task}\n${s.load}`,
    }))
    const lockEntry = {
      source: 'npm' as const,
      version: discovery.resolvedVersion,
      fetchedAt: new Date().toISOString(),
      fileCount: discovery.skills.length,
      contentHash: contentHash(hashable),
      installPath: discovery.installPath,
      format: 'intent-skills' as const,
    }
    upsertLockEntry(projectDir, libName, lockEntry)
    consola.info(
      `Lock updated (format: intent-skills): ${path.relative(projectDir, getLockPath(projectDir))}`,
    )

    const agentsPath = upsertIntentSkillsBlock(projectDir, pkgName, discovery.skills)
    consola.info(`AGENTS.md intent-skills block updated: ${path.relative(projectDir, agentsPath)}`)

    consola.success(
      `Done! ${pkgName}@${discovery.resolvedVersion} (${discovery.skills.length} intent skill${discovery.skills.length === 1 ? '' : 's'}) are ready for AI agents.`,
    )
    return
  }

  // docs-kind: reuse the existing ask pipeline.  The fact that we
  // discovered it locally (vs through a registry call) is transparent
  // from this point on — the lock entry records `installPath` so future
  // `ask docs sync` runs can short-circuit when the installed version
  // still matches.
  consola.start(
    `Discovered ${pkgName}@${discovery.resolvedVersion} via ${discovery.adapter} adapter (${discovery.files.length} files)`,
  )

  const sourceConfig: NpmSourceOptions = {
    source: 'npm',
    name: libName,
    version: discovery.resolvedVersion,
    package: pkgName,
    docsPath: discovery.docsPath,
  }

  const syntheticFetch: FetchResult = {
    files: discovery.files,
    resolvedVersion: discovery.resolvedVersion,
    meta: discovery.installPath ? { installPath: discovery.installPath } : {},
  }

  // Materialize a copy under `.ask/docs/<name>@<ver>/` so `listDocs` and
  // `generateAgentsMd` see the entry without needing an install-path-aware
  // rewrite of the lister (deferred, see Surprises & Discoveries in the
  // plan). `ask docs sync` still re-reads from `installPath` on the next
  // run because `NpmSource.tryLocalRead` is consulted first.
  const docsDir = saveDocs(projectDir, libName, discovery.resolvedVersion, discovery.files)
  consola.info(`Docs saved to: ${docsDir}`)

  addDocEntry(projectDir, { ...sourceConfig, version: discovery.resolvedVersion })
  consola.info(`Config updated: ${path.relative(projectDir, getConfigPath(projectDir))}`)

  const lockEntry = buildLockEntry(sourceConfig, syntheticFetch)
  upsertLockEntry(projectDir, libName, lockEntry)
  consola.info(`Lock updated: ${path.relative(projectDir, getLockPath(projectDir))}`)

  const skillPath = generateSkill(
    projectDir,
    libName,
    discovery.resolvedVersion,
    discovery.files.map(f => f.path),
  )
  consola.info(`Skill created: ${skillPath}`)

  const agentsPath = generateAgentsMd(projectDir)
  consola.info(`AGENTS.md updated: ${agentsPath}`)

  manageIgnoreFiles(projectDir, 'install')

  consola.success(`Done! ${pkgName}@${discovery.resolvedVersion} docs are ready for AI agents.`)
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

    // Local convention-based discovery — the new pre-registry stage.
    //
    // Runs only for `npm:` ecosystem specs without an explicit `--source`
    // or `--docs-path`: those two flags are the power-user overrides, so
    // we honour them by skipping discovery entirely and falling through
    // to the existing registry / resolver pipeline.
    //
    // On a hit, `handleLocalDiscovery` performs all writes and we return
    // early. On a miss, we continue to the github fast-path / registry
    // auto-detect just like before.
    if (
      !args.source
      && !args.docsPath
      && parsed.kind === 'ecosystem'
      && parsed.ecosystem === 'npm'
    ) {
      const discovery = await runLocalDiscovery({
        projectDir,
        pkg: parsed.name,
        requestedVersion: parsed.version,
      })
      if (discovery) {
        await handleLocalDiscovery(projectDir, parsed.name, discovery)
        return
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

  // Collect intent-skills lock entries up front — they have no
  // `config.docs` row, so the early-exit on empty config would
  // otherwise skip them entirely for intent-only projects.
  const intentKeysPrecomputed: string[] = []
  for (const [key, entry] of Object.entries(lock.entries)) {
    if (entry.source === 'npm' && entry.format === 'intent-skills') {
      intentKeysPrecomputed.push(key)
    }
  }

  if (config.docs.length === 0 && intentKeysPrecomputed.length === 0) {
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

  // Intent-skills entries live only in the lock (no config.docs row), so
  // they need a second pass that iterates `lock.entries` filtered by
  // `format: 'intent-skills'`. For each one we re-run the local-intent
  // adapter against the currently installed package and upsert the
  // marker block. If the package was uninstalled from `node_modules`,
  // the adapter returns null and we leave the existing block alone —
  // users can explicitly remove it via `ask docs remove <pkg>`.
  const intentKeys = intentKeysPrecomputed
  if (intentKeys.length > 0) {
    consola.info(`Resyncing ${intentKeys.length} intent-skills entr${intentKeys.length === 1 ? 'y' : 'ies'}...`)
    for (const key of intentKeys) {
      const entry = lock.entries[key]
      if (!entry || entry.source !== 'npm') {
        continue
      }
      // `installPath` is the `node_modules/<pkg>` root we recorded at
      // `ask docs add` time; the trailing segment is the original npm
      // package name which may differ from the slugged lock key
      // (`mastra-client-js` vs `@mastra/client-js`).
      const installPath = entry.installPath
      if (!installPath) {
        continue
      }
      const pkgName = inferPackageNameFromInstallPath(installPath)
      if (!pkgName) {
        continue
      }
      try {
        const result = await localIntentAdapter({
          projectDir,
          pkg: pkgName,
          requestedVersion: 'latest',
        })
        if (!result || result.kind !== 'intent-skills') {
          consola.warn(`  ${pkgName}: intent package no longer detected, skipping`)
          continue
        }
        upsertIntentSkillsBlock(projectDir, pkgName, result.skills)
        const hashable = result.skills.map((s, i) => ({
          relpath: `intent-skill-${i}`,
          content: `${s.task}\n${s.load}`,
        }))
        upsertLockEntry(projectDir, key, {
          source: 'npm',
          version: result.resolvedVersion,
          fetchedAt: new Date().toISOString(),
          fileCount: result.skills.length,
          contentHash: contentHash(hashable),
          installPath: result.installPath,
          format: 'intent-skills',
        })
        consola.info(`  ${pkgName}: updated (${result.skills.length} skills)`)
      }
      catch (err) {
        consola.error(`  ${pkgName}: ${err instanceof Error ? err.message : err}`)
        counts.failed++
      }
    }
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

/**
 * Extract the npm package name from an absolute `node_modules/<pkg>`
 * path. Handles scoped packages — `/foo/node_modules/@scope/pkg` returns
 * `@scope/pkg`. Returns `null` when the path does not look like a
 * `node_modules/...` installation root.
 */
function inferPackageNameFromInstallPath(installPath: string): string | null {
  const marker = `${path.sep}node_modules${path.sep}`
  const idx = installPath.lastIndexOf(marker)
  if (idx === -1) {
    return null
  }
  const after = installPath.slice(idx + marker.length)
  const parts = after.split(path.sep).filter(Boolean)
  if (parts.length === 0) {
    return null
  }
  if (parts[0]!.startsWith('@') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`
  }
  return parts[0]!
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

    // Branch on lock entry format: intent-skills entries have no
    // `.ask/docs/` copy, no `.claude/skills/` dir, and no `config.docs`
    // record — they live exclusively in the `<!-- intent-skills:start -->`
    // AGENTS.md block and a format-tagged lock entry. Removing one means
    // stripping the marker entry and dropping the lock row; the ask-docs
    // block in AGENTS.md is untouched.
    const libName = slugifyNpmName(name)
    const currentLock = readLock(projectDir)
    const lockEntry = currentLock.entries[libName] ?? currentLock.entries[name]
    const lockKey = currentLock.entries[libName] ? libName : name
    const isIntent
      = lockEntry?.source === 'npm' && lockEntry.format === 'intent-skills'

    if (isIntent) {
      const removed = removeFromIntentSkillsBlock(projectDir, name)
      // Drop the lock entry directly — there is no `config.docs` entry
      // to reconcile for intent-skills format.
      removeLockEntries(projectDir, [lockKey])
      if (removed) {
        consola.success(`Removed intent-skills block entry for ${name}`)
      }
      else {
        consola.warn(`No AGENTS.md intent-skills entry found for ${name}`)
      }
      return
    }

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
