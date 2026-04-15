import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { runDocs } from '../../src/commands/docs.js'
import { NoCacheError } from '../../src/commands/ensure-checkout.js'

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
      exit: (code: number) => {
        io.exitCode = code
      },
    },
  }
}

let projectDir: string
let checkoutDir: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-docs-proj-'))
  checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-docs-checkout-'))
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(checkoutDir, { recursive: true, force: true })
})

describe('runDocs', () => {
  it('prints only /doc/i subdirs (not the checkout root) when docs exist', async () => {
    fs.mkdirSync(path.join(checkoutDir, 'docs'), { recursive: true })
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

    await runDocs(
      { spec: 'react@18.2.0', projectDir },
      { ensureCheckout, ...deps },
    )

    expect(io.stdout).toContain(path.join(checkoutDir, 'docs'))
    expect(io.stdout).not.toContain(checkoutDir)
    expect(io.exitCode).toBeNull()
  })

  it('emits dist/docs for packages that publish docs there (mastra convention)', async () => {
    const distDocs = path.join(checkoutDir, 'dist', 'docs')
    fs.mkdirSync(distDocs, { recursive: true })
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'mastra-ai',
      repo: 'mastra',
      ref: 'v0.1.0',
      resolvedVersion: '0.1.0',
      checkoutDir,
      npmPackageName: 'mastra',
    }))

    await runDocs(
      { spec: 'mastra', projectDir },
      { ensureCheckout, ...deps },
    )

    expect(io.stdout).toContain(distDocs)
    expect(io.stdout).not.toContain(checkoutDir)
  })

  it('walks node_modules/<pkg>/ for npm specs and emits only /doc/i subdirs', async () => {
    const nm = path.join(projectDir, 'node_modules', 'react')
    fs.mkdirSync(path.join(nm, 'docs'), { recursive: true })
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir,
      npmPackageName: 'react',
    }))

    await runDocs(
      { spec: 'react', projectDir },
      { ensureCheckout, ...deps },
    )

    expect(io.stdout).toContain(path.join(nm, 'docs'))
    expect(io.stdout).not.toContain(nm)
    // checkoutDir has no docs → falls back to root
    expect(io.stdout).toContain(checkoutDir)
  })

  it('does NOT walk node_modules for non-npm specs', async () => {
    // Create a node_modules dir that should be ignored.
    const nm = path.join(projectDir, 'node_modules', 'somepkg')
    fs.mkdirSync(path.join(nm, 'docs'), { recursive: true })
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'main',
      resolvedVersion: 'main',
      checkoutDir,
      // npmPackageName is undefined for github specs
    }))

    await runDocs(
      { spec: 'github:facebook/react', projectDir },
      { ensureCheckout, ...deps },
    )

    // Stdout should contain the checkout root but no node_modules paths.
    expect(io.stdout).toContain(checkoutDir)
    expect(io.stdout.some(p => p.includes('node_modules'))).toBe(false)
  })

  it('skips node_modules walk when npmPackageName has no installed dir', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir,
      npmPackageName: 'react',
    }))

    await runDocs(
      { spec: 'react', projectDir },
      { ensureCheckout, ...deps },
    )

    expect(io.stdout).toContain(checkoutDir)
    expect(io.stdout.some(p => p.includes('node_modules'))).toBe(false)
  })

  it('does NOT walk node_modules of unrelated packages even when node_modules exists', async () => {
    // Set up node_modules with an unrelated package — but NOT 'react'.
    // This proves the npm walk specifically targets `node_modules/<npmPackageName>/`
    // and is not a generic node_modules sweep.
    const otherNm = path.join(projectDir, 'node_modules', 'other-pkg')
    fs.mkdirSync(path.join(otherNm, 'docs'), { recursive: true })
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir,
      npmPackageName: 'react',
    }))

    await runDocs(
      { spec: 'react', projectDir },
      { ensureCheckout, ...deps },
    )

    // Checkout root must be present.
    expect(io.stdout).toContain(checkoutDir)
    // No node_modules path of any kind — react is not installed, other-pkg is unrelated.
    expect(io.stdout.some(p => p.includes('node_modules'))).toBe(false)
  })

  it('still emits checkout root even when there are no doc-like dirs', async () => {
    // checkoutDir is empty — no docs subdir.
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir,
      npmPackageName: 'react',
    }))

    await runDocs(
      { spec: 'react@18.2.0', projectDir },
      { ensureCheckout, ...deps },
    )

    expect(io.stdout[0]).toBe(checkoutDir)
    expect(io.exitCode).toBeNull()
  })

  it('forwards noFetch to ensureCheckout', async () => {
    const { deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir,
      npmPackageName: 'react',
    }))

    await runDocs(
      { spec: 'react', projectDir, noFetch: true },
      { ensureCheckout, ...deps },
    )

    const [opts] = ensureCheckout.mock.calls[0] as any[]
    expect(opts.noFetch).toBe(true)
  })

  it('exits 1 with stderr message on NoCacheError', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => {
      throw new NoCacheError('/cache/facebook__react/v18.2.0', 'react@18.2.0')
    })

    await runDocs(
      { spec: 'react@18.2.0', projectDir, noFetch: true },
      { ensureCheckout, ...deps },
    )

    expect(io.stdout).toEqual([])
    expect(io.stderr.length).toBeGreaterThan(0)
    expect(io.stderr[0]).toContain('no cached checkout')
    expect(io.exitCode).toBe(1)
  })

  it('exits 1 with stderr on resolver error', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => {
      throw new Error('Cannot resolve GitHub repository for npm package')
    })

    await runDocs(
      { spec: 'no-repo', projectDir },
      { ensureCheckout, ...deps },
    )

    expect(io.stderr.length).toBeGreaterThan(0)
    expect(io.exitCode).toBe(1)
  })
})
