import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runInstall } from '../../src/install.js'
import { readResolvedJson, writeAskJson } from '../../src/io.js'

/**
 * Integration tests for the in-place npm docs feature (SC-1 through SC-8).
 *
 * Each test builds a minimal project layout with a fake package in
 * `node_modules/<pkg>` that ships docs, then runs `runInstall` and
 * asserts the expected on-disk outcome.
 */

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-in-place-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(file: string, content: string): void {
  const full = path.join(tmpDir, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

function writePkg(pkgName: string, version: string, docsDir: string, files: Record<string, string>): void {
  write(`node_modules/${pkgName}/package.json`, JSON.stringify({
    name: pkgName,
    version,
  }, null, 2))
  for (const [rel, content] of Object.entries(files)) {
    write(`node_modules/${pkgName}/${docsDir}/${rel}`, content)
  }
}

function writeBunLock(pkgName: string, version: string): void {
  write('bun.lock', JSON.stringify({
    packages: {
      [pkgName]: [`${pkgName}@${version}`],
    },
  }))
}

describe('in-place install', () => {
  it('SC-1: does NOT create .ask/docs/<pkg>@<v>/ and AGENTS.md points at node_modules', async () => {
    writePkg('next', '16.2.3', 'dist/docs', {
      'guide.md': '# Guide\n'.repeat(200),
      'api.md': '# API\n'.repeat(200),
      'migration.md': '# Migration\n'.repeat(200),
    })
    writeBunLock('next', '16.2.3')
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:next' }] })

    await runInstall(tmpDir)

    // No vendored docs should exist
    const askDocsDir = path.join(tmpDir, '.ask', 'docs')
    const vendoredDirs = fs.existsSync(askDocsDir)
      ? fs.readdirSync(askDocsDir).filter(d => d.startsWith('next@'))
      : []
    expect(vendoredDirs).toHaveLength(0)

    // AGENTS.md should point at node_modules
    const agentsMd = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain('node_modules/next/dist/docs/')

    // Resolved cache should have materialization: 'in-place'
    const resolved = readResolvedJson(tmpDir)
    expect(resolved.entries.next).toBeDefined()
    expect(resolved.entries.next!.materialization).toBe('in-place')
    expect(resolved.entries.next!.inPlacePath).toBe('node_modules/next/dist/docs')
  })

  it('SC-3: version bump updates resolved version and AGENTS.md without stale .ask/docs/', async () => {
    // First install at 16.2.3
    writePkg('next', '16.2.3', 'dist/docs', {
      'guide.md': '# Guide v16.2.3\n'.repeat(200),
      'api.md': '# API\n'.repeat(200),
      'migration.md': '# Migration\n'.repeat(200),
    })
    writeBunLock('next', '16.2.3')
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:next' }] })
    await runInstall(tmpDir)

    // Bump to 16.2.4
    writePkg('next', '16.2.4', 'dist/docs', {
      'guide.md': '# Guide v16.2.4\n'.repeat(200),
      'api.md': '# API\n'.repeat(200),
      'migration.md': '# Migration\n'.repeat(200),
    })
    writeBunLock('next', '16.2.4')
    await runInstall(tmpDir, { force: true })

    const resolved = readResolvedJson(tmpDir)
    expect(resolved.entries.next!.resolvedVersion).toBe('16.2.4')
    expect(resolved.entries.next!.materialization).toBe('in-place')

    const agentsMd = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain('v16.2.4')

    // No stale .ask/docs/ should exist
    const askDocsDir = path.join(tmpDir, '.ask', 'docs')
    const vendoredDirs = fs.existsSync(askDocsDir)
      ? fs.readdirSync(askDocsDir).filter(d => d.startsWith('next@'))
      : []
    expect(vendoredDirs).toHaveLength(0)
  })

  it('SC-4: package without shipped docs falls through to tarball/copy path', async () => {
    // Use a fake package name that will 404 at `npm view` quickly. We want
    // to prove the in-place discovery returned null for a package with no
    // docs/dist/docs/README, not exercise a real tarball download (which is
    // flaky on slow CI and unrelated to the assertion).
    writePkg('fake-no-docs-pkg', '1.0.0', 'lib', {})
    write(`node_modules/fake-no-docs-pkg/package.json`, JSON.stringify({
      name: 'fake-no-docs-pkg',
      version: '1.0.0',
    }))
    writeBunLock('fake-no-docs-pkg', '1.0.0')
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:fake-no-docs-pkg' }] })

    // This will fail at the source fetch stage (no registry, no local docs),
    // which is expected — we just verify it didn't take the in-place path.
    const summary = await runInstall(tmpDir)
    const resolved = readResolvedJson(tmpDir)
    const entry = resolved.entries['fake-no-docs-pkg']
    // Either skipped/failed (no docs found) or not materialized as in-place
    if (entry) {
      expect(entry.materialization).not.toBe('in-place')
    }
    else {
      expect(summary.skipped + summary.failed).toBeGreaterThan(0)
    }
  })

  it('SC-5: CLI inPlace=false bypasses in-place discovery', async () => {
    // Verify the precedence logic: inPlace=false (CLI) disables discovery.
    // The actual copy path (saveDocs → .ask/docs/) is separately tested by
    // existing tests in install.test.ts and npm-local.test.ts. Here we
    // verify only that the in-place code path is NOT taken.
    writePkg('fake-in-place-pkg', '1.0.0', 'dist/docs', {
      'guide.md': '# Guide\n'.repeat(200),
      'api.md': '# API\n'.repeat(200),
      'migration.md': '# Migration\n'.repeat(200),
    })
    writeBunLock('fake-in-place-pkg', '1.0.0')

    // Default: in-place discovery finds docs → materialization: 'in-place'
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:fake-in-place-pkg' }] })
    const defaultResult = await runInstall(tmpDir)
    expect(defaultResult.installed).toBe(1)
    const resolved = readResolvedJson(tmpDir)
    expect(resolved.entries['fake-in-place-pkg']!.materialization).toBe('in-place')

    // With inPlace=false: the discovery branch is skipped. The npm source
    // falls through to tarball fetch (no real package → fails gracefully).
    // The important assertion: the in-place path was NOT taken.
    const noInPlaceResult = await runInstall(tmpDir, { inPlace: false, force: true })
    // The tarball path fails for a fake package — skipped or failed, not installed.
    expect(noInPlaceResult.installed).toBe(0)
  })

  it('SC-6: ask.json inPlace=false bypasses in-place discovery', async () => {
    writePkg('fake-in-place-pkg', '1.0.0', 'dist/docs', {
      'guide.md': '# Guide\n'.repeat(200),
      'api.md': '# API\n'.repeat(200),
      'migration.md': '# Migration\n'.repeat(200),
    })
    writeBunLock('fake-in-place-pkg', '1.0.0')

    // Default: in-place takes effect
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:fake-in-place-pkg' }] })
    const defaultResult = await runInstall(tmpDir)
    expect(defaultResult.installed).toBe(1)
    expect(readResolvedJson(tmpDir).entries['fake-in-place-pkg']!.materialization).toBe('in-place')

    // ask.json inPlace: false → discovery bypassed
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:fake-in-place-pkg' }], inPlace: false })
    const result = await runInstall(tmpDir, { force: true })
    expect(result.installed).toBe(0)
  })

  it('SC-7: ask remove on an in-place entry removes resolved entry without touching node_modules/', async () => {
    writePkg('next', '16.2.3', 'dist/docs', {
      'guide.md': '# Guide\n'.repeat(200),
      'api.md': '# API\n'.repeat(200),
      'migration.md': '# Migration\n'.repeat(200),
    })
    writeBunLock('next', '16.2.3')
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:next' }] })

    await runInstall(tmpDir)

    // Verify in-place install happened
    let resolved = readResolvedJson(tmpDir)
    expect(resolved.entries.next).toBeDefined()
    expect(resolved.entries.next!.materialization).toBe('in-place')

    // Now simulate remove: drop from ask.json and clean up
    const { dropResolvedEntry } = await import('../../src/install.js')
    const { generateAgentsMd } = await import('../../src/agents.js')
    const { writeAskJson: waj } = await import('../../src/io.js')

    waj(tmpDir, { libraries: [] })
    dropResolvedEntry(tmpDir, 'next')
    generateAgentsMd(tmpDir)

    // Resolved entry should be gone
    resolved = readResolvedJson(tmpDir)
    expect(resolved.entries.next).toBeUndefined()

    // node_modules/next/ should still exist
    expect(fs.existsSync(path.join(tmpDir, 'node_modules', 'next', 'dist', 'docs', 'guide.md'))).toBe(true)
  })

  it('SC-8: pre-existing .ask/docs/<pkg>@<old>/ is removed on first in-place install', async () => {
    // Simulate a pre-existing vendored copy
    write('.ask/docs/next@16.2.2/guide.md', '# old guide')
    write('.ask/docs/next@16.2.2/INDEX.md', '# old index')

    writePkg('next', '16.2.3', 'dist/docs', {
      'guide.md': '# Guide\n'.repeat(200),
      'api.md': '# API\n'.repeat(200),
      'migration.md': '# Migration\n'.repeat(200),
    })
    writeBunLock('next', '16.2.3')
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:next' }] })

    await runInstall(tmpDir)

    // Old vendored dir should be cleaned up
    expect(fs.existsSync(path.join(tmpDir, '.ask', 'docs', 'next@16.2.2'))).toBe(false)

    // New install should be in-place
    const resolved = readResolvedJson(tmpDir)
    expect(resolved.entries.next!.materialization).toBe('in-place')
  })

  it('in-place short-circuit: second install returns unchanged', async () => {
    writePkg('next', '16.2.3', 'dist/docs', {
      'guide.md': '# Guide\n'.repeat(200),
      'api.md': '# API\n'.repeat(200),
      'migration.md': '# Migration\n'.repeat(200),
    })
    writeBunLock('next', '16.2.3')
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:next' }] })

    const first = await runInstall(tmpDir)
    expect(first.installed).toBe(1)

    const second = await runInstall(tmpDir)
    expect(second.unchanged).toBe(1)
    expect(second.installed).toBe(0)
  })
})
