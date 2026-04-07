/**
 * Nested Form — Nuxt UI v4 breaking change: nested form pattern
 *
 * Tests whether the agent uses the v4 nested form pattern:
 * - `nested` prop on child UForm
 * - `name` prop for state inheritance (e.g., `items.${index}`)
 *
 * In v2/v3, nested forms used their own `:state` prop.
 * In v4, nested forms inherit state from parent via `name` prop.
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

// --- Positive: v4 nested form pattern ---

test('Uses UForm component', () => {
  expect(source).toMatch(/UForm|u-form/)
})

test('Has multiple UForm instances (parent + nested)', () => {
  const matches = source.match(/<UForm|<u-form/g)
  expect(matches, 'Expected at least 2 UForm instances').toBeTruthy()
  expect(matches!.length).toBeGreaterThanOrEqual(2)
})

test('Nested form uses `nested` prop', () => {
  // The nested prop can appear as a boolean attribute or :nested="true"
  expect(source).toMatch(/\bnested\b/)
})

test('Nested form uses `name` prop with items index pattern', () => {
  // e.g., :name="`items.${index}`" or name="items.0"
  expect(source).toMatch(/name\s*=\s*["`'].*items[\.\[]/)
})

test('Uses UFormField for form fields', () => {
  expect(source).toMatch(/UFormField|u-form-field|FormField/)
})

test('Has dynamic item addition (v-for with items)', () => {
  expect(source).toMatch(/v-for\s*=\s*".*item/)
})

test('Uses Zod for schema validation', () => {
  expect(source).toMatch(/import.*zod|from\s+['"]zod['"]|z\.object/)
})

test('Has add item functionality', () => {
  expect(source).toMatch(/push\s*\(|addItem|add-item|Add\s*Item/i)
})

// --- Negative: detect deprecated v2/v3 nested form pattern ---

test('Nested form does NOT use its own :state prop (v2/v3 pattern)', () => {
  // In v4, nested forms inherit state from parent — they should NOT have :state="item"
  // We check that no UForm has both `nested` and `:state` props
  // Simple heuristic: a UForm with :state="item" or :state="items[index]" is the old pattern
  expect(source).not.toMatch(/<UForm[^>]*:state\s*=\s*"item[^"]*"[^>]*>/)
})
