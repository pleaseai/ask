import os from 'node:os'
import { describe, expect, it, mock } from 'bun:test'
import { NoCacheError } from '../../src/commands/ensure-checkout.js'
import { buildCspArgs, cspExitCode, runSearch } from '../../src/commands/search.js'

interface CapturedIO {
  stdout: string[]
  stderr: string[]
  exitCode: number | null
}

function makeIo(): { io: CapturedIO, deps: { log: (msg: string) => void, error: (msg: string) => void, exit: (code: number) => void } } {
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

const DIR = '/tmp/ask/github/github.com/facebook/react/v18.2.0'

function okCheckout() {
  return mock(async () => ({
    parsed: { kind: 'npm', pkg: 'react', name: 'react' } as any,
    owner: 'facebook',
    repo: 'react',
    ref: 'v18.2.0',
    resolvedVersion: '18.2.0',
    checkoutDir: DIR,
    npmPackageName: 'react',
  }))
}

describe('buildCspArgs', () => {
  it('puts the path positionally after the query (not a flag)', () => {
    expect(buildCspArgs('how does useState work', DIR, {})).toEqual([
      'search',
      'how does useState work',
      DIR,
    ])
  })

  it('appends --content (repeatable) and --top-k when provided', () => {
    expect(buildCspArgs('q', DIR, { content: ['docs', 'config'], topK: 10 })).toEqual([
      'search',
      'q',
      DIR,
      '--content',
      'docs',
      'config',
      '--top-k',
      '10',
    ])
  })
})

describe('cspExitCode', () => {
  it('forwards a normal exit status', () => {
    expect(cspExitCode({ status: 0 })).toBe(0)
    expect(cspExitCode({ status: 3 })).toBe(3)
  })

  it('maps a signal-killed child to 128 + signum (not 0)', () => {
    const sigkill = os.constants.signals.SIGKILL // 9 on POSIX
    expect(cspExitCode({ status: null, signal: 'SIGKILL' })).toBe(128 + sigkill)
    expect(cspExitCode({ status: null, signal: 'SIGKILL' })).not.toBe(0)
  })

  it('falls back to 0 only when neither status nor signal is present', () => {
    expect(cspExitCode({ status: null })).toBe(0)
  })
})

describe('runSearch', () => {
  it('spawns csp with the built args and forwards its exit code', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = okCheckout()
    const calls: Array<{ bin: string, args: string[] }> = []
    const runCsp = (bin: string, args: string[]) => {
      calls.push({ bin, args })
      return { status: 3 }
    }

    await runSearch(
      { spec: 'react@18.2.0', query: 'reconciler', projectDir: '/proj', topK: 5 },
      { ensureCheckout, resolveCsp: () => '/usr/local/bin/csp', runCsp, ...deps },
    )

    expect(calls).toEqual([
      { bin: '/usr/local/bin/csp', args: ['search', 'reconciler', DIR, '--top-k', '5'] },
    ])
    expect(io.exitCode).toBe(3) // csp exit code forwarded (FR-B4)
  })

  it('reports a signal-killed csp as non-zero (not a bogus 0)', async () => {
    const { io, deps } = makeIo()
    const runCsp = () => ({ status: null, signal: 'SIGKILL' as const })

    await runSearch(
      { spec: 'react', query: 'q', projectDir: '/proj' },
      { ensureCheckout: okCheckout(), resolveCsp: () => '/usr/local/bin/csp', runCsp, ...deps },
    )

    expect(io.exitCode).toBe(128 + os.constants.signals.SIGKILL)
    expect(io.exitCode).not.toBe(0)
  })

  it('degrades gracefully when csp is absent: prints path + recipe, exit 0', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = okCheckout()
    const runCsp = mock(() => ({ status: 0 }))

    await runSearch(
      { spec: 'react@18.2.0', query: 'how does useState work', projectDir: '/proj' },
      { ensureCheckout, resolveCsp: () => null, runCsp, ...deps },
    )

    expect(runCsp).not.toHaveBeenCalled()
    expect(io.stdout[0]).toBe(DIR)
    // recipe is a runnable csp command with the quoted query
    expect(io.stdout[1]).toBe(`csp search "how does useState work" ${DIR}`)
    expect(io.stderr.join(' ')).toContain('csp (code-search) not found')
    expect(io.exitCode).toBe(0) // INV-3: never fail solely because csp is absent
  })

  it('recipe includes --content/--top-k when set', async () => {
    const { io, deps } = makeIo()
    await runSearch(
      { spec: 'react', query: 'q', projectDir: '/proj', content: ['all'], topK: 8 },
      { ensureCheckout: okCheckout(), resolveCsp: () => null, ...deps },
    )
    // quoting rule is uniform: only whitespace tokens are quoted, so a
    // single-word query stays bare while a spaced query/path gets quoted.
    expect(io.stdout[1]).toBe(`csp search q ${DIR} --content all --top-k 8`)
  })

  it('quotes a checkout path containing spaces in the recipe', async () => {
    const { io, deps } = makeIo()
    const spacedDir = '/Users/j doe/.ask/github/github.com/facebook/react/v18.2.0'
    const ensureCheckout = mock(async () => ({
      parsed: { kind: 'npm', pkg: 'react', name: 'react' } as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir: spacedDir,
      npmPackageName: 'react',
    }))

    await runSearch(
      { spec: 'react', query: 'reconciler', projectDir: '/proj' },
      { ensureCheckout, resolveCsp: () => null, ...deps },
    )

    // both the query and the spaced path are quoted → copy-pasteable
    expect(io.stdout[1]).toBe(`csp search reconciler ${JSON.stringify(spacedDir)}`)
  })

  it('exits 1 on cache miss without invoking csp (noFetch)', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => {
      throw new NoCacheError(DIR, 'react@18.2.0')
    })
    const resolveCsp = mock(() => '/usr/local/bin/csp')
    const runCsp = mock(() => ({ status: 0 }))

    await runSearch(
      { spec: 'react@18.2.0', query: 'q', projectDir: '/proj', noFetch: true },
      { ensureCheckout, resolveCsp, runCsp, ...deps },
    )

    expect(runCsp).not.toHaveBeenCalled()
    expect(io.stderr[0]).toContain('no cached checkout')
    expect(io.exitCode).toBe(1)
  })

  it('exits 1 with stderr on resolver error', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => {
      throw new Error('Cannot resolve GitHub repository for npm package \'no-repo\'.')
    })

    await runSearch(
      { spec: 'no-repo', query: 'q', projectDir: '/proj' },
      { ensureCheckout, resolveCsp: () => null, ...deps },
    )

    expect(io.stderr.join(' ')).toContain('Cannot resolve GitHub repository')
    expect(io.exitCode).toBe(1)
  })
})
