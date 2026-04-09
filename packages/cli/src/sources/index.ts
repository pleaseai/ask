import { GithubSource } from './github.js'
import { LlmsTxtSource } from './llms-txt.js'
import { NpmSource } from './npm.js'
import { WebSource } from './web.js'

/**
 * CLI-internal source-adapter input. The pre-refactor codebase derived
 * this from a Zod schema, but with `.ask/config.json` gone the Zod
 * surface served only as a shape for the adapters — there is no
 * persisted JSON to validate. A plain TS union is now sufficient and
 * keeps the schema package focused on `ask.json` / `resolved.json`.
 */
export interface NpmSourceOptions {
  source: 'npm'
  name: string
  version: string
  package?: string
  docsPath?: string
}

export interface GithubSourceOptions {
  source: 'github'
  name: string
  version: string
  repo: string
  branch?: string
  tag?: string
  docsPath?: string
}

export interface WebSourceOptions {
  source: 'web'
  name: string
  version: string
  urls: string[]
  maxDepth?: number
  allowedPathPrefix?: string
}

export interface LlmsTxtSourceOptions {
  source: 'llms-txt'
  name: string
  version: string
  url: string
}

export type SourceConfig
  = | NpmSourceOptions
    | GithubSourceOptions
    | WebSourceOptions
    | LlmsTxtSourceOptions

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
    /** npm tarball URL (omitted for local-`node_modules` reads) */
    tarball?: string
    /** Absolute path to the local `node_modules/<pkg>` dir when read locally */
    installPath?: string
    /** web/llms-txt source URL(s) */
    urls?: string[]
  }
}

export interface DocSource {
  fetch: (options: SourceConfig) => Promise<FetchResult>
}

type SourceKind = SourceConfig['source']

const sources: Record<SourceKind, DocSource> = {
  'npm': new NpmSource(),
  'github': new GithubSource(),
  'web': new WebSource(),
  'llms-txt': new LlmsTxtSource(),
}

export function getSource(type: SourceKind): DocSource {
  return sources[type]
}
