/**
 * Vendored docs ignore-file management.
 *
 * `.ask/docs/` contains third-party documentation downloaded by ASK. It
 * should not be treated as project source: lint/format/code-review tools
 * should skip it, but AI agents must still be able to read it as context.
 *
 * Strategy:
 *   A. Write self-contained nested config files inside `.ask/docs/` for
 *      tools that support hierarchical config resolution (Git, ESLint flat
 *      config, Biome, markdownlint-cli2).
 *   B. The "intent notice" for AI review tools lives in `agents.ts`
 *      (extended `generateAgentsMd`).
 *   C. Patch root files only for tools that do NOT support nested config
 *      (Prettier, SonarQube, legacy markdownlint-cli).
 */

import fs from 'node:fs'
import path from 'node:path'
import { consola } from 'consola'
import { loadConfig } from './config.js'
import { inject, remove as removeMarker, wrap } from './markers.js'
import { getDocsDir } from './storage.js'

/**
 * Local configuration files written inside `.ask/docs/` so that
 * lint/format/review tools with nested-config support automatically skip
 * the directory. Each file has a `name` (relative to `.ask/docs/`) and a
 * `content` template.
 */
const NESTED_CONFIGS: Array<{ name: string, content: string }> = [
  {
    name: '.gitattributes',
    content: [
      '# Managed by ASK — marks vendored docs for GitHub Linguist.',
      '* linguist-vendored=true',
      '* linguist-generated=true',
      '',
    ].join('\n'),
  },
  {
    name: 'eslint.config.mjs',
    content: [
      '// Managed by ASK — vendored docs, excluded from ESLint.',
      'export default [',
      '  { ignores: [\'**/*\'] },',
      ']',
      '',
    ].join('\n'),
  },
  {
    name: 'biome.json',
    content: `${JSON.stringify(
      {
        $schema: 'https://biomejs.dev/schemas/2.0.0/schema.json',
        files: { ignore: ['**/*'] },
      },
      null,
      2,
    )}\n`,
  },
  {
    name: '.markdownlint-cli2.jsonc',
    content: `${JSON.stringify(
      { ignores: ['**/*'] },
      null,
      2,
    )}\n`,
  },
]

interface RootPatch {
  /** File name relative to project root. */
  file: string
  /** Marker syntax to use when injecting/removing. */
  syntax: 'html' | 'hash'
  /** Payload to wrap between markers. */
  payload: string
  /** Optional warning emitted when the file is detected. */
  warn?: string
}

const ROOT_PATCHES: RootPatch[] = [
  {
    file: '.prettierignore',
    syntax: 'hash',
    payload: '# Vendored docs — managed by ASK\n.ask/docs/',
  },
  {
    file: 'sonar-project.properties',
    syntax: 'hash',
    payload: '# Vendored docs — managed by ASK\nsonar.exclusions=.ask/docs/**',
  },
  {
    file: '.markdownlintignore',
    syntax: 'hash',
    payload: '# Vendored docs — managed by ASK\n.ask/docs/',
    warn: 'Legacy .markdownlintignore detected. Consider migrating to markdownlint-cli2, which supports nested config inside .ask/docs/ automatically.',
  },
]

/**
 * Category A: write nested config files inside `.ask/docs/`.
 *
 * The directory is created if it does not exist, so callers may invoke this
 * before any docs have been saved. Existing files are only rewritten if
 * their contents differ, to keep filesystem mtimes stable and logs terse.
 *
 * Returns the list of files that were created or updated (relative to the
 * project root) so callers can log a summary.
 */
export function writeNestedConfigs(projectDir: string): string[] {
  const docsDir = getDocsDir(projectDir)
  fs.mkdirSync(docsDir, { recursive: true })

  const written: string[] = []
  for (const { name, content } of NESTED_CONFIGS) {
    const target = path.join(docsDir, name)
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null
    if (existing !== content) {
      fs.writeFileSync(target, content, 'utf-8')
      written.push(path.relative(projectDir, target))
    }
  }
  return written
}

/**
 * Remove all nested config files written by {@link writeNestedConfigs}.
 *
 * Only files with the exact names we manage are deleted. Other files
 * inside `.ask/docs/` are left alone (including downloaded docs). Returns
 * the list of removed file paths relative to the project root.
 */
export function removeNestedConfigs(projectDir: string): string[] {
  const docsDir = getDocsDir(projectDir)
  if (!fs.existsSync(docsDir))
    return []
  const removed: string[] = []
  for (const { name } of NESTED_CONFIGS) {
    const target = path.join(docsDir, name)
    if (fs.existsSync(target)) {
      fs.rmSync(target)
      removed.push(path.relative(projectDir, target))
    }
  }
  return removed
}

/**
 * Category C: patch root files that do not support nested ignore resolution.
 *
 * Only files that already exist are patched — ASK never creates a root
 * ignore file from scratch, because doing so could imply a tool the user
 * does not actually use.
 */
export function patchRootIgnores(projectDir: string): string[] {
  const updated: string[] = []
  for (const patch of ROOT_PATCHES) {
    const target = path.join(projectDir, patch.file)
    if (!fs.existsSync(target))
      continue

    const existing = fs.readFileSync(target, 'utf-8')
    const block = wrap(patch.payload, patch.syntax)
    const next = inject(existing, block, patch.syntax)
    if (next !== existing) {
      fs.writeFileSync(target, next, 'utf-8')
      updated.push(patch.file)
    }
    if (patch.warn) {
      consola.warn(patch.warn)
    }
  }
  return updated
}

/**
 * Remove ASK-managed marker blocks from root files patched by
 * {@link patchRootIgnores}. Files themselves are never deleted.
 */
export function unpatchRootIgnores(projectDir: string): string[] {
  const updated: string[] = []
  for (const patch of ROOT_PATCHES) {
    const target = path.join(projectDir, patch.file)
    if (!fs.existsSync(target))
      continue
    const existing = fs.readFileSync(target, 'utf-8')
    const next = removeMarker(existing, patch.syntax)
    if (next !== existing) {
      fs.writeFileSync(target, next, 'utf-8')
      updated.push(patch.file)
    }
  }
  return updated
}

/**
 * Top-level orchestrator called from the add/sync/remove commands.
 *
 * - `install` mode: create nested configs and patch detected root files.
 * - `remove`  mode: delete nested configs and strip root marker blocks.
 *
 * Respects `manageIgnores` in `.ask/config.json` (default: true). When the
 * flag is explicitly set to false, the function is a no-op.
 */
export function manageIgnoreFiles(
  projectDir: string,
  mode: 'install' | 'remove',
): void {
  let manage = true
  try {
    const config = loadConfig(projectDir)
    if (config.manageIgnores === false)
      manage = false
  }
  catch {
    // No config yet — default to managing. This matches the behaviour of
    // a fresh project where `ask docs add` writes the config on the fly.
  }

  if (!manage) {
    consola.info('Skipping ignore-file management (manageIgnores: false).')
    return
  }

  if (mode === 'install') {
    const nested = writeNestedConfigs(projectDir)
    const root = patchRootIgnores(projectDir)
    if (nested.length > 0)
      consola.info(`Nested configs written: ${nested.join(', ')}`)
    if (root.length > 0)
      consola.info(`Root ignore files patched: ${root.join(', ')}`)
  }
  else {
    const nested = removeNestedConfigs(projectDir)
    const root = unpatchRootIgnores(projectDir)
    if (nested.length > 0)
      consola.info(`Nested configs removed: ${nested.join(', ')}`)
    if (root.length > 0)
      consola.info(`Root ignore marker blocks removed: ${root.join(', ')}`)
  }
}
