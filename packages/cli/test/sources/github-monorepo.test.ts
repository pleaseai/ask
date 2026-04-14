/**
 * Integration tests: NpmResolver → GithubSource pipeline for monorepo packages.
 *
 * These tests wire the npm resolver and github source together end-to-end,
 * verifying that monorepo tag patterns (e.g. `ai@1.0.0`) are discovered and
 * cloned correctly through the full pipeline.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { NpmResolver } from '../../src/resolvers/npm.js'
import { GithubSource } from '../../src/sources/github.js'

let tmpDir: string
let originalAskHome: string | undefined
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-monorepo-integ-'))
  originalAskHome = process.env.ASK_HOME
  process.env.ASK_HOME = path.join(tmpDir, 'ask-home')
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalAskHome === undefined) {
    delete process.env.ASK_HOME
  }
  else {
    process.env.ASK_HOME = originalAskHome
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Create a bare git remote with only a monorepo-style tag (e.g. `ai@1.0.0`).
 * No `v1.0.0` tag exists — standard v-prefixed resolution will fail.
 */
function createMonorepoRemote(tagName: string): string {
  const repoDir = path.join(tmpDir, 'monorepo-remote.git')
  const workDir = path.join(tmpDir, 'monorepo-work')

  fs.mkdirSync(workDir, { recursive: true })
  execFileSync('git', ['init', '-b', 'main', workDir], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })

  fs.writeFileSync(path.join(workDir, 'README.md'), '# AI SDK Monorepo\n')
  fs.mkdirSync(path.join(workDir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(workDir, 'docs', 'intro.md'), '# AI Docs\n')

  execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'commit', '-m', 'initial'], { stdio: 'ignore' })
  // Only monorepo-style tag — no `v1.0.0`
  execFileSync('git', ['-C', workDir, 'tag', tagName], { stdio: 'ignore' })

  execFileSync('git', ['clone', '--bare', workDir, repoDir], { stdio: 'ignore' })
  return repoDir
}

/**
 * Create a bare git remote with a standard v-prefixed tag only.
 * Simulates a non-monorepo package.
 */
function createStandardRemote(version: string): string {
  const repoDir = path.join(tmpDir, 'standard-remote.git')
  const workDir = path.join(tmpDir, 'standard-work')

  fs.mkdirSync(workDir, { recursive: true })
  execFileSync('git', ['init', '-b', 'main', workDir], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })

  fs.writeFileSync(path.join(workDir, 'README.md'), '# Standard Package\n')
  fs.mkdirSync(path.join(workDir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(workDir, 'docs', 'api.md'), '# API Docs\n')

  execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'commit', '-m', 'initial'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'tag', `v${version}`], { stdio: 'ignore' })

  execFileSync('git', ['clone', '--bare', workDir, repoDir], { stdio: 'ignore' })
  return repoDir
}

/**
 * Mock globalThis.fetch to intercept npm registry calls.
 * Non-registry URLs fall through to the original fetch.
 */
function mockNpmFetch(meta: unknown): void {
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    if (urlStr.includes('registry.npmjs.org')) {
      return new Response(JSON.stringify(meta), { status: 200 })
    }
    return originalFetch(url, init)
  }
}

