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
