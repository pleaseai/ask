import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { NoCacheError } from '../../src/commands/ensure-checkout.js'
import {
  CandidateGatheringError,
  gatherDocsCandidates,
} from '../../src/discovery/candidates.js'

let projectDir: string
let checkoutDir: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-candidates-proj-'))
  checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-candidates-checkout-'))
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(checkoutDir, { recursive: true, force: true })
})

describe('gatherDocsCandidates', () => {
  it('returns both npm and checkout groups for an npm spec with local install and cached checkout', async () => {
    const nm = path.join(projectDir, 'node_modules', 'react')
    fs.mkdirSync(path.join(nm, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(checkoutDir, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(checkoutDir, 'api-docs'), { recursive: true })

    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir,
      npmPackageName: 'react',
    }))

    const groups = await gatherDocsCandidates('npm:react', projectDir, { ensureCheckout })

    expect(groups).toHaveLength(2)
    expect(groups[0]!.root).toBe(nm)
    expect(groups[0]!.paths).toContain(path.join(nm, 'docs'))
    expect(groups[1]!.root).toBe(checkoutDir)
    expect(groups[1]!.paths).toContain(path.join(checkoutDir, 'docs'))
    expect(groups[1]!.paths).toContain(path.join(checkoutDir, 'api-docs'))
  })

  it('omits the npm group when the package is not installed locally', async () => {
    fs.mkdirSync(path.join(checkoutDir, 'docs'), { recursive: true })

    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir,
      npmPackageName: 'react',
    }))

    const groups = await gatherDocsCandidates('npm:react', projectDir, { ensureCheckout })

    expect(groups).toHaveLength(1)
    expect(groups[0]!.root).toBe(checkoutDir)
  })

  it('omits the npm group for github specs (no npm prefix)', async () => {
    fs.mkdirSync(path.join(checkoutDir, 'docs'), { recursive: true })

    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'main',
      resolvedVersion: 'main',
      checkoutDir,
    }))

    const groups = await gatherDocsCandidates('github:facebook/react', projectDir, {
      ensureCheckout,
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]!.root).toBe(checkoutDir)
  })

  it('falls back to [root] per group when no doc-like subdirs exist', async () => {
    const ensureCheckout = mock(async () => ({
      parsed: {} as any,
      owner: 'facebook',
      repo: 'react',
      ref: 'v18.2.0',
      resolvedVersion: '18.2.0',
      checkoutDir,
      npmPackageName: 'react',
    }))

    const groups = await gatherDocsCandidates('npm:react', projectDir, { ensureCheckout })

    expect(groups).toHaveLength(1) // npm group skipped (no install)
    expect(groups[0]!.paths).toEqual([checkoutDir])
  })

  it('silently omits the checkout group on NoCacheError', async () => {
    const nm = path.join(projectDir, 'node_modules', 'react')
    fs.mkdirSync(path.join(nm, 'docs'), { recursive: true })

    const ensureCheckout = mock(async () => {
      throw new NoCacheError('/cache/miss', 'react')
    })

    const groups = await gatherDocsCandidates('npm:react', projectDir, { ensureCheckout })

    // node_modules group is still probed; checkout group is absent.
    expect(groups).toHaveLength(1)
    expect(groups[0]!.root).toBe(nm)
  })

  it('returns an empty array when neither node_modules nor the cache has anything', async () => {
    const ensureCheckout = mock(async () => {
      throw new NoCacheError('/cache/miss', 'react')
    })

    const groups = await gatherDocsCandidates('npm:react', projectDir, { ensureCheckout })

    expect(groups).toEqual([])
  })

  it('wraps unexpected errors in CandidateGatheringError', async () => {
    const ensureCheckout = mock(async () => {
      throw new Error('malformed ecosystem')
    })

    let caught: unknown
    try {
      await gatherDocsCandidates('npm:react', projectDir, { ensureCheckout })
    }
    catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CandidateGatheringError)
    expect((caught as CandidateGatheringError).spec).toBe('npm:react')
  })
})
