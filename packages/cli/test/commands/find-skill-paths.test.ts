import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { findSkillLikePaths } from '../../src/commands/find-skill-paths.js'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-skill-walker-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function mkdir(...segments: string[]) {
  const p = path.join(root, ...segments)
  fs.mkdirSync(p, { recursive: true })
  return p
}

describe('findSkillLikePaths', () => {
  it('returns empty array for a non-existent root (no throw)', () => {
    const missing = path.join(root, 'does-not-exist')
    expect(findSkillLikePaths(missing)).toEqual([])
  })

  it('always returns the root as the first element', () => {
    const result = findSkillLikePaths(root)
    expect(result[0]).toBe(root)
  })

  it('matches a top-level "skills" directory', () => {
    const skills = mkdir('skills')
    const result = findSkillLikePaths(root)
    expect(result).toContain(skills)
  })

  it('matches singular "skill" directory', () => {
    const skill = mkdir('skill')
    const result = findSkillLikePaths(root)
    expect(result).toContain(skill)
  })

  it('matches case-insensitive — "Skills" qualifies', () => {
    const upper = mkdir('Skills')
    const result = findSkillLikePaths(root)
    expect(result).toContain(upper)
  })

  it('matches substring — "agent-skills" qualifies', () => {
    const agentSkills = mkdir('agent-skills')
    const result = findSkillLikePaths(root)
    expect(result).toContain(agentSkills)
  })

  it('does NOT match "docs" (the doc walker\'s domain)', () => {
    mkdir('docs')
    const result = findSkillLikePaths(root)
    expect(result).toEqual([root])
  })

  it('skips node_modules entirely', () => {
    mkdir('node_modules', 'react', 'skills')
    const result = findSkillLikePaths(root)
    expect(result.some(p => p.includes('node_modules'))).toBe(false)
  })

  it('skips .git, .next, .nuxt, dist, build, coverage', () => {
    mkdir('.git', 'skills')
    mkdir('.next', 'skills')
    mkdir('.nuxt', 'skills')
    mkdir('dist', 'skills')
    mkdir('build', 'skills')
    mkdir('coverage', 'skills')
    const result = findSkillLikePaths(root)
    for (const skip of ['.git', '.next', '.nuxt', 'dist', 'build', 'coverage']) {
      expect(result.some(p => p.includes(`${path.sep}${skip}${path.sep}`))).toBe(false)
    }
  })

  it('skips all dotdirs', () => {
    mkdir('.vscode', 'skills')
    mkdir('.cache', 'skills')
    const result = findSkillLikePaths(root)
    expect(result.some(p => p.includes('.vscode'))).toBe(false)
    expect(result.some(p => p.includes('.cache'))).toBe(false)
  })

  it('walks nested directories within depth limit', () => {
    const nested = mkdir('packages', 'core', 'skills')
    const result = findSkillLikePaths(root)
    expect(result).toContain(nested)
  })

  it('respects depth limit of 4', () => {
    const included = mkdir('a', 'b', 'c', 'skills')
    const excluded = mkdir('a', 'b', 'c', 'd', 'skills')
    const result = findSkillLikePaths(root)
    expect(result).toContain(included)
    expect(result).not.toContain(excluded)
  })

  it('does not match files, only directories', () => {
    fs.writeFileSync(path.join(root, 'skills.md'), '# not a dir')
    const result = findSkillLikePaths(root)
    expect(result).toEqual([root])
  })

  it('returns multiple matches for monorepos', () => {
    const a = mkdir('packages', 'pkg-a', 'skills')
    const b = mkdir('packages', 'pkg-b', 'skills')
    const result = findSkillLikePaths(root)
    expect(result).toContain(a)
    expect(result).toContain(b)
  })
})
