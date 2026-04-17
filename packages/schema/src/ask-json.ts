import { z } from 'zod'

/**
 * Spec strings used inside `ask.json` carry the ecosystem identifier in
 * the prefix:
 *
 *   - PM-driven entries: `npm:next`, `npm:@scope/pkg`
 *   - Standalone github entries: `github:owner/repo@v1.2.3`
 *
 * In the lazy-first architecture, `ask.json` is a simple declaration of
 * which libraries to reference. Version resolution happens at `ask install`
 * time via lockfiles (npm) or inline `@ref` suffix (github). Documentation
 * is accessed on-demand via `ask src` / `ask docs` commands.
 */
const SpecString = z.string().min(1).regex(
  /^[a-z][a-z0-9+-]*:.+$/,
  'spec must start with an ecosystem prefix (e.g. "npm:next", "github:owner/repo@v1.2.3")',
)

/**
 * Object form of a library entry — used ONLY when the user has selected
 * a subset of candidate documentation paths at `ask add` time. When no
 * override is needed, entries stay as plain spec strings so existing
 * `ask.json` files render unchanged on disk.
 *
 * `docsPaths` is required and non-empty in this shape: an empty
 * override would be indistinguishable from the default behavior, so the
 * canonical form for "no override" is the bare string, not an object
 * with an empty array.
 *
 * Paths are stored relative to their discovery root — either
 * `node_modules/<pkg>/` (for npm specs with a local install) or the
 * cached git checkout (`<askHome>/github/<host>/<owner>/<repo>/<ref>/`).
 * This keeps the entry portable across machines and cache wipes.
 */
const LibraryEntryObjectSchema = z.object({
  spec: SpecString,
  docsPaths: z.array(z.string().min(1)).nonempty(),
}).strict()

/**
 * A library entry is either a plain spec string (canonical form when
 * there is no docs-path override) or an object carrying a non-empty
 * `docsPaths` subset selected by the user.
 */
export const LibraryEntrySchema = z.union([SpecString, LibraryEntryObjectSchema])
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>

/**
 * Lazy-first `ask.json` — a list of library entries.
 *
 * ```json
 * {
 *   "libraries": [
 *     "npm:next",
 *     { "spec": "npm:zod", "docsPaths": ["docs/API.md"] },
 *     "github:vercel/ai@v5.0.0"
 *   ]
 * }
 * ```
 *
 * Configuration previously carried by per-entry objects (ref, docsPath,
 * storeMode, emitSkill, inPlace) is removed. Versions are resolved from
 * lockfiles (npm) or encoded in the spec string (github: `@ref` suffix).
 * The optional object form carries ONLY `docsPaths` overrides.
 */
export const AskJsonSchema = z.object({
  libraries: z.array(LibraryEntrySchema),
}).strict()

export type AskJson = z.infer<typeof AskJsonSchema>

/**
 * Extract the spec string from either form. Use this at every call site
 * that iterates `askJson.libraries` but only cares about the spec.
 */
export function specFromEntry(entry: LibraryEntry): string {
  return typeof entry === 'string' ? entry : entry.spec
}

/**
 * Extract the docs-path override for the entry, or undefined when the
 * entry has no override (string form).
 */
export function docsPathsFromEntry(entry: LibraryEntry): string[] | undefined {
  return typeof entry === 'string' ? undefined : entry.docsPaths
}

/**
 * Build a library entry from a spec and optional docs paths. Canonical
 * form rule: an empty or absent `docsPaths` collapses to a bare string
 * so `ask.json` stays diff-clean for users who never use the override.
 */
export function entryFromSpec(spec: string, docsPaths?: string[]): LibraryEntry {
  if (!docsPaths || docsPaths.length === 0) {
    return spec
  }
  return { spec, docsPaths: [docsPaths[0]!, ...docsPaths.slice(1)] }
}

/**
 * Re-export the StoreMode enum for the `--fetch` eager path which still
 * needs materialization mode selection.
 */
export const StoreModeSchema = z.enum(['copy', 'link', 'ref'])
export type StoreMode = z.infer<typeof StoreModeSchema>
