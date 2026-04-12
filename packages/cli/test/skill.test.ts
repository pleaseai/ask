import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { generateSkill, getSkillDir, removeSkill } from '../src/skill.js'

describe('generateSkill (lazy-first)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync('/tmp/ask-skill-test-')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates SKILL.md with ask src and ask docs references', () => {
    generateSkill(tmpDir, 'next', '16.2.3')

    const skillPath = path.join(getSkillDir(tmpDir, 'next'), 'SKILL.md')
    expect(fs.existsSync(skillPath)).toBe(true)

    const content = fs.readFileSync(skillPath, 'utf-8')
    expect(content).toContain('ask src next')
    expect(content).toContain('ask docs next')
    expect(content).toContain('v16.2.3')
    expect(content).toContain('"^16"')
  })

  it('emits shell substitution examples', () => {
    generateSkill(tmpDir, 'zod', '3.22.0')

    const content = fs.readFileSync(
      path.join(getSkillDir(tmpDir, 'zod'), 'SKILL.md'),
      'utf-8',
    )
    expect(content).toContain('rg "pattern" $(ask src zod)')
    expect(content).toContain('$(ask docs zod)')
  })

  it('emits frontmatter with trigger description', () => {
    generateSkill(tmpDir, 'next', '16.2.3')

    const content = fs.readFileSync(
      path.join(getSkillDir(tmpDir, 'next'), 'SKILL.md'),
      'utf-8',
    )
    expect(content).toContain('name: next-docs')
    expect(content).toContain('TRIGGER when writing or modifying code that imports or uses next')
  })

  it('does NOT reference .ask/docs/ paths', () => {
    generateSkill(tmpDir, 'next', '16.2.3')

    const content = fs.readFileSync(
      path.join(getSkillDir(tmpDir, 'next'), 'SKILL.md'),
      'utf-8',
    )
    expect(content).not.toContain('.ask/docs/')
  })
})

describe('removeSkill', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync('/tmp/ask-skill-test-')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes skill directory', () => {
    generateSkill(tmpDir, 'next', '16.2.3')
    const skillDir = getSkillDir(tmpDir, 'next')
    expect(fs.existsSync(skillDir)).toBe(true)

    removeSkill(tmpDir, 'next')
    expect(fs.existsSync(skillDir)).toBe(false)
  })

  it('is a no-op when skill does not exist', () => {
    expect(() => removeSkill(tmpDir, 'nonexistent')).not.toThrow()
  })
})
