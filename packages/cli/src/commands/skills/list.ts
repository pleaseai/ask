import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { ensureCheckout as defaultEnsureCheckout, NoCacheError } from '../ensure-checkout.js'

/**
 * Producer-side skills always live at a fixed `<root>/skills/` directory.
 * No other layout is supported — callers that want to surface skills
 * shipped by a library should look here.
 */
const SKILLS_BASENAME = 'skills'

function skillsDirIfExists(root: string): string | undefined {
  const candidate = path.join(root, SKILLS_BASENAME)
  try {
    if (fs.statSync(candidate).isDirectory()) {
      return candidate
    }
  }
  catch {
    // missing or not a directory
  }
  return undefined
}

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
 * shared `ensureCheckout` helper, then prints the producer-side skills
 * directory (always `<root>/skills/`) for each available source:
 *
 *   - `node_modules/<pkg>/skills/` when the npm package is installed.
 *   - `<checkoutDir>/skills/` from the cached source tree.
 *
 * Exits 1 with a helpful message when neither exists. Unlike `ask docs`,
 * skills have a fixed layout — no walking, no fallback to the repo root.
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

  const found: string[] = []
  if (result.npmPackageName) {
    const nmPath = path.join(options.projectDir, 'node_modules', result.npmPackageName)
    const nmSkills = skillsDirIfExists(nmPath)
    if (nmSkills) {
      found.push(nmSkills)
    }
  }
  const checkoutSkills = skillsDirIfExists(result.checkoutDir)
  if (checkoutSkills) {
    found.push(checkoutSkills)
  }

  if (found.length === 0) {
    error(`no skills/ directory found for ${options.spec} — try 'ask src ${options.spec}' for the checkout root`)
    exit(1)
    return
  }

  for (const p of found) {
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
