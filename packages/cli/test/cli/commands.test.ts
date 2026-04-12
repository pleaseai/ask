import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runMain } from 'citty'
import { main } from '../../src/index.js'
import { readAskJson } from '../../src/io.js'

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

describe('ask CLI surface (lazy-first)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-cli-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('ask install bootstraps an empty ask.json', async () => {
    await runCli(tmpDir, ['install'])
    const askJson = readAskJson(tmpDir)
    expect(askJson).toEqual({ libraries: [] })
  })

  it('ask add npm:<pkg> appends a spec string to ask.json', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bun.lock'), '{}\n')
    await runCli(tmpDir, ['add', 'npm:next'])
    const askJson = readAskJson(tmpDir)
    expect(askJson?.libraries).toEqual(['npm:next'])
  })

  it('ask add owner/repo normalizes to github: prefix', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ask.json'), '{"libraries":[]}\n')
    await runCli(tmpDir, ['add', 'vercel/ai'])
    const askJson = readAskJson(tmpDir)
    expect(askJson?.libraries).toEqual(['github:vercel/ai'])
  })

  it('ask remove deletes a matching spec from ask.json', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'ask.json'),
      JSON.stringify({ libraries: ['npm:next', 'npm:zod'] }, null, 2),
    )
    await runCli(tmpDir, ['remove', 'next'])
    const askJson = readAskJson(tmpDir)
    expect(askJson?.libraries).toEqual(['npm:zod'])
  })

  it('ask list runs against an empty ask.json without error', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'ask.json'),
      JSON.stringify({ libraries: [] }, null, 2),
    )
    await runCli(tmpDir, ['list', '--json'])
  })

  it('ask add rejects bare names without ecosystem prefix', async () => {
    let exitCode: number | undefined
    const originalExit = process.exit
    process.exit = ((code?: number): never => {
      exitCode = code
      throw new Error('exit')
    }) as typeof process.exit
    try {
      await runCli(tmpDir, ['add', 'next'])
    }
    catch {
      // expected
    }
    finally {
      process.exit = originalExit
    }
    expect(exitCode).toBe(1)
  })
})
