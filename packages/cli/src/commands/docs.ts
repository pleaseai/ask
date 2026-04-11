import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { ensureCheckout as defaultEnsureCheckout, NoCacheError } from './ensure-checkout.js'
import { findDocLikePaths } from './find-doc-paths.js'

export interface RunDocsOptions {
  spec: string
  projectDir: string
  noFetch?: boolean
}

export interface RunDocsDeps {
  ensureCheckout?: typeof defaultEnsureCheckout
  log?: (msg: string) => void
  error?: (msg: string) => void
  exit?: (code: number) => void
}

/**
 * Implementation of `ask docs <spec>`. Resolves the spec via the
 * shared `ensureCheckout` helper, then walks two locations and prints
 * every doc-like path found, one per line:
 *
 *   1. For npm-ecosystem specs only: `node_modules/<pkg>/` if installed.
 *      Always emits the package root as the first line of that source,
 *      followed by any subdirectory whose basename matches `/doc/i`.
 *   2. The cached source tree (`~/.ask/github/checkouts/<o>__<r>/<ref>/`).
 *      Always emits the checkout root, followed by any `/doc/i` subdirs.
 *
 * The agent decides which path is the "real" docs by reading the
 * contents. Multi-line output is intentional — it lets `rg` and `fd`
 * search across multiple candidates simultaneously via shell
 * substitution.
 */
export async function runDocs(options: RunDocsOptions, deps: RunDocsDeps = {}): Promise<void> {
  const ensureCheckout = deps.ensureCheckout ?? defaultEnsureCheckout
  const log = deps.log ?? ((msg: string) => process.stdout.write(`${msg}\n`))
  const error = deps.error ?? ((msg: string) => process.stderr.write(`${msg}\n`))
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  let result
  try {
    result = await ensureCheckout({
      spec: options.spec,
      projectDir: options.projectDir,
      noFetch: options.noFetch,
    })
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
    return
  }

  // Walk node_modules/<pkg>/ first when the spec is an npm package and
  // the local install actually has it. Non-npm specs and missing
  // installs are silently skipped — the checkout walk below still runs.
  if (result.npmPackageName) {
    const nmPath = path.join(options.projectDir, 'node_modules', result.npmPackageName)
    if (fs.existsSync(nmPath)) {
      for (const p of findDocLikePaths(nmPath)) {
        log(p)
      }
    }
  }

  // Walk the cached source tree. Always emits the root as the first
  // line, even if no /doc/i subdirs are found.
  for (const p of findDocLikePaths(result.checkoutDir)) {
    log(p)
  }
}

/**
 * Citty command surface for `ask docs`. Wires the citty argument
 * parser to `runDocs` and uses real stdout/stderr/process.exit. Tests
 * should call `runDocs` directly with mocked deps.
 */
export const docsCmd = defineCommand({
  meta: {
    name: 'docs',
    description: 'Print all candidate documentation paths from node_modules and the cached source tree',
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
    await runDocs({
      spec: args.spec,
      projectDir: process.cwd(),
      noFetch: Boolean(args['no-fetch']),
    })
  },
})
