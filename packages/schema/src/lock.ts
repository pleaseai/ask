import { z } from 'zod'

const VersionField = z.string().min(1)

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

/**
 * `tarball` is the canonical recording when ASK fetched the package over the
 * network. It is optional because the local-first reader (added for
 * npm-tarball-docs-20260408) can satisfy the request from
 * `node_modules/<pkg>/<docsPath>` without ever downloading a tarball — in
 * that case `installPath` is recorded instead so the lock still points at a
 * real source on disk. Callers MUST supply at least one of the two; this
 * invariant is enforced in the CLI's lock-entry builder rather than via Zod
 * `refine` because `discriminatedUnion` does not accept ZodEffects branches.
 */
const NpmLockEntry = z.object({
  ...LockEntryBase,
  source: z.literal('npm'),
  tarball: z.string().url().optional(),
  integrity: z.string().regex(
    /^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/,
    'integrity must be a valid Subresource Integrity hash',
  ).optional(),
  installPath: z.string().optional(),
  format: z.enum(['docs', 'intent-skills']).optional(),
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
