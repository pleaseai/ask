import { describe, expect, it } from 'bun:test'
import { runWithConcurrency } from '../src/concurrency.js'

describe('runWithConcurrency', () => {
  it('returns empty array for empty input without invoking fn', async () => {
    let calls = 0
    const result = await runWithConcurrency<number, number>([], 5, async (n) => {
      calls++
      return n * 2
    })
    expect(result).toEqual([])
    expect(calls).toBe(0)
  })

  it('preserves input order in results regardless of completion order', async () => {
    const items = [10, 20, 30, 40, 50]
    // First item resolves last; last item resolves first
    const result = await runWithConcurrency(items, 5, async (n, _i) => {
      const delay = (60 - n) // 50, 40, 30, 20, 10
      await new Promise(r => setTimeout(r, delay))
      return n * 2
    })
    expect(result).toEqual([20, 40, 60, 80, 100])
  })

  it('handles single item', async () => {
    const result = await runWithConcurrency([42], 5, async n => n + 1)
    expect(result).toEqual([43])
  })

  it('with limit=1 runs strictly serially', async () => {
    const order: number[] = []
    let inFlight = 0
    let maxInFlight = 0
    await runWithConcurrency([1, 2, 3, 4], 1, async (n) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      order.push(n)
      inFlight--
      return n
    })
    expect(maxInFlight).toBe(1)
    expect(order).toEqual([1, 2, 3, 4])
  })

  it('respects the concurrency limit when fn is slow', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await runWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async (n) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 10))
      inFlight--
      return n
    })
    expect(maxInFlight).toBe(3)
  })

  it('treats limit <= 0 as unbounded', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await runWithConcurrency([1, 2, 3, 4, 5], 0, async (n) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return n
    })
    expect(maxInFlight).toBe(5)
  })

  it('caps effective concurrency at items.length', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await runWithConcurrency([1, 2], 100, async (n) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return n
    })
    expect(maxInFlight).toBe(2)
  })

  it('propagates fn errors to the caller', async () => {
    await expect(
      runWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2)
          throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })
})
