import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { resolveAgentNames } from '../../skills/agent-detect.js'
import { readLock, removeEntry, writeLockAtomic } from '../../skills/lock.js'
import { unlinkIfOwned } from '../../skills/symlinks.js'
import { removeVendorDir, VENDOR_ROOT } from '../../skills/vendor.js'

export interface RunSkillsRemoveOptions {
  /** Full user spec OR the spec-key directly. Resolution falls back to matching `spec` field. */
  spec: string
  projectDir: string
  ignoreMissing?: boolean
}

export interface RunSkillsRemoveDeps {
  log?: (msg: string) => void
  error?: (msg: string) => void
  exit?: (code: number) => void
}

/**
 * `ask skills remove <spec>` — reverse a prior `install` using the lock as
 * the source of truth. Never touches real directories or symlinks that
 * point somewhere else.
 */
export async function runSkillsRemove(
  options: RunSkillsRemoveOptions,
  deps: RunSkillsRemoveDeps = {},
): Promise<void> {
  const log = deps.log ?? ((msg: string) => consola.info(msg))
  const error = deps.error ?? ((msg: string) => consola.error(msg))
  const exit = deps.exit ?? ((code: number) => process.exit(code))

  const lock = readLock(options.projectDir)
  const entry = Object.values(lock.entries).find(
    e => e.specKey === options.spec || e.spec === options.spec,
  )

  if (!entry) {
    if (options.ignoreMissing) {
      log(`no lock entry for ${options.spec} — nothing to do`)
      return
    }
    error(`no lock entry for ${options.spec}. Pass --ignore-missing to silence.`)
    exit(1)
    return
  }

  const vendorDir = path.join(options.projectDir, VENDOR_ROOT, entry.specKey)
  let unlinked = 0
  for (const skill of entry.skills) {
    const agents = resolveAgentNames(options.projectDir, skill.agents)
    for (const agent of agents) {
      const linkPath = path.join(agent.skillsDir, skill.name)
      const targetPath = path.join(vendorDir, skill.name)
      if (unlinkIfOwned(linkPath, targetPath)) {
        unlinked++
      }
    }
  }

  removeVendorDir(options.projectDir, entry.specKey)
  writeLockAtomic(options.projectDir, removeEntry(lock, entry.specKey))

  log(`removed ${unlinked} symlink(s) and vendored copy for ${options.spec}`)
}

export const skillsRemoveCmd = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a previously-installed skill set by spec',
  },
  args: {
    'spec': { type: 'positional', description: 'Spec (same as used with install) or spec-key', required: true },
    'ignore-missing': { type: 'boolean', description: 'Silently succeed if the spec has no lock entry' },
  },
  async run({ args }) {
    await runSkillsRemove({
      spec: args.spec,
      projectDir: process.cwd(),
      ignoreMissing: Boolean(args['ignore-missing']),
    })
  },
})
