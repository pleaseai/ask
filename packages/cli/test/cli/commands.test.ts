import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runMain } from 'citty'
import { main } from '../../src/index.js'
import { readAskJson } from '../../src/io.js'

/**
 * Run a single citty command synchronously, restoring CWD afterward.
 * The CLI surface uses `process.cwd()` heavily, so we chdir into a
 * temp project for each test.
 */
async function runCli(cwd: string, args: string[]): Promise<void> {
  const original = process.cwd()
  const originalArgv = process.argv
  process.chdir(cwd)
  process.argv = ['node', 'ask', ...args]
  try {
    await runMain(main)
  }
  finally {
    process.chdir(original)
    process.argv = originalArgv
  }
}

describe('ask CLI surface (install/add/remove/list)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-cli-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('ask install bootstraps an empty ask.json (FR-8, AC-6)', async () => {
    await runCli(tmpDir, ['install'])
    const askJson = readAskJson(tmpDir)
    expect(askJson).toEqual({ libraries: [] })
  })

  it('ask add npm:<pkg> appends a PM-driven entry to ask.json', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bun.lock'), '{}\n')
    await runCli(tmpDir, ['add', 'npm:next'])
    const askJson = readAskJson(tmpDir)
    expect(askJson?.libraries).toEqual([{ spec: 'npm:next' }])
  })

  it('ask add github:<owner>/<repo> requires --ref', async () => {
    let exitCode: number | undefined
    const originalExit = process.exit
    process.exit = ((code?: number): never => {
      exitCode = code
      throw new Error('exit')
    }) as typeof process.exit
    try {
      await runCli(tmpDir, ['add', 'github:vercel/next.js'])
    }
    catch {
      // expected
    }
    finally {
      process.exit = originalExit
    }
    expect(exitCode).toBe(1)
  })

  it('ask add github:<owner>/<repo> --ref appends a standalone github entry', async () => {
    // Note: install will fail (network), but the ask.json mutation
    // should land before the install runs.
    try {
      await runCli(tmpDir, ['add', 'github:pleaseai/this-does-not-exist', '--ref', 'v1.0.0'])
    }
    catch {
      // ignore install failure
    }
    const askJson = readAskJson(tmpDir)
    expect(askJson?.libraries).toEqual([
      { spec: 'github:pleaseai/this-does-not-exist', ref: 'v1.0.0' },
    ])
  })

  it('ask add github:<owner>/<repo> --ref main --allow-mutable-ref writes the entry', async () => {
    // Pre-create an empty ask.json so the CLI path doesn't bootstrap
    // inside runInstall (which could interact with the flag plumbing
    // in subtle ways). We only care here that the schema accepts a
    // mutable ref when the lax variant is selected.
    fs.writeFileSync(path.join(tmpDir, 'ask.json'), '{"libraries": []}\n')

    try {
      await runCli(tmpDir, [
        'add',
        'github:pleaseai/this-does-not-exist',
        '--ref',
        'main',
        '--allow-mutable-ref',
      ])
    }
    catch {
      // install step may fail (network), but ask.json mutation should land
    }
    const askJson = readAskJson(tmpDir, { allowMutableRef: true })
    expect(askJson?.libraries).toEqual([
      { spec: 'github:pleaseai/this-does-not-exist', ref: 'main' },
    ])
  })

  it('ask remove deletes a matching entry from ask.json (AC-7)', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'ask.json'),
      `${JSON.stringify({
        libraries: [
          { spec: 'npm:next' },
          { spec: 'github:vercel/next.js', ref: 'v14.2.3' },
        ],
      }, null, 2)}\n`,
    )
    await runCli(tmpDir, ['remove', 'next'])
    const askJson = readAskJson(tmpDir)
    expect(askJson?.libraries).toEqual([
      { spec: 'github:vercel/next.js', ref: 'v14.2.3' },
    ])
  })

  it('ask list runs against an empty ask.json without error', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'ask.json'),
      `${JSON.stringify({ libraries: [] }, null, 2)}\n`,
    )
    // Smoke test — the rendered output goes through consola, which is
    // hard to intercept reliably across bun versions. We just assert
    // the command path completes without throwing.
    await runCli(tmpDir, ['list', '--json'])
  })

  it('ask add npm:<pkg> accepts --emit-skill flag without error (SC-2)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bun.lock'), '{}\n')
    // The flag should be accepted at parse level; install will skip (no lockfile entry),
    // but ask.json should have the entry appended.
    await runCli(tmpDir, ['add', 'npm:lodash', '--emit-skill'])
    const askJson = readAskJson(tmpDir)
    expect(askJson?.libraries).toEqual([{ spec: 'npm:lodash' }])
  })
})
