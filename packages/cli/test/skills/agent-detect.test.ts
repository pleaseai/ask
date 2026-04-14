import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { detectAgents, resolveAgentNames, SUPPORTED_AGENTS } from '../../src/skills/agent-detect.js'

let projectDir: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-agents-'))
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

describe('detectAgents', () => {
  it('returns [] for an empty project', () => {
    expect(detectAgents(projectDir)).toEqual([])
  })

  it('detects Claude Code via .claude/', () => {
    fs.mkdirSync(path.join(projectDir, '.claude'))
    const found = detectAgents(projectDir)
    expect(found.map(a => a.name)).toEqual(['claude'])
    expect(found[0].skillsDir).toBe(path.join(projectDir, '.claude', 'skills'))
  })

  it('detects multiple agents in stable order', () => {
    for (const d of ['.claude', '.cursor', '.opencode', '.codex']) {
      fs.mkdirSync(path.join(projectDir, d))
    }
    expect(detectAgents(projectDir).map(a => a.name)).toEqual(['claude', 'cursor', 'opencode', 'codex'])
  })

  it('ignores a lone AGENTS.md (not an install target)', () => {
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# agents')
    expect(detectAgents(projectDir)).toEqual([])
  })
})

describe('resolveAgentNames', () => {
  it('resolves known names without requiring the marker dir to exist', () => {
    const [claude] = resolveAgentNames(projectDir, ['claude'])
    expect(claude.name).toBe('claude')
    expect(claude.skillsDir).toBe(path.join(projectDir, '.claude', 'skills'))
  })

  it('throws on unknown names', () => {
    expect(() => resolveAgentNames(projectDir, ['nope'])).toThrow(/unknown agent/)
  })

  it('SUPPORTED_AGENTS lists all four', () => {
    expect(SUPPORTED_AGENTS.sort()).toEqual(['claude', 'codex', 'cursor', 'opencode'])
  })
})
