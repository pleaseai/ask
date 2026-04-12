import { describe, expect, it } from 'bun:test'
import {
  AskJsonSchema,
  ResolvedJsonSchema,
} from '../src/index.js'

describe('AskJsonSchema — lazy-first string array', () => {
  it('accepts an empty libraries list', () => {
    const result = AskJsonSchema.parse({ libraries: [] })
    expect(result.libraries).toEqual([])
  })

  it('accepts npm spec strings', () => {
    const result = AskJsonSchema.parse({
      libraries: ['npm:next', 'npm:zod', 'npm:@vercel/ai'],
    })
    expect(result.libraries).toHaveLength(3)
  })

  it('accepts github spec strings with inline ref', () => {
    const result = AskJsonSchema.parse({
      libraries: ['github:vercel/next.js@v14.2.3'],
    })
    expect(result.libraries).toHaveLength(1)
    expect(result.libraries[0]).toBe('github:vercel/next.js@v14.2.3')
  })

  it('accepts mixed ecosystem specs', () => {
    const result = AskJsonSchema.parse({
      libraries: [
        'npm:next',
        'github:vercel/ai@v5.0.0',
        'pypi:requests',
      ],
    })
    expect(result.libraries).toHaveLength(3)
  })

  it('rejects bare names without an ecosystem prefix', () => {
    expect(() => AskJsonSchema.parse({
      libraries: ['next'],
    })).toThrow(/ecosystem prefix/)
  })

  it('rejects non-string entries', () => {
    expect(() => AskJsonSchema.parse({
      libraries: [{ spec: 'npm:next' }],
    })).toThrow()
  })

  it('rejects missing libraries field', () => {
    expect(() => AskJsonSchema.parse({})).toThrow()
  })

  it('rejects unknown top-level fields', () => {
    expect(() => AskJsonSchema.parse({
      libraries: [],
      emitSkill: true,
    })).toThrow()
  })

  it('rejects old LibraryEntry object format', () => {
    expect(() => AskJsonSchema.parse({
      libraries: [{ spec: 'npm:next', docsPath: 'docs' }],
    })).toThrow()
  })

  it('rejects old storeMode top-level field', () => {
    expect(() => AskJsonSchema.parse({
      libraries: [],
      storeMode: 'copy',
    })).toThrow()
  })

  it('rejects old inPlace top-level field', () => {
    expect(() => AskJsonSchema.parse({
      libraries: [],
      inPlace: true,
    })).toThrow()
  })

  it('rejects empty spec strings', () => {
    expect(() => AskJsonSchema.parse({
      libraries: [''],
    })).toThrow()
  })
})

describe('ResolvedEntrySchema — materialization & inPlacePath', () => {
  const validHash = `sha256-${'a'.repeat(64)}`
  const validIso = '2026-04-10T00:00:00+00:00'
  const base = {
    spec: 'npm:next',
    resolvedVersion: '16.2.3',
    contentHash: validHash,
    fetchedAt: validIso,
    fileCount: 42,
  }

  it('accepts materialization: copy', () => {
    const result = ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: { next: { ...base, materialization: 'copy' } },
    })
    expect(result.entries.next!.materialization).toBe('copy')
  })

  it('accepts materialization: in-place with inPlacePath', () => {
    const result = ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: {
        next: {
          ...base,
          materialization: 'in-place',
          inPlacePath: 'node_modules/next/dist/docs',
        },
      },
    })
    expect(result.entries.next!.materialization).toBe('in-place')
    expect(result.entries.next!.inPlacePath).toBe('node_modules/next/dist/docs')
  })

  it('rejects materialization: in-place without inPlacePath', () => {
    expect(() => ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: { next: { ...base, materialization: 'in-place' } },
    })).toThrow(/inPlacePath is required when materialization is 'in-place'/)
  })

  it('accepts optional commit field (40-char hex SHA)', () => {
    const sha = 'a'.repeat(40)
    const result = ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: {
        next: {
          spec: 'github:vercel/next.js',
          resolvedVersion: '14.2.3',
          contentHash: validHash,
          fetchedAt: validIso,
          fileCount: 5,
          commit: sha,
        },
      },
    })
    expect(result.entries.next!.commit).toBe(sha)
  })

  it('rejects commit with non-40-hex format', () => {
    expect(() => ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: {
        next: {
          spec: 'github:vercel/next.js',
          resolvedVersion: '14.2.3',
          contentHash: validHash,
          fetchedAt: validIso,
          fileCount: 5,
          commit: 'not-a-sha',
        },
      },
    })).toThrow()
  })
})
