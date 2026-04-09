import { describe, expect, it } from 'bun:test'
import {
  computeSkillNameWidth,
  formatSkillTree,
} from '../../src/display/tree.js'

describe('formatSkillTree', () => {
  it('returns empty string for empty input', () => {
    expect(formatSkillTree([], { nameWidth: 20, showTypes: false })).toBe('')
  })

  it('renders a single leaf without trailing blank lines', () => {
    const out = formatSkillTree(
      [{ name: 'hello', description: 'say hi' }],
      { nameWidth: 20, showTypes: false },
    )
    const lines = out.split('\n')
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('hello')
    expect(lines[0]).toContain('say hi')
    expect(out.endsWith('\n')).toBe(false)
  })

  it('indents root skills by 4 spaces', () => {
    const out = formatSkillTree(
      [{ name: 'root', description: 'd' }],
      { nameWidth: 20, showTypes: false },
    )
    expect(out.startsWith('    root')).toBe(true)
  })

  it('indents root/child skills by 6 spaces', () => {
    const out = formatSkillTree(
      [
        { name: 'root', description: 'parent' },
        { name: 'root/child', description: 'nested' },
      ],
      { nameWidth: 20, showTypes: false },
    )
    const lines = out.split('\n')
    expect(lines[0]!.startsWith('    root')).toBe(true)
    expect(lines[1]!.startsWith('      child')).toBe(true)
  })

  it('emits a path line when skill.path is set', () => {
    const out = formatSkillTree(
      [{ name: 'x', description: 'd', path: 'pkg/skills/x.md' }],
      { nameWidth: 10, showTypes: false },
    )
    const lines = out.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('pkg/skills/x.md')
  })

  it('includes [type] column when showTypes=true', () => {
    const out = formatSkillTree(
      [{ name: 'x', description: 'd', type: 'flow' }],
      { nameWidth: 10, showTypes: true },
    )
    expect(out).toContain('[flow]')
  })
})

describe('computeSkillNameWidth', () => {
  it('returns 2 for empty input', () => {
    expect(computeSkillNameWidth([])).toBe(2)
  })

  it('accounts for indent + longest display name + 2 padding', () => {
    // "root" → 4 + 4 = 8
    // "root/longest" → 6 + 7 = 13
    // expected = 13 + 2 = 15
    const w = computeSkillNameWidth([
      [
        { name: 'root', description: 'x' },
        { name: 'root/longest', description: 'y' },
      ],
    ])
    expect(w).toBe(15)
  })
})
