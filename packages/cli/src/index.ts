#!/usr/bin/env node

import type { LibraryEntry } from './schemas.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { removeFromIntentSkillsBlock } from './agents-intent.js'
import { generateAgentsMd } from './agents.js'
import { manageIgnoreFiles } from './ignore-files.js'
import { dropResolvedEntry, runInstall } from './install.js'
import { readAskJson, writeAskJson } from './io.js'
import { buildListModel } from './list/aggregate.js'
import { ListModelSchema } from './list/model.js'
import { renderList } from './list/render.js'
import { removeSkill } from './skill.js'
import { libraryNameFromSpec, parseSpec } from './spec.js'
import { listDocs, removeDocs } from './storage.js'

/**
 * Validate the spec passed to `ask add`. Bare names (no ecosystem
 * prefix) are rejected — the user must use `npm:next` or
 * `github:owner/repo` so the install pipeline knows which path to
 * take.
 */
const OWNER_REPO_RE = /^[^/]+\/[^/]+$/

function normalizeAddSpec(input: string): string {
  if (!input.includes(':')) {
    // Allow `owner/repo` shorthand for github specs.
    if (OWNER_REPO_RE.test(input)) {
      return `github:${input}`
    }
    throw new Error(
      `Ambiguous spec '${input}'. Use:\n`
      + `  • npm:<name>           (e.g. npm:next, npm:@mastra/client-js)\n`
      + `  • github:<owner>/<repo>  (e.g. github:vercel/next.js)`,
    )
  }
  return input
}

const installCmd = defineCommand({
  meta: {
    name: 'install',
    description: 'Install documentation for all libraries declared in ask.json',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Re-fetch every entry, ignoring the .ask/resolved.json cache',
    },
    'emit-skill': {
      type: 'boolean',
      description: 'Emit a .claude/skills/<name>-docs/SKILL.md file for each installed library',
    },
  },
  async run({ args }) {
    const emitSkill = args['emit-skill'] ? true : undefined
    await runInstall(process.cwd(), { force: Boolean(args.force), emitSkill })
  },
})

const addCmd = defineCommand({
  meta: {
    name: 'add',
    description: 'Add a library entry to ask.json and install it',
  },
  args: {
    spec: {
      type: 'positional',
      description: 'Library spec (e.g. npm:next, github:vercel/next.js)',
      required: true,
    },
    ref: {
      type: 'string',
      description: 'Git ref for github specs (tag/branch/sha)',
    },
    docsPath: {
      type: 'string',
      description: 'Path to docs within the package/repo',
    },
    'emit-skill': {
      type: 'boolean',
      description: 'Emit a .claude/skills/<name>-docs/SKILL.md file for each installed library',
    },
  },
  async run({ args }) {
    const projectDir = process.cwd()
    const spec = normalizeAddSpec(args.spec)
    const parsed = parseSpec(spec)

    if (parsed.kind === 'github' && !args.ref) {
      consola.error(
        `github specs require --ref. Example:\n`
        + `  ask add ${spec} --ref v1.2.3 [--docs-path docs]`,
      )
      process.exit(1)
    }

    let askJson = readAskJson(projectDir)
    if (!askJson) {
      askJson = { libraries: [] }
    }

    // Replace any existing entry with the same spec; otherwise append.
    const newEntry: LibraryEntry = parsed.kind === 'github'
      ? {
          spec,
          ref: args.ref!,
          ...(args.docsPath ? { docsPath: args.docsPath } : {}),
        }
      : {
          spec,
          ...(args.docsPath ? { docsPath: args.docsPath } : {}),
        }

    const existingIdx = askJson.libraries.findIndex(l => l.spec === spec)
    if (existingIdx >= 0) {
      askJson.libraries[existingIdx] = newEntry
      consola.info(`Updated existing entry for ${spec}`)
    }
    else {
      askJson.libraries.push(newEntry)
      consola.info(`Added ${spec} to ask.json`)
    }
    writeAskJson(projectDir, askJson)

    const emitSkill = args['emit-skill'] ? true : undefined
    await runInstall(projectDir, { onlySpecs: [spec], emitSkill })
  },
})

const removeCmd = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a library entry from ask.json and delete its materialized files',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Library name (e.g. next, @mastra/client-js, vercel/next.js) or full spec',
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

    // Match against either the full spec or the slugged library name.
    const target = args.name
    const idx = askJson.libraries.findIndex((l) => {
      if (l.spec === target) {
        return true
      }
      // Allow `npm:<name>` to be matched by `<name>` or by the slug.
      if (libraryNameFromSpec(l.spec) === target) {
        return true
      }
      // Allow npm package name match (e.g. `@mastra/client-js`).
      const parsed = parseSpec(l.spec)
      if (parsed.kind === 'npm' && parsed.pkg === target) {
        return true
      }
      return false
    })
    if (idx < 0) {
      consola.warn(`No ask.json entry matches '${target}'`)
      return
    }

    const removed = askJson.libraries[idx]!
    const libName = libraryNameFromSpec(removed.spec)
    askJson.libraries.splice(idx, 1)
    writeAskJson(projectDir, askJson)

    // Tear down the per-library artifacts. The intent-skills branch
    // strips its AGENTS.md marker entry; the docs branch deletes the
    // materialized directory and the skill file.
    const parsed = parseSpec(removed.spec)
    const pkgForIntent = parsed.kind === 'npm' ? parsed.pkg : libName
    const intentRemoved = removeFromIntentSkillsBlock(projectDir, pkgForIntent)
    if (!intentRemoved) {
      removeDocs(projectDir, libName)
      removeSkill(projectDir, libName)
    }
    dropResolvedEntry(projectDir, libName)
    generateAgentsMd(projectDir)

    const remaining = listDocs(projectDir)
    manageIgnoreFiles(projectDir, remaining.length === 0 ? 'remove' : 'install')

    consola.success(`Removed ${removed.spec}`)
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

// Read version from package.json at runtime so release-please bumps
// automatically propagate to `--version` output. `import.meta.url`
// resolves relative to the compiled file location (`dist/index.js` →
// `../package.json`), which works for both the published tarball and
// local dev builds.
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
  },
})

// Re-export the install orchestrator and a few helpers for tests.
export { runInstall } from './install.js'
export { libraryNameFromSpec, parseSpec } from './spec.js'

// Suppress unused-import noise from `path` — it's referenced indirectly
// by jest fixtures. Kept here so future use sites don't need a
// re-import.
void path
