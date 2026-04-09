import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { upsertIntentSkillsBlock } from '../../src/agents-intent.js'
import { writeLock } from '../../src/io.js'
import { buildListModel, detectConflicts } from '../../src/list/aggregate.js'
import { ListModelSchema } from '../../src/list/model.js'
import { saveDocs } from '../../src/storage.js'

const ISO = '2026-04-10T00:00:00Z'
const SHA = `sha256-${'a'.repeat(64)}`

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-aggregate-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function githubEntry(name: string, version: string) {
  return {
    source: 'github' as const,
    version,
    fetchedAt: ISO,
    fileCount: 1,
    contentHash: SHA,
    repo: `x/${name}`,
    ref: `v${version}`,
  }
}

describe('buildListModel', () => {
  it('returns an empty model for an empty project', () => {
    const model = buildListModel(tmpDir)
    expect(model.entries).toEqual([])
    expect(model.conflicts).toEqual([])
    expect(model.warnings).toEqual([])
    expect(() => ListModelSchema.parse(model)).not.toThrow()
  })

  it('scenario 1: docs-only (three packages)', () => {
    for (const name of ['zod', 'react', 'next']) {
      saveDocs(tmpDir, name, '1.0.0', [{ path: 'README.md', content: name }])
    }
    writeLock(tmpDir, {
      lockfileVersion: 1,
      generatedAt: ISO,
      entries: {
        zod: githubEntry('zod', '1.0.0'),
        react: githubEntry('react', '1.0.0'),
        next: githubEntry('next', '1.0.0'),
      },
    })
    const model = buildListModel(tmpDir)
    expect(model.entries).toHaveLength(3)
    expect(model.entries.every(e => e.format === 'docs')).toBe(true)
    expect(model.conflicts).toEqual([])
    expect(() => ListModelSchema.parse(model)).not.toThrow()
  })

  it('scenario 2: intent-only (two packages with skills)', () => {
    upsertIntentSkillsBlock(tmpDir, '@a/one', [
      { task: 't1', load: 'node_modules/@a/one/skills/t1/SKILL.md' },
    ])
    upsertIntentSkillsBlock(tmpDir, '@a/two', [
      { task: 't2', load: 'node_modules/@a/two/skills/t2/SKILL.md' },
      { task: 't3', load: 'node_modules/@a/two/skills/t3/SKILL.md' },
    ])
    writeLock(tmpDir, {
      lockfileVersion: 1,
      generatedAt: ISO,
      entries: {
        '@a/one': {
          source: 'npm',
          version: '1.0.0',
          fetchedAt: ISO,
          fileCount: 0,
          contentHash: SHA,
          installPath: '/abs/node_modules/@a/one',
          format: 'intent-skills',
        },
        '@a/two': {
          source: 'npm',
          version: '2.0.0',
          fetchedAt: ISO,
          fileCount: 0,
          contentHash: SHA,
          installPath: '/abs/node_modules/@a/two',
          format: 'intent-skills',
        },
      },
    })
    const model = buildListModel(tmpDir)
    expect(model.entries).toHaveLength(2)
    expect(model.entries.every(e => e.format === 'intent-skills')).toBe(true)
    const two = model.entries.find(e => e.name === '@a/two')!
    expect(two.skills).toHaveLength(2)
  })

  it('scenario 3: mixed (one docs + one intent)', () => {
    saveDocs(tmpDir, 'zod', '3.22.4', [{ path: 'README.md', content: 'z' }])
    upsertIntentSkillsBlock(tmpDir, 'alpha', [
      { task: 't', load: 'node_modules/alpha/skills/t/SKILL.md' },
    ])
    writeLock(tmpDir, {
      lockfileVersion: 1,
      generatedAt: ISO,
      entries: {
        zod: githubEntry('zod', '3.22.4'),
        alpha: {
          source: 'npm',
          version: '1.0.0',
          fetchedAt: ISO,
          fileCount: 0,
          contentHash: SHA,
          installPath: '/abs/node_modules/alpha',
          format: 'intent-skills',
        },
      },
    })
    const model = buildListModel(tmpDir)
    const formats = model.entries.map(e => e.format).sort()
    expect(formats).toEqual(['docs', 'intent-skills'])
  })

  it('scenario 4: conflict is NOT produced when lock keys are unique per name', () => {
    // The lock is keyed by name, so a project can only hold one version
    // of a package at a time. detectConflicts is exercised at the unit
    // level below; here we just verify the aggregator output is
    // conflict-free in normal operation.
    saveDocs(tmpDir, 'zod', '3.22.4', [{ path: 'README.md', content: 'z' }])
    writeLock(tmpDir, {
      lockfileVersion: 1,
      generatedAt: ISO,
      entries: { zod: githubEntry('zod', '3.22.4') },
    })
    expect(buildListModel(tmpDir).conflicts).toEqual([])
  })
})

describe('detectConflicts', () => {
  it('returns empty when every name is unique', () => {
    expect(
      detectConflicts([
        makeDocs('a', '1.0.0'),
        makeDocs('b', '1.0.0'),
      ]),
    ).toEqual([])
  })

  it('returns [] when same (name, version) appears twice', () => {
    expect(
      detectConflicts([
        makeDocs('a', '1.0.0'),
        makeDocs('a', '1.0.0'),
      ]),
    ).toEqual([])
  })

  it('flags a two-version collision', () => {
    const out = detectConflicts([
      makeDocs('a', '1.0.0'),
      makeDocs('a', '2.0.0'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('a')
    expect(out[0]!.versions).toEqual(['1.0.0', '2.0.0'])
  })

  it('sorts conflicts by name for deterministic output', () => {
    const out = detectConflicts([
      makeDocs('z', '1.0.0'),
      makeDocs('z', '2.0.0'),
      makeDocs('a', '1.0.0'),
      makeDocs('a', '2.0.0'),
    ])
    expect(out.map(c => c.name)).toEqual(['a', 'z'])
  })
})

function makeDocs(name: string, version: string) {
  return {
    name,
    version,
    format: 'docs' as const,
    source: 'github' as const,
    location: `.ask/docs/${name}@${version}`,
    fileCount: 1,
  }
}
