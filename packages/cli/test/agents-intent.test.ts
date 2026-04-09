import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  removeFromIntentSkillsBlock,
  upsertIntentSkillsBlock,
} from '../src/agents-intent.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-agents-intent-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function readAgents(): string {
  return fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
}

describe('upsertIntentSkillsBlock', () => {
  it('creates AGENTS.md with the marker block when absent', () => {
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', [
      { task: 'use pkg-a for auth', load: 'node_modules/pkg-a/skills/auth/SKILL.md' },
    ])
    const content = readAgents()
    expect(content).toContain('<!-- intent-skills:start -->')
    expect(content).toContain('<!-- intent-skills:end -->')
    expect(content).toContain('# Skill mappings')
    expect(content).toContain('skills:')
    expect(content).toContain('  - task: "use pkg-a for auth"')
    expect(content).toContain('    load: "node_modules/pkg-a/skills/auth/SKILL.md"')
  })

  it('is idempotent: repeating the same upsert yields identical bytes', () => {
    const skills = [
      { task: 't1', load: 'node_modules/pkg-a/skills/s1/SKILL.md' },
      { task: 't2', load: 'node_modules/pkg-a/skills/s2/SKILL.md' },
    ]
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', skills)
    const first = readAgents()
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', skills)
    const second = readAgents()
    expect(second).toBe(first)
  })

  it('preserves entries from other packages when upserting', () => {
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', [
      { task: 'a-task', load: 'node_modules/pkg-a/skills/x/SKILL.md' },
    ])
    upsertIntentSkillsBlock(tmpDir, 'pkg-b', [
      { task: 'b-task', load: 'node_modules/pkg-b/skills/y/SKILL.md' },
    ])
    const content = readAgents()
    expect(content).toContain('node_modules/pkg-a/skills/x/SKILL.md')
    expect(content).toContain('node_modules/pkg-b/skills/y/SKILL.md')
  })

  it('replaces only the target package entries on re-upsert', () => {
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', [
      { task: 'old-task', load: 'node_modules/pkg-a/skills/x/SKILL.md' },
    ])
    upsertIntentSkillsBlock(tmpDir, 'pkg-b', [
      { task: 'b-task', load: 'node_modules/pkg-b/skills/y/SKILL.md' },
    ])
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', [
      { task: 'new-task', load: 'node_modules/pkg-a/skills/x/SKILL.md' },
    ])
    const content = readAgents()
    expect(content).not.toContain('old-task')
    expect(content).toContain('new-task')
    expect(content).toContain('b-task')
  })

  it('does not modify bytes outside the marker block', () => {
    const preexisting = '# My Project\n\nSome intro.\n\n## Section\n\nBody.\n'
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), preexisting, 'utf-8')
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', [
      { task: 't', load: 'node_modules/pkg-a/skills/s/SKILL.md' },
    ])
    const content = readAgents()
    expect(content.startsWith(preexisting.trimEnd())).toBe(true)
  })

  it('leaves the existing ask-docs-auto-generated block fully intact (marker isolation)', () => {
    const askBlock
      = '<!-- BEGIN:ask-docs-auto-generated -->\n# Documentation References\n\n## zod v3.22.4\n\n- Version: `3.22.4`\n<!-- END:ask-docs-auto-generated -->'
    const preexisting = `# Project\n\n${askBlock}\n`
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), preexisting, 'utf-8')
    upsertIntentSkillsBlock(tmpDir, 'pkg-intent', [
      { task: 'use pkg-intent', load: 'node_modules/pkg-intent/skills/s/SKILL.md' },
    ])
    const after = readAgents()
    // Ask block is preserved byte-for-byte.
    expect(after).toContain(askBlock)
    // Intent block is present.
    expect(after).toContain('<!-- intent-skills:start -->')
    expect(after).toContain('<!-- intent-skills:end -->')
    // Now remove the intent block and verify the ask block is still
    // untouched — neither writer reads past the other's markers.
    removeFromIntentSkillsBlock(tmpDir, 'pkg-intent')
    const afterRemove = readAgents()
    expect(afterRemove).toContain(askBlock)
    expect(afterRemove).not.toContain('<!-- intent-skills:start -->')
  })

  it('handles scoped package names via load-path prefix matching', () => {
    upsertIntentSkillsBlock(tmpDir, '@scope/pkg', [
      { task: 't', load: 'node_modules/@scope/pkg/skills/s/SKILL.md' },
    ])
    upsertIntentSkillsBlock(tmpDir, 'other', [
      { task: 't2', load: 'node_modules/other/skills/s/SKILL.md' },
    ])
    upsertIntentSkillsBlock(tmpDir, '@scope/pkg', [
      { task: 't-updated', load: 'node_modules/@scope/pkg/skills/s/SKILL.md' },
    ])
    const content = readAgents()
    expect(content).not.toContain('"t"')
    expect(content).toContain('t-updated')
    expect(content).toContain('t2')
  })

  it('escapes double quotes and backslashes in task and load values', () => {
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', [
      { task: 'has "quotes" and \\slash', load: 'node_modules/pkg-a/skills/x/SKILL.md' },
    ])
    const content = readAgents()
    expect(content).toContain('"has \\"quotes\\" and \\\\slash"')
  })

  it('round-trips values containing a backslash adjacent to a quote', () => {
    // Regression guard for the double-pass unescape bug: the value
    // `\"` (literal backslash + literal quote) must survive
    // encode → parse → re-emit without losing the backslash.
    const originalTask = 'literal \\" pair'
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', [
      { task: originalTask, load: 'node_modules/pkg-a/skills/x/SKILL.md' },
    ])
    // Force a parse-then-serialize cycle by upserting a DIFFERENT
    // package against the same AGENTS.md — the writer will read the
    // existing pkg-a entry, parse it, and re-emit it alongside the
    // new pkg-b entry. If unescape is lossy, pkg-a's task value will
    // drift here.
    upsertIntentSkillsBlock(tmpDir, 'pkg-b', [
      { task: 'unrelated', load: 'node_modules/pkg-b/skills/y/SKILL.md' },
    ])
    const content = readAgents()
    // The re-emitted form must still carry the backslash-quote pair.
    expect(content).toContain('literal \\\\\\" pair')
  })
})

