import { GithubSource } from './github.js'
import { LlmsTxtSource } from './llms-txt.js'
import { NpmSource } from './npm.js'
import { WebSource } from './web.js'

export interface DocFile {
  path: string
  content: string
}

export interface FetchResult {
  files: DocFile[]
  resolvedVersion: string
  /** Source-specific metadata propagated to ask.lock */
  meta?: {
    /** GitHub commit sha (40 hex chars) */
    commit?: string
    /** GitHub ref used (tag name or branch name) */
    ref?: string
    /** npm Subresource Integrity hash from dist.integrity */
    integrity?: string
    /** npm tarball URL */
    tarball?: string
    /** web/llms-txt source URL(s) */
    urls?: string[]
  }
}

export interface DocSourceOptions {
  name: string
  version: string
}

export interface NpmSourceOptions extends DocSourceOptions {
  source: 'npm'
  package?: string
  docsPath?: string
}

export interface GithubSourceOptions extends DocSourceOptions {
  source: 'github'
  repo: string
  branch?: string
  tag?: string
  docsPath?: string
}

export interface WebSourceOptions extends DocSourceOptions {
  source: 'web'
  urls: string[]
  maxDepth?: number
  allowedPathPrefix?: string
}

export interface LlmsTxtSourceOptions extends DocSourceOptions {
  source: 'llms-txt'
  url: string
}

export type SourceConfig
  = | NpmSourceOptions
    | GithubSourceOptions
    | WebSourceOptions
    | LlmsTxtSourceOptions

export interface DocSource {
  fetch: (options: SourceConfig) => Promise<FetchResult>
}

const sources: Record<string, DocSource> = {
  'npm': new NpmSource(),
  'github': new GithubSource(),
  'web': new WebSource(),
  'llms-txt': new LlmsTxtSource(),
}

export function getSource(type: string): DocSource {
  const source = sources[type]
  if (!source) {
    throw new Error(
      `Unknown source type: ${type}. Available: ${Object.keys(sources).join(', ')}`,
    )
  }
  return source
}
