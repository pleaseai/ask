import type {
  DocSource,
  FetchResult,
  LlmsTxtSourceOptions,
  SourceConfig,
} from './index.js'
import { consola } from 'consola'

export class LlmsTxtSource implements DocSource {
  async fetch(options: SourceConfig): Promise<FetchResult> {
    const opts = options as LlmsTxtSourceOptions
    const url = opts.url

    consola.info(`  Fetching: ${url}`)

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ask-docs/0.1 (documentation downloader)',
        'Accept': 'text/plain, text/markdown',
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
    }

    const content = await response.text()

    if (content.trim().length === 0) {
      throw new Error(`No content found at ${url}`)
    }

    // Determine filename from URL path
    const urlObj = new URL(url)
    const filename = urlObj.pathname.split('/').pop() || 'llms.txt'
    const filePath = filename.endsWith('.md') || filename.endsWith('.txt')
      ? filename
      : `${filename}.md`

    consola.info(`  Fetched: ${url} -> ${filePath} (${content.length} chars)`)

    return {
      files: [{ path: filePath, content }],
      resolvedVersion: opts.version,
    }
  }
}
