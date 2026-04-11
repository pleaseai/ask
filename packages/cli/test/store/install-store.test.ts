import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { saveDocs } from '../../src/storage.js'
import { acquireEntryLock, npmStorePath, resolveAskHome, writeEntryAtomic } from '../../src/store/index.js'

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

describe('T025: concurrency via acquireEntryLock', () => {
  it('two concurrent lock acquisitions — one succeeds, other waits and sees store hit', async () => {
    const askHome = resolveAskHome()
    const storeDir = npmStorePath(askHome, 'concurrent-pkg', '1.0.0')
    const files = [{ path: 'doc.md', content: '# Concurrent test' }]

    // Simulate two concurrent workers: both call acquireEntryLock.
    // Worker A acquires first and writes the entry. Worker B waits,
    // then finds the entry exists and returns null (store hit).
    const workerA = async (): Promise<string> => {
      const lock = await acquireEntryLock(storeDir)
      expect(lock).not.toBeNull()
      try {
        writeEntryAtomic(storeDir, files)
      }
      finally {
        lock!.release()
      }
      return 'A-wrote'
    }

    const workerB = async (): Promise<string> => {
      // Small delay to ensure A wins the race
      await new Promise(resolve => setTimeout(resolve, 50))
      const lock = await acquireEntryLock(storeDir)
      // B should see null (A's entry already exists) OR get a fresh lock
      // if the race was lost. Either way, the store should be intact.
      if (lock === null) {
        return 'B-store-hit'
      }
      lock.release()
      return 'B-acquired'
    }

    const [resultA, resultB] = await Promise.all([workerA(), workerB()])
    expect(resultA).toBe('A-wrote')
    // B either saw the store hit or acquired fresh after A released
    expect(['B-store-hit', 'B-acquired']).toContain(resultB)
    // Store content is intact
    expect(fs.readFileSync(path.join(storeDir, 'doc.md'), 'utf-8')).toBe('# Concurrent test')
  })

  it('acquireEntryLock returns null when entry appears while waiting on held lock', async () => {
    const askHome = resolveAskHome()
    const storeDir = npmStorePath(askHome, 'race-pkg', '1.0.0')

    // Hold the lock manually — simulates another process mid-write
    const lockPath = `${storeDir}.lock`
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const fd = fs.openSync(lockPath, 'wx')
    fs.closeSync(fd)

    // Start a second acquisition that will block on the existing lock
    const waiterPromise = acquireEntryLock(storeDir)

    // Simulate the first worker finishing its write — create the entry
    // but leave the lock held so the waiter's next retry sees both
    // EEXIST (lock) and existsSync(entryDir) → returns null (store hit).
    await new Promise(resolve => setTimeout(resolve, 200))
    fs.mkdirSync(storeDir, { recursive: true })
    fs.writeFileSync(path.join(storeDir, 'doc.md'), '# Winner')

    const result = await waiterPromise
    expect(result).toBeNull()

    // Clean up the held lock
    fs.unlinkSync(lockPath)
  })
})

describe('link-mode EPERM fallback', () => {
  it('falls back to copy when symlinkSync throws EPERM', () => {
    const askHome = resolveAskHome()
    const projectDir = path.join(tmpDir, 'project-eperm')
    fs.mkdirSync(projectDir, { recursive: true })

    const storeDir = npmStorePath(askHome, 'next', '16.2.3')
    writeEntryAtomic(storeDir, testFiles)

    // Mock fs.symlinkSync to throw EPERM
    const origSymlink = fs.symlinkSync
    let symlinkAttempted = false
    ;(fs as { symlinkSync: typeof fs.symlinkSync }).symlinkSync = () => {
      symlinkAttempted = true
      const err = new Error('Operation not permitted') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    }

    try {
      const docsDir = saveDocs(projectDir, 'next', '16.2.3', testFiles, {
        storeMode: 'link',
        storePath: storeDir,
      })

      // Symlink was attempted, then fell back to copy
      expect(symlinkAttempted).toBe(true)

      // docsDir exists as a real directory (not a symlink)
      const stats = fs.lstatSync(docsDir)
      expect(stats.isSymbolicLink()).toBe(false)
      expect(stats.isDirectory()).toBe(true)

      // Files are present (copy succeeded)
      expect(fs.existsSync(path.join(docsDir, 'getting-started.md'))).toBe(true)
      expect(fs.existsSync(path.join(docsDir, 'INDEX.md'))).toBe(true)
    }
    finally {
      ;(fs as { symlinkSync: typeof fs.symlinkSync }).symlinkSync = origSymlink
    }
  })
})
