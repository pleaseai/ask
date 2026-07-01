import process from 'node:process'
import { defineCommand } from 'citty'
import { z } from 'zod'
import { ensureCheckout as defaultEnsureCheckout, NoCacheError } from './ensure-checkout.js'

export interface RunSrcOptions {
  spec: string
  projectDir: string
  noFetch?: boolean
  json?: boolean
}

// ── JSON output model ─────────────────────────────────────────────
// Schema for `ask src <spec> --json`. This is the stable machine-
// readable handoff that downstream tools (e.g. csp — code-search)
// consume: `checkoutDir` is the version-pinned, content-stable store
// path they index/search. Mirrors the `DocsModelSchema` precedent in
// docs.ts (zod-schema-as-output-contract).

export const SrcModelSchema = z.object({
  spec: z.string(),
  owner: z.string(),
  repo: z.string(),
  ref: z.string(),
  resolvedVersion: z.string(),
  /** Absolute path to `<askHome>/github/<host>/<owner>/<repo>/<ref>/`. */
  checkoutDir: z.string(),
  npmPackageName: z.string().nullable(),
})

export type SrcModel = z.infer<typeof SrcModelSchema>

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
    if (options.json) {
      const model: SrcModel = {
        spec: options.spec,
        owner: result.owner,
        repo: result.repo,
        ref: result.ref,
        resolvedVersion: result.resolvedVersion,
        checkoutDir: result.checkoutDir,
        npmPackageName: result.npmPackageName ?? null,
      }
      log(JSON.stringify(SrcModelSchema.parse(model), null, 2))
    }
    else {
      log(result.checkoutDir)
    }
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
    'json': {
      type: 'boolean',
      description: 'Emit resolution as JSON matching SrcModelSchema (spec, owner, repo, ref, resolvedVersion, checkoutDir, npmPackageName)',
    },
  },
  async run({ args }) {
    await runSrc({
      spec: args.spec,
      projectDir: process.cwd(),
      noFetch: Boolean(args['no-fetch']),
      json: Boolean(args.json),
    })
  },
})
