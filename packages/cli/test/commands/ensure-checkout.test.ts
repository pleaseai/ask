import type { GithubSourceOptions, SourceConfig } from '../../src/sources/index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  ensureCheckout,
  NoCacheError,
  splitExplicitVersion,
} from '../../src/commands/ensure-checkout.js'

interface FetchCall {
  opts: GithubSourceOptions
}

function makeFetcher(behavior: (opts: GithubSourceOptions) => void) {
  const calls: FetchCall[] = []
  const fetcher = {
    fetch: mock(async (opts: SourceConfig) => {
      const ghOpts = opts as GithubSourceOptions
      calls.push({ opts: ghOpts })
      behavior(ghOpts)
      return {
        files: [],
        resolvedVersion: ghOpts.version,
        storePath: undefined,
      }
    }),
  }
  return { fetcher, calls }
}

function makeResolver(map: Record<string, { repo: string, ref: string, resolvedVersion: string }>) {
  return {
    resolve: mock(async (name: string, _version: string) => {
      const result = map[name]
      if (!result) {
        throw new Error(`mock resolver: no mapping for ${name}`)
      }
      return { ...result, fallbackRefs: [] }
    }),
  }
}

let askHome: string
let projectDir: string

beforeEach(() => {
  askHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-home-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-proj-'))
})

