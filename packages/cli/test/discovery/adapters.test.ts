import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runLocalDiscovery } from '../../src/discovery/index.js'
import { localAskAdapter } from '../../src/discovery/local-ask.js'
import { localConventionsAdapter } from '../../src/discovery/local-conventions.js'

/**
 * Unit tests for the local-stage discovery adapters. Each test builds a
 * minimal `node_modules/<pkg>` layout inside a tmp project dir and
 * invokes the adapter directly, mirroring how the dispatcher calls it.
 */

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-adapters-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writePkg(pkgName: string, pkgJson: Record<string, unknown>, files: Record<string, string> = {}): string {
  const pkgDir = path.join(tmpDir, 'node_modules', pkgName)
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf-8')
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(pkgDir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf-8')
  }
  return pkgDir
}

describe('localAskAdapter', () => {
  it('returns null when package.json has no ask.docsPath', async () => {
    writePkg('pkg-plain', { name: 'pkg-plain', version: '1.0.0' })
    const result = await localAskAdapter({
      projectDir: tmpDir,
      pkg: 'pkg-plain',
      requestedVersion: 'latest',
    })
    expect(result).toBeNull()
  })

  it('returns a docs-kind result when ask.docsPath points at a real dir', async () => {
    writePkg(
      'pkg-ask',
      {
        name: 'pkg-ask',
        version: '2.1.0',
        ask: { docsPath: 'dist/docs' },
      },
      {
        'dist/docs/guide.md': '# guide\ncontent',
        'dist/docs/api.md': '# api\ncontent',
      },
    )
    const result = await localAskAdapter({
      projectDir: tmpDir,
      pkg: 'pkg-ask',
      requestedVersion: 'latest',
    })
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('docs')
    if (result!.kind === 'docs') {
      expect(result!.adapter).toBe('local-ask')
      expect(result!.resolvedVersion).toBe('2.1.0')
      expect(result!.docsPath).toBe('dist/docs')
      expect(result!.files.length).toBe(2)
      expect(result!.installPath).toBeDefined()
    }
  })

  it('returns null when the declared docsPath does not exist', async () => {
    writePkg('pkg-ask-broken', {
      name: 'pkg-ask-broken',
      version: '1.0.0',
      ask: { docsPath: 'nowhere' },
    })
    const result = await localAskAdapter({
      projectDir: tmpDir,
      pkg: 'pkg-ask-broken',
      requestedVersion: 'latest',
    })
    expect(result).toBeNull()
  })

  it('returns null when the package is not installed', async () => {
    const result = await localAskAdapter({
      projectDir: tmpDir,
      pkg: 'nope',
      requestedVersion: 'latest',
    })
    expect(result).toBeNull()
  })
})

describe('localConventionsAdapter', () => {
  it('selects dist/docs when it has enough content', async () => {
    writePkg(
      'pkg-conv',
      { name: 'pkg-conv', version: '1.2.3' },
      {
        'dist/docs/a.md': '# a\n'.repeat(200),
        'dist/docs/b.md': '# b\n'.repeat(200),
        'dist/docs/c.md': '# c\n'.repeat(200),
      },
    )
    const result = await localConventionsAdapter({
      projectDir: tmpDir,
      pkg: 'pkg-conv',
      requestedVersion: 'latest',
    })
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('docs')
    if (result!.kind !== 'docs') {
      throw new Error(`expected docs result, got ${result!.kind}`)
    }
    expect(result!.docsPath).toBe('dist/docs')
    expect(result!.adapter).toBe('local-conventions')
    expect(result!.files.length).toBe(3)
  })

  it('falls through to README.md when conventions have only noise', async () => {
    writePkg(
      'pkg-readme-only',
      { name: 'pkg-readme-only', version: '1.0.0' },
      {
        'docs/CHANGELOG.md': 'changelog',
        'docs/CONTRIBUTING.md': 'contributing',
        'README.md': '# Real README\n'.repeat(100),
      },
    )
    const result = await localConventionsAdapter({
      projectDir: tmpDir,
      pkg: 'pkg-readme-only',
      requestedVersion: 'latest',
    })
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('docs')
    if (result!.kind !== 'docs') {
      throw new Error(`expected docs result, got ${result!.kind}`)
    }
    expect(result!.docsPath).toBe('README.md')
  })

  it('treats lowercase meta filenames as noise (case-insensitive filter)', async () => {
    writePkg(
      'pkg-lower-noise',
      { name: 'pkg-lower-noise', version: '1.0.0' },
      {
        'docs/contributing.md': 'c',
        'docs/changelog.md': 'c',
        'docs/security.md': 'c',
      },
    )
    const result = await localConventionsAdapter({
      projectDir: tmpDir,
      pkg: 'pkg-lower-noise',
      requestedVersion: 'latest',
    })
    expect(result).toBeNull()
  })

  it('returns null for a noise-only package (SC-3)', async () => {
    writePkg(
      'pkg-noise',
      { name: 'pkg-noise', version: '1.0.0' },
      {
        'CONTRIBUTING.md': 'c',
        'CHANGELOG.md': 'c',
      },
    )
    const result = await localConventionsAdapter({
      projectDir: tmpDir,
      pkg: 'pkg-noise',
      requestedVersion: 'latest',
    })
    expect(result).toBeNull()
  })
})

describe('runLocalDiscovery priority order', () => {
  it('local-ask takes precedence over local-conventions', async () => {
    writePkg(
      'pkg-both',
      {
        name: 'pkg-both',
        version: '1.0.0',
        ask: { docsPath: 'docs' },
      },
      {
        'docs/a.md': 'a',
        'docs/b.md': 'b',
        'docs/c.md': 'c',
        'dist/docs/other.md': '# other\n'.repeat(500),
      },
    )
    const result = await runLocalDiscovery({
      projectDir: tmpDir,
      pkg: 'pkg-both',
      requestedVersion: 'latest',
    })
    expect(result).not.toBeNull()
    if (result && result.kind === 'docs') {
      expect(result.adapter).toBe('local-ask')
      expect(result.docsPath).toBe('docs')
    }
  })

  it('returns null when explicitDocsPath is set (discovery is bypassed)', async () => {
    writePkg(
      'pkg-both',
      {
        name: 'pkg-both',
        version: '1.0.0',
        ask: { docsPath: 'docs' },
      },
      { 'docs/a.md': 'a', 'docs/b.md': 'b', 'docs/c.md': 'c' },
    )
    const result = await runLocalDiscovery({
      projectDir: tmpDir,
      pkg: 'pkg-both',
      requestedVersion: 'latest',
      explicitDocsPath: 'some-other-dir',
    })
    expect(result).toBeNull()
  })

  it('returns null when package is not installed', async () => {
    const result = await runLocalDiscovery({
      projectDir: tmpDir,
      pkg: 'nope',
      requestedVersion: 'latest',
    })
    expect(result).toBeNull()
  })
})
