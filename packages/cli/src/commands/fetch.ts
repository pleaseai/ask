import process from 'node:process'
import { defineCommand } from 'citty'
import { ensureCheckout as defaultEnsureCheckout } from './ensure-checkout.js'

export interface RunFetchOptions {
  specs: string[]
  projectDir: string
  quiet?: boolean
}

export interface RunFetchDeps {
  ensureCheckout?: typeof defaultEnsureCheckout
  log?: (msg: string) => void
  error?: (msg: string) => void
  exit?: (code: number) => void
}

/**
 * Implementation of `ask fetch <spec...>` (ported from opensrc's
 * `opensrc fetch`, vercel-labs/opensrc#53). Warms the checkout cache for
 * each spec via the shared `ensureCheckout` helper WITHOUT printing
 * paths — the counterpart to `ask src`/`ask docs`, which print where the
 * source lives. Useful for prefetching in setup scripts and for warming
 * the cache that `ask add`'s offline-first docs-path prompt reads from.
 *
 * Per-spec failures are reported and the remaining specs still run;
 * the process exits non-zero at the end if any spec failed.
 */
export async function runFetch(options: RunFetchOptions, deps: RunFetchDeps = {}): Promise<void> {
  const ensureCheckout = deps.ensureCheckout ?? defaultEnsureCheckout
  const log = deps.log ?? ((msg: string) => process.stdout.write(`${msg}\n`))
  const error = deps.error ?? ((msg: string) => process.stderr.write(`${msg}\n`))
  const exit = deps.exit ?? ((code: number) => process.exit(code))

  let fetched = 0
  let cached = 0
  let hadErrors = false

  for (const spec of options.specs) {
    try {
      const result = await ensureCheckout({ spec, projectDir: options.projectDir })
      // Avoid `spec@ref` duplication when the user already pinned the
      // ref in the spec itself (e.g. `github:owner/repo@v1.2.3`).
      const display = spec.endsWith(`@${result.ref}`) ? spec : `${spec}@${result.ref}`
      if (result.fromCache) {
        cached += 1
        if (!options.quiet)
          log(`  ✓ ${display} already cached (${result.checkoutDir})`)
      }
      else {
        fetched += 1
        if (!options.quiet)
          log(`  ✓ Fetched ${display} (${result.checkoutDir})`)
      }
    }
    catch (err) {
      hadErrors = true
      error(`  ✗ ${spec}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!options.quiet) {
    const parts: string[] = []
    if (fetched > 0)
      parts.push(`${fetched} fetched`)
    if (cached > 0)
      parts.push(`${cached} already cached`)
    if (parts.length > 0)
      log(`\n${parts.join(', ')}`)
  }

  if (hadErrors)
    exit(1)
}

/**
 * Citty command surface for `ask fetch`. Wires the citty argument parser
 * to `runFetch` and uses real stdout/stderr/process.exit. Tests should
 * call `runFetch` directly with mocked deps.
 */
export const fetchCmd = defineCommand({
  meta: {
    name: 'fetch',
    description: 'Warm the source cache for one or more specs without printing paths',
  },
  args: {
    spec: {
      type: 'positional',
      description: 'Library spec(s) (e.g. react, npm:react@18.2.0, github:facebook/react@v18.2.0)',
      required: true,
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      description: 'Suppress progress output (errors still print to stderr)',
    },
  },
  async run({ args }) {
    // citty binds the first positional to `args.spec` and keeps ALL
    // positionals (including the first) in `args._`.
    const rest = (args._ ?? []).filter(s => s.length > 0)
    const specs = rest.length > 0 ? rest : [args.spec]
    await runFetch({
      specs,
      projectDir: process.cwd(),
      quiet: Boolean(args.quiet),
    })
  },
})
