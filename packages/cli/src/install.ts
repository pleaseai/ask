import type { DocsDiscoveryResult, LocalDiscoveryAdapter } from './discovery/types.js'
import type { LibraryEntry, ResolvedEntry, StoreMode } from './schemas.js'
import type { DocFile, GithubSourceOptions, NpmSourceOptions, SourceConfig } from './sources/index.js'
import fs from 'node:fs'
import path from 'node:path'
import { consola } from 'consola'
import { upsertIntentSkillsBlock } from './agents-intent.js'
import { generateAgentsMd } from './agents.js'
import { runLocalDiscovery } from './discovery/index.js'
import { localIntentAdapter } from './discovery/local-intent.js'
import { manageIgnoreFiles } from './ignore-files.js'
import {
  contentHash,
  getAskJsonPath,
  readAskJson,
  readResolvedJson,
  removeResolvedEntries,
  upsertResolvedEntry,
  writeAskJson,
  writeResolvedJson,
} from './io.js'
import { npmEcosystemReader } from './lockfiles/index.js'
import { fetchRegistryEntry } from './registry.js'
import { generateSkill, getSkillDir } from './skill.js'
import { getSource } from './sources/index.js'
import { parseSpec } from './spec.js'
import { removeDocs, saveDocs } from './storage.js'
import { npmStorePath, quarantineEntry, resolveAskHome, verifyEntry } from './store/index.js'

const RE_LEADING_V = /^v/

export interface RunInstallOptions {
  /** Subset of libraries to install (by spec). When omitted, install all. */
  onlySpecs?: string[]
  /** Force re-fetch even when the resolved-cache short-circuit would skip. */
  force?: boolean
  /**
   * When true, emit a `.claude/skills/<name>-docs/SKILL.md` file alongside
   * the AGENTS.md block. Overrides the `emitSkill` field in `ask.json`.
   * Precedence: CLI flag > ask.json `emitSkill` > default false.
   */
  emitSkill?: boolean
  /**
   * How to materialize store entries into the project.
   * Precedence: CLI flag > ask.json `storeMode` > 'copy'.
   */
  storeMode?: StoreMode
  /**
   * When set to false, disable in-place referencing of discovery-detected
   * npm docs and force the copy path. Overrides the `inPlace` field in
   * `ask.json`. Precedence: CLI flag > ask.json `inPlace` > default true.
   */
  inPlace?: boolean
}

export interface InstallSummary {
  installed: number
  unchanged: number
  skipped: number
  failed: number
}

/**
 * Main `ask install` orchestrator.
 *
 * Reads `ask.json`, resolves each entry against the right source of
 * truth (lockfile for PM-driven, `ref` for standalone github),
 * short-circuits via `.ask/resolved.json` content hash, and writes the
 * materialized output. Per FR-10 / AC-5, individual entry failures are
 * warned and skipped — exit code is 0 even when some entries fail so
 * that `postinstall` integration stays robust.
 */
