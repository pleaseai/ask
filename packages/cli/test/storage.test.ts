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

describe('saveDocs — storeSubpath wiring (T007)', () => {
  it('ref mode with storeSubpath returns path.join(storePath, storeSubpath)', () => {
    const storePath = path.join(tmpDir, 'store', 'github.com', 'facebook', 'react', 'v18.0.0')
    fs.mkdirSync(path.join(storePath, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(storePath, 'docs', 'guide.md'), '# Guide')

    const result = saveDocs(tmpDir, 'react', '18.0.0', [], {
      storeMode: 'ref',
      storePath,
      storeSubpath: 'docs',
    })

    expect(result).toBe(path.join(storePath, 'docs'))
  })

  it('ref mode without storeSubpath returns storePath unchanged', () => {
    const storePath = path.join(tmpDir, 'store', 'npm', 'zod@3.22.4')
    fs.mkdirSync(storePath, { recursive: true })
    const result = saveDocs(tmpDir, 'zod', '3.22.4', [], {
      storeMode: 'ref',
      storePath,
    })
    expect(result).toBe(storePath)
  })

  it('link mode with storeSubpath points symlink at the docs subdirectory', () => {
    const storePath = path.join(tmpDir, 'store', 'github.com', 'facebook', 'react', 'v18.0.0')
    fs.mkdirSync(path.join(storePath, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(storePath, 'docs', 'README.md'), '# Docs')

    const result = saveDocs(tmpDir, 'react', '18.0.0', [], {
      storeMode: 'link',
      storePath,
      storeSubpath: 'docs',
    })

    // Result may be the project-local docsDir (link) or a copy fallback.
    const linkStat = fs.lstatSync(result)
    if (linkStat.isSymbolicLink()) {
      const target = fs.readlinkSync(result)
      expect(target).toBe(path.join(storePath, 'docs'))
    }
    else {
      // Copy fallback (EPERM on some systems) — at least verify the
      // docs subdirectory content is present.
      expect(fs.existsSync(path.join(result, 'README.md'))).toBe(true)
    }
  })

  it('link mode without storeSubpath points symlink at storePath (npm behavior)', () => {
    const storePath = path.join(tmpDir, 'store', 'npm', 'zod@3.22.4')
    fs.mkdirSync(storePath, { recursive: true })
    fs.writeFileSync(path.join(storePath, 'README.md'), '# Zod')

    const result = saveDocs(tmpDir, 'zod', '3.22.4', [], {
      storeMode: 'link',
      storePath,
    })

    const linkStat = fs.lstatSync(result)
    if (linkStat.isSymbolicLink()) {
      expect(fs.readlinkSync(result)).toBe(storePath)
    }
    else {
      expect(fs.existsSync(path.join(result, 'README.md'))).toBe(true)
    }
  })
})
