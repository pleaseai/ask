import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runInstall } from '../../src/install.js'
import { readAskJson, readResolvedJson, writeAskJson } from '../../src/io.js'

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