export async function runInstall(
  projectDir: string,
  options: RunInstallOptions = {},
): Promise<InstallSummary> {
  let askJson = readAskJson(projectDir)
  if (!askJson) {
    // FR-8: bootstrap an empty ask.json and exit cleanly. The user can
    // then run `ask add npm:<pkg>` to declare their first entry.
    askJson = { libraries: [] }
    writeAskJson(projectDir, askJson)
    consola.info(
      `Created empty ${path.relative(projectDir, getAskJsonPath(projectDir))}. `
      + 'Add libraries with `ask add npm:<package>` or `ask add github:<owner>/<repo>`.',
    )
    return { installed: 0, unchanged: 0, skipped: 0, failed: 0 }
  }

  // Resolve emitSkill: CLI flag (options.emitSkill) > ask.json emitSkill > false.
  // The CLI flag wins when explicitly supplied (true or false).
  // When absent (undefined), fall through to the ask.json field, then default false.
  const resolvedEmitSkill: boolean = options.emitSkill ?? askJson.emitSkill ?? false

  // Resolve storeMode: CLI flag > ask.json storeMode > 'copy'.
  const resolvedStoreMode: StoreMode = options.storeMode ?? askJson.storeMode ?? 'copy'

  // Resolve inPlace: CLI flag (options.inPlace) > ask.json inPlace > true.
  // Default is true: discovery-detected npm docs are referenced in place.
  const resolvedInPlace: boolean = options.inPlace ?? askJson.inPlace ?? true

  const targets = options.onlySpecs
    ? askJson.libraries.filter(l => options.onlySpecs!.includes(l.spec))
    : askJson.libraries

  if (targets.length === 0) {
    consola.info('No libraries to install.')
    return { installed: 0, unchanged: 0, skipped: 0, failed: 0 }
  }

  consola.start(`Installing ${targets.length} librar${targets.length === 1 ? 'y' : 'ies'}...`)

  const summary: InstallSummary = { installed: 0, unchanged: 0, skipped: 0, failed: 0 }

  for (const lib of targets) {
    try {
      const status = await installOne(
        projectDir,
        lib,
        options,
        resolvedEmitSkill,
        resolvedStoreMode,
        resolvedInPlace,
      )
      summary[status]++
    }
    catch (err) {
      consola.warn(
        `  ${lib.spec}: ${err instanceof Error ? err.message : String(err)} — skipping`,
      )
      summary.failed++
    }
  }

  // AGENTS.md + ignore files always run, even on partial failure, so
  // the on-disk state reflects the entries that DID land.
  generateAgentsMd(projectDir)
  manageIgnoreFiles(projectDir, 'install')

  consola.success(
    `Install complete: ${summary.installed} installed, ${summary.unchanged} unchanged, `
    + `${summary.skipped} skipped, ${summary.failed} failed.`,
  )
  return summary
}

type InstallStatus = 'installed' | 'unchanged' | 'skipped' | 'failed'

