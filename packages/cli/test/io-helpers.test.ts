import type { Config, Lock } from '../src/schemas.js'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readConfig,
  readLock,
  writeConfig,
  writeLock,
} from '../src/io.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-io-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('readConfig / writeConfig', () => {
  it('returns a default empty config when file does not exist', () => {
    const cfg = readConfig(tmpDir)
    expect(cfg.schemaVersion).toBe(1)
    expect(cfg.docs).toEqual([])
  })

  it('round-trips a valid config', () => {
    const cfg: Config = {
      schemaVersion: 1,
      docs: [
        {
          source: 'github',
          name: 'zod',
          version: '3.22.4',
          repo: 'colinhacks/zod',
          tag: 'v3.22.4',
        },
      ],
    }
    writeConfig(tmpDir, cfg)
    const out = readConfig(tmpDir)
    expect(out).toEqual(cfg)
  })

  it('sorts docs[] by name on write', () => {
    const cfg: Config = {
      schemaVersion: 1,
      docs: [
        { source: 'npm', name: 'zod', version: '3.22.4' },
        { source: 'npm', name: 'hono', version: '4.6.5' },
        { source: 'npm', name: 'drizzle-orm', version: '0.36.0' },
      ],
    }
    writeConfig(tmpDir, cfg)
    const raw = fs.readFileSync(path.join(tmpDir, '.ask', 'config.json'), 'utf-8')
    const idxDrizzle = raw.indexOf('drizzle-orm')
    const idxHono = raw.indexOf('hono')
    const idxZod = raw.indexOf('zod')
    expect(idxDrizzle).toBeLessThan(idxHono)
    expect(idxHono).toBeLessThan(idxZod)
  })

  it('produces byte-identical output on round-trip', () => {
    const cfg: Config = {
      schemaVersion: 1,
      docs: [
        {
          source: 'github',
          name: 'zod',
          version: '3.22.4',
          repo: 'colinhacks/zod',
          tag: 'v3.22.4',
        },
      ],
    }
    writeConfig(tmpDir, cfg)
    const first = fs.readFileSync(
      path.join(tmpDir, '.ask', 'config.json'),
      'utf-8',
    )
    const reread = readConfig(tmpDir)
    writeConfig(tmpDir, reread)
    const second = fs.readFileSync(
      path.join(tmpDir, '.ask', 'config.json'),
      'utf-8',
    )
    expect(second).toBe(first)
  })

  it('throws on invalid config (e.g. github source missing repo)', () => {
    const configPath = path.join(tmpDir, '.ask', 'config.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        docs: [{ source: 'github', name: 'x', version: '1.0.0' }],
      }),
    )
    expect(() => readConfig(tmpDir)).toThrow()
  })

  it('writeConfig throws on invalid config without writing', () => {
    expect(() =>
      writeConfig(tmpDir, { schemaVersion: 99 as 1, docs: [] }),
    ).toThrow()
    expect(fs.existsSync(path.join(tmpDir, '.ask', 'config.json'))).toBe(false)
  })
})

describe('readLock / writeLock', () => {
  it('returns a default empty lock when file does not exist', () => {
    const lock = readLock(tmpDir)
    expect(lock.lockfileVersion).toBe(1)
    expect(lock.entries).toEqual({})
  })

  it('round-trips a valid lock', () => {
    const lock: Lock = {
      lockfileVersion: 1,
      generatedAt: '2026-04-07T06:00:00Z',
      entries: {
        zod: {
          source: 'github',
          version: '3.22.4',
          repo: 'colinhacks/zod',
          ref: 'v3.22.4',
          commit: 'a'.repeat(40),
          fetchedAt: '2026-04-07T06:00:00Z',
          fileCount: 23,
          contentHash: `sha256-${'a'.repeat(64)}`,
        },
      },
    }
    writeLock(tmpDir, lock)
    const out = readLock(tmpDir)
    expect(out).toEqual(lock)
  })

  it('produces byte-identical output on round-trip', () => {
    const lock: Lock = {
      lockfileVersion: 1,
      generatedAt: '2026-04-07T06:00:00Z',
      entries: {
        b: {
          source: 'npm',
          version: '1.0.0',
          tarball: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz',
          integrity: `sha512-${'A'.repeat(86)}==`,
          fetchedAt: '2026-04-07T06:00:00Z',
          fileCount: 5,
          contentHash: `sha256-${'b'.repeat(64)}`,
        },
        a: {
          source: 'npm',
          version: '2.0.0',
          tarball: 'https://registry.npmjs.org/a/-/a-2.0.0.tgz',
          integrity: `sha512-${'C'.repeat(86)}==`,
          fetchedAt: '2026-04-07T06:00:00Z',
          fileCount: 7,
          contentHash: `sha256-${'c'.repeat(64)}`,
        },
      },
    }
    writeLock(tmpDir, lock)
    const first = fs.readFileSync(
      path.join(tmpDir, '.ask', 'ask.lock'),
      'utf-8',
    )
    const reread = readLock(tmpDir)
    writeLock(tmpDir, reread)
    const second = fs.readFileSync(
      path.join(tmpDir, '.ask', 'ask.lock'),
      'utf-8',
    )
    expect(second).toBe(first)
  })

  it('determinism stress: write→read→write is idempotent across many keys', () => {
    const lock: Lock = {
      lockfileVersion: 1,
      generatedAt: '2026-04-07T06:00:00Z',
      entries: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => {
          const name = `lib-${String(i).padStart(2, '0')}`
          return [name, {
            source: 'github' as const,
            version: `${i}.0.0`,
            repo: `owner/${name}`,
            ref: `v${i}.0.0`,
            commit: i.toString(16).padStart(40, '0'),
            fetchedAt: '2026-04-07T06:00:00Z',
            fileCount: i,
            contentHash: `sha256-${i.toString(16).padStart(64, '0')}`,
          }]
        }),
      ),
    }
    writeLock(tmpDir, lock)
    const a = fs.readFileSync(path.join(tmpDir, '.ask', 'ask.lock'), 'utf-8')
    writeLock(tmpDir, readLock(tmpDir))
    const b = fs.readFileSync(path.join(tmpDir, '.ask', 'ask.lock'), 'utf-8')
    writeLock(tmpDir, readLock(tmpDir))
    const c = fs.readFileSync(path.join(tmpDir, '.ask', 'ask.lock'), 'utf-8')
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('sorts entries map keys on write', () => {
    const lock: Lock = {
      lockfileVersion: 1,
      generatedAt: '2026-04-07T06:00:00Z',
      entries: {
        zed: {
          source: 'npm',
          version: '1.0.0',
          tarball: 'https://registry.npmjs.org/zed/-/zed-1.0.0.tgz',
          integrity: `sha512-${'A'.repeat(86)}==`,
          fetchedAt: '2026-04-07T06:00:00Z',
          fileCount: 1,
          contentHash: `sha256-${'a'.repeat(64)}`,
        },
        alpha: {
          source: 'npm',
          version: '1.0.0',
          tarball: 'https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz',
          integrity: `sha512-${'B'.repeat(86)}==`,
          fetchedAt: '2026-04-07T06:00:00Z',
          fileCount: 1,
          contentHash: `sha256-${'b'.repeat(64)}`,
        },
      },
    }
    writeLock(tmpDir, lock)
    const raw = fs.readFileSync(path.join(tmpDir, '.ask', 'ask.lock'), 'utf-8')
    expect(raw.indexOf('alpha')).toBeLessThan(raw.indexOf('zed'))
  })
})
