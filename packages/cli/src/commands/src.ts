import process from 'node:process'
import { defineCommand } from 'citty'
import { ensureCheckout as defaultEnsureCheckout, NoCacheError } from './ensure-checkout.js'

export interface RunSrcOptions {
  spec: string
  projectDir: string
  noFetch?: boolean
}

export interface RunSrcDeps {
  ensureCheckout?: typeof defaultEnsureCheckout
  log?: (msg: string) => void
  error?: (msg: string) => void
  exit?: (code: number) => void
}

/**
 * Implementation of `ask src <spec>`. Resolves the spec via the shared
 * `ensureCheckout` helper, fetching on cache miss unless `noFetch` is
 * set, then prints the absolute checkout path to stdout.
 *
 * Errors (NoCacheError, resolver failures, unsupported ecosystems) are
 * routed through the injected `error` and `exit` callbacks so the
 * function stays unit-testable without process exits or console writes.
 */
export async function runSrc(options: RunSrcOptions, deps: RunSrcDeps = {}): Promise<void> {
  const ensureCheckout = deps.ensureCheckout ?? defaultEnsureCheckout
  const log = deps.log ?? ((msg: string) => process.stdout.write(`${msg}\n`))
  const error = deps.error ?? ((msg: string) => process.stderr.write(`${msg}\n`))
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  try {
    const result = await ensureCheckout({
      spec: options.spec,
      projectDir: options.projectDir,
      noFetch: options.noFetch,
    })
    log(result.checkoutDir)
  }
  catch (err) {
    if (err instanceof NoCacheError) {
      error(err.message)
      exit(1)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    error(message)
    exit(1)
  }
}

/**
 * Citty command surface for `ask src`. Wires the citty argument parser
 * to `runSrc` and uses real stdout/stderr/process.exit. Tests should
 * call `runSrc` directly with mocked deps; this wrapper is only for the
 * CLI entrypoint.
 */
export const srcCmd = defineCommand({
  meta: {
    name: 'src',
    description: 'Print the absolute path to a cached library source tree (lazy fetch on cache miss)',
  },
  args: {
    'spec': {
      type: 'positional',
      description: 'Library spec (e.g. react, npm:react@18.2.0, github:facebook/react@v18.2.0)',
      required: true,
    },
    'no-fetch': {
      type: 'boolean',
      description: 'Return cache hit only — exit 1 on cache miss',
    },
  },
  async run({ args }) {
    await runSrc({
      spec: args.spec,
      projectDir: process.cwd(),
      noFetch: Boolean(args['no-fetch']),
    })
  },
})
