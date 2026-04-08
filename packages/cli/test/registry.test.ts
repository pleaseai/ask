import type { RegistryStrategy } from '@pleaseai/ask-schema'
import type { ParsedDocSpec } from '../src/registry.js'
import { describe, expect, it } from 'bun:test'
import { parseDocSpec, selectBestStrategy } from '../src/registry.js'

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

describe('selectBestStrategy', () => {
  // T-3/T-4 (npm-tarball-docs-20260408): An npm strategy carrying a `docsPath`
  // is treated as author-curated and outranks github. Without `docsPath` the
  // static SOURCE_PRIORITY table still wins. These tests are the regression
  // guard for that selection rule.

  const github: RegistryStrategy = { source: 'github', repo: 'vercel/next.js', docsPath: 'docs' }
  const npmCurated: RegistryStrategy = { source: 'npm', package: 'next', docsPath: 'dist/docs' }
  const npmBare: RegistryStrategy = { source: 'npm', package: 'next' }
  const web: RegistryStrategy = { source: 'web', urls: ['https://example.com/docs'] }

  it('returns the only strategy when list has one entry (github)', () => {
    expect(selectBestStrategy([github])).toBe(github)
  })

  it('returns the only strategy when list has one entry (curated npm)', () => {
    expect(selectBestStrategy([npmCurated])).toBe(npmCurated)
  })

  it('npm-with-docsPath beats github even when github is listed first', () => {
    // Real-world case: vercel/ai entry lists npm + github strategies; the
    // curated npm dist/docs path must win regardless of declaration order.
    expect(selectBestStrategy([github, npmCurated])).toBe(npmCurated)
    expect(selectBestStrategy([npmCurated, github])).toBe(npmCurated)
  })

  it('npm-without-docsPath does NOT beat github (falls back to static priority)', () => {
    // A bare `source: npm` entry has no proof of curation — github wins.
    expect(selectBestStrategy([github, npmBare])).toBe(github)
    expect(selectBestStrategy([npmBare, github])).toBe(github)
  })

  it('curated npm wins over web too', () => {
    expect(selectBestStrategy([web, npmCurated])).toBe(npmCurated)
  })

  it('tie-break is stable (declaration order) for non-curated case', () => {
    const githubA: RegistryStrategy = { source: 'github', repo: 'a/x' }
    const githubB: RegistryStrategy = { source: 'github', repo: 'b/y' }
    expect(selectBestStrategy([githubA, githubB])).toBe(githubA)
    expect(selectBestStrategy([githubB, githubA])).toBe(githubB)
  })

  it('among multiple curated npm strategies WITHOUT context, declaration order wins', () => {
    const core: RegistryStrategy = { source: 'npm', package: '@mastra/core', docsPath: 'dist/docs' }
    const memory: RegistryStrategy = { source: 'npm', package: '@mastra/memory', docsPath: 'dist/docs' }
    expect(selectBestStrategy([core, memory])).toBe(core)
    expect(selectBestStrategy([memory, core])).toBe(memory)
  })

  it('with requestedPackage context, picks the matching curated npm strategy (monorepo case)', () => {
    // Real-world Mastra case: one registry entry holds two npm strategies
    // (@mastra/core and @mastra/memory). The user asks for one of them and
    // must get the matching strategy regardless of declaration order.
    const core: RegistryStrategy = { source: 'npm', package: '@mastra/core', docsPath: 'dist/docs' }
    const memory: RegistryStrategy = { source: 'npm', package: '@mastra/memory', docsPath: 'dist/docs' }
    const github: RegistryStrategy = { source: 'github', repo: 'mastra-ai/mastra', docsPath: 'docs' }

    // Asking for @mastra/memory must NOT return the core strategy.
    expect(
      selectBestStrategy([core, memory, github], { requestedPackage: '@mastra/memory' }),
    ).toBe(memory)
    // And asking for @mastra/core must return core even when memory is first.
    expect(
      selectBestStrategy([memory, core, github], { requestedPackage: '@mastra/core' }),
    ).toBe(core)
  })

  it('with requestedPackage context that matches no strategy, falls back to first curated', () => {
    const core: RegistryStrategy = { source: 'npm', package: '@mastra/core', docsPath: 'dist/docs' }
    const memory: RegistryStrategy = { source: 'npm', package: '@mastra/memory', docsPath: 'dist/docs' }

    // requestedPackage is set but no strategy matches it — fall back to
    // Rule 2 (first curated npm).
    expect(
      selectBestStrategy([core, memory], { requestedPackage: '@mastra/nonexistent' }),
    ).toBe(core)
  })

  it('throws on empty list', () => {
    expect(() => selectBestStrategy([])).toThrow(/at least one/i)
  })

  // T-14 regression: ensure that registry entries WITHOUT explicit
  // strategies (the common case for entries created before this track) keep
  // resolving to a github strategy via expandStrategies + selectBestStrategy.
  // The full chain runs in fetchRegistryEntry → resolveFromRegistry. Here we
  // just exercise selectBestStrategy on the synthetic shape that
  // expandStrategies emits for those entries.
  it('regression: bare github entry (no strategies array) still resolves to github', () => {
    // Mirrors the shape `expandStrategies({ repo, docsPath })` produces for
    // entries like lodash/lodash, axios/axios, jquery/jquery.
    const fromBareEntry: RegistryStrategy = { source: 'github', repo: 'lodash/lodash' }
    expect(selectBestStrategy([fromBareEntry])).toBe(fromBareEntry)
  })
})
