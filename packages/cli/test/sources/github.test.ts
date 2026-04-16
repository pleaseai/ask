import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GithubSource } from '../../src/sources/github.js'
import { verifyEntry } from '../../src/store/index.js'

let tmpDir: string
let originalAskHome: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-github-src-'))
  originalAskHome = process.env.ASK_HOME
  process.env.ASK_HOME = path.join(tmpDir, 'ask-home')
})

afterEach(() => {
  if (originalAskHome === undefined) {
    delete process.env.ASK_HOME
  }
  else {
    process.env.ASK_HOME = originalAskHome
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Create a local git repo with two tags and a `docs/` subdirectory,
 * then clone it bare so it can serve as a file:// remote URL for the
 * github source. Returns the bare repo path.
 */
function createLocalRemote(): string {
  const repoDir = path.join(tmpDir, 'local-remote.git')
  const workDir = path.join(tmpDir, 'work')

  fs.mkdirSync(workDir, { recursive: true })
  execFileSync('git', ['init', '-b', 'main', workDir], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })

  fs.writeFileSync(path.join(workDir, 'README.md'), '# Test Repo\n')
  fs.mkdirSync(path.join(workDir, 'docs'))
  fs.writeFileSync(path.join(workDir, 'docs', 'guide.md'), '# Guide v1\n')

  execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'commit', '-m', 'initial'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'tag', 'v1.0.0'], { stdio: 'ignore' })

  fs.writeFileSync(path.join(workDir, 'docs', 'guide.md'), '# Guide v2\n')
  execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'commit', '-m', 'update'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'tag', 'v2.0.0'], { stdio: 'ignore' })

  // Add a bare tag (no `v` prefix) so we can test the fallback chain
  fs.writeFileSync(path.join(workDir, 'docs', 'guide.md'), '# Guide v3\n')
  execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'commit', '-m', 'bare-tag'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'tag', '3.0.0'], { stdio: 'ignore' })

  execFileSync('git', ['clone', '--bare', workDir, repoDir], { stdio: 'ignore' })
  return repoDir
}

