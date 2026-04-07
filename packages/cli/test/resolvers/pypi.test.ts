import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { PypiResolver } from '../../src/resolvers/pypi.js'

describe('PypiResolver', () => {
  const resolver = new PypiResolver()
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

  it('resolves a package with project_urls.Source', async () => {
    mockFetchJson({
      info: {
        version: '0.115.0',
        project_urls: {
          Source: 'https://github.com/fastapi/fastapi',
          Documentation: 'https://fastapi.tiangolo.com/',
        },
      },
    })

    const result = await resolver.resolve('fastapi', 'latest')
    expect(result).toEqual({
      repo: 'fastapi/fastapi',
      ref: 'v0.115.0',
      resolvedVersion: '0.115.0',
    })
  })

  it('resolves explicit version via /pypi/<name>/<version>/json', async () => {
    mockFetchJson({
      info: {
        version: '0.110.0',
        project_urls: {
          'Source Code': 'https://github.com/fastapi/fastapi',
        },
      },
    })

    const result = await resolver.resolve('fastapi', '0.110.0')
    expect(result.resolvedVersion).toBe('0.110.0')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://pypi.org/pypi/fastapi/0.110.0/json',
    )
  })

  it('finds repo via Repository key', async () => {
    mockFetchJson({
      info: {
        version: '2.0.0',
        project_urls: {
          Repository: 'https://github.com/pallets/flask',
        },
      },
    })

    const result = await resolver.resolve('flask', 'latest')
    expect(result.repo).toBe('pallets/flask')
  })

  it('falls back to home_page when project_urls has no GitHub link', async () => {
    mockFetchJson({
      info: {
        version: '1.0.0',
        project_urls: {
          Documentation: 'https://docs.example.com',
        },
        home_page: 'https://github.com/owner/repo',
      },
    })

    const result = await resolver.resolve('pkg', 'latest')
    expect(result.repo).toBe('owner/repo')
  })

  it('throws when PyPI returns 404', async () => {
    mockFetchJson({}, 404)
    await expect(resolver.resolve('nonexistent', 'latest')).rejects.toThrow(/404/)
  })

  it('throws when no GitHub URL found', async () => {
    mockFetchJson({
      info: {
        version: '1.0.0',
        project_urls: {
          Documentation: 'https://docs.example.com',
        },
        home_page: 'https://example.com',
      },
    })
    await expect(resolver.resolve('no-gh', 'latest')).rejects.toThrow(/Cannot resolve GitHub/)
  })

  it('throws when project_urls is null', async () => {
    mockFetchJson({
      info: {
        version: '1.0.0',
        project_urls: null,
        home_page: null,
      },
    })
    await expect(resolver.resolve('empty', 'latest')).rejects.toThrow(/Cannot resolve GitHub/)
  })
})
