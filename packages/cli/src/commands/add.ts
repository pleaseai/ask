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
    const parsed = options.docsPathsArg
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
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
    const rel = path.relative(c.group.root, c.abs)
    if (rel) {
      selected.push(rel)
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
