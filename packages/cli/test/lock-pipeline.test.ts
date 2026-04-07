import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addDocEntry, loadConfig } from '../src/config.js'
import {
  contentHash,
  readLock,
  removeLockEntries,
  upsertLockEntry,
} from '../src/io.js'
import { saveDocs } from '../src/storage.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-pipeline-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function fakeFiles(): Array<{ path: string, content: string }> {
  return [
    { path: 'README.md', content: '# fake' },
    { path: 'guide/intro.md', content: 'intro content' },
  ]
}

function buildHash(files: Array<{ path: string, content: string }>) {
  return contentHash(
    files.map(f => ({
      relpath: f.path,
      bytes: new TextEncoder().encode(f.content),
    })),
  )
}

describe('add pipeline (T013): saveDocs + addDocEntry + upsertLockEntry', () => {
  it('produces .ask/docs, .ask/config.json, and .ask/ask.lock with consistent state', () => {
    const files = fakeFiles()
    saveDocs(tmpDir, 'fakelib', '1.0.0', files)
    addDocEntry(tmpDir, {
      source: 'github',
      name: 'fakelib',
      version: '1.0.0',
      repo: 'fake/lib',
      tag: 'v1.0.0',
    })
    upsertLockEntry(tmpDir, 'fakelib', {
      source: 'github',
      version: '1.0.0',
      repo: 'fake/lib',
      ref: 'v1.0.0',
      commit: 'a'.repeat(40),
      fetchedAt: '2026-04-07T06:00:00Z',
      fileCount: files.length,
      contentHash: buildHash(files),
    })

    expect(fs.existsSync(path.join(tmpDir, '.ask', 'docs', 'fakelib@1.0.0', 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, '.ask', 'docs', 'fakelib@1.0.0', 'INDEX.md'))).toBe(true)

    const cfg = loadConfig(tmpDir)
    expect(cfg.docs).toHaveLength(1)
    expect(cfg.docs[0].name).toBe('fakelib')

    const lock = readLock(tmpDir)
    expect(lock.entries.fakelib).toBeDefined()
    expect(lock.entries.fakelib.contentHash).toBe(buildHash(files))
  })

  it('SC-4: re-running with identical content leaves lock byte-stable (modulo fetchedAt)', () => {
    const files = fakeFiles()
    const baseEntry = {
      source: 'npm' as const,
      version: '1.0.0',
      tarball: 'https://registry.npmjs.org/fake/-/fake-1.0.0.tgz',
      integrity: `sha512-${'A'.repeat(86)}==`,
      fileCount: files.length,
      contentHash: buildHash(files),
    }
    upsertLockEntry(tmpDir, 'fake', { ...baseEntry, fetchedAt: '2026-04-07T06:00:00Z' })
    const first = fs.readFileSync(path.join(tmpDir, '.ask', 'ask.lock'), 'utf-8')

    // Second upsert with same content but different fetchedAt — generatedAt
    // should NOT update (because the entry-modulo-fetchedAt is unchanged).
    upsertLockEntry(tmpDir, 'fake', { ...baseEntry, fetchedAt: '2026-04-07T07:00:00Z' })
    const second = fs.readFileSync(path.join(tmpDir, '.ask', 'ask.lock'), 'utf-8')

    // generatedAt is preserved across the two writes
    const firstParsed = JSON.parse(first)
    const secondParsed = JSON.parse(second)
    expect(secondParsed.generatedAt).toBe(firstParsed.generatedAt)
  })

  it('content change updates generatedAt and contentHash', async () => {
    const filesA = fakeFiles()
    upsertLockEntry(tmpDir, 'fake', {
      source: 'npm',
      version: '1.0.0',
      tarball: 'https://registry.npmjs.org/fake/-/fake-1.0.0.tgz',
      integrity: `sha512-${'A'.repeat(86)}==`,
      fileCount: filesA.length,
      contentHash: buildHash(filesA),
      fetchedAt: '2026-04-07T06:00:00Z',
    })
    const generatedAtA = readLock(tmpDir).generatedAt

    // `generatedAt` comes from `new Date().toISOString()` (ms resolution).
    // Without this gap, two back-to-back writes on fast machines can land
    // in the same millisecond and collide, making the assertion below flaky.
    await new Promise(resolve => setTimeout(resolve, 2))

    const filesB = [
      ...filesA,
      { path: 'CHANGELOG.md', content: '## new' },
    ]
    upsertLockEntry(tmpDir, 'fake', {
      source: 'npm',
      version: '1.0.0',
      tarball: 'https://registry.npmjs.org/fake/-/fake-1.0.0.tgz',
      integrity: `sha512-${'A'.repeat(86)}==`,
      fileCount: filesB.length,
      contentHash: buildHash(filesB),
      fetchedAt: '2026-04-07T06:00:00Z',
    })
    const lockB = readLock(tmpDir)
    expect(lockB.generatedAt).not.toBe(generatedAtA)
    expect(lockB.entries.fake.contentHash).not.toBe(buildHash(filesA))
  })
})

describe('sync pipeline (T014): drift classification', () => {
  it('SC-5: bumping a version updates lock and lets us prune the old entry', () => {
    // Initial state: fake@1.0.0 exists in lock
    const filesV1 = fakeFiles()
    upsertLockEntry(tmpDir, 'fake', {
      source: 'github',
      version: '1.0.0',
      repo: 'fake/lib',
      ref: 'v1.0.0',
      commit: 'a'.repeat(40),
      fetchedAt: '2026-04-07T06:00:00Z',
      fileCount: filesV1.length,
      contentHash: buildHash(filesV1),
    })

    // Drift: version bump to 2.0.0
    const filesV2 = [{ path: 'README.md', content: '# v2' }]
    upsertLockEntry(tmpDir, 'fake', {
      source: 'github',
      version: '2.0.0',
      repo: 'fake/lib',
      ref: 'v2.0.0',
      commit: 'b'.repeat(40),
      fetchedAt: '2026-04-07T07:00:00Z',
      fileCount: filesV2.length,
      contentHash: buildHash(filesV2),
    })

    const lock = readLock(tmpDir)
    expect(lock.entries.fake.version).toBe('2.0.0')
    expect(lock.entries.fake.contentHash).toBe(buildHash(filesV2))
  })

  it('removeLockEntries prunes by name and is a no-op for unknown names', () => {
    upsertLockEntry(tmpDir, 'a', {
      source: 'npm',
      version: '1.0.0',
      tarball: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
      integrity: `sha512-${'A'.repeat(86)}==`,
      fetchedAt: '2026-04-07T06:00:00Z',
      fileCount: 1,
      contentHash: `sha256-${'a'.repeat(64)}`,
    })
    upsertLockEntry(tmpDir, 'b', {
      source: 'npm',
      version: '1.0.0',
      tarball: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz',
      integrity: `sha512-${'B'.repeat(86)}==`,
      fetchedAt: '2026-04-07T06:00:00Z',
      fileCount: 1,
      contentHash: `sha256-${'b'.repeat(64)}`,
    })
    removeLockEntries(tmpDir, ['a', 'unknown'])
    const lock = readLock(tmpDir)
    expect(lock.entries.a).toBeUndefined()
    expect(lock.entries.b).toBeDefined()
  })
})