describe('integration: full pipeline — NpmResolver + GithubSource', () => {
  it('monorepo package: resolver detects directory → fallbackRefs → GithubSource clones ai@1.0.0', async () => {
    const remoteUrl = createMonorepoRemote('ai@1.0.0')

    // Mock npm registry — package lives in packages/ai inside the monorepo
    mockNpmFetch({
      'repository': {
        type: 'git',
        url: 'git+https://github.com/test/monorepo.git',
        directory: 'packages/ai',
      },
      'dist-tags': { latest: '1.0.0' },
      'versions': { '1.0.0': {} },
    })

    const resolver = new NpmResolver()
    const resolveResult = await resolver.resolve('ai', '1.0.0')

    // Resolver should detect monorepo and generate pkg-name fallbackRefs
    expect(resolveResult.fallbackRefs).toContain('ai@1.0.0')
    expect(resolveResult.resolvedVersion).toBe('1.0.0')

    // GithubSource should use fallbackRefs to find the monorepo tag
    const source = new GithubSource()
    const fetchResult = await source.fetch({
      source: 'github',
      name: 'ai',
      version: resolveResult.resolvedVersion,
      repo: resolveResult.repo,
      tag: resolveResult.ref,
      docsPath: 'docs',
      fallbackRefs: resolveResult.fallbackRefs,
      remoteUrl,
    } as any)

    // Should have cloned successfully using the monorepo tag
    expect(fetchResult.storePath).toContain('ai@1.0.0')
    expect(fetchResult.resolvedVersion).toBe('1.0.0')
    expect(fs.existsSync(path.join(fetchResult.storePath!, 'docs', 'intro.md'))).toBe(true)
  })

  it('no regression: standard v-prefixed package resolves without fallbackRefs', async () => {
    const remoteUrl = createStandardRemote('2.0.0')

    // Mock npm registry — no repository.directory (not a monorepo)
    mockNpmFetch({
      'repository': {
        type: 'git',
        url: 'git+https://github.com/test/standard.git',
      },
      'dist-tags': { latest: '2.0.0' },
      'versions': { '2.0.0': {} },
    })

    const resolver = new NpmResolver()
    const resolveResult = await resolver.resolve('standard', '2.0.0')

    // No monorepo fallbackRefs — only the bare version
    expect(resolveResult.fallbackRefs).toEqual(['2.0.0'])
    expect(resolveResult.ref).toBe('v2.0.0')

    // GithubSource should still clone using the standard v-prefixed tag
    const source = new GithubSource()
    const fetchResult = await source.fetch({
      source: 'github',
      name: 'standard',
      version: resolveResult.resolvedVersion,
      repo: resolveResult.repo,
      tag: resolveResult.ref,
      docsPath: 'docs',
      fallbackRefs: resolveResult.fallbackRefs,
      remoteUrl,
    } as any)

    expect(fetchResult.storePath).toContain('v2.0.0')
    expect(fetchResult.resolvedVersion).toBe('2.0.0')
    expect(fs.existsSync(path.join(fetchResult.storePath!, 'docs', 'api.md'))).toBe(true)
  })

  it('scoped package @vercel/ai: resolver uses unscoped name "ai" in fallbackRefs', async () => {
    // Mock npm registry for @vercel/ai with repository.directory
    mockNpmFetch({
      'repository': {
        type: 'git',
        url: 'git+https://github.com/vercel/ai.git',
        directory: 'packages/ai',
      },
      'dist-tags': { latest: '6.0.158' },
      'versions': { '6.0.158': {} },
    })

    const resolver = new NpmResolver()
    const resolveResult = await resolver.resolve('@vercel/ai', '6.0.158')

    // Unscoped name must be used — NOT @vercel/ai@6.0.158
    expect(resolveResult.fallbackRefs).toContain('ai@6.0.158')
    expect(resolveResult.fallbackRefs).toContain('ai@v6.0.158')
    // Scoped form must NOT appear
    expect(resolveResult.fallbackRefs!.every(r => !r.startsWith('@'))).toBe(true)

    // Verify the unscoped tag pattern works with GithubSource
    const remoteUrl = createMonorepoRemote('ai@6.0.158')
    const source = new GithubSource()
    const fetchResult = await source.fetch({
      source: 'github',
      name: 'ai',
      version: resolveResult.resolvedVersion,
      repo: resolveResult.repo,
      tag: resolveResult.ref,
      docsPath: 'docs',
      fallbackRefs: resolveResult.fallbackRefs,
      remoteUrl,
    } as any)

    expect(fetchResult.storePath).toContain('ai@6.0.158')
    expect(fetchResult.resolvedVersion).toBe('6.0.158')
  })
})