async function installOne(
  projectDir: string,
  lib: LibraryEntry,
  options: RunInstallOptions,
  emitSkill: boolean,
  storeMode: StoreMode,
  inPlace: boolean = true,
): Promise<InstallStatus> {
  const parsed = parseSpec(lib.spec)
  const libName = parsed.name
  const isStandaloneGithub = 'ref' in lib

  // Resolve version: lockfile (PM-driven) or `ref` (standalone github).
  // For standalone GitHub entries, strip a leading "v" from the ref so
  // the resolved-cache key and docs-path match the version that
  // GithubSource.fetch() returns (it normalises tags the same way).
  let resolvedVersion: string
  if (isStandaloneGithub) {
    resolvedVersion = lib.ref.replace(RE_LEADING_V, '')
  }
  else if (parsed.kind === 'npm') {
    const hit = npmEcosystemReader.read(parsed.pkg, projectDir)
    if (!hit) {
      // FR-9: PM-driven entry with no lockfile match → warn and skip.
      consola.warn(
        `  ${lib.spec}: not found in any lockfile (bun.lock / package-lock.json / `
        + `pnpm-lock.yaml / yarn.lock / package.json) — skipping`,
      )
      return 'skipped'
    }
    resolvedVersion = hit.version
  }
  else if (parsed.kind === 'github') {
    // PM-driven github (no `ref`) is not supported — should have been
    // rejected by the schema, but defensive guard for clarity.
    consola.warn(`  ${lib.spec}: github entries require an explicit \`ref\` field — skipping`)
    return 'skipped'
  }
  else {
    consola.warn(`  ${lib.spec}: unknown ecosystem '${parsed.ecosystem}' — skipping`)
    return 'skipped'
  }

  // First-pass intent-skills detection — only for npm-ecosystem entries
  // where the package is actually installed in node_modules. The
  // adapter consults `keywords: ['tanstack-intent']`. If it matches we
  // take the intent path and never touch `.ask/docs/`.
  if (parsed.kind === 'npm') {
    const intent = await runIntentAdapter(localIntentAdapter, {
      projectDir,
      pkg: parsed.pkg,
      requestedVersion: resolvedVersion,
    })
    if (intent) {
      return await materializeIntent(projectDir, lib, libName, intent.skills, intent.resolvedVersion, options)
    }
  }

  // In-place discovery: when enabled and no explicit docsPath is supplied,
  // run local discovery to check if the package ships docs in node_modules.
  // If discovery returns an in-place result, skip the copy pipeline entirely.
  if (inPlace && parsed.kind === 'npm' && !lib.docsPath) {
    const discovery = await runLocalDiscovery({
      projectDir,
      pkg: parsed.pkg,
      requestedVersion: resolvedVersion,
    })
    if (discovery && discovery.kind === 'docs' && discovery.inPlace && discovery.installPath) {
      return await materializeInPlace(
        projectDir,
        lib,
        libName,
        discovery,
        options,
        emitSkill,
      )
    }
  }

  // Standard docs path: build a SourceConfig and dispatch to the
  // existing source adapter. NPM goes through registry/local-first;
  // github uses the entry's docsPath + ref directly.
  const sourceConfig = await buildSourceConfigForEntry(lib, libName, resolvedVersion)
  if (!sourceConfig) {
    consola.warn(`  ${lib.spec}: could not build a source config — skipping`)
    return 'skipped'
  }

  // Resolved-cache short-circuit — if a previous install recorded the
  // same spec at the same resolved version AND the materialized files
  // still exist, skip the fetch.
  if (!options.force) {
    const cached = readResolvedJson(projectDir).entries[libName]
    const docsDir = path.join(projectDir, '.ask', 'docs', `${libName}@${resolvedVersion}`)
    if (
      cached
      && cached.spec === lib.spec
      && cached.resolvedVersion === resolvedVersion
      && cached.format !== 'intent-skills'
      && fs.existsSync(docsDir)
    ) {
      // Docs are cached, but skill may still need generation if emitSkill
      // was toggled on after a previous install without it.
      if (emitSkill && !fs.existsSync(path.join(getSkillDir(projectDir, libName), 'SKILL.md'))) {
        const files = fs.readdirSync(docsDir, { recursive: true })
          .map(f => String(f))
          .filter(f => fs.statSync(path.join(docsDir, f)).isFile())
        generateSkill(projectDir, libName, resolvedVersion, files)
        consola.info(`  ${lib.spec}: already up to date — generated skill (${resolvedVersion})`)
        return 'unchanged'
      }
      consola.info(`  ${lib.spec}: already up to date (${resolvedVersion})`)
      return 'unchanged'
    }
  }

  // Global store hit: if a previous install on this machine already
  // populated the store for this (pkg, version), materialize directly
  // from the store without touching the source adapter. Applies only
  // to npm for now — github entries are keyed on ref (which we have)
  // but reading the store entry requires re-parsing with the right
  // docsPath, handled by the source adapter's store-hit branch.
  if (!options.force && parsed.kind === 'npm' && sourceConfig.source === 'npm') {
    const askHome = resolveAskHome()
    const storeDir = npmStorePath(askHome, parsed.pkg, resolvedVersion)
    // verifyEntry guard: never short-circuit on a store entry whose
    // stamp is missing or whose content hash does not match. A
    // corrupted entry is quarantined and the install falls through to
    // a fresh fetch via the source adapter.
    if (fs.existsSync(storeDir) && verifyEntry(storeDir)) {
      const files = readFilesFromStore(storeDir)
      if (files.length > 0) {
        consola.info(`  ${lib.spec}: store hit ${libName}@${resolvedVersion}`)
        saveDocs(projectDir, libName, resolvedVersion, files, {
          storeMode,
          storePath: storeDir,
        })
        if (emitSkill) {
          generateSkill(projectDir, libName, resolvedVersion, files.map(f => f.path))
        }
        upsertResolvedEntry(projectDir, libName, {
          spec: lib.spec,
          resolvedVersion,
          contentHash: contentHash(files.map(f => ({ relpath: f.path, content: f.content }))),
          fetchedAt: new Date().toISOString(),
          fileCount: files.length,
          format: 'docs',
          storePath: storeDir,
          materialization: storeMode,
        })
        return 'installed'
      }
    }
    else if (fs.existsSync(storeDir)) {
      // Entry exists but failed verification — quarantine and
      // continue to the fresh-fetch path below.
      quarantineEntry(askHome, storeDir)
    }
  }

  consola.info(`  ${lib.spec}: fetching ${libName}@${resolvedVersion}...`)
  const source = getSource(sourceConfig.source)
  const result = await source.fetch(sourceConfig)

  // Determine effective materialization mode. If the source returned a
  // storePath, honor the requested storeMode. Otherwise, fall back to
  // copy (the source wrote files but not to the global store).
  const effectiveMode = result.storePath ? storeMode : 'copy'

  saveDocs(projectDir, libName, result.resolvedVersion, result.files, {
    storeMode: effectiveMode,
    storePath: result.storePath,
    storeSubpath: result.storeSubpath,
  })
  if (emitSkill) {
    generateSkill(
      projectDir,
      libName,
      result.resolvedVersion,
      result.files.map(f => f.path),
    )
  }

  const entry: ResolvedEntry = {
    spec: lib.spec,
    resolvedVersion: result.resolvedVersion,
    contentHash: contentHash(result.files.map(f => ({ relpath: f.path, content: f.content }))),
    fetchedAt: new Date().toISOString(),
    fileCount: result.files.length,
    format: 'docs',
    storePath: result.storePath,
    storeSubpath: result.storeSubpath,
    materialization: effectiveMode,
    // Propagate the github commit SHA (captured via git rev-parse HEAD
    // in the github source). For npm/web/llms-txt `meta.commit` is
    // unset so this is a no-op.
    commit: result.meta?.commit,
  }
  upsertResolvedEntry(projectDir, libName, entry)

  consola.success(`  ${lib.spec}: installed ${libName}@${result.resolvedVersion} (${result.files.length} files)`)
  return 'installed'
}

