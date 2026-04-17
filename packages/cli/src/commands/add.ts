import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { CandidateGatheringError, gatherDocsCandidates } from '../discovery/candidates.js'
import { runInstall } from '../install.js'
import { runInteractiveAdd } from '../interactive.js'
import { readAskJson, writeAskJson } from '../io.js'
import { entryFromSpec, specFromEntry } from '../schemas.js'
import { parseSpec } from '../spec.js'

const OWNER_REPO_RE = /^[^/]+\/[^/]+$/

/**
 * Validate and canonicalize a user-supplied docs path (either from the
 * interactive prompt or the `--docs-paths` CSV flag). Returns the
 * POSIX-normalized relative path on success, or null when the input
 * is unsafe / empty. Rejects:
 *
 *   - Empty / whitespace-only strings
 *   - Absolute paths (anything `path.isAbsolute` accepts — covers
 *     POSIX `/...`, Windows `C:\...` and UNC `\\server\...`)
 *   - Paths that resolve out of their root via `..` segments
 *
 * Normalization uses `path.posix.normalize` over a forward-slash
 * representation of the input so the value persisted in `ask.json`
 * stays portable across operating systems. A Windows user writing
 * `docs\api` and a POSIX user writing `docs/api` both produce the
 * same stored token `docs/api`. The read side (`ask docs`) re-joins
 * via `path.resolve`, which accepts both separator styles on Windows
 * and forward slashes on POSIX.
 */
function sanitizeDocsPath(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  if (path.isAbsolute(trimmed)) {
    return null
  }
  const normalized = path.posix.normalize(trimmed.replaceAll('\\', '/'))
  if (!normalized) {
    return null
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    return null
  }
  return normalized
}

function normalizeAddSpec(input: string): string {
  if (!input.includes(':')) {
    if (OWNER_REPO_RE.test(input)) {
      return `github:${input}`
    }
    throw new Error(
      `Ambiguous spec '${input}'. Use:\n`
      + `  • npm:<name>           (e.g. npm:next, npm:@mastra/client-js)\n`
      + `  • github:<owner>/<repo>@<ref>  (e.g. github:vercel/next.js@v14.2.3)`,
    )
  }
  return input
}

export interface RunAddOptions {
  projectDir: string
  spec: string
  /** Raw CSV from `--docs-paths`. When set, skips the interactive prompt. */
  docsPathsArg?: string
  /** `--clear-docs-paths` — drop any existing `docsPaths` override. */
  clearDocsPaths?: boolean
}

export interface RunAddDeps {
  gatherCandidates?: typeof gatherDocsCandidates
  /** Injection seam for tests — mirrors `consola.prompt`. */
  prompt?: typeof consola.prompt
  isTTY?: () => boolean
  installer?: typeof runInstall
}

/**
 * `ask add <spec>` implementation. Three policies drive whether the
 * entry gets stored as a bare spec string or an object with a
 * `docsPaths` override:
 *
 *   1. `--clear-docs-paths` → force canonical string form (downgrade)
 *   2. `--docs-paths a,b,c` → store the supplied CSV, no prompt
 *   3. otherwise probe candidates via `ensureCheckout`; if more than
 *      one doc-like directory exists AND stdout is a TTY, run a
 *      multiselect prompt; selections become the persisted override.
 *
 * Selections are stored as **relative** paths keyed to each candidate
 * group's root (`node_modules/<pkg>` or the cached git checkout), so
 * the entry stays portable across machines and cache wipes. The read
 * side (`ask docs`) re-derives the same roots and resolves.
 *
 * When `gatherDocsCandidates` fails (network miss, resolver error), we
 * warn and still persist the spec — a bare `ask add` call must not
 * block on an offline cache. The user can rerun to pick paths later.
 */
export async function runAdd(options: RunAddOptions, deps: RunAddDeps = {}): Promise<void> {
  const gatherCandidates = deps.gatherCandidates ?? gatherDocsCandidates
  const prompt = deps.prompt ?? consola.prompt
  const isTTY = deps.isTTY ?? (() => Boolean(process.stdout.isTTY))
  const installer = deps.installer ?? runInstall

  const spec = normalizeAddSpec(options.spec)

  const parsed = parseSpec(spec)
  if (parsed.kind === 'unknown') {
    throw new Error(`Invalid spec: ${spec}`)
  }

  const askJson = readAskJson(options.projectDir) ?? { libraries: [] }
  const existingIdx = askJson.libraries.findIndex(e => specFromEntry(e) === spec)

  const selectedPaths = await resolveSelectedPaths(
    spec,
    options,
    { gatherCandidates, prompt, isTTY },
  )

  const entry = entryFromSpec(spec, selectedPaths)
  if (existingIdx >= 0) {
    askJson.libraries[existingIdx] = entry
    consola.info(`Updated ${spec} in ask.json`)
  }
  else {
    askJson.libraries.push(entry)
    consola.info(`Added ${spec} to ask.json`)
  }
  writeAskJson(options.projectDir, askJson)

  await installer(options.projectDir, { onlySpecs: [spec] })
}

