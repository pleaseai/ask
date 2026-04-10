import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runMain } from 'citty'
import { main } from '../../src/index.js'
import { writeAskJson } from '../../src/io.js'
import { getSkillDir } from '../../src/skill.js'

/**
 * Integration tests for `ask remove` skill cleanup (T007).
 *
 * Scenario: a `.claude/skills/<name>-docs/SKILL.md` was created by a prior
 * opt-in install (`emitSkill: true`). The current project no longer sets
 * `emitSkill` (it is false/undefined). Running `ask remove <pkg>` must still
 * clean up the pre-existing skill directory.
 *
 * This verifies the guarantee stated in plan.md:
 * "ask remove npm:next with a pre-existing .claude/skills/next-docs/ →
 *  directory is removed regardless of current emitSkill."
 */

async function runCli(cwd: string, args: string[]): Promise<void> {
  const original = process.cwd()
  const originalArgv = process.argv
  process.chdir(cwd)
  process.argv = ['node', 'ask', ...args]
  try {
    await runMain(main)
  }
  finally {
    process.chdir(original)
    process.argv = originalArgv
  }
}

describe('ask remove: pre-existing skill cleanup (T007)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-remove-skill-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function plantSkillDir(libName: string): string {
    const skillDir = getSkillDir(tmpDir, libName)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${libName} skill\n`)
    return skillDir
  }

  it('removes a pre-existing skill dir when emitSkill is absent from ask.json', async () => {
    // Plant ask.json with no emitSkill field (default false scenario).
    writeAskJson(tmpDir, {
      libraries: [{ spec: 'npm:next' }],
    })
    // Plant a skill directory as if a prior opt-in install had created it.
    const skillDir = plantSkillDir('next')
    expect(fs.existsSync(skillDir)).toBe(true)

    await runCli(tmpDir, ['remove', 'next'])

    expect(fs.existsSync(skillDir)).toBe(false)
  })

  it('removes a pre-existing skill dir when emitSkill is explicitly false', async () => {
    writeAskJson(tmpDir, {
      libraries: [{ spec: 'npm:zod' }],
      emitSkill: false,
    })
    const skillDir = plantSkillDir('zod')
    expect(fs.existsSync(skillDir)).toBe(true)

    await runCli(tmpDir, ['remove', 'zod'])

    expect(fs.existsSync(skillDir)).toBe(false)
  })
})
