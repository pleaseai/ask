import type { ParsedDocSpec } from '../src/registry.js'
import { describe, expect, it } from 'bun:test'
import { parseDocSpec, parseEcosystem } from '../src/registry.js'

describe('parseEcosystem', () => {
  it('splits simple ecosystem prefix', () => {
    expect(parseEcosystem('npm:next')).toEqual({ ecosystem: 'npm', spec: 'next' })
  })

  it('splits scoped npm package (colon before slash)', () => {
    // Regression: the old `!input.includes('/')` guard bailed on scoped
    // names and returned `{ ecosystem: undefined, spec: 'npm:@scope/pkg' }`,
    // which fed a garbage URL (`registry/npm/npm:`) into the registry
    // lookup and forced a miss → github-monorepo download.
    expect(parseEcosystem('npm:@mastra/client-js')).toEqual({
      ecosystem: 'npm',
      spec: '@mastra/client-js',
    })
  })

  it('does not treat owner/repo shorthand as ecosystem', () => {
    expect(parseEcosystem('vercel/next.js')).toEqual({
      ecosystem: undefined,
      spec: 'vercel/next.js',
    })
  })

  it('does not treat owner/repo@ref shorthand as ecosystem', () => {
    // No colon at all, so nothing to split.
    expect(parseEcosystem('vercel/next.js@canary')).toEqual({
      ecosystem: undefined,
      spec: 'vercel/next.js@canary',
    })
  })
})

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

  // Regression guard for add-docs-cli-split-20260408: Gate A in `addCmd.run()`
  // rejects bare-name specs at the command layer, but the parser itself must
  // still return `kind: 'name'` so the gate can classify the input. Changing
  // the parser to throw on bare names would break `detectEcosystem` flows and
  // other callers. This test documents that invariant.
  describe('bare name regression (Gate A lives in command layer)', () => {
    it('parseDocSpec(\'next\') still returns kind: name', () => {
      const parsed = parseDocSpec('next')
      expect(parsed.kind).toBe('name')
      expect(parsed).toEqual({ kind: 'name', name: 'next', version: 'latest' })
    })

    it('parseDocSpec(\'next@15\') still returns kind: name with version', () => {
      const parsed = parseDocSpec('next@15')
      expect(parsed.kind).toBe('name')
      if (parsed.kind === 'name') {
        expect(parsed.name).toBe('next')
        expect(parsed.version).toBe('15')
      }
    })
  })
})

// NOTE: Source selection moved from the client to the entry author per
// ADR-0001 — `sources[]` is iterated in declaration order, and the registry
// server no longer reorders. There is no `selectBestStrategy` equivalent on
// the CLI side. Schema-level shape tests live in `packages/schema/test/`.
