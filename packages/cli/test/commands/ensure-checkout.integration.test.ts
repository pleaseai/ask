import type { GithubSourceOptions, SourceConfig } from '../../src/sources/index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ensureCheckout } from '../../src/commands/ensure-checkout.js'
import { runDocs } from '../../src/commands/docs.js'
import { githubStorePath } from '../../src/store/index.js'

/**
 * Integration tests pinning the contract between `ensureCheckout` and the
 * real `GithubSource.fetch` output layout.
 *
 * `GithubSource.fetch` writes to the PM-unified layout:
 *   <askHome>/github/<host>/<owner>/<repo>/<tag>/
 *
 * `ensureCheckout`'s returned `checkoutDir` MUST match that exact layout —
 * otherwise downstream callers like `ask docs` and `ask src` walk a path
 * that does not exist and silently emit nothing (observed as "no output"
 * exit 0 against real GitHub repos).
 */

let askHome: string
let projectDir: string

beforeEach(() => {
  askHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-ec-int-home-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-ec-int-proj-'))
})

afterEach(() => {
  fs.rmSync(askHome, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

describe('ensureCheckout ↔ GithubSource.fetch layout contract', () => {
  it('returns the PM-unified store path that GithubSource.fetch writes to', async () => {
    // Simulate GithubSource.fetch by writing to the real PM-unified layout.
    const fetcher = {
      fetch: async (opts: SourceConfig) => {
        const gh = opts as GithubSourceOptions
        const [owner, repo] = gh.repo.split('/')
        const ref = gh.tag ?? gh.branch!
        const storeDir = githubStorePath(askHome, 'github.com', owner, repo, ref)
        fs.mkdirSync(storeDir, { recursive: true })
        fs.writeFileSync(path.join(storeDir, 'README.md'), '# test')
        return { files: [], resolvedVersion: ref, storePath: storeDir }
      },
    }

    const result = await ensureCheckout(
      { spec: 'github:agentskills/agentskills', projectDir },
      {
        askHome,
        fetcher,
        resolverFor: () => null,
        lockfileReader: { read: () => null },
      },
    )

    const expectedDir = githubStorePath(askHome, 'github.com', 'agentskills', 'agentskills', 'main')
    expect(result.checkoutDir).toBe(expectedDir)
    expect(fs.existsSync(result.checkoutDir)).toBe(true)
  })

  it('returns the winning candidate path when fetch falls back from ref to a fallbackRef', async () => {
    // Guards against a second silent-failure vector: when the resolver
    // provides `fallbackRefs` (monorepo tags) or `cloneAtTag` rescues a
    // non-`v` ref via `v<ref>`, `GithubSource.fetch` writes to the
    // *winning* candidate's path — which may differ from the primary
    // `ref`. `ensureCheckout` MUST surface that path (via
    // `FetchResult.storePath`), otherwise `ask docs` / `ask src` walk a
    // directory that does not exist and print nothing.
    const winningRef = 'ai@6.0.158' // the fallback
    const fetcher = {
      fetch: async (opts: SourceConfig) => {
        const gh = opts as GithubSourceOptions
        const [owner, repo] = gh.repo.split('/')
        const storeDir = githubStorePath(askHome, 'github.com', owner, repo, winningRef)
        fs.mkdirSync(storeDir, { recursive: true })
        fs.writeFileSync(path.join(storeDir, 'README.md'), '# test')
        // The primary tag is NOT created — only the fallback wins.
        return { files: [], resolvedVersion: winningRef, storePath: storeDir }
      },
    }
    const resolver = {
      resolve: async () => ({
        repo: 'vercel/ai',
        ref: 'ai@6.0.159',
        resolvedVersion: '6.0.159',
        fallbackRefs: ['ai@6.0.158'],
      }),
    }

    const result = await ensureCheckout(
      { spec: 'npm:@vercel/ai@6.0.159', projectDir },
      {
        askHome,
        fetcher,
        resolverFor: () => resolver,
        lockfileReader: { read: () => null },
      },
    )

    const expectedDir = githubStorePath(askHome, 'github.com', 'vercel', 'ai', winningRef)
    expect(result.checkoutDir).toBe(expectedDir)
    expect(fs.existsSync(result.checkoutDir)).toBe(true)
  })

  it('runDocs emits the PM-unified checkout path so output is not empty after fetch', async () => {
    // End-to-end guard for the bug where `ask docs github:foo/bar` exited 0
    // with no output: ensureCheckout returned a legacy path that did not
    // exist, so findDocLikePaths returned [] and nothing was printed.
    const fetcher = {
      fetch: async (opts: SourceConfig) => {
        const gh = opts as GithubSourceOptions
        const [owner, repo] = gh.repo.split('/')
        const ref = gh.tag ?? gh.branch!
        const storeDir = githubStorePath(askHome, 'github.com', owner, repo, ref)
        fs.mkdirSync(path.join(storeDir, 'docs'), { recursive: true })
        return { files: [], resolvedVersion: ref, storePath: storeDir }
      },
    }

    const stdout: string[] = []
    const stderr: string[] = []
    let exitCode: number | null = null

    await runDocs(
      { spec: 'github:agentskills/agentskills', projectDir },
      {
        ensureCheckout: opts =>
          ensureCheckout(opts, {
            askHome,
            fetcher,
            resolverFor: () => null,
            lockfileReader: { read: () => null },
          }),
        log: (m: string) => stdout.push(m),
        error: (m: string) => stderr.push(m),
        exit: (c: number) => {
          exitCode = c
        },
      },
    )

    const storeDir = githubStorePath(askHome, 'github.com', 'agentskills', 'agentskills', 'main')
    expect(stdout).toContain(storeDir)
    expect(stdout).toContain(path.join(storeDir, 'docs'))
    expect(stderr).toEqual([])
    expect(exitCode).toBeNull()
  })
})
