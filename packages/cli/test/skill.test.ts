import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { generateSkill } from '../src/skill.js'

/**
 * Tests for SKILL.md generation. The "When the docs cannot be found"
 * fallback section is required (added in npm-tarball-docs-20260408 / T-12)
 * so that agents can recover docs from `node_modules` when the .ask/docs
 * directory is missing.
 */

describe('generateSkill', () => {
  let projectDir: string | null = null

  afterEach(() => {
    if (projectDir) {
      fs.rmSync(projectDir, { recursive: true, force: true })
      projectDir = null
    }
  })

  it('emits a fallback "When the docs cannot be found" section that points at node_modules', () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-skill-'))
    const skillPath = generateSkill(projectDir, 'ai', '5.1.0', ['index.md', 'guides/agents.md'])
    const content = fs.readFileSync(skillPath, 'utf-8')

    // Section header
    expect(content).toContain('## When the docs cannot be found')

    // Mentions the curated dist/docs path first
    expect(content).toContain('node_modules/ai/dist/docs/')

    // Mentions the fallback `docs/` and root `*.md` locations
    expect(content).toContain('node_modules/ai/docs/')
    expect(content).toContain('node_modules/ai/*.md')

    // Mentions scoped package guidance so agents know how to handle @scope/pkg
    expect(content).toContain('@scope/pkg')

    // Mentions the registration suggestion command
    expect(content).toContain('ask docs add npm:ai')
  })

  it('emits the available-guides table of contents above the fallback section', () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-skill-'))
    const skillPath = generateSkill(projectDir, 'zod', '3.22.0', ['INDEX.md', 'guide.md'])
    const content = fs.readFileSync(skillPath, 'utf-8')

    const tocIdx = content.indexOf('## Available Guides')
    const fallbackIdx = content.indexOf('## When the docs cannot be found')
    expect(tocIdx).toBeGreaterThan(0)
    expect(fallbackIdx).toBeGreaterThan(tocIdx)

    // INDEX.md should be filtered out of the TOC (existing behavior we
    // shouldn't regress on).
    const tocSlice = content.slice(tocIdx, fallbackIdx)
    expect(tocSlice).not.toContain('INDEX.md')
    expect(tocSlice).toContain('guide.md')
  })
})
