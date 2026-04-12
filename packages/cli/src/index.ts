#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { generateAgentsMd } from './agents.js'
import { docsCmd } from './commands/docs.js'
import { srcCmd } from './commands/src.js'
import { manageIgnoreFiles } from './ignore-files.js'
import { runInstall } from './install.js'
import { readAskJson, writeAskJson } from './io.js'
import { buildListModel } from './list/aggregate.js'
import { ListModelSchema } from './list/model.js'
import { renderList } from './list/render.js'
import { removeSkill } from './skill.js'
import { libraryNameFromSpec, parseSpec } from './spec.js'
import { cacheCleanLegacy, cacheGc, cacheLs, detectLegacyLayout, formatBytes, parseDuration } from './store/cache.js'
import { resolveAskHome } from './store/index.js'

const OWNER_REPO_RE = /^[^/]+\/[^/]+$/

function normalizeAddSpec(input: string): string {
  if (!input.includes(':')) {
    if (OWNER_REPO_RE.test(input)) {
      return `github:${input}`
    }
    throw new Error(
      `Ambiguous spec '${input}'. Use:\n`
      + `  • npm:<name>           (e.g. npm:next, npm:@mastra/client-js)\n`
      + `  • github:<owner>/<repo>@<ref>  (e.g. github:vercel/next.js@v14.2.3)`,
    )
  }
  return input
}

const installCmd = defineCommand({
  meta: {
    name: 'install',
    description: 'Resolve versions and generate AGENTS.md + SKILL.md for all libraries in ask.json',
  },
  args: {},
  async run() {
    await runInstall(process.cwd())
  },
})

const addCmd = defineCommand({
  meta: {
    name: 'add',
    description: 'Add a library spec to ask.json and generate docs references',
  },
  args: {
    spec: {
      type: 'positional',
      description: 'Library spec (e.g. npm:next, github:vercel/next.js@v14.2.3)',
      required: true,
    },
  },
  async run({ args }) {
    const projectDir = process.cwd()
    const spec = normalizeAddSpec(args.spec)

    // Validate the spec parses correctly
    const parsed = parseSpec(spec)
    if (parsed.kind === 'unknown') {
      consola.error(`Invalid spec: ${spec}`)
      process.exit(1)
    }

    let askJson = readAskJson(projectDir)
    if (!askJson) {
      askJson = { libraries: [] }
    }

    // Replace any existing entry with the same spec; otherwise append.
    const existingIdx = askJson.libraries.indexOf(spec)
    if (existingIdx >= 0) {
      consola.info(`${spec} already in ask.json`)
    }
    else {
      askJson.libraries.push(spec)
      consola.info(`Added ${spec} to ask.json`)
    }
    writeAskJson(projectDir, askJson)

    await runInstall(projectDir, { onlySpecs: [spec] })
  },
})

const removeCmd = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a library entry from ask.json and delete its skill file',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Library name (e.g. next, @mastra/client-js) or full spec',
      required: true,
    },
  },
  run({ args }) {
    const projectDir = process.cwd()
    const askJson = readAskJson(projectDir)
    if (!askJson) {
      consola.warn('No ask.json found — nothing to remove')
      return
    }

    const target = args.name
    const idx = askJson.libraries.findIndex((spec) => {
      if (spec === target) return true
      if (libraryNameFromSpec(spec) === target) return true
      const parsed = parseSpec(spec)
      if (parsed.kind === 'npm' && parsed.pkg === target) return true
      return false
    })
    if (idx < 0) {
      consola.warn(`No ask.json entry matches '${target}'`)
      return
    }

    const removed = askJson.libraries[idx]!
    const libName = libraryNameFromSpec(removed)
    askJson.libraries.splice(idx, 1)
    writeAskJson(projectDir, askJson)

    removeSkill(projectDir, libName)

    // Regenerate AGENTS.md without the removed library
    // Import resolveAll lazily to avoid circular deps
    generateAgentsMd(projectDir, [])
    // Re-run install to regenerate AGENTS.md with remaining libraries
    runInstall(projectDir)

    const remaining = askJson.libraries
    manageIgnoreFiles(projectDir, remaining.length === 0 ? 'remove' : 'install')

    consola.success(`Removed ${removed}`)
  },
})

function runList(args: { json?: boolean }): void {
  const projectDir = process.cwd()
  const model = buildListModel(projectDir)
  if (args.json) {
    consola.log(JSON.stringify(ListModelSchema.parse(model), null, 2))
    return
  }
  renderList(model)
}

