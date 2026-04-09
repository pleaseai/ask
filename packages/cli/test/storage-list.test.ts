import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { upsertIntentSkillsBlock } from '../src/agents-intent.js'
import { writeLock } from '../src/io.js'
import { listDocs, saveDocs } from '../src/storage.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-list-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const ISO = '2026-04-10T00:00:00Z'
const SHA = `sha256-${'a'.repeat(64)}`

describe('listDocs (lock-backed)', () => {
  it('returns an empty array when the lock is empty', () => {
    expect(listDocs(tmpDir)).toEqual([])
  })

  it('surfaces a docs-format github entry with filesystem count', () => {
    saveDocs(tmpDir, 'zod', '3.22.4', [
      { path: 'README.md', content: '# zod' },
      { path: 'docs/intro.md', content: 'intro' },
    ])
    writeLock(tmpDir, {
      lockfileVersion: 1,
      generatedAt: ISO,
      entries: {
        zod: {
          source: 'github',
          version: '3.22.4',
          fetchedAt: ISO,
          fileCount: 2,
          contentHash: SHA,
          repo: 'colinhacks/zod',
          ref: 'v3.22.4',
        },
      },
    })

    const entries = listDocs(tmpDir)
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry!.name).toBe('zod')
    expect(entry!.format).toBe('docs')
    expect(entry!.source).toBe('github')
    expect(entry!.location).toContain(path.join('.ask', 'docs', 'zod@3.22.4'))
    // .ask/docs/zod@3.22.4 has README.md + docs/intro.md + INDEX.md = 3
    expect(entry!.fileCount).toBe(3)
  })

  it('distinguishes npm tarball vs installPath source', () => {
    saveDocs(tmpDir, 'pkg-a', '1.0.0', [{ path: 'README.md', content: 'a' }])
    saveDocs(tmpDir, 'pkg-b', '1.0.0', [{ path: 'README.md', content: 'b' }])
    writeLock(tmpDir, {
      lockfileVersion: 1,
      generatedAt: ISO,
      entries: {
        'pkg-a': {
          source: 'npm',
          version: '1.0.0',
          fetchedAt: ISO,
          fileCount: 1,
          contentHash: SHA,
          tarball: 'https://registry.npmjs.org/pkg-a/-/pkg-a-1.0.0.tgz',
        },
        'pkg-b': {
          source: 'npm',
          version: '1.0.0',
          fetchedAt: ISO,
          fileCount: 1,
          contentHash: SHA,
          installPath: '/abs/node_modules/pkg-b',
        },
      },
    })
    const map = new Map(listDocs(tmpDir).map(e => [e.name, e]))
    expect(map.get('pkg-a')!.source).toBe('tarball')
    expect(map.get('pkg-b')!.source).toBe('installPath')
  })

  it('surfaces intent-skills entries with zero files on disk', () => {
    // Seed the AGENTS.md intent-skills block via the writer so the
    // reader path is exercised end-to-end.
    upsertIntentSkillsBlock(tmpDir, '@scope/pkg', [
      { task: 'setup', load: 'node_modules/@scope/pkg/skills/setup/SKILL.md' },
      { task: 'upgrade', load: 'node_modules/@scope/pkg/skills/upgrade/SKILL.md' },
    ])
    writeLock(tmpDir, {
      lockfileVersion: 1,
      generatedAt: ISO,
      entries: {
        '@scope/pkg': {
          source: 'npm',
          version: '2.0.0',
          fetchedAt: ISO,
          fileCount: 0,
          contentHash: SHA,
          installPath: '/abs/node_modules/@scope/pkg',
          format: 'intent-skills',
        },
      },
    })

    const entries = listDocs(tmpDir)
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry!.format).toBe('intent-skills')
    expect(entry!.source).toBe('installPath')
    expect(entry!.skills).toHaveLength(2)
    // itemCount mirrors skills length when no filesystem files exist
    expect(entry!.fileCount).toBe(2)
    expect(entry!.location).toContain('node_modules')
  })

  it('returns entries sorted by name for deterministic output', () => {
    saveDocs(tmpDir, 'bbb', '1.0.0', [{ path: 'a.md', content: 'x' }])
    saveDocs(tmpDir, 'aaa', '1.0.0', [{ path: 'a.md', content: 'x' }])
    writeLock(tmpDir, {
      lockfileVersion: 1,
      generatedAt: ISO,
      entries: {
        bbb: {
          source: 'github',
          version: '1.0.0',
          fetchedAt: ISO,
          fileCount: 1,
          contentHash: SHA,
          repo: 'x/bbb',
          ref: 'v1',
        },
        aaa: {
          source: 'github',
          version: '1.0.0',
          fetchedAt: ISO,
          fileCount: 1,
          contentHash: SHA,
          repo: 'x/aaa',
          ref: 'v1',
        },
      },
    })
    const names = listDocs(tmpDir).map(e => e.name)
    expect(names).toEqual(['aaa', 'bbb'])
  })
})
