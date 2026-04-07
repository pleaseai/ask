import type { ParsedDocSpec } from '../src/registry.js'
import { describe, expect, it } from 'bun:test'
import { parseDocSpec } from '../src/registry.js'

describe('parseDocSpec', () => {
  describe('github kind (owner/repo)', () => {
    it('parses owner/repo without ref', () => {
      expect(parseDocSpec('vercel/next.js')).toEqual({
        kind: 'github',
        owner: 'vercel',
        repo: 'next.js',
      })
    })

    it('parses owner/repo with @tag ref', () => {
      expect(parseDocSpec('vercel/next.js@v15.0.0')).toEqual({
        kind: 'github',
        owner: 'vercel',
        repo: 'next.js',
        ref: 'v15.0.0',
      })
    })

    it('parses owner/repo with @branch ref', () => {
      expect(parseDocSpec('vercel/next.js@canary')).toEqual({
        kind: 'github',
        owner: 'vercel',
        repo: 'next.js',
        ref: 'canary',
      })
    })

    it('keeps dots and dashes in repo name', () => {
      expect(parseDocSpec('colinhacks/zod-v4')).toEqual({
        kind: 'github',
        owner: 'colinhacks',
        repo: 'zod-v4',
      })
    })
  })

  describe('ecosystem kind (prefix:name)', () => {
    it('parses ecosystem prefix without version', () => {
      expect(parseDocSpec('npm:next')).toEqual({
        kind: 'ecosystem',
        ecosystem: 'npm',
        name: 'next',
        version: 'latest',
      })
    })

    it('parses ecosystem prefix with version', () => {
      expect(parseDocSpec('npm:next@canary')).toEqual({
        kind: 'ecosystem',
        ecosystem: 'npm',
        name: 'next',
        version: 'canary',
      })
    })

    it('parses ecosystem prefix with semver range', () => {
      expect(parseDocSpec('npm:next@^15')).toEqual({
        kind: 'ecosystem',
        ecosystem: 'npm',
        name: 'next',
        version: '^15',
      })
    })

    it('parses pypi ecosystem', () => {
      expect(parseDocSpec('pypi:fastapi@0.110.0')).toEqual({
        kind: 'ecosystem',
        ecosystem: 'pypi',
        name: 'fastapi',
        version: '0.110.0',
      })
    })

    it('parses simple ecosystem name with version', () => {
      expect(parseDocSpec('npm:zod@3.22.4')).toEqual({
        kind: 'ecosystem',
        ecosystem: 'npm',
        name: 'zod',
        version: '3.22.4',
      })
    })

    it('routes scoped npm package to ecosystem (slash + colon)', () => {
      // `npm:@scope/pkg@1.0` contains both `/` and `:` — the colon-prefix
      // rule must win so the entry goes through the registry path, not
      // the github fast-path.
      expect(parseDocSpec('npm:@scope/pkg@1.0')).toEqual({
        kind: 'ecosystem',
        ecosystem: 'npm',
        name: '@scope/pkg',
        version: '1.0',
      })
    })
  })

  describe('name kind (bare name)', () => {
    it('parses bare name without version', () => {
      expect(parseDocSpec('next')).toEqual({
        kind: 'name',
        name: 'next',
        version: 'latest',
      })
    })

    it('parses bare name with version', () => {
      expect(parseDocSpec('zod@3.22.4')).toEqual({
        kind: 'name',
        name: 'zod',
        version: '3.22.4',
      })
    })
  })

  describe('regression: existing 6 registry entries still resolve as non-github', () => {
    // T-6: ensure none of the shipped registry entries collide with the new
    // github fast-path. All bare names must parse as `name`, prefixed names
    // as `ecosystem`. A regression here would route them away from the
    // registry lookup and break `ask docs add next` etc.
    const entries: Array<[string, ParsedDocSpec['kind']]> = [
      ['next', 'name'],
      ['nuxt', 'name'],
      ['nuxt-ui', 'name'],
      ['tailwindcss', 'name'],
      ['zod', 'name'],
      ['fastapi', 'name'],
      ['npm:next', 'ecosystem'],
      ['npm:zod', 'ecosystem'],
      ['pypi:fastapi', 'ecosystem'],
    ]
    for (const [input, expectedKind] of entries) {
      it(`'${input}' → ${expectedKind}`, () => {
        expect(parseDocSpec(input).kind).toBe(expectedKind)
      })
    }
  })

  describe('error cases', () => {
    it('throws on more than one slash', () => {
      expect(() => parseDocSpec('a/b/c')).toThrow(/exactly one slash/i)
    })

    it('throws on empty owner', () => {
      expect(() => parseDocSpec('/repo')).toThrow(/owner/i)
    })

    it('throws on empty repo', () => {
      expect(() => parseDocSpec('owner/')).toThrow(/repo/i)
    })

    it('throws on empty input', () => {
      expect(() => parseDocSpec('')).toThrow()
    })
  })
})
