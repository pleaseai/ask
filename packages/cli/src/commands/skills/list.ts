import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { ensureCheckout as defaultEnsureCheckout, NoCacheError } from '../ensure-checkout.js'
import { findSkillLikePaths } from '../find-skill-paths.js'

export interface RunSkillsListOptions {
  spec: string
  projectDir: string
  noFetch?: boolean
}

export interface RunSkillsListDeps {
  ensureCheckout?: typeof defaultEnsureCheckout
  log?: (msg: string) => void
  error?: (msg: string) => void
  exit?: (code: number) => void
}

/**
 * Implementation of `ask skills [list] <spec>`. Resolves the spec via the
 * shared `ensureCheckout` helper, then prints every candidate skills
 * directory found under `node_modules/<pkg>/` (for npm specs that are
 * locally installed) and under the cached checkout tree.
 *
 * Output format mirrors `ask docs`: one absolute path per line. The agent
 * decides which path is the "real" producer-side skills directory.
 */
export async function runSkillsList(
  options: RunSkillsListOptions,
  deps: RunSkillsListDeps = {},
): Promise<void> {
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

  if (result.npmPackageName) {
    const nmPath = path.join(options.projectDir, 'node_modules', result.npmPackageName)
    if (fs.existsSync(nmPath)) {
      for (const p of findSkillLikePaths(nmPath)) {
        log(p)
      }
    }
  }

  for (const p of findSkillLikePaths(result.checkoutDir)) {
    log(p)
  }
}

export const skillsListCmd = defineCommand({
  meta: {
    name: 'list',
    description: 'Print all candidate producer-side skill paths from node_modules and the cached source tree',
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
    await runSkillsList({
      spec: args.spec,
      projectDir: process.cwd(),
      noFetch: Boolean(args['no-fetch']),
    })
  },
})
