/**
 * Theme Customization — Nuxt UI v4 CSS-first theming
 *
 * Tests whether the agent correctly uses:
 * - app.config.ts for color aliases (primary, secondary)
 * - @theme directive in CSS for custom tokens
 * - Correct Nuxt UI v4 components (UButton, UCard, UBadge)
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
    if (/\.(vue|ts|tsx|js|jsx|css)$/.test(entry)) {
      files.push({ path: fullPath, content: readFileSync(fullPath, 'utf-8') })
    }
  }
  return files
}

const sourceFiles = readSourceFiles(process.cwd())
const source = sourceFiles.map(f => f.content).join('\n')

function fileWith(pattern: RegExp): SourceFile | undefined {
  return sourceFiles.find(f => pattern.test(f.content))
}

test('app.config.ts sets primary color to indigo', () => {
  const configFile = sourceFiles.find(f => f.path.includes('app.config'))
  expect(configFile, 'Expected app.config.ts to exist').toBeDefined()
  expect(configFile!.content).toMatch(/primary\s*:\s*['"]indigo['"]/)
})

test('app.config.ts sets secondary color to rose', () => {
  const configFile = sourceFiles.find(f => f.path.includes('app.config'))
  expect(configFile!.content).toMatch(/secondary\s*:\s*['"]rose['"]/)
})

test('CSS uses @theme directive for custom font', () => {
  const cssFile = sourceFiles.find(f => /\.css$/.test(f.path))
  expect(cssFile, 'Expected a CSS file').toBeDefined()
  expect(cssFile!.content).toMatch(/@theme/)
  expect(cssFile!.content).toMatch(/--font-sans/)
})

test('Page uses UButton with primary color', () => {
  expect(source).toMatch(/UButton|u-button/)
  expect(source).toMatch(/color\s*=\s*"primary"/)
})

test('Page uses UCard component', () => {
  expect(source).toMatch(/UCard|u-card/)
})

test('Page uses UBadge component', () => {
  expect(source).toMatch(/UBadge|u-badge/)
})

test('CSS imports follow v4 pattern', () => {
  // v4 uses @import "tailwindcss" and @import "@nuxt/ui" (not tailwind.config.js)
  const cssFile = sourceFiles.find(f => /\.css$/.test(f.path) && f.content.includes('@import'))
  expect(cssFile, 'Expected CSS with @import').toBeDefined()
  expect(cssFile!.content).toMatch(/@import\s+["']tailwindcss["']/)
  expect(cssFile!.content).toMatch(/@import\s+["']@nuxt\/ui["']/)
})

// --- Negative assertions: detect deprecated v2/v3 patterns ---

test('Does NOT use tailwind.config (v2/v3) — v4 uses CSS @theme directive', () => {
  const hasTailwindConfig = sourceFiles.some(f =>
    /tailwind\.config\.(js|ts|cjs|mjs)$/.test(f.path),
  )
  expect(hasTailwindConfig, 'tailwind.config should not exist in v4').toBe(false)
})

test('Does NOT use @nuxt/ui-pro (v3) — v4 merged ui-pro into @nuxt/ui', () => {
  expect(source).not.toMatch(/@nuxt\/ui-pro/)
})
