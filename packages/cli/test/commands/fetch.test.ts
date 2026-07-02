import type { EnsureCheckoutResult } from '../../src/commands/ensure-checkout.js'
import { describe, expect, it } from 'bun:test'
import { runFetch } from '../../src/commands/fetch.js'

function resultFor(spec: string, fromCache: boolean): EnsureCheckoutResult {
  return {
    parsed: { kind: 'github', owner: 'o', repo: 'r', name: 'r' } as EnsureCheckoutResult['parsed'],
    owner: 'o',
    repo: 'r',
    ref: 'v1.0.0',
    resolvedVersion: '1.0.0',
    checkoutDir: `/store/github/github.com/o/${spec}/v1.0.0`,
    fromCache,
  }
}

interface Capture {
  logs: string[]
  errors: string[]
  exitCodes: number[]
}

function deps(capture: Capture, impl: (spec: string) => Promise<EnsureCheckoutResult>) {
  return {
    ensureCheckout: (opts: { spec: string }) => impl(opts.spec),
    log: (msg: string) => capture.logs.push(msg),
    error: (msg: string) => capture.errors.push(msg),
    exit: (code: number) => capture.exitCodes.push(code),
  }
}

describe('runFetch', () => {
  it('reports fetched and cached specs with a summary', async () => {
    const capture: Capture = { logs: [], errors: [], exitCodes: [] }
    await runFetch(
      { specs: ['a', 'b'], projectDir: '/proj' },
      deps(capture, async spec => resultFor(spec, spec === 'b')),
    )
    expect(capture.logs[0]).toContain('Fetched a@v1.0.0')
    expect(capture.logs[1]).toContain('b@v1.0.0 already cached')
    expect(capture.logs[2]).toBe('\n1 fetched, 1 already cached')
    expect(capture.errors).toEqual([])
    expect(capture.exitCodes).toEqual([])
  })

  it('suppresses progress output with quiet but keeps errors', async () => {
    const capture: Capture = { logs: [], errors: [], exitCodes: [] }
    await runFetch(
      { specs: ['a', 'bad'], projectDir: '/proj', quiet: true },
      deps(capture, async (spec) => {
        if (spec === 'bad')
          throw new Error('resolver blew up')
        return resultFor(spec, false)
      }),
    )
    expect(capture.logs).toEqual([])
    expect(capture.errors).toEqual(['  ✗ bad: resolver blew up'])
    expect(capture.exitCodes).toEqual([1])
  })

  it('continues after a failing spec and exits non-zero at the end', async () => {
    const capture: Capture = { logs: [], errors: [], exitCodes: [] }
    await runFetch(
      { specs: ['bad', 'a'], projectDir: '/proj' },
      deps(capture, async (spec) => {
        if (spec === 'bad')
          throw new Error('boom')
        return resultFor(spec, false)
      }),
    )
    expect(capture.errors).toEqual(['  ✗ bad: boom'])
    // The good spec after the failure still ran and is summarized.
    expect(capture.logs.at(-1)).toBe('\n1 fetched')
    expect(capture.exitCodes).toEqual([1])
  })

  it('prints no summary when nothing was processed', async () => {
    const capture: Capture = { logs: [], errors: [], exitCodes: [] }
    await runFetch(
      { specs: [], projectDir: '/proj' },
      deps(capture, async spec => resultFor(spec, false)),
    )
    expect(capture.logs).toEqual([])
    expect(capture.exitCodes).toEqual([])
  })
})
