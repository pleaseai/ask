import { z } from 'zod'

const ContentHashField = z.string().regex(
  /^sha256-[0-9a-f]{64}$/,
  'contentHash must be sha256-<64 hex chars>',
)

const IsoDateTimeField = z.string().datetime({ offset: true })

/**
 * One row in `.ask/resolved.json` — the cache that lets `ask install`
 * short-circuit when nothing has changed (NFR-1, FR-11).
 *
 * `key` (the map key, not in the schema) is the library's slug —
 * `next`, `mastra-core`, etc. — the same string used as the directory
 * under `.ask/docs/` and as the skill dir name.
 */
export const ResolvedEntrySchema = z.object({
  /** The exact spec from `ask.json` (so we can detect spec edits). */
  spec: z.string().min(1),
  /** Resolved version (from lockfile for PM-driven, from `ref` for standalone). */
  resolvedVersion: z.string().min(1),
  /** Hash of the materialized doc files; lets us detect re-fetch needs. */
  contentHash: ContentHashField,
  /** ISO timestamp of the most recent successful fetch. */
  fetchedAt: IsoDateTimeField,
  /** Number of files written under `.ask/docs/<slug>@<ver>/`. */
  fileCount: z.number().int().nonnegative(),
  /** Tracks intent-skills entries separately from materialized docs. */
  format: z.enum(['docs', 'intent-skills']).optional(),
  /** Absolute path to the finalized store entry (when global store is active). */
  storePath: z.string().optional(),
  /**
   * How the docs were materialized:
   *   - `copy` / `link` / `ref` — global store modes (from the store feature).
   *   - `in-place` — referenced directly from `node_modules/<pkg>/<docsPath>`.
   */
  materialization: z.enum(['copy', 'link', 'ref', 'in-place']).optional(),
  /** Project-relative path to docs when materialization is 'in-place' (e.g. node_modules/next/dist/docs). */
  inPlacePath: z.string().optional(),
}).strict()

export type ResolvedEntry = z.infer<typeof ResolvedEntrySchema>

export const ResolvedJsonSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: IsoDateTimeField,
  entries: z.record(z.string(), ResolvedEntrySchema),
}).strict()

export type ResolvedJson = z.infer<typeof ResolvedJsonSchema>
