/**
 * Chat Message — Nuxt UI v4 Chat Components
 *
 * Tests whether the agent correctly uses:
 * - UChatMessage with parts prop (AI SDK format)
 * - UChatMessages wrapper component
 * - UChatPrompt input component
 * - role prop for user/assistant distinction
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

test('Uses UChatMessage component', () => {
  expect(source).toMatch(/UChatMessage|u-chat-message|ChatMessage/)
})

test('ChatMessage uses parts prop with AI SDK format', () => {
  // parts can appear as a template binding (:parts=) or as a data property key (parts: [...])
  expect(source).toMatch(/:?parts\s*=|parts\s*:/)
  expect(source).toMatch(/type:\s*['"]text['"]/)
})

test('Messages have role prop for user and assistant', () => {
  expect(source).toMatch(/role\s*=\s*"user"|role:\s*['"]user['"]/)
  expect(source).toMatch(/role\s*=\s*"assistant"|role:\s*['"]assistant['"]/)
})

test('Uses UChatMessages wrapper component', () => {
  expect(source).toMatch(/UChatMessages|u-chat-messages|ChatMessages/)
})

test('Uses UChatPrompt input component', () => {
  expect(source).toMatch(/UChatPrompt|u-chat-prompt|ChatPrompt/)
})

// --- Negative assertions: detect deprecated v3 patterns ---

test('Does NOT use deprecated content prop (v3) — must use parts (v4)', () => {
  // v3 used :content="message.content", v4 uses :parts="message.parts"
  expect(source).not.toMatch(/:content\s*=\s*"message\.content"/)
})

test('Does NOT use deprecated useChat composable (v3) — must use Chat class (v4)', () => {
  // v3 used useChat() from @ai-sdk/vue, v4 uses new Chat()
  expect(source).not.toMatch(/useChat\s*\(/)
})
