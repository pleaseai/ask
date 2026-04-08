import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'bun:test'
import { NpmSource } from '../../src/sources/npm.js'

/**
 * Tests for `NpmSource.tryLocalRead` — the local-first read path that
 * short-circuits the tarball download when the package is already installed
 * in the project's `node_modules` directory.
 *
 * Track: npm-tarball-docs-20260408 (T-8)
 */

interface FixtureOptions {
  pkg: string
  version: string
  docsPath?: string
  files?: Record<string, string>
  /** When false, skip writing package.json (simulates a broken install) */
  writePkgJson?: boolean
}

function createFixtureProject(opts: FixtureOptions): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-npm-local-'))
  const pkgDir = path.join(projectDir, 'node_modules', opts.pkg)
  fs.mkdirSync(pkgDir, { recursive: true })

  if (opts.writePkgJson !== false) {
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: opts.pkg, version: opts.version }),
    )
  }

  if (opts.docsPath && opts.files) {
    const docsDir = path.join(pkgDir, opts.docsPath)
    fs.mkdirSync(docsDir, { recursive: true })
    for (const [relpath, content] of Object.entries(opts.files)) {
      const dest = path.join(docsDir, relpath)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, content)
    }
  }

  return projectDir
}

describe('NpmSource.tryLocalRead', () => {
  let projectDir: string | null = null

  afterEach(() => {
    if (projectDir) {
      fs.rmSync(projectDir, { recursive: true, force: true })
      projectDir = null
    }
  })

  it('hits on exact version match and returns docs', () => {
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
      docsPath: 'dist/docs',
      files: {
        'index.md': '# AI SDK',
        'guides/agents.md': '# Agents',
      },
    })

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: '5.1.0',
      docsPath: 'dist/docs',
    })

    expect(result).not.toBeNull()
    expect(result!.resolvedVersion).toBe('5.1.0')
    expect(result!.files).toHaveLength(2)
    expect(result!.files.map(f => f.path).sort()).toEqual([
      'guides/agents.md',
      'index.md',
    ])
    expect(result!.meta?.installPath).toContain(path.join('node_modules', 'ai'))
  })

  it('hits on `latest` request regardless of installed version', () => {
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
      docsPath: 'dist/docs',
      files: { 'index.md': '# AI SDK' },
    })

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: 'latest',
      docsPath: 'dist/docs',
    })

    expect(result).not.toBeNull()
    expect(result!.resolvedVersion).toBe('5.1.0')
  })

  it('hits on semver range that the installed version satisfies', () => {
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
      docsPath: 'dist/docs',
      files: { 'index.md': '# AI SDK' },
    })

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: '^5.0.0',
      docsPath: 'dist/docs',
    })

    expect(result).not.toBeNull()
    expect(result!.resolvedVersion).toBe('5.1.0')
  })

  it('misses on version mismatch (exact)', () => {
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
      docsPath: 'dist/docs',
      files: { 'index.md': '# AI SDK' },
    })

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: '4.0.0',
      docsPath: 'dist/docs',
    })

    expect(result).toBeNull()
  })

  it('misses on semver range mismatch', () => {
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
      docsPath: 'dist/docs',
      files: { 'index.md': '# AI SDK' },
    })

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: '^4.0.0',
      docsPath: 'dist/docs',
    })

    expect(result).toBeNull()
  })

  it('misses when docsPath does not exist in the installed package', () => {
    // package is installed but `dist/docs` was never built / shipped.
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
    })

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: '5.1.0',
      docsPath: 'dist/docs',
    })

    expect(result).toBeNull()
  })

  it('misses when node_modules entry is absent', () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-npm-local-empty-'))

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: '5.1.0',
      docsPath: 'dist/docs',
    })

    expect(result).toBeNull()
  })

  it('returns null when no docsPath is supplied (no auto-detect locally)', () => {
    // Local-first is opt-in via `docsPath` from the registry strategy.
    // Without it we don't probe — that's the discovery contract.
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
      docsPath: 'dist/docs',
      files: { 'index.md': '# AI SDK' },
    })

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: '5.1.0',
      docsPath: undefined,
    })

    expect(result).toBeNull()
  })

  it('returns null when docsPath exists but contains no readable doc files', () => {
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
      docsPath: 'dist/docs',
      files: { '.gitkeep': '' }, // not a .md/.mdx/.txt/.rst
    })

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: '5.1.0',
      docsPath: 'dist/docs',
    })

    expect(result).toBeNull()
  })

  it('handles scoped packages (@mastra/core) with monorepo dist/docs', () => {
    projectDir = createFixtureProject({
      pkg: '@mastra/core',
      version: '0.5.2',
      docsPath: 'dist/docs',
      files: {
        'README.md': '# Mastra Core',
        'agents.md': '# Agents',
      },
    })

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: '@mastra/core',
      requestedVersion: '0.5.2',
      docsPath: 'dist/docs',
    })

    expect(result).not.toBeNull()
    expect(result!.resolvedVersion).toBe('0.5.2')
    expect(result!.files).toHaveLength(2)
    expect(result!.meta?.installPath).toContain(path.join('node_modules', '@mastra', 'core'))
  })

  // T-9 / T-10: end-to-end fetch via NpmSource.fetch — exercises the local
  // short-circuit through the public DocSource interface. The test would
  // throw if the code fell through to `execSync('npm view ...')` because
  // the fixture package does not exist on the public npm registry.
  it('NpmSource.fetch uses the local node_modules entry without contacting npm', async () => {
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
      docsPath: 'dist/docs',
      files: {
        'index.md': '# AI SDK',
        'guides/agents.md': '# Agents',
      },
    })

    // Switch cwd so NpmSource.fetch picks up our fixture node_modules.
    const originalCwd = process.cwd()
    process.chdir(projectDir)
    try {
      const result = await new NpmSource().fetch({
        source: 'npm',
        name: 'ai',
        version: '5.1.0',
        docsPath: 'dist/docs',
      })
      expect(result.files).toHaveLength(2)
      expect(result.resolvedVersion).toBe('5.1.0')
      expect(result.meta?.installPath).toBeDefined()
      expect(result.meta?.tarball).toBeUndefined()
    }
    finally {
      process.chdir(originalCwd)
    }
  })

  it('NpmSource.fetch handles scoped @mastra/core via local read', async () => {
    projectDir = createFixtureProject({
      pkg: '@mastra/core',
      version: '0.5.2',
      docsPath: 'dist/docs',
      files: {
        'README.md': '# Mastra Core',
        'getting-started.md': '# Getting started',
      },
    })

    const originalCwd = process.cwd()
    process.chdir(projectDir)
    try {
      const result = await new NpmSource().fetch({
        source: 'npm',
        name: '@mastra/core',
        version: '0.5.2',
        docsPath: 'dist/docs',
      })
      expect(result.files).toHaveLength(2)
      expect(result.resolvedVersion).toBe('0.5.2')
      expect(result.meta?.installPath).toBeDefined()
    }
    finally {
      process.chdir(originalCwd)
    }
  })

  it('rejects docsPath that escapes the package directory (path traversal)', () => {
    // Defense-in-depth: a malformed registry entry that puts e.g.
    // `docsPath: '../../../etc/passwd'` must not be allowed to read
    // outside `node_modules/<pkg>/`. The local-first read returns null
    // (which will fall back to the tarball path, where the same input
    // would also fail because the tarball extracts into a temp dir).
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
      docsPath: 'dist/docs',
      files: { 'index.md': '# AI SDK' },
    })

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: '5.1.0',
      docsPath: '../../etc/passwd',
    })

    expect(result).toBeNull()
  })

  it('rejects docsPath that escapes the package directory via symlink', () => {
    // Even when the string-level check passes (docsPath stays inside
    // pkgDir lexically), a symlink at the docsPath location can point
    // outside. The realpath check catches this.
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
    })
    // Create a target outside the package dir with real docs
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-outside-'))
    try {
      fs.writeFileSync(path.join(outsideDir, 'malicious.md'), '# leaked')
      // Plant a symlink at node_modules/ai/dist/docs that points outside
      const distDir = path.join(projectDir, 'node_modules', 'ai', 'dist')
      fs.mkdirSync(distDir, { recursive: true })
      fs.symlinkSync(outsideDir, path.join(distDir, 'docs'))

      const result = new NpmSource().tryLocalRead({
        projectDir,
        pkg: 'ai',
        requestedVersion: '5.1.0',
        docsPath: 'dist/docs',
      })

      expect(result).toBeNull()
    }
    finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('rejects absolute docsPath', () => {
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
      docsPath: 'dist/docs',
      files: { 'index.md': '# AI SDK' },
    })

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: '5.1.0',
      docsPath: '/etc/passwd',
    })

    expect(result).toBeNull()
  })

  it('returns null on broken package.json (no version field)', () => {
    projectDir = createFixtureProject({
      pkg: 'ai',
      version: '5.1.0',
      docsPath: 'dist/docs',
      files: { 'index.md': '# AI SDK' },
    })
    // overwrite package.json to remove the version
    fs.writeFileSync(
      path.join(projectDir, 'node_modules', 'ai', 'package.json'),
      JSON.stringify({ name: 'ai' }),
    )

    const result = new NpmSource().tryLocalRead({
      projectDir,
      pkg: 'ai',
      requestedVersion: '5.1.0',
      docsPath: 'dist/docs',
    })

    expect(result).toBeNull()
  })
})
