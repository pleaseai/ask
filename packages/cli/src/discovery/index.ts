import type {
  DiscoveryResult,
  LocalDiscoveryAdapter,
  LocalDiscoveryOptions,
  RepoDiscoveryOptions,
} from './types.js'
import { localAskAdapter } from './local-ask.js'
import { localConventionsAdapter } from './local-conventions.js'
import { localIntentAdapter } from './local-intent.js'
import { repoConventionsAdapter } from './repo-conventions.js'

export type {
  DiscoveryResult,
  DocsDiscoveryResult,
  IntentSkillEntry,
  IntentSkillsDiscoveryResult,
  LocalDiscoveryOptions,
  QualityScore,
  RepoDiscoveryOptions,
} from './types.js'

/**
 * Priority order for `runLocalDiscovery`. The array order is the
 * documented adapter priority (spec §Discovery pipeline):
 *
 *   1. local-ask         — library-author opt-in via `ask.docsPath`
 *   2. local-intent      — `tanstack-intent` keyword packages
 *   3. local-conventions — `dist/docs` / `docs` / README fallback
 *
 * A later adapter never overrides an earlier one, even if the later
 * adapter would produce a higher-quality result. This is a deliberate
 * choice: opting in via `ask.docsPath` or `tanstack-intent` keywords is
 * a contract from the library author, and automatic scanning must not
 * second-guess that contract.
 */
const LOCAL_ADAPTERS: readonly LocalDiscoveryAdapter[] = [
  localAskAdapter,
  localIntentAdapter,
  localConventionsAdapter,
] as const

/**
 * Orchestrator for local-stage discovery. Runs each adapter in the
 * documented priority order and keeps the first non-null result. Returns
 * `null` when no adapter matches, which signals the CLI to fall through
 * to `resolveFromRegistry` and then the ecosystem resolvers.
 *
 * If the caller supplied an explicit `--docs-path`, discovery is
 * bypassed entirely — the user asked for a specific directory and the
 * existing registry / source pipeline already honours that flag.
 */
export async function runLocalDiscovery(
  opts: LocalDiscoveryOptions,
): Promise<DiscoveryResult | null> {
  if (opts.explicitDocsPath) {
    return null
  }
  for (const adapter of LOCAL_ADAPTERS) {
    const result = await adapter(opts)
    if (result) {
      return result
    }
  }
  return null
}

/**
 * Orchestrator for repo-stage discovery. Runs after an ecosystem
 * resolver downloads a tarball into `repoDir`. Currently only one
 * adapter (`repo-conventions`) — the function is kept as an
 * orchestrator so future adapters (e.g. a repo-level `ask.docsPath`
 * manifest lookup) can slot in without touching call sites.
 */
export async function runRepoDiscovery(
  opts: RepoDiscoveryOptions,
): Promise<DiscoveryResult | null> {
  return repoConventionsAdapter(opts)
}
