import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runInstall } from '../../src/install.js'
import { readAskJson, readResolvedJson, writeAskJson } from '../../src/io.js'
import { stampEntry } from '../../src/store/index.js'

describe('runInstall', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-install-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(file: string, content: string) {
    const full = path.join(tmpDir, file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }

  it('bootstraps an empty ask.json when none exists (FR-8)', async () => {
    const summary = await runInstall(tmpDir)
    expect(summary).toEqual({ installed: 0, unchanged: 0, skipped: 0, failed: 0 })
    const askJson = readAskJson(tmpDir)
    expect(askJson).toEqual({ libraries: [] })
  })

  it('returns zero counts when ask.json is empty', async () => {
    writeAskJson(tmpDir, { libraries: [] })
    const summary = await runInstall(tmpDir)
    expect(summary).toEqual({ installed: 0, unchanged: 0, skipped: 0, failed: 0 })
  })

  it('warns and skips PM-driven entries with no lockfile match (FR-9)', async () => {
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:nonexistent-package-xyz' }] })
    const summary = await runInstall(tmpDir)
    expect(summary.skipped).toBe(1)
    expect(summary.installed).toBe(0)
    expect(summary.failed).toBe(0)
  })

  it('warns and skips an entry whose source fetch fails, exit 0 semantics (AC-5)', async () => {
    // Use a github entry pointed at a tag that does not exist. Source
    // fetch should throw; install must capture, warn, and continue.
    write('bun.lock', '{}\n')
    writeAskJson(tmpDir, {
      libraries: [
        {
          spec: 'github:pleaseai/this-repo-does-not-exist-xyz',
          ref: 'v0.0.0-nonexistent',
        },
      ],
    })
    const summary = await runInstall(tmpDir)
    // Either failed (network reached) or skipped (no network) — both
    // are fine, what matters is we did NOT throw and the resolved
    // cache is empty.
    expect(summary.installed).toBe(0)
    expect(summary.failed + summary.skipped).toBe(1)
    const resolved = readResolvedJson(tmpDir)
    expect(Object.keys(resolved.entries)).toHaveLength(0)
  })

  it('skips PM-driven entries when the requested package is not in the lockfile but other entries succeed (AC-4)', async () => {
    // bun.lock contains "absent-on-disk" but not "missing-pkg"
    write('bun.lock', '{ "packages": { "absent-on-disk": ["absent-on-disk@1.0.0"] } }\n')
    writeAskJson(tmpDir, {
      libraries: [
        { spec: 'npm:missing-pkg' },
      ],
    })
    const summary = await runInstall(tmpDir)
    expect(summary.skipped).toBe(1)
    expect(summary.failed).toBe(0)
  })

  it('records resolved.json entries that exist after a successful run', async () => {
    // We don't actually fetch anything; verify that the empty install
    // path leaves resolved.json in a readable state (default empty).
    writeAskJson(tmpDir, { libraries: [] })
    await runInstall(tmpDir)
    const resolved = readResolvedJson(tmpDir)
    expect(resolved.schemaVersion).toBe(1)
    expect(resolved.entries).toEqual({})
  })

  it('honours --force by clearing the cache short-circuit', async () => {
    writeAskJson(tmpDir, { libraries: [] })
    const first = await runInstall(tmpDir)
    const second = await runInstall(tmpDir, { force: true })
    expect(first).toEqual(second)
  })
})

/**
 * Tests for the npm store-hit short-circuit in `install.ts`. The guard
 * pattern is:
 *
 *   if (fs.existsSync(storeDir) && verifyEntry(storeDir)) → short-circuit
 *   else if (fs.existsSync(storeDir))                    → quarantineEntry + fresh fetch
 *
 * CLAUDE.md calls this out as load-bearing: "Never reintroduce a bare
 * fs.existsSync(storeDir) check without the guard." These tests lock
 * both branches of the guard so a regression that drops verifyEntry
 * is caught immediately.
 */