/**
 * Materialize an in-place discovery result: skip `saveDocs`, clean up any
 * stale `.ask/docs/<name>@<ver>/` directories left by previous copy installs,
 * generate a skill file pointing at the node_modules path, and stamp the
 * resolved cache with `materialization: 'in-place'`.
 */
async function materializeInPlace(
  projectDir: string,
  lib: LibraryEntry,
  libName: string,
  discovery: DocsDiscoveryResult,
  options: RunInstallOptions,
  emitSkill: boolean,
): Promise<InstallStatus> {
  const resolvedVersion = discovery.resolvedVersion
  const docsPath = discovery.docsPath ?? ''
  const inPlacePath = path.relative(
    projectDir,
    path.join(discovery.installPath!, docsPath),
  )

  // Resolved-cache short-circuit: if the same spec + version + in-place path
  // is already recorded, skip.
  if (!options.force) {
    const cached = readResolvedJson(projectDir).entries[libName]
    if (
      cached
      && cached.spec === lib.spec
      && cached.resolvedVersion === resolvedVersion
      && cached.materialization === 'in-place'
      && cached.inPlacePath === inPlacePath
    ) {
      // Skill may still need generation if emitSkill was toggled on.
      if (emitSkill && !fs.existsSync(path.join(getSkillDir(projectDir, libName), 'SKILL.md'))) {
        generateSkill(projectDir, libName, resolvedVersion, discovery.files.map(f => f.path), { docsDir: inPlacePath })
        consola.info(`  ${lib.spec}: already up to date (in-place) — generated skill (${resolvedVersion})`)
        return 'unchanged'
      }
      consola.info(`  ${lib.spec}: already up to date (in-place, ${resolvedVersion})`)
      return 'unchanged'
    }
  }

  // Clean up any stale vendored directories from previous copy installs
  // (SC-8: pre-existing .ask/docs/next@<old>/ removed on first in-place install).
  removeDocs(projectDir, libName)

  // Generate skill file pointing at the in-place docs path.
  if (emitSkill) {
    generateSkill(projectDir, libName, resolvedVersion, discovery.files.map(f => f.path), { docsDir: inPlacePath })
  }

  // Stamp the resolved cache.
  const entry: ResolvedEntry = {
    spec: lib.spec,
    resolvedVersion,
    contentHash: contentHash(discovery.files.map(f => ({ relpath: f.path, content: f.content }))),
    fetchedAt: new Date().toISOString(),
    fileCount: discovery.files.length,
    format: 'docs',
    materialization: 'in-place',
    inPlacePath,
  }
  upsertResolvedEntry(projectDir, libName, entry)

  consola.success(
    `  ${lib.spec}: installed in-place ${libName}@${resolvedVersion} `
    + `(${discovery.files.length} files at ${inPlacePath})`,
  )
  return 'installed'
}

