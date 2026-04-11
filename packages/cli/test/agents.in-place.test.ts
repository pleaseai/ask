import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { generateAgentsMd } from '../src/agents.js'
import { upsertResolvedEntry, writeAskJson } from '../src/io.js'

/**
 * Tests for AGENTS.md in-place block generation (SC-2, T014).
 */

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-agents-inplace-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(file: string, content: string): void {
  const full = path.join(tmpDir, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

const validHash = `sha256-${'a'.repeat(64)}`
const validIso = '2026-04-10T00:00:00+00:00'

describe('generateAgentsMd — in-place entries', () => {
  it('SC-2: emits "shipped by the package" / "bun install keeps them in sync" wording for in-place entries', () => {
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:next' }] })
    upsertResolvedEntry(tmpDir, 'next', {
      spec: 'npm:next',
      resolvedVersion: '16.2.3',
      contentHash: validHash,
      fetchedAt: validIso,
      fileCount: 42,
      format: 'docs',
      materialization: 'in-place',
      inPlacePath: 'node_modules/next/dist/docs',
    })

    generateAgentsMd(tmpDir)

    const agentsMd = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain('shipped by the package')
    expect(agentsMd).toContain('bun install')
    expect(agentsMd).toContain('node_modules/next/dist/docs/')
    expect(agentsMd).toContain('v16.2.3')
    // Should NOT contain .ask/docs/ path or INDEX.md reference
    expect(agentsMd).not.toContain('.ask/docs/next@16.2.3/')
    expect(agentsMd).not.toContain('INDEX.md')
  })

  it('emits standard wording for copy-materialized entries', () => {
    writeAskJson(tmpDir, { libraries: [{ spec: 'npm:lodash' }] })
    // Create the docs dir so listDocs can count files
    write('.ask/docs/lodash@4.17.21/INDEX.md', '# lodash docs')
    upsertResolvedEntry(tmpDir, 'lodash', {
      spec: 'npm:lodash',
      resolvedVersion: '4.17.21',
      contentHash: validHash,
      fetchedAt: validIso,
      fileCount: 1,
      format: 'docs',
    })

    generateAgentsMd(tmpDir)

    const agentsMd = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain('.ask/docs/lodash@4.17.21/')
    expect(agentsMd).toContain('INDEX.md')
    expect(agentsMd).not.toContain('shipped by the package')
  })

  it('handles mixed in-place and copy entries in the same AGENTS.md', () => {
    writeAskJson(tmpDir, {
      libraries: [
        { spec: 'npm:next' },
        { spec: 'npm:lodash' },
      ],
    })
    write('.ask/docs/lodash@4.17.21/INDEX.md', '# lodash docs')

    upsertResolvedEntry(tmpDir, 'next', {
      spec: 'npm:next',
      resolvedVersion: '16.2.3',
      contentHash: validHash,
      fetchedAt: validIso,
      fileCount: 42,
      format: 'docs',
      materialization: 'in-place',
      inPlacePath: 'node_modules/next/dist/docs',
    })
    upsertResolvedEntry(tmpDir, 'lodash', {
      spec: 'npm:lodash',
      resolvedVersion: '4.17.21',
      contentHash: validHash,
      fetchedAt: validIso,
      fileCount: 1,
      format: 'docs',
    })

    generateAgentsMd(tmpDir)

    const agentsMd = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    // next block: in-place wording
    expect(agentsMd).toContain('node_modules/next/dist/docs/')
    expect(agentsMd).toContain('shipped by the package')
    // lodash block: copy wording
    expect(agentsMd).toContain('.ask/docs/lodash@4.17.21/')
  })
})