const listCmd = defineCommand({
  meta: {
    name: 'list',
    description: 'List declared libraries with their resolved versions',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit the list as JSON matching ListModelSchema',
    },
  },
  run({ args }) {
    runList(args)
  },
})

const cacheLsCmd = defineCommand({
  meta: {
    name: 'ls',
    description: 'List entries in the global ASK store',
  },
  args: {
    kind: {
      type: 'string',
      description: 'Filter by kind: npm, github, web, llms-txt',
    },
  },
  run({ args }) {
    const askHome = resolveAskHome()
    const kind = args.kind
    if (kind && !['npm', 'github', 'web', 'llms-txt'].includes(kind)) {
      consola.error(`Invalid --kind '${kind}'. Must be one of: npm, github, web, llms-txt`)
      process.exit(1)
    }
    const entries = cacheLs(askHome, kind ? { kind: kind as 'npm' | 'github' | 'web' | 'llms-txt' } : undefined)

    if (entries.length === 0) {
      consola.info(`No entries in store at ${askHome}`)
      return
    }

    consola.info(`Store: ${askHome}`)
    consola.info(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:\n`)
    for (const entry of entries) {
      consola.log(`  ${entry.kind}/${entry.key}  ${formatBytes(entry.sizeBytes)}`)
    }

    const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0)
    consola.info(`\nTotal: ${formatBytes(totalBytes)}`)
  },
})

const cacheGcCmd = defineCommand({
  meta: {
    name: 'gc',
    description: 'Remove unreferenced entries from the global ASK store',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be removed without deleting',
    },
    'older-than': {
      type: 'string',
      description: 'Only remove entries older than this duration (e.g. 30d, 12h, 90m, 60s)',
    },
  },
  run({ args }) {
    const askHome = resolveAskHome()
    const dryRun = Boolean(args['dry-run'])
    const scanRoots = process.env.ASK_GC_SCAN_ROOTS
      ? process.env.ASK_GC_SCAN_ROOTS.split(':')
      : undefined

    let olderThan: number | undefined
    if (args['older-than']) {
      const parsed = parseDuration(args['older-than'])
      if (parsed === null) {
        consola.error(`Invalid --older-than value '${args['older-than']}'. Use format like 30d, 12h, 90m, 60s.`)
        process.exit(1)
      }
      olderThan = parsed
    }

    const result = cacheGc(askHome, { dryRun, scanRoots, olderThan })

    if (result.removed.length === 0) {
      consola.success('Store is clean — no unreferenced entries.')
      return
    }

    if (dryRun) {
      consola.info(`Would remove ${result.removed.length} entr${result.removed.length === 1 ? 'y' : 'ies'} (${formatBytes(result.freedBytes)}):`)
      for (const entry of result.removed) {
        consola.log(`  ${entry.kind}/${entry.key}  ${formatBytes(entry.sizeBytes)}`)
      }
    }
    else {
      consola.success(`Removed ${result.removed.length} entr${result.removed.length === 1 ? 'y' : 'ies'}, freed ${formatBytes(result.freedBytes)}.`)
    }
  },
})

const cacheCleanCmd = defineCommand({
  meta: {
    name: 'clean',
    description: 'Remove legacy store layout directories (pre-v2)',
  },
  args: {
    legacy: {
      type: 'boolean',
      description: 'Remove github/db and github/checkouts left behind by the pre-v2 store layout',
    },
  },
  run({ args }) {
    const askHome = resolveAskHome()
    if (!args.legacy) {
      consola.error('ask cache clean requires a mode. Pass --legacy to remove pre-v2 github store dirs.')
      process.exit(1)
    }
    if (!detectLegacyLayout(askHome)) {
      consola.info(`No legacy github store detected at ${askHome}. Nothing to clean.`)
      return
    }
    const { removed } = cacheCleanLegacy(askHome)
    if (removed.length === 0) {
      consola.info('No legacy paths removed.')
      return
    }
    consola.success(`Removed ${removed.length} legacy path${removed.length === 1 ? '' : 's'}:`)
    for (const p of removed) {
      consola.log(`  ${p}`)
    }
  },
})

const cacheCmd = defineCommand({
  meta: {
    name: 'cache',
    description: 'Manage the global ASK documentation store',
  },
  subCommands: {
    ls: cacheLsCmd,
    gc: cacheGcCmd,
    clean: cacheCleanCmd,
  },
})

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
    install: installCmd,
    add: addCmd,
    remove: removeCmd,
    list: listCmd,
    src: srcCmd,
    docs: docsCmd,
    cache: cacheCmd,
  },
})

export { runInstall } from './install.js'
export { libraryNameFromSpec, parseSpec } from './spec.js'

void path
