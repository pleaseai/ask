import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { generateAgentsMd } from '../src/agents.js'

describe('generateAgentsMd — lazy-first', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync('/tmp/ask-agents-test-')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates AGENTS.md with lazy command references', () => {
    generateAgentsMd(tmpDir, [
      { name: 'next', version: '16.2.3', spec: 'npm:next' },
    ])

    const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(content).toContain('ask docs next')
    expect(content).toContain('ask src next')
    expect(content).toContain('v16.2.3')
    expect(content).toContain('"^16"')
  })

  it('emits version warning for agents', () => {
    generateAgentsMd(tmpDir, [
      { name: 'zod', version: '3.22.0', spec: 'npm:zod' },
    ])

    const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(content).toContain('WARNING')
    expect(content).toContain('may differ from your training data')
  })

  it('contains shell substitution examples', () => {
    generateAgentsMd(tmpDir, [
      { name: 'react', version: '18.2.0', spec: 'npm:react' },
    ])

    const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(content).toContain('rg "pattern" $(ask src <package>)')
    expect(content).toContain('ask docs <package>')
  })

  it('handles multiple libraries', () => {
    generateAgentsMd(tmpDir, [
      { name: 'next', version: '16.2.3', spec: 'npm:next' },
      { name: 'zod', version: '3.22.0', spec: 'npm:zod' },
    ])

    const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(content).toContain('## next v16.2.3')
    expect(content).toContain('## zod v3.22.0')
  })

  it('returns empty string when no libraries', () => {
    const result = generateAgentsMd(tmpDir, [])
    expect(result).toBe('')
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false)
  })

  it('creates CLAUDE.md with @AGENTS.md reference', () => {
    generateAgentsMd(tmpDir, [
      { name: 'next', version: '16.2.3', spec: 'npm:next' },
    ])

    const claudeContent = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')
    expect(claudeContent).toContain('@AGENTS.md')
  })

  it('preserves existing CLAUDE.md content', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# My Project\n', 'utf-8')

    generateAgentsMd(tmpDir, [
      { name: 'next', version: '16.2.3', spec: 'npm:next' },
    ])

    const claudeContent = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')
    expect(claudeContent).toContain('# My Project')
    expect(claudeContent).toContain('@AGENTS.md')
  })

  it('replaces existing auto-generated block on re-run', () => {
    generateAgentsMd(tmpDir, [
      { name: 'next', version: '16.0.0', spec: 'npm:next' },
    ])

    generateAgentsMd(tmpDir, [
      { name: 'next', version: '16.2.3', spec: 'npm:next' },
    ])

    const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(content).toContain('v16.2.3')
    expect(content).not.toContain('v16.0.0')
    // Only one BEGIN marker
    expect(content.split('BEGIN:ask-docs-auto-generated').length).toBe(2)
  })

  it('does NOT reference .ask/docs/ paths', () => {
    generateAgentsMd(tmpDir, [
      { name: 'next', version: '16.2.3', spec: 'npm:next' },
    ])

    const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(content).not.toContain('.ask/docs/')
  })
})
