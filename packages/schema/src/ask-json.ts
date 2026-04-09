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
const SpecField = z.string().min(1).regex(
  /^[a-z][a-z0-9+-]*:.+$/,
  'spec must start with an ecosystem prefix (e.g. "npm:next", "github:owner/repo")',
)

const GitRefField = z.string().regex(
  /^[\w./-]+$/,
  'ref must contain only [A-Za-z0-9 _ . / -]',
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
  docsPath: z.string().optional(),
}).strict()

/**
 * Entry shape B — standalone github. Version is fixed locally via
 * `ref` and never read from any lockfile. The `ref` field is required:
 * we used to accept `main` as an implicit default, but a missing ref
 * forced users to debug "why is the version `main`" later. Make it
 * explicit.
 */
const StandaloneGithubLibraryEntry = z.object({
  spec: SpecField.regex(/^github:/, 'standalone entries must use github: prefix'),
  ref: GitRefField,
  docsPath: z.string().optional(),
}).strict()

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

export type LibraryEntry = z.infer<typeof LibraryEntrySchema>
export type PmDrivenLibrary = z.infer<typeof PmDrivenLibraryEntry>
export type StandaloneGithubLibrary = z.infer<typeof StandaloneGithubLibraryEntry>

export const AskJsonSchema = z.object({
  libraries: z.array(LibraryEntrySchema),
}).strict()

export type AskJson = z.infer<typeof AskJsonSchema>
