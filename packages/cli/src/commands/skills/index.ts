import process from 'node:process'
import { defineCommand } from 'citty'
import { skillsInstallCmd } from './install.js'
import { runSkillsList, skillsListCmd } from './list.js'
import { skillsRemoveCmd } from './remove.js'

/**
 * Citty parent command for `ask skills`. Subcommands are `list`, `install`,
 * `remove`. When invoked without a subcommand but with a positional spec,
 * falls through to `list` so `ask skills <spec>` works as a shorthand.
 */
export const skillsCmd = defineCommand({
  meta: {
    name: 'skills',
    description: 'Surface and install producer-side skills shipped by libraries',
  },
  subCommands: {
    list: skillsListCmd,
    install: skillsInstallCmd,
    remove: skillsRemoveCmd,
  },
  args: {
    'spec': { type: 'positional', description: 'Library spec (shorthand for `skills list <spec>`)', required: false },
    'no-fetch': { type: 'boolean', description: 'Return cache hit only — exit 1 on cache miss' },
  },
  async run({ args }) {
    if (!args.spec) {
      return
    }
    await runSkillsList({
      spec: args.spec,
      projectDir: process.cwd(),
      noFetch: Boolean(args['no-fetch']),
    })
  },
})

export { runSkillsInstall } from './install.js'
export { runSkillsList } from './list.js'
export { runSkillsRemove } from './remove.js'
