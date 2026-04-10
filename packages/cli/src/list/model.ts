// ---------------------------------------------------------------------------
// ListModel — typed view of the `ask list` output. Single source of truth
// shared by the text renderer and the JSON emitter.
// ---------------------------------------------------------------------------

import { z } from 'zod'

/**
 * Where the files for a given docs entry actually live. Used by the
 * renderer for the "Location" column and by downstream tooling to
 * distinguish in-place installs from copied tarballs.
 */
export const ListEntrySourceSchema = z.enum([
  'pm-driven',
  'github',
  'unresolved',
])
export type ListEntrySource = z.infer<typeof ListEntrySourceSchema>

/**
 * Lock-entry format. Mirrors `NpmLockEntry.format` from @pleaseai/ask-schema.
 * `docs` = copied/rendered markdown under `.ask/docs/`;
 * `intent-skills` = `<!-- intent-skills:start -->` reference entries in
 * AGENTS.md, no file copy.
 */
export const ListEntryFormatSchema = z.enum(['docs', 'intent-skills'])
export type ListEntryFormat = z.infer<typeof ListEntryFormatSchema>

/** One item inside an intent-skills entry's skill list. */
export const ListSkillSchema = z.object({
  task: z.string(),
  load: z.string(),
  description: z.string().optional(),
})
export type ListSkill = z.infer<typeof ListSkillSchema>

/** One row in the list table. */
export const ListEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  format: ListEntryFormatSchema,
  source: ListEntrySourceSchema,
  location: z.string(),
  /** Number of files under `.ask/docs/<name>@<version>` for docs format. */
  itemCount: z.number().int().nonnegative().optional(),
  /** Skill entries for intent-skills format (omitted for docs). */
  skills: z.array(ListSkillSchema).optional(),
})
export type ListEntry = z.infer<typeof ListEntrySchema>

/** A name-collision across entries (same `name`, differing `version`). */
export const ListConflictSchema = z.object({
  name: z.string(),
  versions: z.array(z.string()).min(2),
})
export type ListConflict = z.infer<typeof ListConflictSchema>

/** Full top-level model consumed by the renderer. */
export const ListModelSchema = z.object({
  entries: z.array(ListEntrySchema),
  conflicts: z.array(ListConflictSchema),
  warnings: z.array(z.string()),
})
export type ListModel = z.infer<typeof ListModelSchema>
