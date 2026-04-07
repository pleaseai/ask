import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readConfig } from '../src/io.js'
import { migrateLegacyWorkspace } from '../src/migrate-legacy.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-migrate-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function seedLegacy(legacyConfig: object, libs: Record<string, string>): void {
  const please = path.join(tmpDir, '.please')
  fs.mkdirSync(path.join(please, 'docs'), { recursive: true })
  fs.writeFileSync(
    path.join(please, 'config.json'),
    `${JSON.stringify(legacyConfig, null, 2)}\n`,
  )
  for (const [dirName, content] of Object.entries(libs)) {
    const libDir = path.join(please, 'docs', dirName)
    fs.mkdirSync(libDir, { recursive: true })
    fs.writeFileSync(path.join(libDir, 'README.md'), content)
  }
}

describe('migrateLegacyWorkspace', () => {
  it('is a no-op when neither .please nor .ask exists', () => {
    migrateLegacyWorkspace(tmpDir)
    expect(fs.existsSync(path.join(tmpDir, '.ask'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, '.please'))).toBe(false)
  })

  it('is a no-op when .ask/config.json already exists (sentinel)', () => {
    // The sentinel is .ask/config.json specifically — a bare .ask/ directory
    // could exist for unrelated reasons, so the migration only short-circuits
    // when the new config file is in place.
    fs.mkdirSync(path.join(tmpDir, '.ask'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.ask', 'config.json'),
      '{"schemaVersion":1,"docs":[]}\n',
    )
    fs.mkdirSync(path.join(tmpDir, '.please', 'docs', 'foo@1.0.0'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.please', 'docs', 'foo@1.0.0', 'README.md'), 'old')
    migrateLegacyWorkspace(tmpDir)
    // .please/docs should still be there because migration was skipped
    expect(fs.existsSync(path.join(tmpDir, '.please', 'docs', 'foo@1.0.0'))).toBe(true)
    // .ask/docs not created because migration was skipped
    expect(fs.existsSync(path.join(tmpDir, '.ask', 'docs'))).toBe(false)
  })

  it('moves .please/docs/* into .ask/docs/', () => {
    seedLegacy(
      {
        docs: [
          { source: 'github', name: 'foo', version: '1.0.0', repo: 'a/foo', tag: 'v1.0.0' },
        ],
      },
      { 'foo@1.0.0': '# foo' },
    )
    migrateLegacyWorkspace(tmpDir)
    expect(fs.existsSync(path.join(tmpDir, '.ask', 'docs', 'foo@1.0.0', 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, '.please', 'docs', 'foo@1.0.0'))).toBe(false)
  })

  it('parses legacy config and rewrites it under .ask/ with schemaVersion 1', () => {
    seedLegacy(
      {
        docs: [
          { source: 'github', name: 'foo', version: '1.0.0', repo: 'a/foo', tag: 'v1.0.0' },
          { source: 'npm', name: 'bar', version: '2.0.0' },
        ],
      },
      { 'foo@1.0.0': '# foo', 'bar@2.0.0': '# bar' },
    )
    migrateLegacyWorkspace(tmpDir)
    const cfg = readConfig(tmpDir)
    expect(cfg.schemaVersion).toBe(1)
    expect(cfg.docs).toHaveLength(2)
    // docs[] is sorted by name on write — bar before foo
    expect(cfg.docs[0].name).toBe('bar')
    expect(cfg.docs[1].name).toBe('foo')
    expect(fs.existsSync(path.join(tmpDir, '.please', 'config.json'))).toBe(false)
  })

  it('runs exactly once — second invocation is a no-op', () => {
    seedLegacy(
      { docs: [{ source: 'npm', name: 'foo', version: '1.0.0' }] },
      { 'foo@1.0.0': '# foo' },
    )
    migrateLegacyWorkspace(tmpDir)
    const firstReadme = fs.readFileSync(
      path.join(tmpDir, '.ask', 'docs', 'foo@1.0.0', 'README.md'),
      'utf-8',
    )
    // Tamper with the migrated file to verify second call doesn't re-migrate
    fs.writeFileSync(
      path.join(tmpDir, '.ask', 'docs', 'foo@1.0.0', 'README.md'),
      'tampered',
    )
    migrateLegacyWorkspace(tmpDir)
    const secondReadme = fs.readFileSync(
      path.join(tmpDir, '.ask', 'docs', 'foo@1.0.0', 'README.md'),
      'utf-8',
    )
    expect(secondReadme).toBe('tampered')
    expect(firstReadme).toBe('# foo')
  })
})