describe('removeFromIntentSkillsBlock', () => {
  it('returns false when AGENTS.md has no block', () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# hi\n', 'utf-8')
    const removed = removeFromIntentSkillsBlock(tmpDir, 'pkg-a')
    expect(removed).toBe(false)
  })

  it('returns false when the block exists but has no matching package', () => {
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', [
      { task: 't', load: 'node_modules/pkg-a/skills/x/SKILL.md' },
    ])
    const removed = removeFromIntentSkillsBlock(tmpDir, 'pkg-unknown')
    expect(removed).toBe(false)
  })

  it('strips only the target package entries, preserves siblings', () => {
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', [
      { task: 'a-task', load: 'node_modules/pkg-a/skills/x/SKILL.md' },
    ])
    upsertIntentSkillsBlock(tmpDir, 'pkg-b', [
      { task: 'b-task', load: 'node_modules/pkg-b/skills/y/SKILL.md' },
    ])
    const removed = removeFromIntentSkillsBlock(tmpDir, 'pkg-a')
    expect(removed).toBe(true)
    const content = readAgents()
    expect(content).not.toContain('a-task')
    expect(content).toContain('b-task')
    expect(content).toContain('<!-- intent-skills:start -->')
  })

  it('strips the whole block when the last entry is removed', () => {
    upsertIntentSkillsBlock(tmpDir, 'pkg-a', [
      { task: 'a-task', load: 'node_modules/pkg-a/skills/x/SKILL.md' },
    ])
    removeFromIntentSkillsBlock(tmpDir, 'pkg-a')
    const content = readAgents()
    expect(content).not.toContain('<!-- intent-skills:start -->')
    expect(content).not.toContain('<!-- intent-skills:end -->')
  })
})
