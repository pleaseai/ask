/**
 * Convention path tables for the two scan stages. The order is meaningful:
 * adapters walk each list top-to-bottom and keep the first candidate whose
 * `quality.ts` score passes the threshold.
 *
 * The lists intentionally stay short. Every additional path is a miss we
 * pay on every `ask add`, so entries should be justified by real-world
 * prevalence across the current registry corpus (see T026 audit).
 */

/**
 * Paths checked inside an installed `node_modules/<pkg>/` tree. The order
 * is: pre-built docs first (published distributions often ship a flattened
 * `dist/docs/`), then the source `docs/` folder. README is handled by the
 * dedicated `readme-fallback` branch in `local-conventions.ts` so that it
 * can emit a warning and is not interleaved with richer-content paths.
 */
export const LOCAL_CONVENTIONS: readonly string[] = [
  'dist/docs',
  'docs',
] as const

/**
 * Paths checked inside a downloaded GitHub repo archive. Ordered from most
 * specific (Nuxt-style `src/content/docs`) to most generic (`docs/`).
 * More specific paths get priority because they indicate the repo owner
 * explicitly curated that directory as user-facing docs.
 */
export const REPO_CONVENTIONS: readonly string[] = [
  'docs/src/content/docs',
  'src/content/docs',
  'apps/docs',
  'packages/docs',
  'website/docs',
  'docs',
] as const

/**
 * Filenames (case-insensitive) that are excluded from the quality score
 * even if they carry a `.md` extension. These are project-meta files
 * that most repositories contain and that on their own never represent
 * "docs" — including them would let a bare `contributing.md` +
 * `CHANGELOG.md` repo (SC-3 failure case) falsely pass the threshold.
 * Stored lowercase so we can match case-insensitively via a single
 * `toLowerCase()` call on the candidate.
 */
const EXCLUDED_EXACT_LOWER = new Set<string>([
  'contributing.md',
  'changelog.md',
  'code_of_conduct.md',
  'security.md',
])

/**
 * LICENSE files come in many spellings (LICENSE, LICENSE.md, LICENSE-MIT,
 * LICENCE.txt). The prefix match is intentionally loose — any filename
 * starting with `LICENSE` / `LICENCE` is treated as meta.
 */
const EXCLUDED_PREFIX_RE = /^licen[cs]e/i

export function isExcludedFilename(filename: string): boolean {
  if (EXCLUDED_EXACT_LOWER.has(filename.toLowerCase())) {
    return true
  }
  return EXCLUDED_PREFIX_RE.test(filename)
}

/**
 * Maximum directory recursion depth for any discovery walker.
 * Shared between `quality.ts` (scoreDirectory) and
 * `repo-conventions.ts` (collectDocFiles) so both stages agree on what
 * counts as "too deep". Keeping them in sync prevents scoreDirectory
 * from accepting a candidate whose deep files collectDocFiles later
 * skips, and vice-versa. 20 levels is both generous (real docs trees
 * rarely exceed ~6) and bounded enough to survive symlink loops that
 * the tarball extractor failed to resolve.
 */
export const MAX_WALK_DEPTH = 20
