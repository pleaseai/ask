import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { LOCK_FILENAME, readLock, removeEntry, upsertEntry, writeLockAtomic } from '../../src/skills/lock.js'

let projectDir: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-lock-'))
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const ENTRY = {
  spec: 'npm:next@14.2.3',
  specKey: 'npm__next__14.2.3',
  skills: [{ name: 'ssr', agents: ['claude'] }],
  installedAt: '2026-04-14T00:00:00Z',
}

describe('lock IO', () => {
  it('readLock returns an empty lock when the file is missing', () => {
    expect(readLock(projectDir)).toEqual({ version: 1, entries: {} })
  })

  it('writeLockAtomic then readLock round-trips', () => {
    const lock = upsertEntry({ version: 1, entries: {} }, ENTRY)
    writeLockAtomic(projectDir, lock)
    expect(readLock(projectDir)).toEqual(lock)
  })

  it('writes to .ask/skills-lock.json', () => {
    writeLockAtomic(projectDir, upsertEntry({ version: 1, entries: {} }, ENTRY))
    expect(fs.existsSync(path.join(projectDir, LOCK_FILENAME))).toBe(true)
  })

  it('upsertEntry is pure (does not mutate input)', () => {
    const initial = { version: 1 as const, entries: {} }
    const next = upsertEntry(initial, ENTRY)
    expect(initial.entries).toEqual({})
    expect(next.entries[ENTRY.specKey]).toEqual(ENTRY)
  })

  it('upsertEntry replaces an existing entry by specKey', () => {
    const first = upsertEntry({ version: 1, entries: {} }, ENTRY)
    const updated = { ...ENTRY, installedAt: '2026-04-15T00:00:00Z' }
    const second = upsertEntry(first, updated)
    expect(Object.keys(second.entries)).toHaveLength(1)
    expect(second.entries[ENTRY.specKey]?.installedAt).toBe(updated.installedAt)
  })

  it('removeEntry deletes the specKey and is a no-op for missing keys', () => {
    const lock = upsertEntry({ version: 1, entries: {} }, ENTRY)
    const afterRemove = removeEntry(lock, ENTRY.specKey)
    expect(afterRemove.entries).toEqual({})
    expect(removeEntry(afterRemove, 'not-there')).toEqual(afterRemove)
  })

  it('readLock throws on malformed JSON', () => {
    fs.mkdirSync(path.join(projectDir, '.ask'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, LOCK_FILENAME), '{"version":2}')
    expect(() => readLock(projectDir)).toThrow(/schema mismatch/)
  })
})
