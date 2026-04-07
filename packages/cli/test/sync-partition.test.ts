import type { SourceConfig } from '../src/sources/index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runSync } from '../src/index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-sync-test-'))
  fs.mkdirSync(path.join(tmpDir, '.ask'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeConfig(docs: SourceConfig[]): void {
  fs.writeFileSync(
    path.join(tmpDir, '.ask', 'config.json'),
    `${JSON.stringify({ schemaVersion: 1, docs }, null, 2)}\n`,
  )
}

describe('runSync partition + concurrency', () => {
  it('runs github/npm/llms-txt entries through the parallel limiter and web entries serially', async () => {
    const docs: SourceConfig[] = [
      { source: 'github', name: 'a', version: '1.0.0', repo: 'foo/a' },
      { source: 'npm', name: 'b', version: '2.0.0' },
      { source: 'web', name: 'c', version: '3.0.0', urls: ['https://example.com/c'] },
      { source: 'web', name: 'd', version: '4.0.0', urls: ['https://example.com/d'] },
      { source: 'llms-txt', name: 'e', version: '5.0.0', url: 'https://example.com/e.txt' },
    ]
    writeConfig(docs)

    let inFlight = 0
    let maxParallelInFlight = 0
    let maxWebInFlight = 0
    const order: string[] = []

    const result = await runSync(tmpDir, {
      skipAgentsMd: true,
      syncEntryFn: async (_dir, entry) => {
        inFlight++
        if (entry.source === 'web') {
          maxWebInFlight = Math.max(maxWebInFlight, inFlight)
        }
        else {
          maxParallelInFlight = Math.max(maxParallelInFlight, inFlight)
        }
        await new Promise(r => setTimeout(r, 15))
        order.push(entry.name)
        inFlight--
        return 'unchanged'
      },
    })

    expect(result).toEqual({ drifted: 0, unchanged: 5, failed: 0 })
    // 3 parallel-eligible entries (a, b, e) should overlap
    expect(maxParallelInFlight).toBeGreaterThanOrEqual(2)
    // web entries (c, d) must never overlap with each other
    expect(maxWebInFlight).toBe(1)
    // web entries run after the parallel batch in original order
    const webOrder = order.filter(n => n === 'c' || n === 'd')
    expect(webOrder).toEqual(['c', 'd'])
  })

  it('caps parallel concurrency at 5 even with many entries', async () => {
    const docs: SourceConfig[] = Array.from({ length: 12 }, (_, i) => ({
      source: 'github' as const,
      name: `lib${i}`,
      version: '1.0.0',
      repo: `foo/lib${i}`,
    }))
    writeConfig(docs)

    let inFlight = 0
    let maxInFlight = 0
    await runSync(tmpDir, {
      skipAgentsMd: true,
      syncEntryFn: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 15))
        inFlight--
        return 'drifted'
      },
    })
    expect(maxInFlight).toBeLessThanOrEqual(5)
    expect(maxInFlight).toBeGreaterThanOrEqual(2)
  })

  it('catch-and-continue: a single failing entry does not abort the batch', async () => {
    const docs: SourceConfig[] = [
      { source: 'github', name: 'a', version: '1.0.0', repo: 'foo/a' },
      { source: 'github', name: 'b', version: '1.0.0', repo: 'foo/b' },
      { source: 'github', name: 'c', version: '1.0.0', repo: 'foo/c' },
    ]
    writeConfig(docs)

    const result = await runSync(tmpDir, {
      skipAgentsMd: true,
      syncEntryFn: async (_dir, entry) => {
        if (entry.name === 'b')
          return 'failed'
        return 'drifted'
      },
    })
    expect(result).toEqual({ drifted: 2, unchanged: 0, failed: 1 })
  })

  it('returns zero counts for an empty config', async () => {
    writeConfig([])
    const result = await runSync(tmpDir, { skipAgentsMd: true })
    expect(result).toEqual({ drifted: 0, unchanged: 0, failed: 0 })
  })

  it('handles a config with only web entries (all serial)', async () => {
    const docs: SourceConfig[] = [
      { source: 'web', name: 'w1', version: '1.0.0', urls: ['https://example.com/w1'] },
      { source: 'web', name: 'w2', version: '1.0.0', urls: ['https://example.com/w2'] },
      { source: 'web', name: 'w3', version: '1.0.0', urls: ['https://example.com/w3'] },
    ]
    writeConfig(docs)

    let inFlight = 0
    let maxInFlight = 0
    const order: string[] = []
    const result = await runSync(tmpDir, {
      skipAgentsMd: true,
      syncEntryFn: async (_dir, entry) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 10))
        order.push(entry.name)
        inFlight--
        return 'unchanged'
      },
    })
    expect(result.unchanged).toBe(3)
    expect(maxInFlight).toBe(1)
    expect(order).toEqual(['w1', 'w2', 'w3'])
  })
})
