import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { runSkillsInstall } from '../../src/commands/skills/install.js'
import { runSkillsRemove } from '../../src/commands/skills/remove.js'
import { readLock } from '../../src/skills/lock.js'

/**
 * End-to-end coverage of ask skills install/remove using a synthetic
 * checkout tree. ensureCheckout is mocked so the test never touches the
 * real GitHub store or network.
 */

let projectDir: string
let checkoutDir: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-skills-e2e-proj-'))
  checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-skills-e2e-ck-'))
  // Synthetic producer skills under the checkout.
  const skillsRoot = path.join(checkoutDir, 'skills')
  fs.mkdirSync(path.join(skillsRoot, 'alpha'), { recursive: true })
  fs.writeFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'alpha v1')
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(checkoutDir, { recursive: true, force: true })
})

function mockEnsureCheckout() {
  return mock(async () => ({
    parsed: { kind: 'github', owner: 'acme', repo: 'skills-lib', name: 'skills-lib' } as any,
    owner: 'acme',
    repo: 'skills-lib',
    ref: 'v1.0.0',
    resolvedVersion: 'v1.0.0',
    checkoutDir,
  }))
}

function quiet() {
  return {
    log: () => {},
    error: () => {},
    exit: (code: number) => { throw new Error(`exit ${code}`) },
  }
}

function createClaudeMarker() {
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true })
}

describe('skills install/remove (integration)', () => {
  it('installs into .claude/skills/ when only Claude is detected', async () => {
    createClaudeMarker()
    const ensureCheckout = mockEnsureCheckout()
    // Need a fake ask.json for manageIgnoreFiles to do anything.
    fs.writeFileSync(path.join(projectDir, 'ask.json'), JSON.stringify({ libraries: [] }))

    await runSkillsInstall(
      { spec: 'github:acme/skills-lib@v1.0.0', projectDir },
      { ensureCheckout, ...quiet() },
    )

    // Vendored copy.
    const vendorDir = path.join(projectDir, '.ask/skills/github__acme__skills-lib__v1.0.0/alpha')
    expect(fs.existsSync(path.join(vendorDir, 'SKILL.md'))).toBe(true)

    // Symlink in agent dir.
    const link = path.join(projectDir, '.claude/skills/alpha')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf-8')).toBe('alpha v1')

    // Lock entry present.
    const lock = readLock(projectDir)
    const entry = Object.values(lock.entries)[0]
    expect(entry.skills[0].name).toBe('alpha')
    expect(entry.skills[0].agents).toEqual(['claude'])
  })

  it('re-install is idempotent', async () => {
    createClaudeMarker()
    fs.writeFileSync(path.join(projectDir, 'ask.json'), JSON.stringify({ libraries: [] }))
    const ensureCheckout = mockEnsureCheckout()

    await runSkillsInstall({ spec: 'github:acme/skills-lib@v1.0.0', projectDir }, { ensureCheckout, ...quiet() })
    // Second run should not throw.
    await runSkillsInstall({ spec: 'github:acme/skills-lib@v1.0.0', projectDir }, { ensureCheckout, ...quiet() })

    const lock = readLock(projectDir)
    expect(Object.keys(lock.entries)).toHaveLength(1)
  })

  it('remove undoes install cleanly', async () => {
    createClaudeMarker()
    fs.writeFileSync(path.join(projectDir, 'ask.json'), JSON.stringify({ libraries: [] }))
    const ensureCheckout = mockEnsureCheckout()
    await runSkillsInstall({ spec: 'github:acme/skills-lib@v1.0.0', projectDir }, { ensureCheckout, ...quiet() })

    await runSkillsRemove({ spec: 'github:acme/skills-lib@v1.0.0', projectDir }, quiet())

    expect(fs.existsSync(path.join(projectDir, '.claude/skills/alpha'))).toBe(false)
    expect(fs.existsSync(path.join(projectDir, '.ask/skills/github__acme__skills-lib__v1.0.0'))).toBe(false)
    expect(readLock(projectDir).entries).toEqual({})
  })

  it('remove refuses missing entry without --ignore-missing', async () => {
    await expect(
      runSkillsRemove({ spec: 'npm:nope@1.0.0', projectDir }, quiet()),
    ).rejects.toThrow(/exit 1/)
  })

  it('install without detectable agent exits 1', async () => {
    const ensureCheckout = mockEnsureCheckout()
    await expect(
      runSkillsInstall({ spec: 'github:acme/skills-lib@v1.0.0', projectDir }, { ensureCheckout, ...quiet() }),
    ).rejects.toThrow(/exit 1/)
  })
})
