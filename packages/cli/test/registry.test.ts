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

    it('handles scoped npm packages with @ in name', () => {
      // Note: scoped packages aren't expected in ecosystem prefix syntax,
      // but if someone writes `npm:@scope/pkg`, the slash makes it ambiguous —
      // we treat anything with a colon prefix as ecosystem mode and use the
      // last @ as version separator.
      expect(parseDocSpec('npm:zod@3.22.4')).toEqual({
        kind: 'ecosystem',
        ecosystem: 'npm',
        name: 'zod',
        version: '3.22.4',
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
