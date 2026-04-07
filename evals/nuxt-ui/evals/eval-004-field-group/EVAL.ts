/**
 * Field Group — Nuxt UI v4 breaking change: ButtonGroup → FieldGroup
 *
 * Tests whether the agent uses the v4 FieldGroup component (not deprecated ButtonGroup).
 * In v2/v3, button grouping used UButtonGroup. In v4, it was renamed to UFieldGroup.
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

// --- Positive: v4 FieldGroup usage ---

test('Uses UFieldGroup component', () => {
  expect(source).toMatch(/UFieldGroup|u-field-group|FieldGroup/)
})

test('Has multiple FieldGroup instances for different button groups', () => {
  const matches = source.match(/UFieldGroup|u-field-group|<FieldGroup/g)
  expect(matches, 'Expected at least 2 FieldGroup usages').toBeTruthy()
  expect(matches!.length).toBeGreaterThanOrEqual(2)
})

test('Uses size prop on FieldGroup', () => {
  expect(source).toMatch(/size\s*=\s*"sm"/)
})

test('Uses orientation prop for vertical layout', () => {
  expect(source).toMatch(/orientation\s*=\s*"vertical"/)
})

test('Uses UButton inside groups', () => {
  expect(source).toMatch(/UButton|u-button/)
})

test('Buttons have Lucide icons', () => {
  expect(source).toMatch(/icon\s*=\s*"i-lucide-/)
})

// --- Negative: detect deprecated v2/v3 ButtonGroup ---

test('Does NOT use deprecated UButtonGroup (v2/v3) — renamed to UFieldGroup in v4', () => {
  expect(source).not.toMatch(/UButtonGroup|u-button-group|ButtonGroup/)
})
