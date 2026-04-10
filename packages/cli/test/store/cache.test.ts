import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cacheGc, cacheLs, formatBytes } from '../../src/store/cache.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-cache-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function createStoreEntry(askHome: string, kind: string, key: string, content: string): string {
  const dir = kind === 'github'
    ? path.join(askHome, 'github', 'checkouts', ...key.split('/'))
    : path.join(askHome, kind, key)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'doc.md'), content, 'utf-8')
  return dir
}

function createResolvedJson(projectDir: string, entries: Record<string, { storePath: string }>): void {
  const askDir = path.join(projectDir, '.ask')
  fs.mkdirSync(askDir, { recursive: true })
  const resolved = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: Object.fromEntries(
      Object.entries(entries).map(([name, e]) => [name, {
        spec: `npm:${name}`,
        resolvedVersion: '1.0.0',
        contentHash: `sha256-${'a'.repeat(64)}`,
        fetchedAt: new Date().toISOString(),
        fileCount: 1,
        storePath: e.storePath,
      }]),
    ),
  }
  fs.writeFileSync(path.join(askDir, 'resolved.json'), JSON.stringify(resolved), 'utf-8')
}

describe('cacheLs', () => {
  it('returns empty array for empty store', () => {
    expect(cacheLs(tmpDir)).toEqual([])
  })

  it('lists npm entries', () => {
    createStoreEntry(tmpDir, 'npm', 'next@16.2.3', '# Next.js')
    createStoreEntry(tmpDir, 'npm', 'react@19.0.0', '# React')

    const entries = cacheLs(tmpDir)
    expect(entries).toHaveLength(2)
    expect(entries.map(e => e.key).sort()).toEqual(['next@16.2.3', 'react@19.0.0'])
    expect(entries[0].kind).toBe('npm')
  })

  it('lists github checkouts', () => {
    createStoreEntry(tmpDir, 'github', 'vercel__next.js/v16.2.3', '# Next.js docs')

    const entries = cacheLs(tmpDir, { kind: 'github' })
    expect(entries).toHaveLength(1)
    expect(entries[0].key).toBe('vercel__next.js/v16.2.3')
    expect(entries[0].kind).toBe('github')
  })

  it('filters by kind', () => {
    createStoreEntry(tmpDir, 'npm', 'next@16', '# Next')
    createStoreEntry(tmpDir, 'web', 'abc123', '# Web')

    const npmOnly = cacheLs(tmpDir, { kind: 'npm' })
    expect(npmOnly).toHaveLength(1)
    expect(npmOnly[0].kind).toBe('npm')
  })

  it('calculates entry sizes', () => {
    createStoreEntry(tmpDir, 'npm', 'test@1.0.0', 'Hello, world!')

    const entries = cacheLs(tmpDir)
    expect(entries[0].sizeBytes).toBeGreaterThan(0)
  })
})

describe('cacheGc', () => {
  it('removes unreferenced entries', () => {
    const storeDir = createStoreEntry(tmpDir, 'npm', 'unused@1.0.0', '# Unused')
    expect(fs.existsSync(storeDir)).toBe(true)

    const result = cacheGc(tmpDir, { scanRoots: ['/nonexistent-root'] })
    expect(result.removed).toHaveLength(1)
    expect(result.removed[0].key).toBe('unused@1.0.0')
    expect(fs.existsSync(storeDir)).toBe(false)
  })

  it('keeps referenced entries', () => {
    const storeDir = createStoreEntry(tmpDir, 'npm', 'next@16.2.3', '# Next')

    // Create a project that references this store entry
    const projectDir = path.join(tmpDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    createResolvedJson(projectDir, { next: { storePath: storeDir } })

    const result = cacheGc(tmpDir, { scanRoots: [tmpDir] })
    expect(result.removed).toHaveLength(0)
    expect(result.kept).toHaveLength(1)
    expect(fs.existsSync(storeDir)).toBe(true)
  })

  it('dry-run does not delete anything', () => {
    const storeDir = createStoreEntry(tmpDir, 'npm', 'unused@1.0.0', '# Unused')

    const result = cacheGc(tmpDir, { dryRun: true, scanRoots: ['/nonexistent-root'] })
    expect(result.removed).toHaveLength(1)
    expect(result.freedBytes).toBeGreaterThan(0)
    expect(fs.existsSync(storeDir)).toBe(true) // NOT deleted
  })

  it('returns empty result for clean store', () => {
    const result = cacheGc(tmpDir, { scanRoots: ['/nonexistent-root'] })
    expect(result.removed).toHaveLength(0)
    expect(result.kept).toHaveLength(0)
    expect(result.freedBytes).toBe(0)
  })
})

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  it('formats kilobytes', () => {
    expect(formatBytes(2048)).toBe('2.0 KB')
  })

  it('formats megabytes', () => {
    expect(formatBytes(1024 * 1024 * 5)).toBe('5.0 MB')
  })
})
