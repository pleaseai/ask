import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { generateAgentsMd } from '../src/agents.js'
import { upsertResolvedEntry, writeAskJson } from '../src/io.js'

/**
 * Tests for the "Searching across cached libraries" subsection appended
 * to the AGENTS.md auto-generated block (FR-10 of lazy-ask-src-docs).
 */

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-agents-search-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(file: string, content: string): void {
  const full = path.join(tmpDir, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

function readAgentsMd(): string {
  return fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
}

const validHash = `sha256-${'a'.repeat(64)}`
const validIso = '2026-04-10T00:00:00+00:00'

function setupReactEntry(): void {
  writeAskJson(tmpDir, { libraries: [{ spec: 'npm:react' }] })
  write('.ask/docs/react@18.2.0/INDEX.md', '# react docs')
  upsertResolvedEntry(tmpDir, 'react', {
    spec: 'npm:react',
    resolvedVersion: '18.2.0',
    contentHash: validHash,
    fetchedAt: validIso,
    fileCount: 1,
    format: 'docs',
  })
}

describe('generateAgentsMd — search subsection (FR-10)', () => {
  it('appends "Searching across cached libraries" subsection inside the auto-generated block', () => {
    setupReactEntry()
    generateAgentsMd(tmpDir)
    const md = readAgentsMd()
    expect(md).toContain('## Searching across cached libraries')
  })

  it('subsection appears AFTER the per-library section but INSIDE the END marker', () => {
    setupReactEntry()
    generateAgentsMd(tmpDir)
    const md = readAgentsMd()
    const libIdx = md.indexOf('## react v18.2.0')
    const searchIdx = md.indexOf('## Searching across cached libraries')
    const endIdx = md.indexOf('<!-- END:ask-docs-auto-generated -->')
    expect(libIdx).toBeGreaterThan(-1)
    expect(searchIdx).toBeGreaterThan(libIdx)
    expect(endIdx).toBeGreaterThan(searchIdx)
  })

  it('contains the three substitution examples (rg, cat, fd)', () => {
    setupReactEntry()
    generateAgentsMd(tmpDir)
    const md = readAgentsMd()
    expect(md).toContain('rg "pattern" $(ask src <package>)')
    expect(md).toContain('cat $(ask docs <package>)/api.md')
    expect(md).toContain('fd "\\.md$" $(ask docs <package>)')
  })

  it('mentions both ask src and ask docs commands', () => {
    setupReactEntry()
    generateAgentsMd(tmpDir)
    const md = readAgentsMd()
    expect(md).toContain('ask src')
    expect(md).toContain('ask docs')
  })

  it('preserves the existing per-library section unchanged', () => {
    setupReactEntry()
    generateAgentsMd(tmpDir)
    const md = readAgentsMd()
    // Existing wording from agents.ts is preserved.
    expect(md).toContain('## react v18.2.0')
    expect(md).toContain('.ask/docs/react@18.2.0/')
    expect(md).toContain('INDEX.md')
    expect(md).toContain('WARNING:')
  })

  it('does NOT emit the search subsection when there are zero docs', () => {
    writeAskJson(tmpDir, { libraries: [] })
    generateAgentsMd(tmpDir)
    // With zero docs the function early-exits without writing AGENTS.md
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false)
  })
})
