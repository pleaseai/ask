import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getDocsDir, getLibraryDocsDir, saveDocs } from '../src/storage.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-storage-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('storage paths', () => {
  it('getDocsDir points at .ask/docs (not .please/docs)', () => {
    const dir = getDocsDir(tmpDir)
    expect(dir).toBe(path.join(tmpDir, '.ask', 'docs'))
    expect(dir.includes('.please')).toBe(false)
  })

  it('getLibraryDocsDir composes name@version under .ask/docs', () => {
    const dir = getLibraryDocsDir(tmpDir, 'zod', '3.22.4')
    expect(dir).toBe(path.join(tmpDir, '.ask', 'docs', 'zod@3.22.4'))
  })

  it('saveDocs writes files under .ask/docs/<name>@<version>', () => {
    saveDocs(tmpDir, 'zod', '3.22.4', [
      { path: 'README.md', content: '# zod' },
      { path: 'guide/intro.md', content: 'intro' },
    ])
    const docsDir = path.join(tmpDir, '.ask', 'docs', 'zod@3.22.4')
    expect(fs.existsSync(path.join(docsDir, 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(docsDir, 'guide', 'intro.md'))).toBe(true)
    expect(fs.existsSync(path.join(docsDir, 'INDEX.md'))).toBe(true)
  })

  it('saveDocs replaces an existing version directory', () => {
    saveDocs(tmpDir, 'foo', '1.0.0', [{ path: 'old.md', content: 'old' }])
    saveDocs(tmpDir, 'foo', '1.0.0', [{ path: 'new.md', content: 'new' }])
    const docsDir = path.join(tmpDir, '.ask', 'docs', 'foo@1.0.0')
    expect(fs.existsSync(path.join(docsDir, 'old.md'))).toBe(false)
    expect(fs.existsSync(path.join(docsDir, 'new.md'))).toBe(true)
  })
})