/**
 * Build the SourceConfig that the existing source adapters expect from
 * a single `ask.json` library entry. Returns null when the entry shape
 * cannot be mapped (e.g. unknown ecosystem).
 */
async function buildSourceConfigForEntry(
  lib: LibraryEntry,
  libName: string,
  resolvedVersion: string,
): Promise<SourceConfig | null> {
  if ('ref' in lib) {
    // Standalone github entry — owner/repo from spec, ref + docsPath
    // from the entry. Existing tarball-based github source consumes
    // this directly.
    const parsed = parseSpec(lib.spec)
    if (parsed.kind !== 'github') {
      return null
    }
    return {
      source: 'github',
      name: libName,
      version: resolvedVersion,
      repo: `${parsed.owner}/${parsed.repo}`,
      tag: lib.ref,
      docsPath: lib.docsPath,
    } satisfies GithubSourceOptions
  }

  const parsed = parseSpec(lib.spec)
  if (parsed.kind === 'npm') {
    // npm: try registry for an enriched docsPath/source-priority
    // recipe; otherwise fetch the tarball directly. Honoring the
    // registry is what makes curated entries (vercel/ai etc.) load
    // from `dist/docs` instead of crawling the whole repo.
    let docsPath = lib.docsPath
    if (!docsPath) {
      // Best-effort: ask the registry by owner/repo. If the npm
      // package's GitHub mirror happens to be a curated entry, we
      // pick up its docsPath. We deliberately do NOT call the
      // ecosystem resolver here — it would expand the spec to a full
      // GitHub monorepo download, which is a behaviour change vs
      // the existing local-first npm path.
      try {
        const enriched = await tryEnrichDocsPathFromRegistry(parsed.pkg)
        if (enriched) {
          docsPath = enriched
        }
      }
      catch {
        // registry lookup is best-effort
      }
    }
    return {
      source: 'npm',
      name: libName,
      version: resolvedVersion,
      package: parsed.pkg,
      docsPath,
    } satisfies NpmSourceOptions
  }

  return null
}

async function tryEnrichDocsPathFromRegistry(pkg: string): Promise<string | undefined> {
  // Skip the lookup for scoped packages — the registry lookup is keyed
  // on owner/repo and we don't have a cheap way to resolve a scoped
  // npm name to a github owner/repo without the resolver.
  if (pkg.startsWith('@')) {
    return undefined
  }
  // Try to fetch the entry by owner=pkg, repo=pkg (the only stable
  // hint we have for unscoped packages). The registry returns null on
  // miss; we tolerate any error here.
  try {
    const entry = await fetchRegistryEntry(pkg, pkg)
    if (!entry) {
      return undefined
    }
    const npmSource = entry.sources.find(s => s.type === 'npm')
    if (npmSource && npmSource.type === 'npm') {
      return npmSource.path
    }
    return undefined
  }
  catch {
    return undefined
  }
}

