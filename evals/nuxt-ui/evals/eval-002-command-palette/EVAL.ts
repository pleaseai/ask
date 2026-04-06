/**
 * CommandPalette — Nuxt UI v4 groups API
 *
 * Tests whether the agent correctly uses:
 * - UCommandPalette with groups prop (array of group objects)
 * - Group structure: { id, label, items }
 * - Item properties: label, icon, kbds, onSelect
 * - v-model binding
 */

import { expect, test } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

type SourceFile = { path: string, content: string }

const IGNORE_DIRS = new Set(['.git', '.nuxt', '.output', 'node_modules', 'dist'])
const IGNORE_FILES = new Set(['EVAL.ts', 'PROMPT.md'])

function readSourceFiles(dir: string): SourceFile[] {
  if (!existsSync(dir)) return []
  const files: SourceFile[] = []
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      files.push(...readSourceFiles(fullPath))
      continue
    }
    if (IGNORE_FILES.has(entry)) continue
    if (/\.(vue|ts|tsx|js|jsx)$/.test(entry)) {
      files.push({ path: fullPath, content: readFileSync(fullPath, 'utf-8') })
    }
  }
  return files
}

const sourceFiles = readSourceFiles(process.cwd())
const source = sourceFiles.map(f => f.content).join('\n')

test('Uses UCommandPalette component', () => {
  expect(source).toMatch(/UCommandPalette|u-command-palette|CommandPalette/)
})

test('CommandPalette receives groups prop', () => {
  expect(source).toMatch(/:groups\s*=/)
})

test('Groups have id and items structure', () => {
  // At least two group IDs defined
  expect(source).toMatch(/id:\s*['"]actions['"]/)
  expect(source).toMatch(/id:\s*['"]navigation['"]/)
})

test('Items have icon props with Lucide icons', () => {
  expect(source).toMatch(/icon:\s*['"]i-lucide-/)
})

test('At least one item has keyboard shortcut hints (kbds)', () => {
  expect(source).toMatch(/kbds:\s*\[/)
})

test('At least one item has onSelect callback', () => {
  expect(source).toMatch(/onSelect\s*[:(]/)
})

test('Uses v-model binding', () => {
  expect(source).toMatch(/v-model\s*=/)
})
