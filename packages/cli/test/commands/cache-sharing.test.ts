import type { GithubSourceOptions, SourceConfig } from '../../src/sources/index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { ensureCheckout } from '../../src/commands/ensure-checkout.js'
import { githubCheckoutPath } from '../../src/store/index.js'

/**
 * SC-6: After running `ask install` for a library that populates
 * `~/.ask/github/checkouts/<o>__<r>/<ref>/`, calling `ask src <spec>`
 * for the same library hits the EXACT same directory — zero
 * duplication.
 *
 * The eager (`install.ts` → `GithubSource.fetch`) and lazy
 * (`ensureCheckout` → `GithubSource.fetch`) paths must compute the
 * checkout path through the same `githubCheckoutPath(askHome, owner,
 * repo, ref)` helper. This test pins that contract by:
 *
 *   1. Computing the expected store path with `githubCheckoutPath`
 *      directly (the same way install.ts does it).
 *   2. Pre-populating that path with a fake checkout (simulating a
 *      prior `ask install` run).
 *   3. Calling `ensureCheckout` with the same owner/repo/ref via a
 *      mock resolver.
 *   4. Asserting the returned `checkoutDir` is byte-identical to the
 *      pre-computed path AND that no fetch was triggered (cache hit).
 *
 * If anyone refactors the path layout in either path, this test will
 * fail and force the change to be applied to both sides simultaneously.
 */

let askHome: string
let projectDir: string

beforeEach(() => {
  askHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-cache-sharing-home-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-cache-sharing-proj-'))
})

afterEach(() => {
  fs.rmSync(askHome, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

describe('cache sharing — install vs src/docs (SC-6)', () => {
  it('ensureCheckout returns the same path that githubCheckoutPath computes', async () => {
    // Pre-compute the path the eager pipeline would write to.
    const expectedPath = githubCheckoutPath(askHome, 'facebook', 'react', 'v18.2.0')

    // Simulate the directory left behind by a prior `ask install` run.
    fs.mkdirSync(expectedPath, { recursive: true })
    fs.writeFileSync(path.join(expectedPath, 'package.json'), '{"name":"react"}')

    const fetcher = {
      fetch: mock(async (_opts: SourceConfig) => {
        throw new Error('cache hit must short-circuit before fetcher.fetch')
      }),
    }
    const resolver = {
      resolve: mock(async (_name: string, _version: string) => ({
        repo: 'facebook/react',
        ref: 'v18.2.0',
        resolvedVersion: '18.2.0',
        fallbackRefs: [],
      })),
    }

    const result = await ensureCheckout(
      { spec: 'react@18.2.0', projectDir },
      {
        askHome,
        fetcher,
        resolverFor: () => resolver,
        lockfileReader: { read: () => null },
      },
    )

    // Byte-for-byte path equality.
    expect(result.checkoutDir).toBe(expectedPath)
    // Cache hit ⇒ fetcher MUST NOT have been called.
    expect(fetcher.fetch).toHaveBeenCalledTimes(0)
  })

  it('ensureCheckout writes through the same key on cache miss', async () => {
    // No pre-populated dir — this is a cache miss. We assert the path
    // the helper hands the fetcher matches the path the eager pipeline
    // would use. The fake fetcher creates the dir to simulate a
    // successful fetch and we verify the post-condition.
    const expectedPath = githubCheckoutPath(askHome, 'facebook', 'react', 'v18.2.0')

    let fetchedRepo: string | undefined
    let fetchedTag: string | undefined
    const fetcher = {
      fetch: mock(async (opts: SourceConfig) => {
        const ghOpts = opts as GithubSourceOptions
        fetchedRepo = ghOpts.repo
        fetchedTag = ghOpts.tag
        // Simulate a successful fetch by writing to the expected path.
        fs.mkdirSync(expectedPath, { recursive: true })
      }),
    }
    const resolver = {
      resolve: mock(async () => ({
        repo: 'facebook/react',
        ref: 'v18.2.0',
        resolvedVersion: '18.2.0',
        fallbackRefs: [],
      })),
    }

    const result = await ensureCheckout(
      { spec: 'react@18.2.0', projectDir },
      {
        askHome,
        fetcher,
        resolverFor: () => resolver,
        lockfileReader: { read: () => null },
      },
    )

    expect(fetcher.fetch).toHaveBeenCalledTimes(1)
    expect(fetchedRepo).toBe('facebook/react')
    expect(fetchedTag).toBe('v18.2.0')
    expect(result.checkoutDir).toBe(expectedPath)
  })

  it('lazy and eager paths agree on the namespacing scheme (owner__repo / ref)', () => {
    // This is a structural test: it asserts the directory layout is
    // <askHome>/github/checkouts/<owner>__<repo>/<ref>/ — the layout
    // both pipelines depend on. If anyone changes the separator or
    // adds an intermediate segment, this test forces the rename to
    // happen everywhere at once.
    const p = githubCheckoutPath(askHome, 'facebook', 'react', 'v18.2.0')
    const expected = path.join(askHome, 'github', 'checkouts', 'facebook__react', 'v18.2.0')
    expect(p).toBe(expected)
  })
})
