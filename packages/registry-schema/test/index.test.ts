import { describe, expect, it } from 'bun:test'
import { aliasSchema, expandStrategies, registryEntrySchema, strategySchema } from '../src/index.js'

describe('expandStrategies', () => {
  it('generates github strategy from repo + docsPath', () => {
    const result = expandStrategies({
      repo: 'vercel/next.js',
      docsPath: 'docs',
    })
    expect(result).toEqual([
      { source: 'github', repo: 'vercel/next.js', docsPath: 'docs' },
    ])
  })

  it('generates github strategy from repo alone (no docsPath)', () => {
    const result = expandStrategies({
      repo: 'colinhacks/zod',
    })
    expect(result).toEqual([
      { source: 'github', repo: 'colinhacks/zod' },
    ])
  })

  it('returns existing strategies as-is when provided', () => {
    const strategies = [
      { source: 'npm' as const, package: 'next', docsPath: 'dist/docs' },
      { source: 'github' as const, repo: 'vercel/next.js', docsPath: 'docs' },
    ]
    const result = expandStrategies({ strategies })
    expect(result).toEqual(strategies)
  })

  it('returns existing strategies when both repo and strategies are provided', () => {
    const strategies = [
      { source: 'web' as const, urls: ['https://tailwindcss.com/docs'], maxDepth: 2 },
    ]
    const result = expandStrategies({ repo: 'tailwindlabs/tailwindcss', strategies })
    expect(result).toEqual(strategies)
  })

  it('throws when neither repo nor strategies is provided', () => {
    expect(() => expandStrategies({})).toThrow(/repo.*strategies|strategies.*repo/)
  })

  it('throws when strategies is an empty array and no repo', () => {
    expect(() => expandStrategies({ strategies: [] })).toThrow(/repo.*strategies|strategies.*repo/)
  })

  it('generates strategy from repo when strategies is empty array', () => {
    const result = expandStrategies({
      repo: 'fastapi/fastapi',
      strategies: [],
      docsPath: 'docs',
    })
    expect(result).toEqual([
      { source: 'github', repo: 'fastapi/fastapi', docsPath: 'docs' },
    ])
  })
})

describe('strategySchema', () => {
  it('parses valid strategy', () => {
    const result = strategySchema.parse({ source: 'github', repo: 'vercel/next.js' })
    expect(result.source).toBe('github')
    expect(result.repo).toBe('vercel/next.js')
  })

  it('rejects invalid source', () => {
    expect(() => strategySchema.parse({ source: 'invalid' })).toThrow()
  })
})

describe('aliasSchema', () => {
  it('parses valid alias', () => {
    const result = aliasSchema.parse({ ecosystem: 'npm', name: 'react' })
    expect(result.ecosystem).toBe('npm')
    expect(result.name).toBe('react')
  })

  it('rejects invalid ecosystem', () => {
    expect(() => aliasSchema.parse({ ecosystem: 'invalid', name: 'x' })).toThrow()
  })
})

describe('registryEntrySchema', () => {
  it('parses valid entry with defaults', () => {
    const result = registryEntrySchema.parse({
      name: 'next',
      description: 'React framework',
      repo: 'vercel/next.js',
    })
    expect(result.aliases).toEqual([])
    expect(result.strategies).toEqual([])
  })

  it('parses a fully-populated entry', () => {
    const result = registryEntrySchema.parse({
      name: 'next',
      description: 'React framework',
      repo: 'vercel/next.js',
      docsPath: 'docs',
      homepage: 'https://nextjs.org',
      license: 'MIT',
      aliases: [{ ecosystem: 'npm', name: 'next' }],
      strategies: [{ source: 'github', repo: 'vercel/next.js', docsPath: 'docs' }],
      tags: ['react', 'framework'],
    })
    expect(result.aliases).toHaveLength(1)
    expect(result.strategies).toHaveLength(1)
  })

  it('rejects invalid repo format', () => {
    expect(() => registryEntrySchema.parse({
      name: 'bad',
      description: 'bad',
      repo: 'no-slash',
    })).toThrow()
  })
})
