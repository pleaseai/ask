import { describe, expect, it, mock } from 'bun:test'
import { NoCacheError } from '../../src/commands/ensure-checkout.js'
import { runSrc } from '../../src/commands/src.js'

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

describe('runSrc', () => {
  it('prints the checkout path to stdout on success', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: { kind: 'npm', pkg: 'react', name: 'react' } as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir: '/tmp/ask/github/github.com/facebook/react/v18.2.0',
      npmPackageName: 'react',
    }))

    await runSrc(
      { spec: 'react@18.2.0', projectDir: '/proj' },
      { ensureCheckout, ...deps },
    )

    expect(io.stdout).toEqual(['/tmp/ask/github/github.com/facebook/react/v18.2.0'])
    expect(io.stderr).toEqual([])
    expect(io.exitCode).toBeNull()
  })

  it('forwards spec, projectDir, and noFetch=undefined to ensureCheckout', async () => {
    const { deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: { kind: 'npm', pkg: 'react', name: 'react' } as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir: '/cache/facebook__react/v18.2.0',
    }))

    await runSrc(
      { spec: 'react@18.2.0', projectDir: '/proj' },
      { ensureCheckout, ...deps },
    )

    expect(ensureCheckout).toHaveBeenCalledTimes(1)
    const [opts] = ensureCheckout.mock.calls[0] as any[]
    expect(opts.spec).toBe('react@18.2.0')
    expect(opts.projectDir).toBe('/proj')
    expect(opts.noFetch).toBeUndefined()
  })

  it('forwards noFetch=true to ensureCheckout when --no-fetch passed', async () => {
    const { deps } = makeIo()
    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir: '/cache/facebook__react/v18.2.0',
    }))

    await runSrc(
      { spec: 'react@18.2.0', projectDir: '/proj', noFetch: true },
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

    await runSrc(
      { spec: 'react@18.2.0', projectDir: '/proj', noFetch: true },
      { ensureCheckout, ...deps },
    )

    expect(io.stdout).toEqual([])
    expect(io.stderr.length).toBeGreaterThan(0)
    expect(io.stderr[0]).toContain('no cached checkout')
    expect(io.stderr[0]).toContain('react@18.2.0')
    expect(io.exitCode).toBe(1)
  })

  it('exits 1 with stderr message on resolver error', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => {
      throw new Error(
        'Cannot resolve GitHub repository for npm package \'no-repo\'. '
        + 'The \'repository\' field is missing or not a GitHub URL.',
      )
    })

    await runSrc(
      { spec: 'no-repo', projectDir: '/proj' },
      { ensureCheckout, ...deps },
    )

    expect(io.stdout).toEqual([])
    expect(io.stderr.length).toBeGreaterThan(0)
    expect(io.stderr.join(' ')).toContain('Cannot resolve GitHub repository')
    expect(io.exitCode).toBe(1)
  })

  it('exits 1 with stderr on unknown ecosystem error', async () => {
    const { io, deps } = makeIo()
    const ensureCheckout = mock(async () => {
      throw new Error('unsupported ecosystem \'haskell\' for spec \'haskell:lens\'')
    })

    await runSrc(
      { spec: 'haskell:lens', projectDir: '/proj' },
      { ensureCheckout, ...deps },
    )

    expect(io.stderr.join(' ')).toMatch(/unsupported ecosystem/)
    expect(io.exitCode).toBe(1)
  })
})
