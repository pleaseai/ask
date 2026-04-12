import path from 'node:path'
import { z } from 'zod'

/**
 * Spec strings used inside `ask.json` carry the ecosystem identifier in
 * the prefix:
 *
 *   - PM-driven entries: `npm:next`, `npm:@scope/pkg`
 *     (future: `pypi:`, `pub:`, `crates:`, `go:`, `hex:`, `nuget:`,
 *     `maven:`)
 *   - Standalone github entries: `github:owner/repo`
 *
 * The shape is forward-extensible — adding new ecosystems in follow-up
 * tracks does not require breaking the v1 `ask.json` shape (NFR-4).
 */
const RE_DOCS_PATH_TRAVERSAL = /(?:^|[\\/])\.\.(?:[\\/]|$)/

const SpecField = z.string().min(1).regex(
  /^[a-z][a-z0-9+-]*:.+$/,
  'spec must start with an ecosystem prefix (e.g. "npm:next", "github:owner/repo")',
)

const GitRefField = z.string().regex(
  /^[\w./-]+$/,
  'ref must contain only [A-Za-z0-9 _ . / -]',
)

/**
 * Heuristic for "tag-like" refs that are safe to pin to. Accepts:
 *   - 40-char lowercase hex SHA
 *   - `v?<semver>` (including pre-release and build-metadata suffixes)
 *   - tag-like strings containing at least one `.` or digit
 *
 * Rejects known mutable branches (`main`, `master`, `develop`, `trunk`,
 * `HEAD`, `latest`) and any single-word string without a `.` or digit
 * (e.g. `canary`).
 *
 * The refinement is wrapped in a factory so the CLI can bypass it via
 * `--allow-mutable-ref` by selecting `LaxAskJsonSchema`.
 */
const RE_SHA40 = /^[0-9a-f]{40}$/
const RE_CONTAINS_DIGIT_OR_DOT = /[.\d]/
const MUTABLE_REF_BLOCKLIST = new Set([
  'main',
  'master',
  'develop',
  'trunk',
  'HEAD',
  'latest',
])

function isTagLikeRef(ref: string): boolean {
  if (RE_SHA40.test(ref))
    return true
  if (MUTABLE_REF_BLOCKLIST.has(ref))
    return false
  return RE_CONTAINS_DIGIT_OR_DOT.test(ref)
}

const MUTABLE_REF_MESSAGE
  = 'ref looks like a mutable branch (use a tag, SHA, or pass --allow-mutable-ref to bypass)'

const RE_GITHUB_PREFIX = /^github:/

const StrictGitRefField = GitRefField.refine(
  isTagLikeRef,
  MUTABLE_REF_MESSAGE,
)

/**
 * Entry shape A — PM-driven. Version is resolved from the project's
 * lockfile at `ask install` time. No `ref` field is permitted.
 *
 * Currently only `npm:` ecosystem entries are wired up to a lockfile
 * reader; other prefixes are accepted at the schema layer but cause
 * a warn-and-skip at install time per FR-9.
 */
const PmDrivenLibraryEntry = z.object({
  spec: SpecField.refine(
    s => !s.startsWith('github:'),
    'github: specs must include a `ref` field (standalone entries)',
  ),
  docsPath: z.string()
    .refine(
      p => !path.isAbsolute(p) && !RE_DOCS_PATH_TRAVERSAL.test(p),
      'docsPath must be a relative path without traversal segments',
    )
    .optional(),
}).strict()

/**
 * Build a `StandaloneGithubLibraryEntry` schema parameterized on ref
 * strictness. `strictRefs: true` applies the tag-like refinement;
 * `false` keeps only the base shell-safety regex.
 */
function buildStandaloneGithubLibraryEntry(strictRefs: boolean): z.ZodTypeAny {
  return z.object({
    spec: SpecField.regex(RE_GITHUB_PREFIX, 'standalone entries must use github: prefix'),
    ref: strictRefs ? StrictGitRefField : GitRefField,
    docsPath: z.string()
      .refine(
        p => !path.isAbsolute(p) && !RE_DOCS_PATH_TRAVERSAL.test(p),
        'docsPath must be a relative path without traversal segments',
      )
      .optional(),
  }).strict()
}

/**
 * Entry shape B — standalone github. Version is fixed locally via
 * `ref` and never read from any lockfile. The `ref` field is required:
 * we used to accept `main` as an implicit default, but a missing ref
 * forced users to debug "why is the version `main`" later. Make it
 * explicit.
 *
 * The default export uses strict ref validation. CLI callers that
 * need to accept mutable refs (CI pipelines, test fixtures) should
 * use `LaxAskJsonSchema` via `createAskJsonSchema({ strictRefs: false })`.
 */
const StandaloneGithubLibraryEntry = buildStandaloneGithubLibraryEntry(true)

/**
 * Discriminator: presence of `ref` ⇒ standalone github; absence ⇒
 * PM-driven. We use a `superRefine` rather than `discriminatedUnion`
 * because the discriminator is "field present vs absent", not a tagged
 * value.
 */
export const LibraryEntrySchema = z.union([
  StandaloneGithubLibraryEntry,
  PmDrivenLibraryEntry,
])

const LaxLibraryEntrySchema = z.union([
  buildStandaloneGithubLibraryEntry(false),
  PmDrivenLibraryEntry,
])

export type LibraryEntry = z.infer<typeof LibraryEntrySchema>
export type PmDrivenLibrary = z.infer<typeof PmDrivenLibraryEntry>
export interface StandaloneGithubLibrary {
  spec: string
  ref: string
  docsPath?: string
}

export const StoreModeSchema = z.enum(['copy', 'link', 'ref'])
export type StoreMode = z.infer<typeof StoreModeSchema>

export const AskJsonSchema = z.object({
  libraries: z.array(LibraryEntrySchema),
  emitSkill: z.boolean().optional(),
  storeMode: StoreModeSchema.optional(),
  inPlace: z.boolean().optional(),
}).strict()

export const LaxAskJsonSchema = z.object({
  libraries: z.array(LaxLibraryEntrySchema),
  emitSkill: z.boolean().optional(),
  storeMode: StoreModeSchema.optional(),
  inPlace: z.boolean().optional(),
}).strict()

export type AskJson = z.infer<typeof AskJsonSchema>

/**
 * Factory for the top-level `ask.json` schema. The `strictRefs` option
 * toggles whether standalone github entries enforce the tag-like ref
 * refinement. CLI callers use the factory when `--allow-mutable-ref`
 * is set; all other code paths should import the default
 * `AskJsonSchema` (strict) or `LaxAskJsonSchema` directly.
 */
export interface CreateAskJsonSchemaOptions {
  /** When true (default), rejects mutable refs like `main`/`master`/`HEAD`. */
  strictRefs?: boolean
}

export function createAskJsonSchema(
  options: CreateAskJsonSchemaOptions = {},
): typeof AskJsonSchema | typeof LaxAskJsonSchema {
  const strictRefs = options.strictRefs ?? true
  return strictRefs ? AskJsonSchema : LaxAskJsonSchema
}
