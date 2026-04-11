import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { withBareClone } from '../../src/store/github-bare.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-ghbare-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Create a local git repo that can serve as a "remote" for testing
 * without hitting the network. Returns the bare repo path (serves as
 * the remoteUrl for withBareClone).
 */
function createLocalRemote(): string {
  const repoDir = path.join(tmpDir, 'local-remote.git')
  const workDir = path.join(tmpDir, 'work')

  fs.mkdirSync(workDir, { recursive: true })
  execFileSync('git', ['init', workDir], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })

  fs.writeFileSync(path.join(workDir, 'README.md'), '# Test Repo\n')
  fs.mkdirSync(path.join(workDir, 'docs'))
  fs.writeFileSync(path.join(workDir, 'docs', 'guide.md'), '# Guide v1\n')

  execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'commit', '-m', 'initial'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'tag', 'v1.0.0'], { stdio: 'ignore' })

  // Add a second commit + tag
  fs.writeFileSync(path.join(workDir, 'docs', 'guide.md'), '# Guide v2\n')
  execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'commit', '-m', 'update'], { stdio: 'ignore' })
  execFileSync('git', ['-C', workDir, 'tag', 'v2.0.0'], { stdio: 'ignore' })

  // Clone as bare — serves as our "remote"
  execFileSync('git', ['clone', '--bare', workDir, repoDir], { stdio: 'ignore' })

  return repoDir
}

describe('withBareClone', () => {
  it('creates bare db + checkout directory from a local remote', () => {
    const remoteUrl = createLocalRemote()
    const askHome = path.join(tmpDir, 'ask-home')

    const result = withBareClone(askHome, 'test', 'repo', 'v1.0.0', { remoteUrl })

    expect(result).not.toBeNull()
    expect(result).toBe(path.join(askHome, 'github', 'checkouts', 'test__repo', 'v1.0.0'))

    // bare db was created
    expect(fs.existsSync(path.join(askHome, 'github', 'db', 'test__repo.git'))).toBe(true)

    // checkout contains the v1.0.0 content
    expect(fs.existsSync(path.join(result!, 'README.md'))).toBe(true)
    expect(fs.readFileSync(path.join(result!, 'docs', 'guide.md'), 'utf-8')).toBe('# Guide v1\n')
  })

  it('reuses existing bare clone when fetching a second ref', () => {
    const remoteUrl = createLocalRemote()
    const askHome = path.join(tmpDir, 'ask-home')

    const result1 = withBareClone(askHome, 'test', 'repo', 'v1.0.0', { remoteUrl })
    expect(result1).not.toBeNull()

    // Capture the bare db mtime before second call
    const dbPath = path.join(askHome, 'github', 'db', 'test__repo.git')
    const statBefore = fs.statSync(dbPath)

    const result2 = withBareClone(askHome, 'test', 'repo', 'v2.0.0', { remoteUrl })
    expect(result2).not.toBeNull()
    expect(result2).toBe(path.join(askHome, 'github', 'checkouts', 'test__repo', 'v2.0.0'))

    // Same bare clone should still exist (reused, not recreated)
    const statAfter = fs.statSync(dbPath)
    expect(statAfter.ino).toBe(statBefore.ino)

    // Both checkouts have the correct content
    expect(fs.readFileSync(path.join(result1!, 'docs', 'guide.md'), 'utf-8')).toBe('# Guide v1\n')
    expect(fs.readFileSync(path.join(result2!, 'docs', 'guide.md'), 'utf-8')).toBe('# Guide v2\n')
  })

  it('returns existing checkout path without re-fetching', () => {
    const remoteUrl = createLocalRemote()
    const askHome = path.join(tmpDir, 'ask-home')

    // First call creates the checkout
    const result1 = withBareClone(askHome, 'test', 'repo', 'v1.0.0', { remoteUrl })
    expect(result1).not.toBeNull()

    // Manually tamper with checkout — add a marker file
    fs.writeFileSync(path.join(result1!, 'marker.txt'), 'do not overwrite')

    // Second call should return the same path WITHOUT re-fetching (marker preserved)
    const result2 = withBareClone(askHome, 'test', 'repo', 'v1.0.0', { remoteUrl })
    expect(result2).toBe(result1)
    expect(fs.readFileSync(path.join(result2!, 'marker.txt'), 'utf-8')).toBe('do not overwrite')
  })

  it('returns null when ref does not exist in remote', () => {
    const remoteUrl = createLocalRemote()
    const askHome = path.join(tmpDir, 'ask-home')

    const result = withBareClone(askHome, 'test', 'repo', 'v99.99.99', { remoteUrl })
    expect(result).toBeNull()

    // Checkout directory should be cleaned up on failure
    expect(fs.existsSync(path.join(askHome, 'github', 'checkouts', 'test__repo', 'v99.99.99'))).toBe(false)
  })

  it('falls back to null on invalid remote URL', () => {
    const askHome = path.join(tmpDir, 'ask-home')

    // Use a bogus local path that doesn't exist
    const result = withBareClone(askHome, 'test', 'repo', 'v1.0.0', {
      remoteUrl: path.join(tmpDir, 'nonexistent.git'),
    })
    expect(result).toBeNull()
  })
})
