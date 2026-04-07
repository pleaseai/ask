import { describe, expect, it } from 'bun:test'
import { expandStrategies } from '../src/registry-schema.js'

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
