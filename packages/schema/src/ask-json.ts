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
 * Lazy-first `ask.json` — a simple list of spec strings.
 *
 * ```json
 * { "libraries": ["npm:next", "npm:zod", "github:vercel/ai@v5.0.0"] }
 * ```
 *
 * All configuration previously carried by per-entry objects (ref, docsPath,
 * storeMode, emitSkill, inPlace) is removed. Versions are resolved from
 * lockfiles (npm) or encoded in the spec string (github: `@ref` suffix).
 * Metadata like docsPath comes from the ASK Registry at install time.
 */
export const AskJsonSchema = z.object({
  libraries: z.array(SpecString),
}).strict()

export type AskJson = z.infer<typeof AskJsonSchema>

/**
 * Re-export the StoreMode enum for the `--fetch` eager path which still
 * needs materialization mode selection.
 */
export const StoreModeSchema = z.enum(['copy', 'link', 'ref'])
export type StoreMode = z.infer<typeof StoreModeSchema>
