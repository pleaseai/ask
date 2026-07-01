import type { ResolveCspDeps } from './resolve-csp.js'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { defineCommand } from 'citty'
import { ensureCheckout as defaultEnsureCheckout, NoCacheError } from './ensure-checkout.js'
import { resolveCsp as defaultResolveCsp } from './resolve-csp.js'

export interface RunSearchOptions {
  spec: string
  query: string
  projectDir: string
  noFetch?: boolean
  /** Maps to csp `--content` (repeatable enum: code | docs | config | all). */
  content?: string[]
  /** Maps to csp `--top-k` / `-k`. */
  topK?: number
}

export interface CspRunResult {
  status: number | null
}

export interface RunSearchDeps {
  ensureCheckout?: typeof defaultEnsureCheckout
  resolveCsp?: (deps?: ResolveCspDeps) => string | null
  /** Test seam around `spawnSync` — spawns csp with inherited stdio. */
  runCsp?: (bin: string, args: string[]) => CspRunResult
  log?: (msg: string) => void
  error?: (msg: string) => void
  exit?: (code: number) => void
}

function defaultRunCsp(bin: string, args: string[]): CspRunResult {
  // stdio:'inherit' streams csp's ranked snippets straight through to
  // the caller's terminal; we only care about the exit status.
  const result = spawnSync(bin, args, { stdio: 'inherit' })
  if (result.error)
    throw result.error
  return { status: result.status }
}

/**
 * Build the csp argv (FR-B1). Path is a POSITIONAL arg AFTER the query
 * (verified against csp's clap defs — Phase 0), not a flag. No `csp
 * index` step: `csp search` auto-indexes into `~/.csp/index/<hash>` and
 * reuses the content-addressed cache (FR-C1).
 */
export function buildCspArgs(query: string, checkoutDir: string, options: { content?: string[], topK?: number }): string[] {
  const args = ['search', query, checkoutDir]
  if (options.content && options.content.length > 0)
    args.push('--content', ...options.content)
  if (options.topK !== undefined)
    args.push('--top-k', String(options.topK))
  return args
}

/**
 * Implementation of `ask search <spec> <query>`. Resolves the spec to a
 * version-pinned checkout via `ensureCheckout`, then hands that path to
 * csp for semantic search (acquisition feeds retrieval).
 *
 * csp is optional: when it is not found on PATH / `CSP_BIN`, ask prints
 * the resolved checkout path plus a copy-pasteable recipe and exits 0
 * (FR-B3) — it never fails solely because csp is absent (INV-3). When
 * csp IS present, its exit code is forwarded (FR-B4).
 */
export async function runSearch(options: RunSearchOptions, deps: RunSearchDeps = {}): Promise<void> {
  const ensureCheckout = deps.ensureCheckout ?? defaultEnsureCheckout
  const resolveCsp = deps.resolveCsp ?? defaultResolveCsp
  const runCsp = deps.runCsp ?? defaultRunCsp
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

  const checkoutDir = result.checkoutDir
  const cspArgs = buildCspArgs(options.query, checkoutDir, options)
  const csp = resolveCsp()

  // Graceful degradation (FR-B3): no csp → emit the path + a runnable
  // recipe, exit 0. ask deliberately passes the LOCAL checkout, never a
  // git URL, even though csp accepts URLs (INV-2).
  if (!csp) {
    const recipe = ['csp', ...cspArgs.map(a => (a === options.query ? JSON.stringify(a) : a))].join(' ')
    error('ask: csp (code-search) not found on PATH or $CSP_BIN — printing checkout path + recipe.')
    log(checkoutDir)
    log(recipe)
    exit(0)
    return
  }

  // csp present: stream its output through and forward the exit code.
  const { status } = runCsp(csp, cspArgs)
  exit(status ?? 0)
}

/**
 * Citty command surface for `ask search`. Tests should call `runSearch`
 * directly with mocked deps; this wrapper is only for the CLI entry.
 */
export const searchCmd = defineCommand({
  meta: {
    name: 'search',
    description: 'Semantic code search over a version-pinned library checkout (delegates to csp; optional)',
  },
  args: {
    'spec': {
      type: 'positional',
      description: 'Library spec (e.g. react, npm:react@18.2.0, github:facebook/react@v18.2.0)',
      required: true,
    },
    'query': {
      type: 'positional',
      description: 'Natural-language or identifier query',
      required: true,
    },
    'content': {
      type: 'string',
      description: 'csp content filter(s), comma-separated: code | docs | config | all',
    },
    'top-k': {
      type: 'string',
      description: 'Max results to return (csp --top-k)',
    },
    'no-fetch': {
      type: 'boolean',
      description: 'Return cache hit only — exit 1 on cache miss',
    },
  },
  async run({ args }) {
    const content = typeof args.content === 'string' && args.content.length > 0
      ? args.content.split(',').map(s => s.trim()).filter(Boolean)
      : undefined
    const topKRaw = args['top-k']
    const topK = typeof topKRaw === 'string' && topKRaw.length > 0 ? Number(topKRaw) : undefined
    await runSearch({
      spec: args.spec,
      query: args.query,
      projectDir: process.cwd(),
      noFetch: Boolean(args['no-fetch']),
      content,
      topK: Number.isNaN(topK) ? undefined : topK,
    })
  },
})
