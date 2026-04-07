/**
 * Nullable Input — Nuxt UI v4 breaking change: nullify → nullable
 *
 * Tests whether the agent uses the v4 `.nullable` modifier (not deprecated `.nullify`).
 * In v2/v3, converting empty input to null used `v-model.nullify`.
 * In v4, this was renamed to `v-model.nullable`.
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

// --- Positive: v4 nullable modifier usage ---

test('Uses v-model.nullable modifier on inputs', () => {
  expect(source).toMatch(/v-model\.nullable\s*=/)
})

test('Uses nullable on multiple optional fields', () => {
  const matches = source.match(/v-model\.nullable/g)
  expect(matches, 'Expected at least 2 nullable modifiers for optional fields').toBeTruthy()
  expect(matches!.length).toBeGreaterThanOrEqual(2)
})

test('Uses UForm component', () => {
  expect(source).toMatch(/UForm|u-form/)
})

test('Uses UFormField with name props', () => {
  expect(source).toMatch(/UFormField|u-form-field|FormField/)
  expect(source).toMatch(/name\s*=\s*"nickname"/)
})

test('Uses UInput component', () => {
  expect(source).toMatch(/UInput|u-input/)
})

test('Uses UTextarea component', () => {
  expect(source).toMatch(/UTextarea|u-textarea|Textarea/)
})

test('Uses Zod for schema validation', () => {
  expect(source).toMatch(/import.*zod|from\s+['"]zod['"]|z\.object/)
})

// --- Negative: detect deprecated v2/v3 nullify modifier ---

test('Does NOT use deprecated v-model.nullify (v2/v3) — renamed to .nullable in v4', () => {
  expect(source).not.toMatch(/v-model\.nullify/)
})

test('Does NOT use deprecated nullify in modelModifiers (v2/v3)', () => {
  expect(source).not.toMatch(/nullify\s*:\s*true/)
})
