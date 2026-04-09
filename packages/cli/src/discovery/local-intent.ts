import type { DiscoveryResult, IntentSkillEntry, LocalDiscoveryAdapter } from './types.js'
import fs from 'node:fs'
import path from 'node:path'
import { findSkillFiles, parseFrontmatter } from '@tanstack/intent'
import { satisfies, validRange } from 'semver'
import { z } from 'zod'

/**
 * Runtime validation of `@tanstack/intent`'s `parseFrontmatter` output.
 *
 * Intent is pinned exact in `package.json` (spec Constraint), but an
 * upgrade that changes the frontmatter shape would otherwise silently
 * produce bad load entries. `passthrough()` keeps unrecognised fields so
 * the adapter stays forward-compatible with Intent adding optional
 * metadata, while the task / description / name chain below still picks
 * a reasonable task label.
 */
const SkillFrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    task: z.string().optional(),
    type: z.string().optional(),
    framework: z.string().optional(),
  })
  .passthrough()

interface IntentPackageJson {
  version?: string
  keywords?: unknown
}

/**
 * Match the requested version against the installed version. Mirrors
 * `NpmSource.versionMatches` because that helper is private — if the
 * match logic ever moves into a shared util, these two call sites should
 * merge.
 *
 * Accept `latest`, any semver range (`^1`, `>=2 <3`, ...), or an exact
 * match for opaque tags like `next` or `canary`.
 */
function versionMatches(requested: string, installed: string): boolean {
  if (requested === 'latest') {
    return true
  }
  if (validRange(requested)) {
    return satisfies(installed, requested)
  }
  return requested === installed
}

/**
 * Build the stable `load:` path for an Intent skill entry. The Intent
 * CLI (`@tanstack/intent install`) emits paths relative to the project
 * root in the form `node_modules/<pkg>/skills/<dir>/SKILL.md`, so we
 * produce the same shape here — byte-identical output is required by
 * SC-2.
 */
function buildLoadPath(projectDir: string, skillFile: string): string {
  const rel = path.relative(projectDir, skillFile)
  // Normalise to POSIX separators so Windows runs still emit the stable
  // unix-style path the Intent CLI writes.
  return rel.split(path.sep).join('/')
}

/**
 * Adapter: `local-intent` — discovery for `tanstack-intent` keyword
 * packages via `@tanstack/intent`'s programmatic read-path helpers.
 *
 * Preconditions for a match:
 *   1. The package is installed at `node_modules/<pkg>` and its version
 *      satisfies the requested range.
 *   2. `package.json.keywords` contains `tanstack-intent`.
 *   3. `findSkillFiles(pkgDir)` returns at least one `SKILL.md`.
 *
 * On a match the adapter returns a `kind: 'intent-skills'` result that
 * the dispatcher will route into the `<!-- intent-skills:start -->`
 * AGENTS.md block instead of the `.ask/docs/` copy pipeline.
 */
export const localIntentAdapter: LocalDiscoveryAdapter = async (opts) => {
  const { projectDir, pkg, requestedVersion } = opts

  const pkgDir = path.join(projectDir, 'node_modules', pkg)
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    return null
  }

  let meta: IntentPackageJson
  try {
    meta = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as IntentPackageJson
  }
  catch {
    return null
  }

  if (!meta.version || !versionMatches(requestedVersion, meta.version)) {
    return null
  }

  const keywords = Array.isArray(meta.keywords) ? meta.keywords : []
  if (!keywords.includes('tanstack-intent')) {
    return null
  }

  let skillFiles: string[]
  try {
    skillFiles = findSkillFiles(pkgDir)
  }
  catch {
    return null
  }
  if (skillFiles.length === 0) {
    return null
  }

  const skills: IntentSkillEntry[] = []
  for (const skillFile of skillFiles) {
    const parsed = SkillFrontmatterSchema.safeParse(parseFrontmatter(skillFile) ?? {})
    // Label precedence: explicit `task`, then `description`, then the
    // directory name (which in Intent's layout encodes the skill slug).
    const skillDir = path.basename(path.dirname(skillFile))
    const task = parsed.success
      ? (parsed.data.task ?? parsed.data.description ?? skillDir)
      : skillDir
    skills.push({
      task,
      load: buildLoadPath(projectDir, skillFile),
    })
  }

  const result: DiscoveryResult = {
    kind: 'intent-skills',
    adapter: 'local-intent',
    packageName: pkg,
    resolvedVersion: meta.version,
    installPath: pkgDir,
    skills,
  }
  return result
}
