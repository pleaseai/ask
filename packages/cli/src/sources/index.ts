import type { SourceConfig } from '../schemas.js'
import { GithubSource } from './github.js'
import { LlmsTxtSource } from './llms-txt.js'
import { NpmSource } from './npm.js'
import { WebSource } from './web.js'

export type { SourceConfig }

// Re-export per-source variants as Extract<> aliases over the Zod-inferred
// union. This makes the Zod schema in `../schemas.ts` the single source of
// truth for runtime invariants — the CLI cannot construct a SourceConfig
// that satisfies the type but fails Zod validation downstream.
export type NpmSourceOptions = Extract<SourceConfig, { source: 'npm' }>
export type GithubSourceOptions = Extract<SourceConfig, { source: 'github' }>
export type WebSourceOptions = Extract<SourceConfig, { source: 'web' }>
export type LlmsTxtSourceOptions = Extract<SourceConfig, { source: 'llms-txt' }>

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
