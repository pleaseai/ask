import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { z } from 'zod'
import { findEntry, readAskJson } from '../io.js'
import { docsPathsFromEntry } from '../schemas.js'
import { ensureCheckout as defaultEnsureCheckout, NoCacheError } from './ensure-checkout.js'
import { findDocLikePaths } from './find-doc-paths.js'

export interface RunDocsOptions {
  spec: string
  projectDir: string
  noFetch?: boolean
  json?: boolean
}

// ── JSON output model ─────────────────────────────────────────────
// Schema for `ask docs <spec> --json`. Each candidate carries its
// source root so agents can prefer `node_modules` (faster, no clone)
// over the cached checkout, or filter on a specific origin.

export const DocsCandidateSchema = z.object({
  path: z.string(),
  root: z.enum(['node_modules', 'checkout']),
})

export const DocsModelSchema = z.object({
  spec: z.string(),
  npmPackageName: z.string().nullable(),
  checkoutDir: z.string(),
  /**
   * True iff ask.json defines a `docsPaths` override for this spec AND
   * at least one of those paths resolved to an existing file/dir.
   * When the override exists but every entry is stale, the model falls
   * back to the unfiltered walk and reports `false`.
   */
  storedOverride: z.boolean(),
  paths: z.array(DocsCandidateSchema),
})

export type DocsModel = z.infer<typeof DocsModelSchema>

export interface RunDocsDeps {
  ensureCheckout?: typeof defaultEnsureCheckout
  log?: (msg: string) => void
  error?: (msg: string) => void
  exit?: (code: number) => void
}

/**
 * Implementation of `ask docs <spec>`. Resolves the spec via the
 * shared `ensureCheckout` helper, then prints documentation candidate
 * paths from two locations (one per line):
 *
 *   1. For npm-ecosystem specs only: `node_modules/<pkg>/` if installed.
 *   2. The cached source tree (`<askHome>/github/<host>/<owner>/<repo>/<ref>/`).
 *
 * For each location, `findDocLikePaths` emits:
 *   - `dist/docs` when it exists (publish-time convention, e.g. mastra).
 *   - Any subdirectory whose basename matches `/doc/i` up to depth 4.
 *   - The root itself as a fallback when nothing above matches
 *     (README-only packages).
 *
 * Emitting only doc-like paths when they exist keeps shell substitution
 * (`rg "x" $(ask docs <spec>)`) focused on documentation instead of
 * dragging the entire source tree into the search. Callers that need
 * the checkout root itself should use `ask src`.
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

  // Collect every candidate path into `paths` so both text mode (per-
  // line `log`) and JSON mode (single blob at the end) consume the same
  // result. `emit` is the single sink — it streams to `log` in text
  // mode and just accumulates in JSON mode.
  const paths: Array<{ path: string, root: 'node_modules' | 'checkout' }> = []
  const emit = (p: string, root: 'node_modules' | 'checkout') => {
    paths.push({ path: p, root })
    if (!options.json)
      log(p)
  }

  const nmPath = result.npmPackageName
    ? path.join(options.projectDir, 'node_modules', result.npmPackageName)
    : null

  // If the spec is registered in ask.json with a persisted docsPaths
  // override, emit ONLY the stored paths (resolved against both roots
  // that `ask add` probed at selection time). Falls back to the
  // unfiltered walk when every stored path is stale — a silent
  // exact-match with no output would be worse than just printing
  // whatever does exist.
  const askJson = readAskJson(options.projectDir)
  const entry = askJson ? findEntry(askJson, options.spec) : undefined
  const stored = entry ? docsPathsFromEntry(entry) : undefined
  let storedOverride = false

  if (stored && stored.length > 0) {
    const roots: Array<{ abs: string, kind: 'node_modules' | 'checkout' }> = []
    if (nmPath && fs.existsSync(nmPath))
      roots.push({ abs: nmPath, kind: 'node_modules' })
    roots.push({ abs: result.checkoutDir, kind: 'checkout' })

    for (const rel of stored) {
      for (const { abs: root, kind } of roots) {
        // Containment guard: a malicious or buggy `docsPaths` entry
        // (`..`, absolute path) must not escape its root, otherwise
        // `ask docs` would emit arbitrary filesystem paths. Resolve
        // both sides and confirm abs is rootAbs itself or a descendant.
        const rootAbs = path.resolve(root)
        const abs = path.resolve(rootAbs, rel)
        if (abs !== rootAbs && !abs.startsWith(`${rootAbs}${path.sep}`)) {
          continue
        }
        if (fs.existsSync(abs)) {
          emit(abs, kind)
          break
        }
      }
    }

    if (paths.length > 0) {
      storedOverride = true
    }
    else {
      error(
        `ask: stored docsPaths for ${options.spec} are all stale; emitting all candidates`,
      )
      // fall through to the default walk
    }
  }

  if (!storedOverride) {
    // Walk node_modules/<pkg>/ first when the spec is an npm package
    // and the local install actually has it. Non-npm specs and missing
    // installs are silently skipped — the checkout walk below still
    // runs.
    if (nmPath && fs.existsSync(nmPath)) {
      for (const p of findDocLikePaths(nmPath))
        emit(p, 'node_modules')
    }

    // Walk the cached source tree. Always emits the root as the first
    // line, even if no /doc/i subdirs are found.
    for (const p of findDocLikePaths(result.checkoutDir))
      emit(p, 'checkout')
  }

  if (options.json) {
    const model: DocsModel = {
      spec: options.spec,
      npmPackageName: result.npmPackageName ?? null,
      checkoutDir: result.checkoutDir,
      storedOverride,
      paths,
    }
    log(JSON.stringify(DocsModelSchema.parse(model), null, 2))
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
    'json': {
      type: 'boolean',
      description: 'Emit candidates as JSON matching DocsModelSchema (single blob, suppresses per-line output)',
    },
  },
  async run({ args }) {
    await runDocs({
      spec: args.spec,
      projectDir: process.cwd(),
      noFetch: Boolean(args['no-fetch']),
      json: Boolean(args.json),
    })
  },
})
