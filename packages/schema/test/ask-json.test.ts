import { describe, expect, it } from 'bun:test'
import {
  AskJsonSchema,
  LibraryEntrySchema,
  ResolvedJsonSchema,
} from '../src/index.js'

describe('LibraryEntrySchema', () => {
  it('parses a PM-driven npm entry', () => {
    const result = LibraryEntrySchema.parse({ spec: 'npm:next' })
    expect(result.spec).toBe('npm:next')
  })

  it('parses a PM-driven entry with docsPath', () => {
    const result = LibraryEntrySchema.parse({ spec: 'npm:next', docsPath: 'docs' })
    expect((result as { docsPath?: string }).docsPath).toBe('docs')
  })

  it('parses a standalone github entry with required ref', () => {
    const result = LibraryEntrySchema.parse({
      spec: 'github:vercel/next.js',
      ref: 'v14.2.3',
      docsPath: 'docs',
    })
    expect(result.spec).toBe('github:vercel/next.js')
    expect((result as { ref?: string }).ref).toBe('v14.2.3')
  })

  it('rejects standalone github entry without ref', () => {
    expect(() => LibraryEntrySchema.parse({ spec: 'github:vercel/next.js' })).toThrow()
  })

  it('rejects bare names without an ecosystem prefix', () => {
    expect(() => LibraryEntrySchema.parse({ spec: 'next' })).toThrow()
  })

  it('rejects unknown fields (strict)', () => {
    expect(() => LibraryEntrySchema.parse({ spec: 'npm:next', extra: true })).toThrow()
  })

  it('rejects ref with shell-mischief characters', () => {
    expect(() => LibraryEntrySchema.parse({
      spec: 'github:foo/bar',
      ref: 'v1; rm -rf /',
    })).toThrow()
  })
})

describe('AskJsonSchema', () => {
  it('accepts an empty libraries list', () => {
    const result = AskJsonSchema.parse({ libraries: [] })
    expect(result.libraries).toEqual([])
  })

  it('accepts mixed PM-driven and standalone entries', () => {
    const result = AskJsonSchema.parse({
      libraries: [
        { spec: 'npm:next' },
        { spec: 'github:vercel/next.js', ref: 'v14.2.3', docsPath: 'docs' },
      ],
    })
    expect(result.libraries).toHaveLength(2)
  })

  it('rejects missing libraries field', () => {
    expect(() => AskJsonSchema.parse({})).toThrow()
  })

  it('rejects unknown top-level fields', () => {
    expect(() => AskJsonSchema.parse({ libraries: [], extra: 1 })).toThrow()
  })

  it('accepts emitSkill: true at the top level', () => {
    const result = AskJsonSchema.parse({ libraries: [], emitSkill: true })
    expect((result as { emitSkill?: boolean }).emitSkill).toBe(true)
  })

  it('accepts emitSkill: false at the top level', () => {
    const result = AskJsonSchema.parse({ libraries: [], emitSkill: false })
    expect((result as { emitSkill?: boolean }).emitSkill).toBe(false)
  })

  it('accepts absence of emitSkill (optional field)', () => {
    const result = AskJsonSchema.parse({ libraries: [] })
    expect((result as { emitSkill?: boolean }).emitSkill).toBeUndefined()
  })

  it('accepts storeMode: copy', () => {
    const result = AskJsonSchema.parse({ libraries: [], storeMode: 'copy' })
    expect(result.storeMode).toBe('copy')
  })

  it('accepts storeMode: link', () => {
    const result = AskJsonSchema.parse({ libraries: [], storeMode: 'link' })
    expect(result.storeMode).toBe('link')
  })

  it('accepts storeMode: ref', () => {
    const result = AskJsonSchema.parse({ libraries: [], storeMode: 'ref' })
    expect(result.storeMode).toBe('ref')
  })

  it('accepts absence of storeMode (optional field)', () => {
    const result = AskJsonSchema.parse({ libraries: [] })
    expect(result.storeMode).toBeUndefined()
  })

  it('rejects invalid storeMode value', () => {
    expect(() => AskJsonSchema.parse({ libraries: [], storeMode: 'invalid' })).toThrow()
  })

  it('accepts inPlace: true at the top level', () => {
    const result = AskJsonSchema.parse({ libraries: [], inPlace: true })
    expect((result as { inPlace?: boolean }).inPlace).toBe(true)
  })

  it('accepts inPlace: false at the top level', () => {
    const result = AskJsonSchema.parse({ libraries: [], inPlace: false })
    expect((result as { inPlace?: boolean }).inPlace).toBe(false)
  })

  it('accepts absence of inPlace (optional field)', () => {
    const result = AskJsonSchema.parse({ libraries: [] })
    expect((result as { inPlace?: boolean }).inPlace).toBeUndefined()
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

  it('accepts absence of materialization (backward compat)', () => {
    const result = ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: { next: base },
    })
    expect(result.entries.next!.materialization).toBeUndefined()
  })

  it('rejects invalid materialization value', () => {
    expect(() => ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: { next: { ...base, materialization: 'symlink' } },
    })).toThrow()
  })

  it('rejects materialization: in-place without inPlacePath', () => {
    expect(() => ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: { next: { ...base, materialization: 'in-place' } },
    })).toThrow(/inPlacePath is required when materialization is 'in-place'/)
  })
})

