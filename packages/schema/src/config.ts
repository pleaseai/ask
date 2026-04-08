import { z } from 'zod'

const NameField = z.string().min(1)
const VersionField = z.string().min(1)

// Git ref names must match a conservative subset to prevent shell-injection or
// path-traversal style mischief — git itself permits broader characters but
// the ASK lockfile only needs alphanumerics, dot, slash, underscore, hyphen.
const GitRefField = z.string().regex(
  /^[\w./-]+$/,
  'git ref must contain only [A-Za-z0-9 _ . / -]',
)

const GithubSourceConfig = z.object({
  source: z.literal('github'),
  name: NameField,
  version: VersionField,
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be in "owner/name" form'),
  branch: GitRefField.optional(),
  tag: GitRefField.optional(),
  docsPath: z.string().optional(),
})

const NpmSourceConfig = z.object({
  source: z.literal('npm'),
  name: NameField,
  version: VersionField,
  package: z.string().optional(),
  docsPath: z.string().optional(),
})

const WebSourceConfig = z.object({
  source: z.literal('web'),
  name: NameField,
  version: VersionField,
  urls: z.array(z.string().url()).min(1),
  maxDepth: z.number().int().min(0).optional(),
  allowedPathPrefix: z.string().optional(),
})

const LlmsTxtSourceConfig = z.object({
  source: z.literal('llms-txt'),
  name: NameField,
  version: VersionField,
  url: z.string().url(),
})

export const SourceConfigSchema = z.discriminatedUnion('source', [
  GithubSourceConfig,
  NpmSourceConfig,
  WebSourceConfig,
  LlmsTxtSourceConfig,
])

export type SourceConfig = z.infer<typeof SourceConfigSchema>

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1),
  docs: z.array(SourceConfigSchema),
  manageIgnores: z.boolean().optional(),
})

export type Config = z.infer<typeof ConfigSchema>
