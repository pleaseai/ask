import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { NoCacheError } from '../../src/commands/ensure-checkout.js'
import { runSkillsList } from '../../src/commands/skills/list.js'

interface CapturedIO {
  stdout: string[]
  stderr: string[]
  exitCode: number | null
}

function makeIo() {
  const io: CapturedIO = { stdout: [], stderr: [], exitCode: null }
  return {
    io,
    deps: {
      log: (msg: string) => io.stdout.push(msg),
      error: (msg: string) => io.stderr.push(msg),
      exit: (code: number) => { io.exitCode = code },
    },
  }
}

let projectDir: string
let checkoutDir: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-slist-proj-'))
  checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-slist-ck-'))
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(checkoutDir, { recursive: true, force: true })
})

describe('runSkillsList', () => {
  it('prints checkout root and any /skill/i subdirs', async () => {
    fs.mkdirSync(path.join(checkoutDir, 'skills'), { recursive: true })
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: { kind: 'npm', pkg: 'react', name: 'react' } as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir,
      npmPackageName: 'react',
    }))

    await runSkillsList({ spec: 'react@18.2.0', projectDir }, { ensureCheckout, ...deps })

    expect(io.stdout).toContain(checkoutDir)
    expect(io.stdout).toContain(path.join(checkoutDir, 'skills'))
  })

  it('walks node_modules/<pkg>/ when the package is installed locally', async () => {
    const pkgDir = path.join(projectDir, 'node_modules', 'react', 'skills')
    fs.mkdirSync(pkgDir, { recursive: true })
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: { kind: 'npm', pkg: 'react', name: 'react' } as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir,
      npmPackageName: 'react',
    }))

    await runSkillsList({ spec: 'react', projectDir }, { ensureCheckout, ...deps })

    expect(io.stdout).toContain(pkgDir)
  })

  it('exits 1 with NoCacheError message when ensureCheckout throws it', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => {
      throw new NoCacheError('/somewhere', 'react')
    })

    await runSkillsList(
      { spec: 'react', projectDir, noFetch: true },
      { ensureCheckout, ...deps },
    )

    expect(io.exitCode).toBe(1)
    expect(io.stderr.join('\n')).toContain('no cached checkout')
  })

  it('exits 1 on generic resolver failure', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => {
      throw new Error('unsupported ecosystem')
    })
    await runSkillsList({ spec: 'xxx:foo', projectDir }, { ensureCheckout, ...deps })
    expect(io.exitCode).toBe(1)
    expect(io.stderr.join('\n')).toContain('unsupported')
  })
})
