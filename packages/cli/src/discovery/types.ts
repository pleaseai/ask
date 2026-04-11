import type { DocFile } from '../sources/index.js'

/**
 * Quality score for a candidate docs directory. Used by the scanner to
 * decide whether a given convention path has enough real content to be
 * treated as "docs" or should fall through to the next candidate.
 */
export interface QualityScore {
  fileCount: number
  totalBytes: number
  /** True when `fileCount >= 3` OR `totalBytes >= 4 KiB`. */
  passes: boolean
}

/**
 * Adapters that produce a `docs`-kind result fill this shape. `installPath`
 * is set when the files live in `node_modules/<pkg>` and should NOT be
 * copied into `.ask/docs/` — the skill file references them in place.
 */
export interface DocsDiscoveryResult {
  kind: 'docs'
  /** Which adapter produced the result (for logging + lock diagnostics). */
  adapter: 'local-ask' | 'local-conventions' | 'repo-conventions'
  files: DocFile[]
  resolvedVersion: string
  /**
   * Absolute path to the installed package root when the files are read
   * in place. Omitted for tarball / github downloads that still need to
   * be copied into `.ask/docs/<name>@<ver>/`.
   */
  installPath?: string
  /** Relative path within the package/repo that was selected (diagnostic). */
  docsPath?: string
  /** Quality score that selected this directory, if any. */
  quality?: QualityScore
  /**
   * When true, the docs live inside `node_modules/<pkg>/<subdir>` and
   * should be referenced in place rather than copied into `.ask/docs/`.
   * Set by local-stage adapters (`local-ask`, `local-conventions`) when
   * `installPath` is present.
   */
  inPlace?: true
}

/**
 * One entry in the `intent-skills` AGENTS.md block. `load` is the path
 * agents load at read time (relative to project root, stable format
 * `node_modules/<pkg>/skills/<name>/SKILL.md`).
 */
export interface IntentSkillEntry {
  task: string
  load: string
}

/**
 * Adapters that produce an `intent-skills`-kind result fill this shape.
 * Unlike `docs`, these entries are never copied — the installation model
 * for Intent-format packages is reference-in-place via `node_modules`.
 */
export interface IntentSkillsDiscoveryResult {
  kind: 'intent-skills'
  adapter: 'local-intent'
  packageName: string
  resolvedVersion: string
  /** Absolute path to `node_modules/<pkg>`. */
  installPath: string
  skills: IntentSkillEntry[]
}

export type DiscoveryResult = DocsDiscoveryResult | IntentSkillsDiscoveryResult

/**
 * Input to local-stage adapters (`local-ask`, `local-intent`,
 * `local-conventions`). `explicitDocsPath` is the user-supplied
 * `--docs-path` flag, if any — when set, discovery skips to the
 * registry-style path so we do not double-scan.
 */
export interface LocalDiscoveryOptions {
  projectDir: string
  pkg: string
  requestedVersion: string
  explicitDocsPath?: string
}

/**
 * Input to the repo-stage adapter, which runs after an ecosystem resolver
 * downloads a tarball to `repoDir`. The adapter picks the best conventional
 * subdirectory and returns a `docs`-kind result keyed to `resolvedVersion`.
 */
export interface RepoDiscoveryOptions {
  repoDir: string
  pkg: string
  resolvedVersion: string
}

/**
 * Common shape for local-stage adapters. Each adapter independently tests
 * one detection strategy and returns `null` when the strategy does not
 * apply, so `runLocalDiscovery` can iterate in priority order and keep the
 * first non-null result.
 */
export type LocalDiscoveryAdapter = (
  opts: LocalDiscoveryOptions,
) => Promise<DiscoveryResult | null>

export type RepoDiscoveryAdapter = (
  opts: RepoDiscoveryOptions,
) => Promise<DiscoveryResult | null>
