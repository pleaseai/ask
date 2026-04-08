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

  /**
   * Mock sequential fetch calls: first Search API, then POM XML.
   */
  function mockSearchAndPom(searchData: unknown, pomXml: string, searchStatus = 200, pomStatus = 200) {
    ;(globalThis.fetch as ReturnType<typeof mock>)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(searchData), { status: searchStatus }),
      )
      .mockResolvedValueOnce(
        new Response(pomXml, { status: pomStatus }),
      )
  }

  function mockSearchOnly(searchData: unknown, status = 200) {
    ;(globalThis.fetch as ReturnType<typeof mock>)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(searchData), { status }),
      )
  }

  const SEARCH_GUAVA = {
    response: {
      numFound: 1,
      docs: [{
        g: 'com.google.guava',
        a: 'guava',
        v: '33.4.0-jre',
      }],
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

  describe('resolve with Search API + POM', () => {
    it('resolves latest version', async () => {
      mockSearchAndPom(SEARCH_GUAVA, POM_WITH_SCM)

      const result = await resolver.resolve('com.google.guava:guava', 'latest')
      expect(result).toEqual({
        repo: 'google/guava',
        ref: 'v33.4.0-jre',
        fallbackRefs: ['33.4.0-jre'],
        resolvedVersion: '33.4.0-jre',
      })
    })

    it('resolves explicit version', async () => {
      mockSearchAndPom(SEARCH_GUAVA, POM_WITH_SCM)

      const result = await resolver.resolve('com.google.guava:guava', '33.4.0-jre')
      expect(result).toEqual({
        repo: 'google/guava',
        ref: 'v33.4.0-jre',
        fallbackRefs: ['33.4.0-jre'],
        resolvedVersion: '33.4.0-jre',
      })
    })

    it('falls back to <url> when <scm> has no GitHub URL', async () => {
      mockSearchAndPom(SEARCH_GUAVA, POM_WITH_URL_ONLY)

      const result = await resolver.resolve('com.google.guava:guava', 'latest')
      expect(result.repo).toBe('google/guava')
    })
  })

  describe('POM fallback', () => {
    it('resolves when Search API succeeds but POM is primary repo source', async () => {
      const pomWithGitScm = `<project>
        <scm>
          <url>git+https://github.com/google/guava.git</url>
        </scm>
      </project>`
      mockSearchAndPom(SEARCH_GUAVA, pomWithGitScm)

      const result = await resolver.resolve('com.google.guava:guava', 'latest')
      expect(result.repo).toBe('google/guava')
    })

    it('throws when POM has no GitHub URL', async () => {
      const pomNoGithub = `<project>
        <url>https://example.com</url>
      </project>`
      mockSearchAndPom(SEARCH_GUAVA, pomNoGithub)

      await expect(
        resolver.resolve('com.google.guava:guava', 'latest'),
      ).rejects.toThrow('Cannot resolve GitHub repository')
    })

    it('throws when POM fetch fails and no repo found', async () => {
      mockSearchOnly(SEARCH_GUAVA)
      ;(globalThis.fetch as ReturnType<typeof mock>)
        .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

      await expect(
        resolver.resolve('com.google.guava:guava', 'latest'),
      ).rejects.toThrow('Cannot resolve GitHub repository')
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

    it('throws when Search API returns 0 results', async () => {
      mockSearchOnly({ response: { numFound: 0, docs: [] } })

      await expect(
        resolver.resolve('com.example:nonexistent', 'latest'),
      ).rejects.toThrow('not found')
    })

    it('throws when Search API returns non-200', async () => {
      mockSearchOnly({}, 500)

      await expect(
        resolver.resolve('com.google.guava:guava', 'latest'),
      ).rejects.toThrow('500')
    })
  })
})
