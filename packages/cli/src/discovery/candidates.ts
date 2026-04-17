import fs from 'node:fs'
import path from 'node:path'
import { ensureCheckout as defaultEnsureCheckout, NoCacheError, splitExplicitVersion } from '../commands/ensure-checkout.js'
import { findDocLikePaths } from '../commands/find-doc-paths.js'
import { parseSpec } from '../spec.js'

/**
 * A contiguous discovery region. `root` is the directory that the
 * paths are relative to when persisted; `paths` are absolute candidate
 * docs directories (or the fallback root when no `/doc/i` subdirs
 * exist — `findDocLikePaths` returns `[root]` in that case).
 */
export interface CandidateGroup {
  root: string
  paths: string[]
}

/**
 * Thrown by `gatherDocsCandidates` only for unexpected failures
 * (malformed spec, programmer errors). A missing cache or offline
 * state is NOT an error — the probe returns zero groups so the caller
 * can silently skip the prompt.
 */
export class CandidateGatheringError extends Error {
  constructor(
    public readonly spec: string,
    public readonly cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(`could not gather docs candidates for ${spec}: ${message}`)
    this.name = 'CandidateGatheringError'
  }
}

export interface GatherDocsCandidatesDeps {
  ensureCheckout?: typeof defaultEnsureCheckout
}

/**
 * Gather candidate documentation directories for a spec without
 * triggering a network fetch. Two locations are probed:
 *
 *   1. `node_modules/<pkg>/` — for npm-ecosystem specs with a local
 *      install. Parsed directly from the spec, so no resolver hit.
 *   2. The cached git checkout — via `ensureCheckout(noFetch: true)`.
 *      A cache miss is treated as "nothing to show here, keep walking":
 *      no error surfaces, the group is simply omitted.
 *
 * This keeps `ask add` offline-friendly. Users who want to surface
 * checkout-based candidates on a fresh spec should run
 * `ask docs <spec>` first to warm the cache, then re-run `ask add`.
 *
 * Returns an empty array when nothing is available — the caller is
 * expected to treat that as "skip the prompt, persist the spec
 * without an override".
 */
export async function gatherDocsCandidates(
  spec: string,
  projectDir: string,
  deps: GatherDocsCandidatesDeps = {},
): Promise<CandidateGroup[]> {
  const ensureCheckout = deps.ensureCheckout ?? defaultEnsureCheckout

  const groups: CandidateGroup[] = []

  // 1. Direct node_modules probe for npm specs — no resolver hop.
  const { spec: specBody } = splitExplicitVersion(spec)
  const parsed = parseSpec(specBody)
  if (parsed.kind === 'npm') {
    const nmPath = path.join(projectDir, 'node_modules', parsed.pkg)
    if (fs.existsSync(nmPath)) {
      groups.push({ root: nmPath, paths: findDocLikePaths(nmPath) })
    }
  }

  // 2. Cached checkout probe. `noFetch: true` so a cache miss is a
  //    silent skip — we do NOT trigger a clone from `ask add`.
  try {
    const result = await ensureCheckout({ spec, projectDir, noFetch: true })
    groups.push({ root: result.checkoutDir, paths: findDocLikePaths(result.checkoutDir) })
  }
  catch (err) {
    if (err instanceof NoCacheError) {
      // Expected on first add of a spec that has never been fetched —
      // skip the checkout group and proceed with whatever we collected.
      return groups
    }
    // Other errors (malformed spec, bad ecosystem) bubble up as a
    // programmer-level problem. Wrap to preserve the spec for caller
    // diagnostics.
    throw new CandidateGatheringError(spec, err)
  }

  return groups
}
