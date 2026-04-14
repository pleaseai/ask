import type { AgentTarget } from '../../skills/agent-detect.js'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { manageIgnoreFiles } from '../../ignore-files.js'
import { detectAgents, resolveAgentNames } from '../../skills/agent-detect.js'
import { readLock, upsertEntry, writeLockAtomic } from '../../skills/lock.js'
import { encodeSpecKey } from '../../skills/spec-key.js'
import { linkSkill } from '../../skills/symlinks.js'
import { vendorSkills } from '../../skills/vendor.js'
import { ensureCheckout as defaultEnsureCheckout, NoCacheError } from '../ensure-checkout.js'
import { findSkillLikePaths } from '../find-skill-paths.js'

export interface RunSkillsInstallOptions {
  spec: string
  projectDir: string
  noFetch?: boolean
  force?: boolean
  /** Explicit agent list (CSV from CLI). Overrides detection + prompt. */
  agents?: string[]
}

export interface RunSkillsInstallDeps {
  ensureCheckout?: typeof defaultEnsureCheckout
  /** Picks agents when more than one is detected and `agents` option is unset. */
  pickAgents?: (candidates: AgentTarget[]) => Promise<AgentTarget[]>
  log?: (msg: string) => void
  error?: (msg: string) => void
  exit?: (code: number) => void
}

const SKILLS_PARENT_RE = /^skills?$/i

async function defaultPickAgents(candidates: AgentTarget[]): Promise<AgentTarget[]> {
  const picked = await consola.prompt('Install into which agents?', {
    type: 'multiselect',
    options: candidates.map(c => ({ value: c.name, label: c.label })),
    required: true,
  }) as unknown as string[]
  const byName = new Map(candidates.map(c => [c.name, c]))
  return picked.map(n => byName.get(n)!).filter(Boolean)
}

/**
 * `ask skills install <spec>` — resolve, vendor, pick agents, symlink,
 * update lock, and patch ignore files.
 */
export async function runSkillsInstall(
  options: RunSkillsInstallOptions,
  deps: RunSkillsInstallDeps = {},
): Promise<void> {
  const ensureCheckout = deps.ensureCheckout ?? defaultEnsureCheckout
  const pickAgents = deps.pickAgents ?? defaultPickAgents
  const log = deps.log ?? ((msg: string) => consola.info(msg))
  const error = deps.error ?? ((msg: string) => consola.error(msg))
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
    error(err instanceof Error ? err.message : String(err))
    exit(1)
    return
  }

  // Discover skill source directories. A source path is only treated as a
  // "skill dir" when its basename itself matches /skill/i — the walker returns
  // roots too, but roots rarely ARE the skill dir. This keeps the vendored
  // layout tidy.
  const sources = collectSkillDirs(options.projectDir, result)
  if (sources.length === 0) {
    error(`no skills/ directories found for ${options.spec}`)
    exit(1)
    return
  }

  // Agent selection: explicit flag > detect + prompt > detect-1 auto > error.
  let agents: AgentTarget[]
  if (options.agents && options.agents.length > 0) {
    agents = resolveAgentNames(options.projectDir, options.agents)
  }
  else {
    const detected = detectAgents(options.projectDir)
    if (detected.length === 0) {
      error('no supported coding agent detected in this project (.claude/, .cursor/, .opencode/, .codex/). Pass --agent <name> to force.')
      exit(1)
      return
    }
    agents = detected.length === 1 ? detected : await pickAgents(detected)
    if (agents.length === 0) {
      error('no agents selected')
      exit(1)
      return
    }
  }

  // Encode the spec-key from the resolver result.
  const ecosystem = result.npmPackageName ? 'npm' : 'github'
  const name = result.npmPackageName ?? `${result.owner}/${result.repo}`
  const specKey = encodeSpecKey({ ecosystem, name, version: result.resolvedVersion })

  // Vendor + symlink.
  const vendor = vendorSkills(options.projectDir, specKey, sources)
  const agentNames = agents.map(a => a.name)
  for (const skill of vendor.skillNames) {
    const targetPath = path.join(vendor.vendorDir, skill)
    for (const agent of agents) {
      const linkPath = path.join(agent.skillsDir, skill)
      linkSkill({ linkPath, targetPath, force: options.force })
    }
  }

  // Persist the lock.
  const lock = readLock(options.projectDir)
  const updated = upsertEntry(lock, {
    spec: options.spec,
    specKey,
    skills: vendor.skillNames.map(n => ({ name: n, agents: agentNames })),
    installedAt: new Date().toISOString(),
  })
  writeLockAtomic(options.projectDir, updated)

  // Make sure .ask/skills/ and skills-lock.json are marked vendored.
  manageIgnoreFiles(options.projectDir, 'install')

  log(`installed ${vendor.skillNames.length} skill(s) for ${options.spec} into ${agentNames.join(', ')}`)
}

/**
 * Gather the candidate individual skill directories. The walker returns the
 * `skills/` parent directories shipped by producers; each of their direct
 * subdirectories is a single skill bundle that should be vendored
 * independently so `.ask/skills/<specKey>/<skill-name>/` lines up.
 */
function collectSkillDirs(
  projectDir: string,
  result: { checkoutDir: string, npmPackageName?: string },
): string[] {
  const parents: string[] = []

  if (result.npmPackageName) {
    const nmPath = path.join(projectDir, 'node_modules', result.npmPackageName)
    if (fs.existsSync(nmPath)) {
      parents.push(...findSkillLikePaths(nmPath))
    }
  }
  parents.push(...findSkillLikePaths(result.checkoutDir))

  const skillDirs: string[] = []
  const seen = new Set<string>()
  for (const parent of parents) {
    // Tight match: only exact `skill` or `skills` (case-insensitive) qualify
    // as the producer-side "skills parent". Substring matches like `my-skills`
    // or unrelated tokens (e.g. temp-dir prefixes that happen to contain
    // "skill") are ignored to avoid vendoring unintended directories.
    if (!SKILLS_PARENT_RE.test(path.basename(parent))) {
      continue
    }
    for (const entry of safeReaddir(parent)) {
      if (!entry.isDirectory())
        continue
      const child = path.join(parent, entry.name)
      if (seen.has(child))
        continue
      seen.add(child)
      skillDirs.push(child)
    }
  }
  return skillDirs
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return []
  }
}

export const skillsInstallCmd = defineCommand({
  meta: {
    name: 'install',
    description: 'Vendor producer-side skills into .ask/skills/ and symlink into detected agent directories',
  },
  args: {
    'spec': {
      type: 'positional',
      description: 'Library spec (e.g. react, npm:react@18.2.0, github:facebook/react@v18.2.0)',
      required: true,
    },
    'no-fetch': { type: 'boolean', description: 'Return cache hit only — exit 1 on cache miss' },
    'force': { type: 'boolean', description: 'Overwrite conflicting entries in agent skills dirs' },
    'agent': { type: 'string', description: 'Explicit agent targets (CSV): claude,cursor,opencode,codex' },
  },
  async run({ args }) {
    const agents = typeof args.agent === 'string' && args.agent.length > 0
      ? args.agent.split(',').map(s => s.trim()).filter(Boolean)
      : undefined
    await runSkillsInstall({
      spec: args.spec,
      projectDir: process.cwd(),
      noFetch: Boolean(args['no-fetch']),
      force: Boolean(args.force),
      agents,
    })
  },
})
