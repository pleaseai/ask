import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { generateAgentsMd } from '../src/agents.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-agents-ref-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function setupProject(options: {
  materialization: 'copy' | 'link' | 'ref'
  storePath?: string
  createLocalDocs?: boolean
}): string {
  const askDir = path.join(tmpDir, '.ask')
  const docsDir = path.join(askDir, 'docs', 'next@16.2.3')
  fs.mkdirSync(askDir, { recursive: true })

  if (options.createLocalDocs) {
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(path.join(docsDir, 'INDEX.md'), '# Next Docs\n')
    fs.writeFileSync(path.join(docsDir, 'README.md'), '# README\n')
  }

  // Write ask.json so listDocs picks up the entry
  fs.writeFileSync(
    path.join(tmpDir, 'ask.json'),
    JSON.stringify({ libraries: [{ spec: 'npm:next' }] }),
    'utf-8',
  )

  // Write resolved.json with the materialization setting
  fs.writeFileSync(
    path.join(askDir, 'resolved.json'),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      entries: {
        next: {
          spec: 'npm:next',
          resolvedVersion: '16.2.3',
          contentHash: `sha256-${'a'.repeat(64)}`,
          fetchedAt: new Date().toISOString(),
          fileCount: 2,
          format: 'docs',
          ...(options.storePath ? { storePath: options.storePath } : {}),
          materialization: options.materialization,
        },
      },
    }),
    'utf-8',
  )

  return tmpDir
}

describe('generateAgentsMd — ref mode', () => {
  it('emits the absolute storePath for ref mode', () => {
    const storePath = '/absolute/path/to/store/npm/next@16.2.3'
    const projectDir = setupProject({
      materialization: 'ref',
      storePath,
      createLocalDocs: false,
    })

    generateAgentsMd(projectDir)

    const agentsMd = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain(storePath)
    expect(agentsMd).toContain('next v16.2.3')
    // Should NOT contain the project-local path in ref mode
    expect(agentsMd).not.toContain('.ask/docs/next@16.2.3')
  })

  it('emits project-relative path for copy mode', () => {
    const projectDir = setupProject({
      materialization: 'copy',
      createLocalDocs: true,
    })

    generateAgentsMd(projectDir)

    const agentsMd = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain('.ask/docs/next@16.2.3')
    expect(agentsMd).toContain('next v16.2.3')
  })

  it('emits project-relative path for link mode', () => {
    const projectDir = setupProject({
      materialization: 'link',
      createLocalDocs: true,
    })

    generateAgentsMd(projectDir)

    const agentsMd = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain('.ask/docs/next@16.2.3')
  })

  it('falls back to project path when ref mode lacks storePath', () => {
    const projectDir = setupProject({
      materialization: 'ref',
      createLocalDocs: true,
      // No storePath provided
    })

    generateAgentsMd(projectDir)

    const agentsMd = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8')
    // Defaults to local path when storePath is missing
    expect(agentsMd).toContain('.ask/docs/next@16.2.3')
  })
})