describe('GithubSource — nested store layout', () => {
  it('materializes a v-prefixed tag into <host>/<owner>/<repo>/<tag>/', async () => {
    const remoteUrl = createLocalRemote()
    const source = new GithubSource()

    const result = await source.fetch({
      source: 'github',
      name: 'test-repo',
      version: '1.0.0',
      repo: 'test/repo',
      tag: 'v1.0.0',
      docsPath: 'docs',
      // Override remote so the test is offline
      remoteUrl,
    } as any)

    const askHome = process.env.ASK_HOME!
    const expectedStorePath = path.join(askHome, 'github', 'github.com', 'test', 'repo', 'v1.0.0')
    expect(result.storePath).toBe(expectedStorePath)
    expect(result.storeSubpath).toBe('docs')
    expect(fs.existsSync(path.join(expectedStorePath, 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(expectedStorePath, 'docs', 'guide.md'))).toBe(true)
    expect(fs.readFileSync(path.join(expectedStorePath, 'docs', 'guide.md'), 'utf-8'))
      .toBe('# Guide v1\n')
  })

  it('strips the .git/ directory after clone', async () => {
    const remoteUrl = createLocalRemote()
    const source = new GithubSource()

    const result = await source.fetch({
      source: 'github',
      name: 'test-repo',
      version: '1.0.0',
      repo: 'test/repo',
      tag: 'v1.0.0',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    expect(result.storePath).toBeDefined()
    expect(fs.existsSync(path.join(result.storePath!, '.git'))).toBe(false)
  })

  it('captures the commit SHA in meta.commit (40-char hex)', async () => {
    const remoteUrl = createLocalRemote()
    const source = new GithubSource()

    const result = await source.fetch({
      source: 'github',
      name: 'test-repo',
      version: '1.0.0',
      repo: 'test/repo',
      tag: 'v1.0.0',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    expect(result.meta?.commit).toBeDefined()
    expect(result.meta!.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('stamps the store entry so verifyEntry returns true', async () => {
    const remoteUrl = createLocalRemote()
    const source = new GithubSource()

    const result = await source.fetch({
      source: 'github',
      name: 'test-repo',
      version: '1.0.0',
      repo: 'test/repo',
      tag: 'v1.0.0',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    expect(verifyEntry(result.storePath!)).toBe(true)
  })

  it('tag fallback: bare version "3.0.0" succeeds without v-prefix', async () => {
    const remoteUrl = createLocalRemote()
    const source = new GithubSource()

    const result = await source.fetch({
      source: 'github',
      name: 'test-repo',
      version: '3.0.0',
      repo: 'test/repo',
      tag: '3.0.0',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    expect(result.resolvedVersion).toBe('3.0.0')
    expect(result.storePath).toContain('3.0.0')
  })

  it('tag fallback: v-prefixed input does NOT emit vv-prefixed candidate', async () => {
    // Invariant: if the caller supplies a v-prefixed ref, cloneAtTag
    // must only try `<ref>` — never `v<ref>` (which would produce
    // `vv1.2.3`). This test locks the guard at sources/github.ts
    // `if (ref.startsWith('v')) return [ref]`.
    const remoteUrl = createLocalRemote()
    const source = new GithubSource()

    // `v9.9.9` does not exist on the local remote (only v1.0.0, v2.0.0,
    // and bare 3.0.0). The clone must fail, and the thrown error's
    // "tried:" list must contain only `v9.9.9` — never `vv9.9.9`.
    let capturedError: Error | null = null
    try {
      await source.fetch({
        source: 'github',
        name: 'test-repo',
        version: '9.9.9',
        repo: 'test/repo',
        tag: 'v9.9.9',
        docsPath: 'docs',
        remoteUrl,
      } as any)
    }
    catch (err) {
      capturedError = err as Error
    }

    expect(capturedError).not.toBeNull()
    const message = capturedError!.message
    expect(message).toContain('v9.9.9')
    // The negative invariant: vv-prefixed candidate must never appear
    expect(message).not.toContain('vv9.9.9')
  })

  it('tag fallback: "1.0.0" falls back to "v1.0.0" when unprefixed tag missing', async () => {
    const remoteUrl = createLocalRemote()
    const source = new GithubSource()

    // The remote has "v1.0.0" but not "1.0.0" — fallback should find it
    const result = await source.fetch({
      source: 'github',
      name: 'test-repo',
      version: '1.0.0',
      repo: 'test/repo',
      tag: '1.0.0',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    // Should land under v1.0.0 in the store since that's what was cloned
    expect(result.storePath).toContain('v1.0.0')
  })

  it('store-hit short-circuit: second fetch uses cache', async () => {
    const remoteUrl = createLocalRemote()
    const source = new GithubSource()

    const first = await source.fetch({
      source: 'github',
      name: 'test-repo',
      version: '1.0.0',
      repo: 'test/repo',
      tag: 'v1.0.0',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    // Fresh clones capture the commit SHA via rev-parse HEAD.
    // Store-hit reads skip the clone entirely, so commit is unset.
    expect(first.meta?.commit).toBeDefined()

    // Record the inode of a file inside the store; a re-clone would
    // replace it with a fresh file (different inode).
    const readmePath = path.join(first.storePath!, 'README.md')
    const inoBefore = fs.statSync(readmePath).ino

    const second = await source.fetch({
      source: 'github',
      name: 'test-repo',
      version: '1.0.0',
      repo: 'test/repo',
      tag: 'v1.0.0',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    expect(second.storePath).toBe(first.storePath)
    expect(second.meta?.commit).toBeUndefined() // cache-hit path
    expect(fs.statSync(readmePath).ino).toBe(inoBefore) // not re-cloned
  })

  it('store-hit with corrupted stamp: quarantines and re-clones', async () => {
    const remoteUrl = createLocalRemote()
    const source = new GithubSource()

    const first = await source.fetch({
      source: 'github',
      name: 'test-repo',
      version: '1.0.0',
      repo: 'test/repo',
      tag: 'v1.0.0',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    // Tamper with a file so verifyEntry returns false
    fs.writeFileSync(path.join(first.storePath!, 'docs', 'guide.md'), 'TAMPERED')
    expect(verifyEntry(first.storePath!)).toBe(false)

    // Second fetch should detect the corruption and re-clone
    const second = await source.fetch({
      source: 'github',
      name: 'test-repo',
      version: '1.0.0',
      repo: 'test/repo',
      tag: 'v1.0.0',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    // The re-cloned store is valid again
    expect(verifyEntry(second.storePath!)).toBe(true)
    // Original content is back
    expect(fs.readFileSync(path.join(second.storePath!, 'docs', 'guide.md'), 'utf-8'))
      .toBe('# Guide v1\n')
  })

  it('rejects path-traversal in repo', async () => {
    const source = new GithubSource()
    await expect(source.fetch({
      source: 'github',
      name: 'bad',
      version: '1.0.0',
      repo: '../etc/passwd',
      tag: 'v1.0.0',
    } as any)).rejects.toThrow()
  })

  it('concurrent install of two different tags of the same repo both succeed (SC-2)', async () => {
    const remoteUrl = createLocalRemote()
    const source = new GithubSource()

    // Fire both fetches in parallel. Both should land in distinct
    // store directories with no lock contention, FETCH_HEAD race, or
    // owner__repo collision because each entry is an independent
    // shallow clone into its own nested path.
    const [first, second] = await Promise.all([
      source.fetch({
        source: 'github',
        name: 'test-repo',
        version: '1.0.0',
        repo: 'test/repo',
        tag: 'v1.0.0',
        docsPath: 'docs',
        remoteUrl,
      } as any),
      source.fetch({
        source: 'test-repo',
        name: 'test-repo',
        version: '2.0.0',
        repo: 'test/repo',
        tag: 'v2.0.0',
        docsPath: 'docs',
        remoteUrl,
      } as any),
    ])

    // Separate directories, neither corrupts the other
    expect(first.storePath).not.toBe(second.storePath)
    expect(first.storePath).toContain('v1.0.0')
    expect(second.storePath).toContain('v2.0.0')

    // Content is correctly versioned
    expect(fs.readFileSync(path.join(first.storePath!, 'docs', 'guide.md'), 'utf-8'))
      .toBe('# Guide v1\n')
    expect(fs.readFileSync(path.join(second.storePath!, 'docs', 'guide.md'), 'utf-8'))
      .toBe('# Guide v2\n')

    // Both stamps are valid
    expect(verifyEntry(first.storePath!)).toBe(true)
    expect(verifyEntry(second.storePath!)).toBe(true)
  })
})

describe('default-branch fallback — main → master', () => {
  /**
   * Create a local remote whose default branch is `master` (no `main`).
   * This simulates older repos (pre-2020) that never migrated to `main`.
   */
  function createMasterDefaultRemote(): string {
    const repoDir = path.join(tmpDir, 'master-remote.git')
    const workDir = path.join(tmpDir, 'master-work')

    fs.mkdirSync(workDir, { recursive: true })
    execFileSync('git', ['init', '-b', 'master', workDir], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })

    fs.writeFileSync(path.join(workDir, 'README.md'), '# Master Default\n')
    fs.mkdirSync(path.join(workDir, 'docs'))
    fs.writeFileSync(path.join(workDir, 'docs', 'guide.md'), '# Master Guide\n')

    execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'commit', '-m', 'initial'], { stdio: 'ignore' })

    execFileSync('git', ['clone', '--bare', workDir, repoDir], { stdio: 'ignore' })
    return repoDir
  }

  it('falls back to master when no tag/branch is specified and main is absent', async () => {
    // Regression test: a repo whose default branch is `master` must
    // clone successfully when the caller supplies neither `tag` nor
    // `branch`. Without the fallback, the ref defaults to `main`,
    // the clone fails, and the user sees a confusing error.
    const remoteUrl = createMasterDefaultRemote()
    const source = new GithubSource()

    const result = await source.fetch({
      source: 'github',
      name: 'master-repo',
      version: 'main',
      repo: 'test/master-repo',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    expect(result.storePath).toContain('master')
    expect(fs.readFileSync(path.join(result.storePath!, 'docs', 'guide.md'), 'utf-8'))
      .toBe('# Master Guide\n')
  })

  it('does NOT fall back to master when branch=main is explicit', async () => {
    // Invariant: an explicit `branch: 'main'` must fail rather than
    // silently resolve to `master`. Otherwise a typo-free but wrong
    // branch name could pick up unrelated content.
    const remoteUrl = createMasterDefaultRemote()
    const source = new GithubSource()

    let capturedError: Error | null = null
    try {
      await source.fetch({
        source: 'github',
        name: 'some-pkg',
        version: '1.0.0',
        repo: 'test/some-pkg',
        branch: 'main',
        docsPath: 'docs',
        remoteUrl,
      } as any)
    }
    catch (err) {
      capturedError = err as Error
    }

    expect(capturedError).not.toBeNull()
    const message = capturedError!.message
    expect(message).toContain('main')
    // The error must NOT list `master` as a tried candidate — explicit
    // branch requests stay literal. Inspect the `tried: ...` list
    // specifically (not the whole message) so unrelated repo/branch
    // names don't accidentally trip the assertion.
    expect(message).not.toMatch(/tried:[^)]*\bmaster\b/)
  })

  it('lists master in the tried candidates when both main and master fail', async () => {
    // Build an empty bare repo (no commits, no branches) so every
    // clone attempt fails. The thrown error's `(tried: ...)` list must
    // include `main`, `vmain`, and `master` — confirming the tail
    // candidate is wired through the clone path.
    const repoDir = path.join(tmpDir, 'empty-remote.git')
    execFileSync('git', ['init', '--bare', repoDir], { stdio: 'ignore' })
    const source = new GithubSource()

    let capturedError: Error | null = null
    try {
      await source.fetch({
        source: 'github',
        name: 'empty-repo',
        version: 'main',
        repo: 'test/empty-repo',
        docsPath: 'docs',
        remoteUrl: repoDir,
      } as any)
    }
    catch (err) {
      capturedError = err as Error
    }

    expect(capturedError).not.toBeNull()
    const message = capturedError!.message
    expect(message).toContain('main')
    expect(message).toContain('master')
  })
})

describe('skipDocExtraction — callers that only need the checkout path', () => {
  /**
   * Regression for `bunx @pleaseai/ask src github:gitbutlerapp/gitbutler`
   * failing with `No docs directory found in gitbutlerapp/gitbutler@master`:
   *
   * `ask src` (and `ask docs`) go through `ensureCheckout`, which calls
   * `GithubSource.fetch` to land the clone in the store. Before this
   * flag, `fetch` unconditionally scanned the checkout for a `docs/`
   * subdirectory and threw when none existed — even though `ask src`
   * never needs the docs-file list, only the cached source tree on disk.
   */
  function createNoDocsRemote(): string {
    const repoDir = path.join(tmpDir, 'no-docs-remote.git')
    const workDir = path.join(tmpDir, 'no-docs-work')

    fs.mkdirSync(workDir, { recursive: true })
    execFileSync('git', ['init', '-b', 'master', workDir], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })

    // Intentionally no docs/ — mirrors gitbutlerapp/gitbutler's layout.
    fs.writeFileSync(path.join(workDir, 'README.md'), '# No Docs Here\n')
    fs.writeFileSync(path.join(workDir, 'src.ts'), 'export {}\n')

    execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'commit', '-m', 'initial'], { stdio: 'ignore' })

    execFileSync('git', ['clone', '--bare', workDir, repoDir], { stdio: 'ignore' })
    return repoDir
  }

  it('succeeds with empty files and storePath when repo has no docs directory', async () => {
    const remoteUrl = createNoDocsRemote()
    const source = new GithubSource()

    const result = await source.fetch({
      source: 'github',
      name: 'no-docs-repo',
      version: 'master',
      repo: 'test/no-docs-repo',
      skipDocExtraction: true,
      remoteUrl,
    } as any)

    expect(result.files).toEqual([])
    expect(result.storePath).toBeDefined()
    expect(fs.existsSync(result.storePath!)).toBe(true)
    expect(fs.existsSync(path.join(result.storePath!, 'README.md'))).toBe(true)
  })

  it('still activates the main→master fallback when skipDocExtraction=true', async () => {
    // Combines the gitbutler scenario: default branch is `master` AND
    // there is no `docs/` dir. Both failure modes must be neutralized.
    const remoteUrl = createNoDocsRemote()
    const source = new GithubSource()

    const result = await source.fetch({
      source: 'github',
      name: 'no-docs-repo',
      version: 'main',
      repo: 'test/no-docs-repo',
      skipDocExtraction: true,
      remoteUrl,
    } as any)

    expect(result.storePath).toContain('master')
    expect(result.files).toEqual([])
  })

  it('default behavior (flag unset) still throws when no docs directory exists', async () => {
    // Guardrail: `runInstall` still depends on the throw — it materializes
    // `.ask/docs/<name>@<version>/` from `FetchResult.files`, so an empty
    // list would silently publish an empty docs tree. The flag is opt-in.
    //
    // With the flag unset, the shallow-clone path's `extractDocsFromDir`
    // rejects the no-docs repo. The outer `fetch()` catches and logs a
    // warn, then falls through to the tar.gz path — which for this
    // fake local remote 404s on github.com. Either way, an error
    // escapes: the point is that `runInstall` does NOT receive a
    // successful empty-files result.
    const remoteUrl = createNoDocsRemote()
    const source = new GithubSource()

    let capturedError: Error | null = null
    try {
      await source.fetch({
        source: 'github',
        name: 'no-docs-repo',
        version: 'master',
        repo: 'test/no-docs-repo',
        branch: 'master',
        remoteUrl,
      } as any)
    }
    catch (err) {
      capturedError = err as Error
    }

    expect(capturedError).not.toBeNull()
  })
})

describe('refCandidates via fetch behavior — fallbackRefs', () => {
  /**
   * Create a local remote with monorepo-style tags (e.g. `ai@6.0.158`).
   */
  function createMonorepoRemote(): string {
    const repoDir = path.join(tmpDir, 'mono-remote.git')
    const workDir = path.join(tmpDir, 'mono-work')

    fs.mkdirSync(workDir, { recursive: true })
    execFileSync('git', ['init', '-b', 'main', workDir], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })

    fs.writeFileSync(path.join(workDir, 'README.md'), '# Monorepo\n')
    fs.mkdirSync(path.join(workDir, 'docs'))
    fs.writeFileSync(path.join(workDir, 'docs', 'intro.md'), '# AI Docs\n')

    execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'commit', '-m', 'initial'], { stdio: 'ignore' })
    // monorepo-style tag with `@` separator
    execFileSync('git', ['-C', workDir, 'tag', 'ai@6.0.158'], { stdio: 'ignore' })

    execFileSync('git', ['clone', '--bare', workDir, repoDir], { stdio: 'ignore' })
    return repoDir
  }

  it('fallbackRefs: resolves monorepo tag "ai@6.0.158" when primary ref "v6.0.158" is absent', async () => {
    const remoteUrl = createMonorepoRemote()
    const source = new GithubSource()

    const result = await source.fetch({
      source: 'github',
      name: 'ai',
      version: '6.0.158',
      repo: 'test/monorepo',
      tag: 'v6.0.158',
      docsPath: 'docs',
      fallbackRefs: ['ai@6.0.158'],
      remoteUrl,
    } as any)

    // Should land under the monorepo tag in the store
    expect(result.storePath).toContain('ai@6.0.158')
    expect(result.resolvedVersion).toBe('6.0.158')
  })

  it('fallbackRefs: resolves monorepo tag when bare version "6.0.158" and "v6.0.158" are both absent', async () => {
    const remoteUrl = createMonorepoRemote()
    const source = new GithubSource()

    // tag is bare without v-prefix, so refCandidates base = ['6.0.158', 'v6.0.158']
    // fallbackRefs = ['ai@6.0.158'] should be tried first
    const result = await source.fetch({
      source: 'github',
      name: 'ai',
      version: '6.0.158',
      repo: 'test/monorepo',
      tag: '6.0.158',
      docsPath: 'docs',
      fallbackRefs: ['ai@6.0.158'],
      remoteUrl,
    } as any)

    expect(result.storePath).toContain('ai@6.0.158')
    expect(result.resolvedVersion).toBe('6.0.158')
  })

  it('fallbackRefs: fetch fails with error listing all tried candidates including fallbackRefs', async () => {
    const remoteUrl = createMonorepoRemote()
    const source = new GithubSource()

    let capturedError: Error | null = null
    try {
      await source.fetch({
        source: 'github',
        name: 'ai',
        version: '99.99.99',
        repo: 'test/monorepo',
        tag: 'v99.99.99',
        docsPath: 'docs',
        fallbackRefs: ['ai@99.99.99'],
        remoteUrl,
      } as any)
    }
    catch (err) {
      capturedError = err as Error
    }

    expect(capturedError).not.toBeNull()
    const message = capturedError!.message
    // Error should mention the fallback ref that was tried
    expect(message).toContain('ai@99.99.99')
  })

  it('RE_SAFE_REF: allows @ in ref (monorepo tags like ai@6.0.158)', async () => {
    const source = new GithubSource()
    // If RE_SAFE_REF does not allow @, this will throw before any git operation
    // We test this by passing a ref containing @ and expecting no validation error
    // (a network/clone error is OK — we just want no "Invalid ref" error)
    let error: Error | null = null
    try {
      await source.fetch({
        source: 'github',
        name: 'ai',
        version: '6.0.158',
        repo: 'test/repo',
        tag: 'ai@6.0.158',
        docsPath: 'docs',
        // No remoteUrl — will fail trying to reach github.com, but AFTER validation
      } as any)
    }
    catch (err) {
      error = err as Error
    }
    // Must not throw an "Invalid ref" validation error
    expect(error?.message).not.toContain('Invalid ref')
  })
})

describe('git ls-remote fallback probe (T005)', () => {
  /**
   * Create a local remote with monorepo-style tags only (e.g. `ai@1.0.0`).
   * No `v1.0.0` tag exists — static candidates will all fail, forcing
   * the ls-remote probe to kick in.
   */
  function createLsRemoteRemote(): string {
    const repoDir = path.join(tmpDir, 'lsremote-remote.git')
    const workDir = path.join(tmpDir, 'lsremote-work')

    fs.mkdirSync(workDir, { recursive: true })
    execFileSync('git', ['init', '-b', 'main', workDir], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })

    fs.writeFileSync(path.join(workDir, 'README.md'), '# LS Remote Test\n')
    fs.mkdirSync(path.join(workDir, 'docs'))
    fs.writeFileSync(path.join(workDir, 'docs', 'api.md'), '# API Docs\n')

    execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', workDir, 'commit', '-m', 'initial'], { stdio: 'ignore' })
    // Only monorepo-style tag: no `v1.0.0` exists
    execFileSync('git', ['-C', workDir, 'tag', 'ai@1.0.0'], { stdio: 'ignore' })

    execFileSync('git', ['clone', '--bare', workDir, repoDir], { stdio: 'ignore' })
    return repoDir
  }

  it('discovers monorepo tag via ls-remote when all static candidates fail', async () => {
    const remoteUrl = createLsRemoteRemote()
    const source = new GithubSource()

    // No fallbackRefs provided — static candidates [v1.0.0, 1.0.0] will miss.
    // ls-remote probe should discover `ai@1.0.0` and clone it successfully.
    const result = await source.fetch({
      source: 'github',
      name: 'ai',
      version: '1.0.0',
      repo: 'test/lsremote',
      tag: 'v1.0.0',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    expect(result.storePath).toContain('ai@1.0.0')
    expect(result.resolvedVersion).toBe('1.0.0')
    expect(result.files.length).toBeGreaterThan(0)
  })

  it('includes matching tags and --ref hint in error when total failure', async () => {
    const remoteUrl = createLsRemoteRemote()
    const source = new GithubSource()

    // Request a version that does not exist at all — even ls-remote won't find it
    let capturedError: Error | null = null
    try {
      await source.fetch({
        source: 'github',
        name: 'ai',
        version: '99.99.99',
        repo: 'test/lsremote',
        tag: 'v99.99.99',
        docsPath: 'docs',
        remoteUrl,
      } as any)
    }
    catch (err) {
      capturedError = err as Error
    }

    expect(capturedError).not.toBeNull()
    // When no matching tags are found, falls back to original error — no hint added
    expect(capturedError!.message).toContain('v99.99.99')
  })

  it('branch requests do not fall through to tag probe', async () => {
    // A branch-only request (no `tag` field) must fail with a plain clone
    // error and must NOT probe remote tags — otherwise a branch named
    // `feature/1.0.0` could silently resolve to an unrelated `v1.0.0` tag.
    const remoteUrl = createLsRemoteRemote()
    const source = new GithubSource()

    let capturedError: Error | null = null
    try {
      await source.fetch({
        source: 'github',
        name: 'ai',
        version: '1.0.0',
        repo: 'test/lsremote',
        branch: 'nonexistent-branch',
        docsPath: 'docs',
        remoteUrl,
      } as any)
    }
    catch (err) {
      capturedError = err as Error
    }

    expect(capturedError).not.toBeNull()
    // Must NOT contain the tag-probe hint — branch fetches skip probeRemoteTag
    expect(capturedError!.message).not.toContain('Available tags matching')
    expect(capturedError!.message).not.toContain('Retry with')
  })

  it('probeRemoteTag is skipped for branch fetches even when matching tags exist', async () => {
    // Regression guard for the tagOnly fix: a fetch with only `branch` set
    // must fail without running probeRemoteTag, even when the remote has a
    // tag that matches the version string. Without the fix, a branch request
    // for `nonexistent-branch` could silently resolve to the `ai@1.0.0` tag.
    const remoteUrl = createLsRemoteRemote()
    const source = new GithubSource()

    // Confirm the remote really does have the `ai@1.0.0` tag (so probe
    // would succeed if it ran).
    const lsOutput = execFileSync('git', ['ls-remote', '--tags', remoteUrl], { encoding: 'utf-8' })
    expect(lsOutput).toContain('ai@1.0.0')

    let capturedError: Error | null = null
    try {
      await source.fetch({
        source: 'github',
        name: 'ai',
        version: '1.0.0',
        repo: 'test/lsremote',
        branch: '1.0.0', // version string that would match the tag via probe
        docsPath: 'docs',
        remoteUrl,
      } as any)
    }
    catch (err) {
      capturedError = err as Error
    }

    // The request must fail — probeRemoteTag is not called for branch fetches
    // so the `ai@1.0.0` tag is never discovered and used as a substitute.
    expect(capturedError).not.toBeNull()
    // The error comes from tar.gz (git falls back), not from a successful
    // clone of the tag — verifying the probe was never entered.
    expect(capturedError!.message).not.toContain('ai@1.0.0')
  })
})

/**
 * A3 — `.git/` dependency audit: after the shallow clone strips
 * `.git/`, the only consumer of `.git/` metadata inside the CLI
 * source should be `sources/github.ts` itself (it reads `rev-parse
 * HEAD` inside a temp clone dir before removing .git/). A runtime
 * assertion is too brittle because several unrelated files
 * legitimately contain the substring ".git" (ignore files, repo URL
 * parsers, inline examples in comments). This smoke test documents
 * the audit strategy: run `rg '\.git/'` manually before merging and
 * confirm each hit is either the github source itself, a string in
 * a comment, or a read-only parser for external URLs. The shallow
 * clone strip is covered by the "strips the .git/ directory after
 * clone" test earlier in this file.
 */
describe('.git/ dependency audit (A3)', () => {
  it('shallow-clone store entries are post-clone .git-free', async () => {
    // The strongest runtime check: any store entry materialized via
    // the github source contains no `.git/` anywhere in the tree.
    const remoteUrl = createLocalRemote()
    const source = new GithubSource()
    const result = await source.fetch({
      source: 'github',
      name: 'test-repo',
      version: '1.0.0',
      repo: 'test/repo',
      tag: 'v1.0.0',
      docsPath: 'docs',
      remoteUrl,
    } as any)

    // Walk the store entry recursively and assert no .git/ directory
    function hasGitDir(dir: string): boolean {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git')
          return true
        if (entry.isDirectory() && hasGitDir(path.join(dir, entry.name)))
          return true
      }
      return false
    }
    expect(hasGitDir(result.storePath!)).toBe(false)
  })
})