/**
 * Run the local-intent adapter exactly the same way the legacy
 * legacy add flow did. Wrapped in a thin helper so the install loop
 * and any future second-pass refresh share the same call site.
 */
async function runIntentAdapter(
  adapter: LocalDiscoveryAdapter,
  args: { projectDir: string, pkg: string, requestedVersion: string },
): Promise<{ skills: { task: string, load: string }[], resolvedVersion: string, installPath: string } | null> {
  const result = await adapter(args)
  if (!result || result.kind !== 'intent-skills') {
    return null
  }
  return {
    skills: result.skills,
    resolvedVersion: result.resolvedVersion,
    installPath: result.installPath,
  }
}

async function materializeIntent(
  projectDir: string,
  lib: LibraryEntry,
  libName: string,
  skills: { task: string, load: string }[],
  resolvedVersion: string,
  options: RunInstallOptions,
): Promise<InstallStatus> {
  const hashable = skills.map((s, i) => ({
    relpath: `intent-skill-${i}`,
    content: `${s.task}\n${s.load}`,
  }))
  const newHash = contentHash(hashable)

  if (!options.force) {
    const cached = readResolvedJson(projectDir).entries[libName]
    if (
      cached
      && cached.spec === lib.spec
      && cached.resolvedVersion === resolvedVersion
      && cached.contentHash === newHash
    ) {
      consola.info(`  ${lib.spec}: already up to date (intent-skills, ${resolvedVersion})`)
      return 'unchanged'
    }
  }

  // The intent-skills adapter knows the original npm package name
  // (which may differ from the slugged libName for scoped packages).
  // Re-derive it from the spec.
  const parsed = parseSpec(lib.spec)
  const pkgName = parsed.kind === 'npm' ? parsed.pkg : libName
  upsertIntentSkillsBlock(projectDir, pkgName, skills)

  upsertResolvedEntry(projectDir, libName, {
    spec: lib.spec,
    resolvedVersion,
    contentHash: newHash,
    fetchedAt: new Date().toISOString(),
    fileCount: skills.length,
    format: 'intent-skills',
  })
  consola.success(
    `  ${lib.spec}: installed (intent-skills, ${skills.length} skill${skills.length === 1 ? '' : 's'})`,
  )
  return 'installed'
}

/**
 * Read all markdown/doc files from a store entry directory, returning
 * them as `DocFile[]` for materialization into a project. Skips the
 * internal `.ask-hash` and `INDEX.md` files so the materialization
 * pipeline can regenerate them.
 */
function readFilesFromStore(storeDir: string): DocFile[] {
  const files: DocFile[] = []
  const walk = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const name = entry.name
      if (name === '.ask-hash' || (prefix === '' && name === 'INDEX.md'))
        continue
      const rel = prefix ? `${prefix}/${name}` : name
      if (entry.isDirectory()) {
        walk(path.join(dir, name), rel)
      }
      else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(path.join(dir, name), 'utf-8')
          files.push({ path: rel, content })
        }
        catch {
          // unreadable file — skip
        }
      }
    }
  }
  walk(storeDir, '')
  return files
}

/**
 * Drop a single library's resolved-cache row. Used by `ask remove` to
 * keep the cache in sync after the entry is gone from `ask.json`.
 */
export function dropResolvedEntry(projectDir: string, libName: string): void {
  removeResolvedEntries(projectDir, [libName])
}

/**
 * Wipe `.ask/resolved.json` entirely. Used by tests; not exposed via
 * the CLI surface.
 */
export function resetResolved(projectDir: string): void {
  writeResolvedJson(projectDir, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: {},
  })
}
