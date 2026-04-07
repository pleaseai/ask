import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { PubResolver } from '../../src/resolvers/pub.js'

describe('PubResolver', () => {
  const resolver = new PubResolver()
  const originalFetch = globalThis.fetch

  beforeEach(() => {
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

  it('resolves a package with pubspec.repository', async () => {
    mockFetchJson({
      latest: {
        version: '2.6.1',
        pubspec: {
          repository: 'https://github.com/rrousselGit/riverpod',
        },
      },
      versions: [{ version: '2.6.1' }, { version: '2.5.0' }],
    })

    const result = await resolver.resolve('riverpod', 'latest')
    expect(result).toEqual({
      repo: 'rrousselGit/riverpod',
      ref: '2.6.1',
      resolvedVersion: '2.6.1',
    })
  })

  it('resolves an explicit version', async () => {
    mockFetchJson({
      latest: {
        version: '2.6.1',
        pubspec: {
          repository: 'https://github.com/rrousselGit/riverpod',
        },
      },
      versions: [{ version: '2.6.1' }, { version: '2.5.0' }],
    })

    const result = await resolver.resolve('riverpod', '2.5.0')
    expect(result).toEqual({
      repo: 'rrousselGit/riverpod',
      ref: '2.5.0',
      resolvedVersion: '2.5.0',
    })
  })

  it('falls back to homepage when repository is missing', async () => {
    mockFetchJson({
      latest: {
        version: '1.0.0',
        pubspec: {
          homepage: 'https://github.com/owner/repo',
        },
      },
    })

    const result = await resolver.resolve('pkg', 'latest')
    expect(result.repo).toBe('owner/repo')
  })

  it('throws when pub.dev returns 404', async () => {
    mockFetchJson({}, 404)
    await expect(resolver.resolve('nonexistent', 'latest')).rejects.toThrow(/404/)
  })

  it('throws when no GitHub URL found', async () => {
    mockFetchJson({
      latest: {
        version: '1.0.0',
        pubspec: {},
      },
    })
    await expect(resolver.resolve('no-repo', 'latest')).rejects.toThrow(/Cannot resolve GitHub/)
  })

  it('throws when requested version does not exist', async () => {
    mockFetchJson({
      latest: {
        version: '1.0.0',
        pubspec: {
          repository: 'https://github.com/owner/repo',
        },
      },
      versions: [{ version: '1.0.0' }],
    })
    await expect(resolver.resolve('pkg', '99.0.0')).rejects.toThrow(/not found/)
  })
})
