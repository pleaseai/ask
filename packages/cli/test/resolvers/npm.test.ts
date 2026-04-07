import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { NpmResolver } from '../../src/resolvers/npm.js'

describe('NpmResolver', () => {
  const resolver = new NpmResolver()
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    // Mock global fetch
    globalThis.fetch = mock() as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetchJson(data: unknown, status = 200) {
    ;(globalThis.fetch as ReturnType<typeof mock>).mockResolvedValue(
      new Response(JSON.stringify(data), { status }),
    )
  }

  it('resolves a package with dist-tag "latest"', async () => {
    mockFetchJson({
      'repository': { type: 'git', url: 'git+https://github.com/lodash/lodash.git' },
      'dist-tags': { latest: '4.17.21' },
      'versions': { '4.17.21': {} },
    })

    const result = await resolver.resolve('lodash', 'latest')
    expect(result).toEqual({
      repo: 'lodash/lodash',
      ref: 'v4.17.21',
      resolvedVersion: '4.17.21',
    })
  })

  it('resolves an explicit version', async () => {
    mockFetchJson({
      'repository': { url: 'https://github.com/colinhacks/zod.git' },
      'dist-tags': { latest: '3.23.8' },
      'versions': { '3.22.4': {}, '3.23.8': {} },
    })

    const result = await resolver.resolve('zod', '3.22.4')
    expect(result).toEqual({
      repo: 'colinhacks/zod',
      ref: 'v3.22.4',
      resolvedVersion: '3.22.4',
    })
  })

  it('resolves a string-form repository field', async () => {
    mockFetchJson({
      'repository': 'https://github.com/expressjs/express',
      'dist-tags': { latest: '5.0.0' },
      'versions': { '5.0.0': {} },
    })

    const result = await resolver.resolve('express', 'latest')
    expect(result.repo).toBe('expressjs/express')
  })

  it('throws when npm returns 404', async () => {
    mockFetchJson({}, 404)
    await expect(resolver.resolve('nonexistent', 'latest')).rejects.toThrow(/404/)
  })

  it('throws when repository field is missing', async () => {
    mockFetchJson({
      'dist-tags': { latest: '1.0.0' },
      'versions': { '1.0.0': {} },
    })
    await expect(resolver.resolve('no-repo', 'latest')).rejects.toThrow(/Cannot resolve GitHub/)
  })

  it('throws when repository is not a GitHub URL', async () => {
    mockFetchJson({
      'repository': { url: 'https://gitlab.com/owner/repo.git' },
      'dist-tags': { latest: '1.0.0' },
      'versions': { '1.0.0': {} },
    })
    await expect(resolver.resolve('gitlab-pkg', 'latest')).rejects.toThrow(/Cannot resolve GitHub/)
  })

  it('throws when version not found in versions object', async () => {
    mockFetchJson({
      'repository': { url: 'https://github.com/owner/repo.git' },
      'dist-tags': { latest: '1.0.0' },
      'versions': { '1.0.0': {} },
    })
    await expect(resolver.resolve('pkg', '99.99.99')).rejects.toThrow(/not found/)
  })
})