async function resolveSelectedPaths(
  spec: string,
  options: RunAddOptions,
  deps: {
    gatherCandidates: typeof gatherDocsCandidates
    prompt: typeof consola.prompt
    isTTY: () => boolean
  },
): Promise<string[] | undefined> {
  if (options.clearDocsPaths) {
    return undefined
  }

  if (options.docsPathsArg !== undefined) {
    const parsed: string[] = []
    for (const raw of options.docsPathsArg.split(',')) {
      const safe = sanitizeDocsPath(raw)
      if (safe === null) {
        const trimmed = raw.trim()
        if (trimmed) {
          consola.warn(
            `Ignoring unsafe docs-path entry ${JSON.stringify(trimmed)} `
            + `(must be a relative path that stays inside its root).`,
          )
        }
        continue
      }
      parsed.push(safe)
    }
    return parsed.length > 0 ? parsed : undefined
  }

  let groups
  try {
    groups = await deps.gatherCandidates(spec, options.projectDir)
  }
  catch (err) {
    if (err instanceof CandidateGatheringError) {
      const reason = err.cause instanceof Error ? err.cause.message : String(err.cause)
      consola.warn(
        `Could not probe docs candidates for ${spec}: ${reason}. `
        + `Recording the spec without a docs-path override.`,
      )
      return undefined
    }
    throw err
  }

  const allCandidates = groups.flatMap(g => g.paths.map(abs => ({ group: g, abs })))
  const allAreRootOnly = groups.every(g => g.paths.length === 1 && g.paths[0] === g.root)

  if (!deps.isTTY() || allCandidates.length <= 1 || allAreRootOnly) {
    return undefined
  }

  const promptOptions = allCandidates.map((c) => {
    const rel = path.relative(c.group.root, c.abs)
    return {
      label: rel || '.',
      value: c.abs,
      hint: path.basename(c.group.root),
    }
  })

  const picked = await deps.prompt(
    `Select docs paths to keep for ${spec} (space to toggle, enter to confirm):`,
    { type: 'multiselect', options: promptOptions },
  ) as unknown as string[]

  if (!picked || picked.length === 0) {
    return undefined
  }

  const byAbs = new Map(allCandidates.map(c => [c.abs, c]))
  const selected: string[] = []
  for (const abs of picked) {
    const c = byAbs.get(abs)
    if (!c) {
      continue
    }
    // Root selection: `path.relative(root, root) === ''`. Persist `.`
    // so the override schema (which requires `string.min(1)`) still
    // accepts it, and so the read side can resolve it back to the
    // root via `path.resolve(rootAbs, '.')`. Without this, a
    // deliberate root pick would be silently dropped.
    const rel = path.relative(c.group.root, c.abs) || '.'
    const safe = sanitizeDocsPath(rel)
    if (safe !== null) {
      selected.push(safe)
    }
  }
  return selected.length > 0 ? selected : undefined
}

/**
 * Citty command for `ask add`. Delegates to `runAdd` with real stdout
 * and `process.exit`. Tests should call `runAdd` directly with
 * injected dependencies.
 */
export const addCmd = defineCommand({
  meta: {
    name: 'add',
    description: 'Add a library spec to ask.json and generate docs references',
  },
  args: {
    'spec': {
      type: 'positional',
      description: 'Library spec (e.g. npm:next, github:vercel/next.js@v14.2.3). Omit for interactive mode.',
      required: false,
    },
    'docs-paths': {
      type: 'string',
      description: 'Comma-separated relative docs paths; skips the interactive prompt',
    },
    'clear-docs-paths': {
      type: 'boolean',
      description: 'Remove any persisted docsPaths override and restore default discovery',
    },
  },
  async run({ args }) {
    const projectDir = process.cwd()

    if (!args.spec) {
      await runInteractiveAdd(projectDir)
      return
    }

    try {
      await runAdd({
        projectDir,
        spec: args.spec,
        docsPathsArg: args['docs-paths'],
        clearDocsPaths: Boolean(args['clear-docs-paths']),
      })
    }
    catch (err) {
      consola.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  },
})
