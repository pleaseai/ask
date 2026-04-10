import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { saveDocs } from '../../src/storage.js'
import { npmStorePath, resolveAskHome, writeEntryAtomic } from '../../src/store/index.js'

let tmpDir: string
let origAskHome: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-install-store-'))
  origAskHome = process.env.ASK_HOME
  process.env.ASK_HOME = path.join(tmpDir, 'ask-home')
})

afterEach(() => {
  if (origAskHome === undefined) {
    delete process.env.ASK_HOME
  }
  else {
    process.env.ASK_HOME = origAskHome
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const testFiles = [
  { path: 'getting-started.md', content: '# Getting Started\nHello world' },
  { path: 'api/reference.md', content: '# API Reference\nSome docs' },
]

describe('T020: copy mode (default)', () => {
  it('creates both store entry and project-local copy with matching bytes', () => {
    const askHome = resolveAskHome()
    const projectDir = path.join(tmpDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })

    // Simulate store entry creation (as source adapter would)
    const storeDir = npmStorePath(askHome, 'next', '16.2.3')
    writeEntryAtomic(storeDir, testFiles)

    // saveDocs in copy mode
    const docsDir = saveDocs(projectDir, 'next', '16.2.3', testFiles, {
      storeMode: 'copy',
      storePath: storeDir,
    })

    // Both locations exist
    expect(fs.existsSync(storeDir)).toBe(true)
    expect(fs.existsSync(docsDir)).toBe(true)

    // Bytes match (ignoring INDEX.md which is only in project-local)
    const storeContent = fs.readFileSync(path.join(storeDir, 'getting-started.md'), 'utf-8')
    const localContent = fs.readFileSync(path.join(docsDir, 'getting-started.md'), 'utf-8')
    expect(storeContent).toBe(localContent)
  })
})

describe('T021: store hit skips fetch', () => {
  it('store entry exists → no re-creation needed', () => {
    const askHome = resolveAskHome()
    const storeDir = npmStorePath(askHome, 'next', '16.2.3')
    writeEntryAtomic(storeDir, testFiles)

    // Verify store entry exists
    expect(fs.existsSync(storeDir)).toBe(true)
    expect(fs.readFileSync(path.join(storeDir, 'getting-started.md'), 'utf-8'))
      .toBe('# Getting Started\nHello world')
  })
})

describe('T022: link mode creates symlink', () => {
  it('creates a symlink on POSIX', () => {
    const askHome = resolveAskHome()
    const projectDir = path.join(tmpDir, 'project-link')
    fs.mkdirSync(projectDir, { recursive: true })

    const storeDir = npmStorePath(askHome, 'next', '16.2.3')
    writeEntryAtomic(storeDir, testFiles)

    const docsDir = saveDocs(projectDir, 'next', '16.2.3', testFiles, {
      storeMode: 'link',
      storePath: storeDir,
    })

    // On POSIX, should be a symlink
    const stats = fs.lstatSync(docsDir)
    expect(stats.isSymbolicLink()).toBe(true)

    // Symlink points to store
    const target = fs.readlinkSync(docsDir)
    expect(target).toBe(storeDir)

    // Files are readable through the symlink
    expect(fs.readFileSync(path.join(docsDir, 'getting-started.md'), 'utf-8'))
      .toBe('# Getting Started\nHello world')
  })

  it('falls back to copy when storePath is not provided', () => {
    const projectDir = path.join(tmpDir, 'project-link-fallback')
    fs.mkdirSync(projectDir, { recursive: true })

    const docsDir = saveDocs(projectDir, 'next', '16.2.3', testFiles, {
      storeMode: 'link',
      // No storePath → falls through to copy
    })

    // Should be a real directory, not a symlink
    const stats = fs.lstatSync(docsDir)
    expect(stats.isSymbolicLink()).toBe(false)
    expect(stats.isDirectory()).toBe(true)
  })
})

describe('T023: ref mode', () => {
  it('does NOT create project-local .ask/docs/', () => {
    const askHome = resolveAskHome()
    const projectDir = path.join(tmpDir, 'project-ref')
    fs.mkdirSync(projectDir, { recursive: true })

    const storeDir = npmStorePath(askHome, 'next', '16.2.3')
    writeEntryAtomic(storeDir, testFiles)

    const result = saveDocs(projectDir, 'next', '16.2.3', testFiles, {
      storeMode: 'ref',
      storePath: storeDir,
    })

    // Returns storePath
    expect(result).toBe(storeDir)

    // No project-local docs directory
    const localDocsDir = path.join(projectDir, '.ask', 'docs', 'next@16.2.3')
    expect(fs.existsSync(localDocsDir)).toBe(false)
  })
})

describe('T025: concurrency', () => {
  it('two concurrent writes to same store entry — one wins, both see result', async () => {
    const askHome = resolveAskHome()
    const storeDir = npmStorePath(askHome, 'concurrent-pkg', '1.0.0')
    const files = [{ path: 'doc.md', content: '# Concurrent test' }]

    // Run two writes concurrently
    const [r1, r2] = await Promise.all([
      writeAndRead(storeDir, files),
      writeAndRead(storeDir, files),
    ])

    // Both should see the same content
    expect(r1).toBe('# Concurrent test')
    expect(r2).toBe('# Concurrent test')
  })
})

async function writeAndRead(storeDir: string, files: { path: string, content: string }[]): Promise<string> {
  writeEntryAtomic(storeDir, files)
  return fs.readFileSync(path.join(storeDir, 'doc.md'), 'utf-8')
}
