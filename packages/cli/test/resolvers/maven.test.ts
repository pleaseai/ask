import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { MavenResolver } from '../../src/resolvers/maven.js'

describe('MavenResolver', () => {
  const resolver = new MavenResolver()
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = mock() as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockResponse(body: unknown, status = 200) {
    const content = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(content, { status })
  }

  const SEARCH_GUAVA = {
    response: {
      numFound: 1,
      docs: [{ g: 'com.google.guava', a: 'guava', v: '33.4.0-jre' }],
    },
  }

  const SEARCH_GAV_WITH_SCM = {
    response: {
      numFound: 1,
      docs: [{ 'g': 'com.google.guava', 'a': 'guava', 'v': '33.4.0-jre', 'scm.url': 'https://github.com/google/guava' }],
    },
  }

  const SEARCH_GAV_NO_SCM = {
    response: {
      numFound: 1,
      docs: [{ g: 'com.google.guava', a: 'guava', v: '33.4.0-jre' }],
    },
  }

  const POM_WITH_SCM = `<project>
    <url>https://guava.dev</url>
    <scm>
      <url>https://github.com/google/guava</url>
    </scm>
  </project>`

  const POM_WITH_URL_ONLY = `<project>
    <url>https://github.com/google/guava</url>
  </project>`

  const METADATA_XML = `<?xml version="1.0" encoding="UTF-8"?>
    <metadata>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <versioning>
        <release>33.4.0-jre</release>
        <latest>33.4.0-jre</latest>
      </versioning>
    </metadata>`

  /**
   * Mock fetch for the standard resolve flow:
   * (1) Search API for version, (2) extended GAV for scmUrl, (3) POM for repo URL
   */
  function mockStandardFlow(opts: {
    searchResponse?: unknown
    searchStatus?: number
    gavResponse?: unknown
    gavStatus?: number
    pomResponse?: string
    pomStatus?: number
  }) {
    const f = globalThis.fetch as ReturnType<typeof mock>
    // (1) Search API
    f.mockResolvedValueOnce(mockResponse(opts.searchResponse ?? SEARCH_GUAVA, opts.searchStatus))
    // (2) Extended GAV search
    f.mockResolvedValueOnce(mockResponse(opts.gavResponse ?? SEARCH_GAV_NO_SCM, opts.gavStatus))
    // (3) POM XML
    if (opts.pomResponse !== undefined || opts.pomStatus !== undefined) {
      f.mockResolvedValueOnce(mockResponse(opts.pomResponse ?? POM_WITH_SCM, opts.pomStatus))
    }
  }

  describe('Search API scmUrl priority (FR-5)', () => {
    it('uses scmUrl from Search API when available, skips POM', async () => {
      const f = globalThis.fetch as ReturnType<typeof mock>
      // (1) Search API
      f.mockResolvedValueOnce(mockResponse(SEARCH_GUAVA))
      // (2) Extended GAV with scmUrl
      f.mockResolvedValueOnce(mockResponse(SEARCH_GAV_WITH_SCM))
      // POM should NOT be fetched

      const result = await resolver.resolve('com.google.guava:guava', 'latest')
      expect(result.repo).toBe('google/guava')
      expect(result.resolvedVersion).toBe('33.4.0-jre')
      // Only 2 fetch calls (no POM)
      expect(f).toHaveBeenCalledTimes(2)
    })

    it('falls back to POM when scmUrl is absent', async () => {
      mockStandardFlow({ pomResponse: POM_WITH_SCM })

      const result = await resolver.resolve('com.google.guava:guava', 'latest')
      expect(result.repo).toBe('google/guava')
    })
  })

  describe('resolve with Search API + POM', () => {
    it('resolves latest version', async () => {
      mockStandardFlow({ pomResponse: POM_WITH_SCM })

      const result = await resolver.resolve('com.google.guava:guava', 'latest')
      expect(result).toEqual({
        repo: 'google/guava',
        ref: 'v33.4.0-jre',
        fallbackRefs: ['33.4.0-jre'],
        resolvedVersion: '33.4.0-jre',
      })
    })

    it('resolves explicit version', async () => {
      mockStandardFlow({ pomResponse: POM_WITH_SCM })

      const result = await resolver.resolve('com.google.guava:guava', '33.4.0-jre')
      expect(result).toEqual({
        repo: 'google/guava',
        ref: 'v33.4.0-jre',
        fallbackRefs: ['33.4.0-jre'],
        resolvedVersion: '33.4.0-jre',
      })
    })

    it('falls back to <url> when <scm> has no GitHub URL', async () => {
      mockStandardFlow({ pomResponse: POM_WITH_URL_ONLY })

      const result = await resolver.resolve('com.google.guava:guava', 'latest')
      expect(result.repo).toBe('google/guava')
    })

    it('resolves when POM has git+https scm URL', async () => {
      const pomWithGitScm = `<project>
        <scm>
          <url>git+https://github.com/google/guava.git</url>
        </scm>
      </project>`
      mockStandardFlow({ pomResponse: pomWithGitScm })

      const result = await resolver.resolve('com.google.guava:guava', 'latest')
      expect(result.repo).toBe('google/guava')
    })
  })

  describe('Search API unavailable fallback (FR-4, AC-3)', () => {
    it('falls back to maven-metadata.xml + POM when Search API is down for latest', async () => {
      const f = globalThis.fetch as ReturnType<typeof mock>
      // (1) Search API fails
      f.mockResolvedValueOnce(mockResponse({}, 503))
      // (2) maven-metadata.xml
      f.mockResolvedValueOnce(mockResponse(METADATA_XML))
      // (3) POM XML
      f.mockResolvedValueOnce(mockResponse(POM_WITH_SCM))

      const result = await resolver.resolve('com.google.guava:guava', 'latest')
      expect(result.repo).toBe('google/guava')
      expect(result.resolvedVersion).toBe('33.4.0-jre')
    })

    it('uses explicit version directly when Search API is down', async () => {
      const f = globalThis.fetch as ReturnType<typeof mock>
      // (1) Search API fails for explicit version
      f.mockResolvedValueOnce(mockResponse({}, 503))
      // (2) POM XML (skips extended search since Search API failed)
      f.mockResolvedValueOnce(mockResponse(POM_WITH_SCM))

      const result = await resolver.resolve('com.google.guava:guava', '33.4.0-jre')
      expect(result.repo).toBe('google/guava')
      expect(result.resolvedVersion).toBe('33.4.0-jre')
    })
  })

  describe('error handling', () => {
    it('throws on invalid name format (missing colon)', async () => {
      await expect(
        resolver.resolve('guava', 'latest'),
      ).rejects.toThrow('groupId:artifactId')
    })

    it('throws on empty groupId', async () => {
      await expect(
        resolver.resolve(':guava', 'latest'),
      ).rejects.toThrow('groupId:artifactId')
    })

    it('throws when Search API returns 0 results and metadata also fails', async () => {
      const f = globalThis.fetch as ReturnType<typeof mock>
      // (1) Search API returns 0 results → throws → tries metadata fallback
      f.mockResolvedValueOnce(mockResponse({ response: { numFound: 0, docs: [] } }))
      // (2) maven-metadata.xml also fails
      f.mockResolvedValueOnce(mockResponse('Not Found', 404))

      await expect(
        resolver.resolve('com.example:nonexistent', 'latest'),
      ).rejects.toThrow('maven-metadata.xml returned 404')
    })

    it('throws when POM has no GitHub URL', async () => {
      const pomNoGithub = `<project>
        <url>https://example.com</url>
      </project>`
      mockStandardFlow({ pomResponse: pomNoGithub })

      await expect(
        resolver.resolve('com.google.guava:guava', 'latest'),
      ).rejects.toThrow('Cannot resolve GitHub repository')
    })

    it('throws when POM fetch fails and no repo found', async () => {
      mockStandardFlow({ pomResponse: 'Not Found', pomStatus: 404 })

      await expect(
        resolver.resolve('com.google.guava:guava', 'latest'),
      ).rejects.toThrow('Cannot resolve GitHub repository')
    })
  })
})
