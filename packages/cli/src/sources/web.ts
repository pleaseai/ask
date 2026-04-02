import type {
  DocFile,
  DocSource,
  FetchResult,
  SourceConfig,
  WebSourceOptions,
} from './index.js'
import { consola } from 'consola'
import { NodeHtmlMarkdown } from 'node-html-markdown'

/* eslint-disable regexp/no-unused-capturing-group -- all capturing groups accessed via match[1] */
const RE_MAIN = /<main[^>]*>([\s\S]*?)<\/main>/i
const RE_ARTICLE = /<article[^>]*>([\s\S]*?)<\/article>/i
const RE_CONTENT_DIV = /<div[^>]*class="[^"]*(?:content|docs|documentation)[^"]*"[^>]*>([\s\S]*?)<\/div>/i
const RE_BODY = /<body[^>]*>([\s\S]*?)<\/body>/i
const RE_HREF = /href="([^"]+)"/g
const RE_SKIP_EXT = /\.(png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2|ttf|eot)$/i
const RE_SKIP_PATH = /\/(api|auth|login|signup|search)\/?$/i
/* eslint-enable regexp/no-unused-capturing-group */
const RE_TRAILING_SLASH = /\/$/
const RE_LEADING_SLASH = /^\//

export class WebSource implements DocSource {
  private nhm = new NodeHtmlMarkdown()

  async fetch(options: SourceConfig): Promise<FetchResult> {
    const opts = options as WebSourceOptions
    const maxDepth = opts.maxDepth ?? 1
    const visited = new Set<string>()
    const files: DocFile[] = []

    for (const startUrl of opts.urls) {
      await this.crawl(startUrl, startUrl, maxDepth, 0, visited, files, opts)
    }

    if (files.length === 0) {
      throw new Error(
        `No documentation content found from URLs: ${opts.urls.join(', ')}`,
      )
    }

    return { files, resolvedVersion: opts.version }
  }

  private async crawl(
    url: string,
    baseUrl: string,
    maxDepth: number,
    currentDepth: number,
    visited: Set<string>,
    files: DocFile[],
    opts: WebSourceOptions,
  ): Promise<void> {
    const normalized = this.normalizeUrl(url)
    if (visited.has(normalized))
      return
    visited.add(normalized)

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'ask-docs/0.1 (documentation downloader)',
          'Accept': 'text/html',
        },
      })

      if (!response.ok) {
        consola.warn(`  Warning: ${url} returned ${response.status}, skipping`)
        return
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/html'))
        return

      const html = await response.text()
      const markdown = this.htmlToMarkdown(html, url)

      if (markdown.trim().length > 0) {
        const filePath = this.urlToFilePath(url, baseUrl)
        files.push({ path: filePath, content: markdown })
        consola.info(`  Fetched: ${url} -> ${filePath}`)
      }

      // Crawl linked pages if depth allows
      if (currentDepth < maxDepth) {
        const links = this.extractLinks(html, url, baseUrl, opts)
        for (const link of links) {
          await this.crawl(
            link,
            baseUrl,
            maxDepth,
            currentDepth + 1,
            visited,
            files,
            opts,
          )
        }
      }
    }
    catch (err) {
      consola.warn(`  Warning: Failed to fetch ${url}: ${err}`)
    }
  }

  private htmlToMarkdown(html: string, url: string): string {
    const mainContent = this.extractMainContent(html)
    const markdown = this.nhm.translate(mainContent)
    return `<!-- Source: ${url} -->\n\n${markdown}`
  }

  private extractMainContent(html: string): string {
    const patterns = [RE_MAIN, RE_ARTICLE, RE_CONTENT_DIV, RE_BODY]

    for (const pattern of patterns) {
      const match = html.match(pattern)
      if (match)
        return match[1]
    }

    return html
  }

  private extractLinks(
    html: string,
    currentUrl: string,
    baseUrl: string,
    opts: WebSourceOptions,
  ): string[] {
    const links: string[] = []
    const base = new URL(baseUrl)

    for (const match of html.matchAll(RE_HREF)) {
      try {
        const resolved = new URL(match[1], currentUrl)

        // Only follow same-origin links
        if (resolved.origin !== base.origin)
          continue

        // Filter by path prefix if specified
        if (opts.allowedPathPrefix) {
          if (!resolved.pathname.startsWith(opts.allowedPathPrefix))
            continue
        }
        else {
          // Default: stay within the base URL's path
          const basePath = new URL(baseUrl).pathname
          if (!resolved.pathname.startsWith(basePath))
            continue
        }

        // Skip non-doc links
        if (this.isSkippableUrl(resolved.pathname))
          continue

        // Remove hash and query
        resolved.hash = ''
        resolved.search = ''

        links.push(resolved.toString())
      }
      catch {
        // Invalid URL, skip
      }
    }

    return links
  }

  private isSkippableUrl(pathname: string): boolean {
    return RE_SKIP_EXT.test(pathname) || RE_SKIP_PATH.test(pathname)
  }

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url)
      u.hash = ''
      u.search = ''
      u.pathname = u.pathname.replace(RE_TRAILING_SLASH, '') || '/'
      return u.toString()
    }
    catch {
      return url
    }
  }

  private urlToFilePath(url: string, baseUrl: string): string {
    const u = new URL(url)
    const base = new URL(baseUrl)

    let relativePath = u.pathname.replace(base.pathname, '').replace(RE_LEADING_SLASH, '')
    if (!relativePath)
      relativePath = 'index'

    relativePath = relativePath.replace(RE_TRAILING_SLASH, '')
    if (!relativePath.endsWith('.md')) {
      relativePath += '.md'
    }

    return relativePath
  }
}
