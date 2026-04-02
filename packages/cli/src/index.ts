#!/usr/bin/env node

import type {
  GithubSourceOptions,
  NpmSourceOptions,
  SourceConfig,
  WebSourceOptions,
} from './sources/index.js'
import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { generateAgentsMd } from './agents.js'
import {
  addDocEntry,
  loadConfig,
  removeDocEntry,
} from './config.js'
import { parseEcosystem, resolveFromRegistry } from './registry.js'
import { generateSkill, removeSkill } from './skill.js'
import { getSource } from './sources/index.js'
import { listDocs, removeDocs, saveDocs } from './storage.js'

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

    default:
      throw new Error(`Unknown source: ${opts.source}`)
  }
}

const addCmd = defineCommand({
  meta: { name: 'add', description: 'Download documentation for a library' },
  args: {
    spec: { type: 'positional', description: 'Library spec (e.g. zod@3.22 or npm:next@canary)', required: true },
    source: { type: 'string', description: 'Source type: npm, github, web (auto-detected if omitted)', alias: ['s'] },
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
    const { spec: cleanSpec } = parseEcosystem(args.spec)
    let sourceConfig: SourceConfig

    if (args.source) {
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
      if (!resolved) {
        consola.error(`'${args.spec}' not found in registry. Use --source to specify manually.`)
        process.exit(1)
      }
      const { strategy } = resolved
      consola.start(`Downloading ${resolved.name}@${resolved.version} docs (source: ${strategy.source})...`)
      sourceConfig = buildSourceConfig(resolved.name, resolved.version, {
        source: strategy.source,
        repo: strategy.repo,
        docsPath: strategy.docsPath,
        url: strategy.urls,
        maxDepth: strategy.maxDepth?.toString(),
        pathPrefix: strategy.allowedPathPrefix,
        branch: strategy.branch,
        tag: strategy.tag,
      })
    }

    const source = getSource(sourceConfig.source)
    const result = await source.fetch(sourceConfig)
    const libName = sourceConfig.name

    consola.info(`Fetched ${result.files.length} doc files (resolved version: ${result.resolvedVersion})`)

    const docsDir = saveDocs(projectDir, libName, result.resolvedVersion, result.files)
    consola.info(`Docs saved to: ${docsDir}`)

    const configEntry = { ...sourceConfig, version: result.resolvedVersion }
    addDocEntry(projectDir, configEntry)
    consola.info('Config updated: .please/config.json')

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

const syncCmd = defineCommand({
  meta: { name: 'sync', description: 'Download/update all docs from .please/config.json' },
  async run() {
    const projectDir = process.cwd()
    const config = loadConfig(projectDir)

    if (config.docs.length === 0) {
      consola.info('No docs configured in .please/config.json')
      return
    }

    consola.start(`Syncing ${config.docs.length} library docs...`)

    for (const entry of config.docs) {
      try {
        consola.info(`  ${entry.name}@${entry.version} (${entry.source})...`)
        const source = getSource(entry.source)
        const result = await source.fetch(entry)

        saveDocs(projectDir, entry.name, result.resolvedVersion, result.files)
        generateSkill(
          projectDir,
          entry.name,
          result.resolvedVersion,
          result.files.map(f => f.path),
        )

        consola.success(`  -> ${result.files.length} files (v${result.resolvedVersion})`)
      }
      catch (err) {
        consola.error(`  -> Error: ${err instanceof Error ? err.message : err}`)
      }
    }

    generateAgentsMd(projectDir)
    consola.success('Sync complete. AGENTS.md updated.')
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

runMain(main)