afterEach(() => {
  fs.rmSync(askHome, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

// ── splitExplicitVersion ────────────────────────────────────────

describe('splitExplicitVersion', () => {
  it('returns spec unchanged when no @ is present', () => {
    expect(splitExplicitVersion('react')).toEqual({ spec: 'react' })
  })

  it('splits trailing @version from a bare name', () => {
    expect(splitExplicitVersion('react@18.2.0')).toEqual({ spec: 'react', version: '18.2.0' })
  })

  it('treats leading @ in scoped npm name as scope marker, not version', () => {
    expect(splitExplicitVersion('@vercel/ai')).toEqual({ spec: '@vercel/ai' })
  })

  it('splits @version after a scoped npm name', () => {
    expect(splitExplicitVersion('@vercel/ai@5.0.0')).toEqual({ spec: '@vercel/ai', version: '5.0.0' })
  })

  it('splits @version after an npm: prefix', () => {
    expect(splitExplicitVersion('npm:react@18.2.0')).toEqual({ spec: 'npm:react', version: '18.2.0' })
  })

  it('treats npm:@scope/pkg as having no explicit version', () => {
    expect(splitExplicitVersion('npm:@vercel/ai')).toEqual({ spec: 'npm:@vercel/ai' })
  })

  it('splits @version after npm:@scope/pkg', () => {
    expect(splitExplicitVersion('npm:@vercel/ai@5.0.0')).toEqual({ spec: 'npm:@vercel/ai', version: '5.0.0' })
  })

  it('splits @version after a github: prefix', () => {
    expect(splitExplicitVersion('github:facebook/react@v18.2.0')).toEqual({
      spec: 'github:facebook/react',
      version: 'v18.2.0',
    })
  })

  it('splits @version containing slashes (git ref with path component)', () => {
    expect(splitExplicitVersion('github:facebook/react@release/v1.2.3')).toEqual({
      spec: 'github:facebook/react',
      version: 'release/v1.2.3',
    })
  })
})

// ── ensureCheckout ─────────────────────────────────────────────

describe('ensureCheckout', () => {
  it('returns existing path on cache hit without calling fetch', async () => {
    // Pre-populate the cache
    const checkoutDir = path.join(askHome, 'github', 'github.com', 'facebook', 'react', 'v18.2.0')
    fs.mkdirSync(checkoutDir, { recursive: true })
    fs.writeFileSync(path.join(checkoutDir, 'README.md'), '# react')

    const { fetcher, calls } = makeFetcher(() => {
      throw new Error('fetcher must not be called on cache hit')
    })
    const resolver = makeResolver({
      react: { repo: 'facebook/react', ref: 'v18.2.0', resolvedVersion: '18.2.0' },
    })

    const result = await ensureCheckout(
      { spec: 'react@18.2.0', projectDir },
      {
        askHome,
        fetcher,
        resolverFor: () => resolver,
        lockfileReader: { read: () => null },
      },
    )

    expect(result.checkoutDir).toBe(checkoutDir)
    expect(result.owner).toBe('facebook')
    expect(result.repo).toBe('react')
    expect(result.ref).toBe('v18.2.0')
    expect(result.resolvedVersion).toBe('18.2.0')
    expect(calls).toHaveLength(0)
  })

  it('calls fetcher on cache miss and returns path', async () => {
    const expectedDir = path.join(askHome, 'github', 'github.com', 'facebook', 'react', 'v18.2.0')

    const { fetcher, calls } = makeFetcher((opts) => {
      // Simulate fetcher writing files to the checkout dir
      fs.mkdirSync(expectedDir, { recursive: true })
      fs.writeFileSync(path.join(expectedDir, 'package.json'), '{}')
      void opts // unused
    })
    const resolver = makeResolver({
      react: { repo: 'facebook/react', ref: 'v18.2.0', resolvedVersion: '18.2.0' },
    })

    const result = await ensureCheckout(
      { spec: 'react@18.2.0', projectDir },
      {
        askHome,
        fetcher,
        resolverFor: () => resolver,
        lockfileReader: { read: () => null },
      },
    )

    expect(result.checkoutDir).toBe(expectedDir)
    expect(calls).toHaveLength(1)
    expect(calls[0].opts.repo).toBe('facebook/react')
    expect(calls[0].opts.tag).toBe('v18.2.0')
  })

  it('uses explicit @version over lockfile version', async () => {
    const expectedDir = path.join(askHome, 'github', 'github.com', 'facebook', 'react', 'v18.2.0')
    fs.mkdirSync(expectedDir, { recursive: true })

    const resolver = makeResolver({
      react: { repo: 'facebook/react', ref: 'v18.2.0', resolvedVersion: '18.2.0' },
    })
    const lockfileReader = {
      read: mock(() => ({ version: '17.0.0' })),
    }

    await ensureCheckout(
      { spec: 'react@18.2.0', projectDir },
      {
        askHome,
        fetcher: { fetch: mock(async () => ({ files: [], resolvedVersion: '18.2.0' })) },
        resolverFor: () => resolver,
        lockfileReader,
      },
    )

    // Resolver was called with the explicit version, not the lockfile version
    expect(resolver.resolve).toHaveBeenCalledWith('react', '18.2.0')
  })

  it('falls back to lockfile version when no explicit @version on npm spec', async () => {
    const expectedDir = path.join(askHome, 'github', 'github.com', 'facebook', 'react', 'v17.0.0')
    fs.mkdirSync(expectedDir, { recursive: true })

    const resolver = makeResolver({
      react: { repo: 'facebook/react', ref: 'v17.0.0', resolvedVersion: '17.0.0' },
    })
    const lockfileReader = {
      read: mock(() => ({ version: '17.0.0' })),
    }

    await ensureCheckout(
      { spec: 'react', projectDir },
      {
        askHome,
        fetcher: { fetch: mock(async () => ({ files: [], resolvedVersion: '17.0.0' })) },
        resolverFor: () => resolver,
        lockfileReader,
      },
    )

    expect(resolver.resolve).toHaveBeenCalledWith('react', '17.0.0')
  })

  it('falls back to "latest" when no explicit version and no lockfile hit', async () => {
    const expectedDir = path.join(askHome, 'github', 'github.com', 'facebook', 'react', 'v18.3.0')
    fs.mkdirSync(expectedDir, { recursive: true })

    const resolver = makeResolver({
      react: { repo: 'facebook/react', ref: 'v18.3.0', resolvedVersion: '18.3.0' },
    })

    await ensureCheckout(
      { spec: 'react', projectDir },
      {
        askHome,
        fetcher: { fetch: mock(async () => ({ files: [], resolvedVersion: '18.3.0' })) },
        resolverFor: () => resolver,
        lockfileReader: { read: () => null },
      },
    )

    expect(resolver.resolve).toHaveBeenCalledWith('react', 'latest')
  })

  it('handles github: spec without explicit ref by defaulting to main', async () => {
    const expectedDir = path.join(askHome, 'github', 'github.com', 'facebook', 'react', 'main')

    const { fetcher, calls } = makeFetcher(() => {
      fs.mkdirSync(expectedDir, { recursive: true })
    })

    const result = await ensureCheckout(
      { spec: 'github:facebook/react', projectDir },
      {
        askHome,
        fetcher,
        resolverFor: () => null,
        lockfileReader: { read: () => null },
      },
    )

    expect(result.ref).toBe('main')
    expect(result.checkoutDir).toBe(expectedDir)
    expect(calls).toHaveLength(1)
    // Implicit default ref: pass NEITHER `tag` nor `branch` so
    // GithubSource can apply its default-branch fallback chain
    // (main → vmain → master). Setting `branch: 'main'` would defeat
    // the fallback for repos whose default branch is `master`.
    expect(calls[0].opts.branch).toBeUndefined()
    expect(calls[0].opts.tag).toBeUndefined()
  })

  it('omits tag/branch for bare github spec so master fallback in GithubSource activates', async () => {
    // Regression for: `bunx @pleaseai/ask src github:gitbutlerapp/gitbutler`
    // failing with `tried: main, vmain` because `ensureCheckout` passed
    // `branch: 'main'` and forced `GithubSource.isDefaultRef = false`.
    const { fetcher, calls } = makeFetcher(() => {
      const dir = path.join(askHome, 'github', 'github.com', 'gitbutlerapp', 'gitbutler', 'main')
      fs.mkdirSync(dir, { recursive: true })
    })

    await ensureCheckout(
      { spec: 'github:gitbutlerapp/gitbutler', projectDir },
      {
        askHome,
        fetcher,
        resolverFor: () => null,
        lockfileReader: { read: () => null },
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].opts.tag).toBeUndefined()
    expect(calls[0].opts.branch).toBeUndefined()
  })

  it('handles github: spec with explicit @ref', async () => {
    const expectedDir = path.join(askHome, 'github', 'github.com', 'facebook', 'react', 'v18.2.0')

    const { fetcher, calls } = makeFetcher(() => {
      fs.mkdirSync(expectedDir, { recursive: true })
    })

    const result = await ensureCheckout(
      { spec: 'github:facebook/react@v18.2.0', projectDir },
      {
        askHome,
        fetcher,
        resolverFor: () => null,
        lockfileReader: { read: () => null },
      },
    )

    expect(result.ref).toBe('v18.2.0')
    expect(result.checkoutDir).toBe(expectedDir)
    expect(calls[0].opts.tag).toBe('v18.2.0')
    expect(calls[0].opts.branch).toBeUndefined()
  })

  it('throws NoCacheError when noFetch is set and cache misses', async () => {
    const resolver = makeResolver({
      react: { repo: 'facebook/react', ref: 'v18.2.0', resolvedVersion: '18.2.0' },
    })
    const fetcher = {
      fetch: mock(async () => {
        throw new Error('fetcher must not be called when noFetch=true')
      }),
    }

    await expect(
      ensureCheckout(
        { spec: 'react@18.2.0', projectDir, noFetch: true },
        {
          askHome,
          fetcher,
          resolverFor: () => resolver,
          lockfileReader: { read: () => null },
        },
      ),
    ).rejects.toBeInstanceOf(NoCacheError)
    expect(fetcher.fetch).toHaveBeenCalledTimes(0)
  })

  it('returns cache hit even with noFetch=true', async () => {
    const checkoutDir = path.join(askHome, 'github', 'github.com', 'facebook', 'react', 'v18.2.0')
    fs.mkdirSync(checkoutDir, { recursive: true })

    const resolver = makeResolver({
      react: { repo: 'facebook/react', ref: 'v18.2.0', resolvedVersion: '18.2.0' },
    })

    const result = await ensureCheckout(
      { spec: 'react@18.2.0', projectDir, noFetch: true },
      {
        askHome,
        fetcher: { fetch: mock(async () => ({ files: [], resolvedVersion: '18.2.0' })) },
        resolverFor: () => resolver,
        lockfileReader: { read: () => null },
      },
    )

    expect(result.checkoutDir).toBe(checkoutDir)
  })

  it('propagates resolver errors with the resolver message', async () => {
    const resolver = {
      resolve: mock(async () => {
        throw new Error(
          'Cannot resolve GitHub repository for npm package \'no-repo\'. '
          + 'The \'repository\' field is missing or not a GitHub URL.',
        )
      }),
    }

    await expect(
      ensureCheckout(
        { spec: 'no-repo', projectDir },
        {
          askHome,
          fetcher: { fetch: mock(async () => ({ files: [], resolvedVersion: '0' })) },
          resolverFor: () => resolver,
          lockfileReader: { read: () => null },
        },
      ),
    ).rejects.toThrow(/Cannot resolve GitHub repository/)
  })

  it('throws when resolverFor returns null for an unknown ecosystem', async () => {
    await expect(
      ensureCheckout(
        { spec: 'haskell:lens', projectDir },
        {
          askHome,
          fetcher: { fetch: mock(async () => ({ files: [], resolvedVersion: '0' })) },
          resolverFor: () => null,
          lockfileReader: { read: () => null },
        },
      ),
    ).rejects.toThrow(/unsupported ecosystem|haskell/i)
  })

  it('exposes npmPackageName for npm-ecosystem specs', async () => {
    const checkoutDir = path.join(askHome, 'github', 'github.com', 'facebook', 'react', 'v18.2.0')
    fs.mkdirSync(checkoutDir, { recursive: true })

    const resolver = makeResolver({
      react: { repo: 'facebook/react', ref: 'v18.2.0', resolvedVersion: '18.2.0' },
    })

    const result = await ensureCheckout(
      { spec: 'react@18.2.0', projectDir },
      {
        askHome,
        fetcher: { fetch: mock(async () => ({ files: [], resolvedVersion: '18.2.0' })) },
        resolverFor: () => resolver,
        lockfileReader: { read: () => null },
      },
    )

    expect(result.npmPackageName).toBe('react')
  })

  it('does not expose npmPackageName for github specs', async () => {
    const checkoutDir = path.join(askHome, 'github', 'github.com', 'facebook', 'react', 'main')
    fs.mkdirSync(checkoutDir, { recursive: true })

    const result = await ensureCheckout(
      { spec: 'github:facebook/react', projectDir },
      {
        askHome,
        fetcher: { fetch: mock(async () => ({ files: [], resolvedVersion: 'main' })) },
        resolverFor: () => null,
        lockfileReader: { read: () => null },
      },
    )

    expect(result.npmPackageName).toBeUndefined()
  })

  it('passes fallbackRefs from resolver result to fetcher options', async () => {
    const { fetcher, calls } = makeFetcher((opts) => {
      const expectedDir = path.join(askHome, 'github', 'github.com', 'vercel', 'ai', 'ai@6.0.159')
      fs.mkdirSync(expectedDir, { recursive: true })
      void opts
    })
    const resolver = {
      resolve: mock(async (_name: string, _version: string) => ({
        repo: 'vercel/ai',
        ref: 'ai@6.0.159',
        resolvedVersion: '6.0.159',
        fallbackRefs: ['ai@6.0.158'],
      })),
    }

    await ensureCheckout(
      { spec: 'npm:@vercel/ai@6.0.159', projectDir },
      {
        askHome,
        fetcher,
        resolverFor: () => resolver,
        lockfileReader: { read: () => null },
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].opts.fallbackRefs).toEqual(['ai@6.0.158'])
  })
})