describe('ResolvedJsonSchema', () => {
  const validHash = `sha256-${'a'.repeat(64)}`
  const validIso = '2026-04-10T00:00:00+00:00'

  it('parses a valid resolved.json', () => {
    const result = ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: {
        next: {
          spec: 'npm:next',
          resolvedVersion: '15.0.0',
          contentHash: validHash,
          fetchedAt: validIso,
          fileCount: 12,
        },
      },
    })
    expect(result.entries.next!.resolvedVersion).toBe('15.0.0')
  })

  it('accepts the optional intent-skills format tag', () => {
    const result = ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: {
        'mastra-client-js': {
          spec: 'npm:@mastra/client-js',
          resolvedVersion: '0.1.0',
          contentHash: validHash,
          fetchedAt: validIso,
          fileCount: 3,
          format: 'intent-skills',
        },
      },
    })
    expect(result.entries['mastra-client-js']!.format).toBe('intent-skills')
  })

  it('rejects malformed contentHash', () => {
    expect(() => ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: {
        next: {
          spec: 'npm:next',
          resolvedVersion: '15.0.0',
          contentHash: 'not-a-hash',
          fetchedAt: validIso,
          fileCount: 0,
        },
      },
    })).toThrow()
  })

  it('rejects schemaVersion other than 1', () => {
    expect(() => ResolvedJsonSchema.parse({
      schemaVersion: 2,
      generatedAt: validIso,
      entries: {},
    })).toThrow()
  })

  it('accepts optional storePath and materialization fields', () => {
    const result = ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: {
        next: {
          spec: 'npm:next',
          resolvedVersion: '16.2.3',
          contentHash: validHash,
          fetchedAt: validIso,
          fileCount: 5,
          storePath: '/home/user/.ask/npm/next@16.2.3',
          materialization: 'copy',
        },
      },
    })
    expect(result.entries.next!.storePath).toBe('/home/user/.ask/npm/next@16.2.3')
    expect(result.entries.next!.materialization).toBe('copy')
  })

  it('accepts materialization: link', () => {
    const result = ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: {
        next: {
          spec: 'npm:next',
          resolvedVersion: '16.2.3',
          contentHash: validHash,
          fetchedAt: validIso,
          fileCount: 5,
          materialization: 'link',
        },
      },
    })
    expect(result.entries.next!.materialization).toBe('link')
  })

  it('accepts materialization: ref', () => {
    const result = ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: {
        next: {
          spec: 'npm:next',
          resolvedVersion: '16.2.3',
          contentHash: validHash,
          fetchedAt: validIso,
          fileCount: 5,
          materialization: 'ref',
        },
      },
    })
    expect(result.entries.next!.materialization).toBe('ref')
  })

  it('rejects invalid materialization value', () => {
    expect(() => ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: {
        next: {
          spec: 'npm:next',
          resolvedVersion: '16.2.3',
          contentHash: validHash,
          fetchedAt: validIso,
          fileCount: 5,
          materialization: 'invalid',
        },
      },
    })).toThrow()
  })

  it('rejects unknown fields on ResolvedEntry (strict)', () => {
    expect(() => ResolvedJsonSchema.parse({
      schemaVersion: 1,
      generatedAt: validIso,
      entries: {
        next: {
          spec: 'npm:next',
          resolvedVersion: '16.2.3',
          contentHash: validHash,
          fetchedAt: validIso,
          fileCount: 5,
          unknownField: true,
        },
      },
    })).toThrow()
  })
})
