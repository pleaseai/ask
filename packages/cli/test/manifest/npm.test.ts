import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { NpmManifestReader } from '../../src/manifest/npm.js'

describe('NpmManifestReader', () => {
  const reader = new NpmManifestReader()
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-manifest-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(file: string, content: string) {
    fs.writeFileSync(path.join(tmpDir, file), content)
  }

  it('returns null when no manifest exists', () => {
    expect(reader.readInstalledVersion('next', tmpDir)).toBeNull()
  })

  it('reads exact version from bun.lock', () => {
    write('bun.lock', `{
  "lockfileVersion": 1,
  "packages": {
    "next": ["next@15.0.3", "https://...", {}, "sha512-..."],
  },
}
`)
    expect(reader.readInstalledVersion('next', tmpDir)).toEqual({
      version: '15.0.3',
      source: 'bun.lock',
      exact: true,
    })
  })

  it('reads exact version from package-lock.json (v3)', () => {
    write('package-lock.json', JSON.stringify({
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { next: '^15' } },
        'node_modules/next': { version: '15.0.3' },
      },
    }))
    expect(reader.readInstalledVersion('next', tmpDir)).toEqual({
      version: '15.0.3',
      source: 'package-lock.json',
      exact: true,
    })
  })

  it('reads exact version from package-lock.json (v1 dependencies)', () => {
    write('package-lock.json', JSON.stringify({
      name: 'demo',
      lockfileVersion: 1,
      dependencies: { next: { version: '14.2.0' } },
    }))
    const hit = reader.readInstalledVersion('next', tmpDir)
    expect(hit?.version).toBe('14.2.0')
  })

  it('reads exact version from pnpm-lock.yaml', () => {
    write('pnpm-lock.yaml', `lockfileVersion: '6.0'
importers:
  .:
    dependencies:
      next:
        specifier: ^15
        version: 15.0.3
packages:

  /next@15.0.3:
    resolution: {integrity: sha512-aaa}
    dev: false
`)
    const hit = reader.readInstalledVersion('next', tmpDir)
    expect(hit).toEqual({
      version: '15.0.3',
      source: 'pnpm-lock.yaml',
      exact: true,
    })
  })

  it('reads exact version from yarn.lock', () => {
    write('yarn.lock', `# yarn lockfile v1


"next@^15.0.0", next@15.0.3:
  version "15.0.3"
  resolved "https://registry.yarnpkg.com/next/-/next-15.0.3.tgz"
`)
    const hit = reader.readInstalledVersion('next', tmpDir)
    expect(hit).toEqual({
      version: '15.0.3',
      source: 'yarn.lock',
      exact: true,
    })
  })

  it('falls back to package.json range (not exact)', () => {
    write('package.json', JSON.stringify({
      name: 'demo',
      dependencies: { next: '^15.0.0' },
    }))
    expect(reader.readInstalledVersion('next', tmpDir)).toEqual({
      version: '^15.0.0',
      source: 'package.json',
      exact: false,
    })
  })

  it('reads devDependencies from package.json', () => {
    write('package.json', JSON.stringify({
      name: 'demo',
      devDependencies: { typescript: '~5.5.0' },
    }))
    const hit = reader.readInstalledVersion('typescript', tmpDir)
    expect(hit?.version).toBe('~5.5.0')
  })

  it('prefers bun.lock over other lockfiles', () => {
    write('bun.lock', `{ "packages": { "next": ["next@15.0.3"] } }\n`)
    write('package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/next': { version: '14.0.0' } },
    }))
    write('package.json', JSON.stringify({ dependencies: { next: '^15' } }))
    expect(reader.readInstalledVersion('next', tmpDir)?.source).toBe('bun.lock')
  })

  it('prefers package-lock.json over pnpm-lock.yaml', () => {
    write('package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/next': { version: '14.0.0' } },
    }))
    write('pnpm-lock.yaml', 'packages:\n  /next@15.0.3:\n    dev: false\n')
    expect(reader.readInstalledVersion('next', tmpDir)?.source).toBe('package-lock.json')
  })

  it('returns null when package is not in manifest', () => {
    write('package.json', JSON.stringify({
      dependencies: { react: '^18' },
    }))
    expect(reader.readInstalledVersion('next', tmpDir)).toBeNull()
  })
})
