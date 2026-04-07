import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { generateAgentsMd } from '../src/agents.js'
import { saveDocs } from '../src/storage.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-agents-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('generateAgentsMd', () => {
  it('writes nothing when there are no docs', () => {
    const result = generateAgentsMd(tmpDir)
    expect(result).toBe('')
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false)
  })

  it('references .ask/docs (not .please/docs) in the marker block', () => {
    saveDocs(tmpDir, 'zod', '3.22.4', [{ path: 'README.md', content: '# zod' }])
    generateAgentsMd(tmpDir)
    const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(content).toContain('.ask/docs/zod@3.22.4')
    expect(content).not.toContain('.please/docs/')
    expect(content).toContain('<!-- BEGIN:ask-docs-auto-generated -->')
    expect(content).toContain('<!-- END:ask-docs-auto-generated -->')
  })

  it('preserves user content outside the marker block', () => {
    const agentsPath = path.join(tmpDir, 'AGENTS.md')
    fs.writeFileSync(
      agentsPath,
      '# My Project\n\nUser-written notes.\n\n<!-- BEGIN:ask-docs-auto-generated -->\nold\n<!-- END:ask-docs-auto-generated -->\n\nMore notes.\n',
    )
    saveDocs(tmpDir, 'zod', '3.22.4', [{ path: 'README.md', content: '# zod' }])
    generateAgentsMd(tmpDir)
    const updated = fs.readFileSync(agentsPath, 'utf-8')
    expect(updated).toContain('# My Project')
    expect(updated).toContain('User-written notes.')
    expect(updated).toContain('More notes.')
    expect(updated).toContain('.ask/docs/zod@3.22.4')
    expect(updated).not.toContain('\nold\n')
  })

  it('creates CLAUDE.md with @AGENTS.md when missing', () => {
    saveDocs(tmpDir, 'zod', '3.22.4', [{ path: 'README.md', content: '# zod' }])
    generateAgentsMd(tmpDir)
    const claude = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')
    expect(claude).toContain('@AGENTS.md')
  })

  it('does not duplicate @AGENTS.md when CLAUDE.md already references it', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Project\n@AGENTS.md\n')
    saveDocs(tmpDir, 'zod', '3.22.4', [{ path: 'README.md', content: '# zod' }])
    generateAgentsMd(tmpDir)
    const claude = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')
    const occurrences = (claude.match(/@AGENTS\.md/g) ?? []).length
    expect(occurrences).toBe(1)
  })
})