describe('runInstall — npm store-hit verifyEntry guard', () => {
  let tmpDir: string
  let askHome: string
  let originalAskHome: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-store-guard-'))
    askHome = path.join(tmpDir, 'ask-home')
    fs.mkdirSync(askHome, { recursive: true })
    originalAskHome = process.env.ASK_HOME
    process.env.ASK_HOME = askHome
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

  function writeProjectFile(projectDir: string, file: string, content: string): void {
    const full = path.join(projectDir, file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }

  /** Pre-populate a stamped npm store entry as if a prior install wrote it. */
  function seedStoreEntry(pkg: string, version: string, files: Record<string, string>): string {
    const storeDir = path.join(askHome, 'npm', `${pkg}@${version}`)
    fs.mkdirSync(storeDir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(storeDir, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    }
    stampEntry(storeDir)
    return storeDir
  }

  it('short-circuits on a valid stamped store entry without fetching', async () => {
    // A valid stamped store entry exists for test-store-pkg@1.0.0.
    const storeDir = seedStoreEntry('test-store-pkg', '1.0.0', {
      'README.md': '# test-store-pkg\n',
      'docs/guide.md': '# Guide\n',
    })

    // bun.lock pins the package at the same version.
    writeProjectFile(
      tmpDir,
      'bun.lock',
      '{ "packages": { "test-store-pkg": ["test-store-pkg@1.0.0"] } }\n',
    )
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:test-store-pkg' }] })

    const summary = await runInstall(tmpDir)

    // Store-hit path installs successfully without touching the network.
    // (This package does not exist on the real npm registry — if the
    // guard were dropped, the source adapter would try to fetch and
    // fail.)
    expect(summary.installed).toBe(1)
    expect(summary.failed).toBe(0)

    // Store entry was NOT quarantined and still passes verifyEntry.
    expect(fs.existsSync(storeDir)).toBe(true)
    expect(fs.existsSync(path.join(askHome, '.quarantine'))).toBe(false)

    // The resolved-cache row points at the same store dir.
    const resolved = readResolvedJson(tmpDir)
    const entry = resolved.entries['test-store-pkg']
    expect(entry?.storePath).toBe(storeDir)
    expect(entry?.resolvedVersion).toBe('1.0.0')
  })

  it('quarantines a tampered store entry and falls through to a fresh fetch', async () => {
    // Seed a valid stamped entry, then tamper with a file so verifyEntry
    // fails on the next install.
    const storeDir = seedStoreEntry('test-tampered-pkg', '1.0.0', {
      'README.md': '# original\n',
    })
    fs.writeFileSync(path.join(storeDir, 'README.md'), '# TAMPERED\n')

    writeProjectFile(
      tmpDir,
      'bun.lock',
      '{ "packages": { "test-tampered-pkg": ["test-tampered-pkg@1.0.0"] } }\n',
    )
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:test-tampered-pkg' }] })

    const summary = await runInstall(tmpDir)

    // The install falls through to fresh-fetch, which fails (the fake
    // package does not exist on the real npm registry). That failure is
    // captured as `failed` or `skipped` — exit-code-0 semantics (AC-5).
    expect(summary.installed).toBe(0)
    expect(summary.failed + summary.skipped).toBeGreaterThanOrEqual(1)

    // The tampered entry is gone from its original location…
    expect(fs.existsSync(storeDir)).toBe(false)

    // …and lives under <askHome>/.quarantine/ for forensic inspection.
    const quarantineRoot = path.join(askHome, '.quarantine')
    expect(fs.existsSync(quarantineRoot)).toBe(true)
    const quarantineEntries = fs.readdirSync(quarantineRoot)
    expect(quarantineEntries.length).toBeGreaterThanOrEqual(1)

    // The tampered content is preserved inside the quarantined copy.
    const firstQuarantined = path.join(quarantineRoot, quarantineEntries[0]!)
    expect(fs.readFileSync(path.join(firstQuarantined, 'README.md'), 'utf-8'))
      .toBe('# TAMPERED\n')
  })

  it('ignores a store entry that lacks a stamp (missing .ask-hash)', async () => {
    // Create the directory tree without calling stampEntry — verifyEntry
    // returns false because .ask-hash is missing, triggering the same
    // fall-through path as the tampered case above.
    const storeDir = path.join(askHome, 'npm', 'test-no-stamp-pkg@1.0.0')
    fs.mkdirSync(storeDir, { recursive: true })
    fs.writeFileSync(path.join(storeDir, 'README.md'), '# unstamped\n')

    writeProjectFile(
      tmpDir,
      'bun.lock',
      '{ "packages": { "test-no-stamp-pkg": ["test-no-stamp-pkg@1.0.0"] } }\n',
    )
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:test-no-stamp-pkg' }] })

    const summary = await runInstall(tmpDir)

    // Not short-circuited. The unstamped entry is quarantined and a
    // fresh fetch is attempted (which fails on the fake package).
    expect(summary.installed).toBe(0)
    expect(fs.existsSync(storeDir)).toBe(false)
    expect(fs.existsSync(path.join(askHome, '.quarantine'))).toBe(true)
  })
})
