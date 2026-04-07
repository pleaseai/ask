import { z } from 'zod'

const NameField = z.string().min(1)
const VersionField = z.string().min(1)

const GithubSourceConfig = z.object({
  source: z.literal('github'),
  name: NameField,
  version: VersionField,
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be in "owner/name" form'),
  branch: z.string().optional(),
  tag: z.string().optional(),
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
  maxDepth: z.number().int().min(0).default(1),
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
})

export type Config = z.infer<typeof ConfigSchema>

const ContentHashField = z.string().regex(
  /^sha256-[0-9a-f]{64}$/,
  'contentHash must be sha256-<64 hex chars>',
)

const IsoDateTimeField = z.string().datetime({ offset: true })

const LockEntryBase = {
  version: VersionField,
  fetchedAt: IsoDateTimeField,
  fileCount: z.number().int().nonnegative(),
  contentHash: ContentHashField,
}

const GithubLockEntry = z.object({
  ...LockEntryBase,
  source: z.literal('github'),
  repo: z.string(),
  ref: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
})

const NpmLockEntry = z.object({
  ...LockEntryBase,
  source: z.literal('npm'),
  tarball: z.string().url(),
  integrity: z.string().regex(
    /^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/,
    'integrity must be a valid Subresource Integrity hash',
  ),
})

const WebLockEntry = z.object({
  ...LockEntryBase,
  source: z.literal('web'),
  urls: z.array(z.string().url()).min(1),
})

const LlmsTxtLockEntry = z.object({
  ...LockEntryBase,
  source: z.literal('llms-txt'),
  url: z.string().url(),
})

export const LockEntrySchema = z.discriminatedUnion('source', [
  GithubLockEntry,
  NpmLockEntry,
  WebLockEntry,
  LlmsTxtLockEntry,
])

export type LockEntry = z.infer<typeof LockEntrySchema>

export const LockSchema = z.object({
  lockfileVersion: z.literal(1),
  generatedAt: IsoDateTimeField,
  entries: z.record(z.string(), LockEntrySchema),
})

export type Lock = z.infer<typeof LockSchema>
