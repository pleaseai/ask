/**
 * End-to-end lifecycle test for vendored-docs ignore management.
 *
 * This test exercises the `add` path via direct calls to the underlying
 * modules (not the CLI runner) so we avoid spawning a subprocess. It
 * verifies that after saving a doc:
 *
 *   - Nested configs inside `.ask/docs/` exist
 *   - AGENTS.md contains the vendored notice
 *   - A detected root `.prettierignore` is patched
 *
 * And that after simulating the `remove` cleanup path:
 *
 *   - Nested configs are gone
 *   - Root `.prettierignore` marker block is gone
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { generateAgentsMd } from '../src/agents.js'
import { manageIgnoreFiles } from '../src/ignore-files.js'
import { writeLock } from '../src/io.js'
import { saveDocs } from '../src/storage.js'

let tmpDir: string

function seedZodLock(): void {
  writeLock(tmpDir, {
    lockfileVersion: 1,
    generatedAt: '2026-04-10T00:00:00Z',
    entries: {
      zod: {
        source: 'github',
        version: '3.22.4',
        fetchedAt: '2026-04-10T00:00:00Z',
        fileCount: 1,
        contentHash: `sha256-${'a'.repeat(64)}`,
        repo: 'colinhacks/zod',
        ref: 'v3.22.4',
      },
    },
  })
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-lifecycle-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('ignore-files lifecycle', () => {
  it('install path produces all expected artifacts', () => {
    // Simulate an existing project with a Prettier ignore file.
    fs.writeFileSync(path.join(tmpDir, '.prettierignore'), 'node_modules\ndist\n')

    // Pretend the user ran `ask docs add zod`:
    saveDocs(tmpDir, 'zod', '3.22.4', [{ path: 'README.md', content: '# zod' }])
    seedZodLock()
    generateAgentsMd(tmpDir)
    manageIgnoreFiles(tmpDir, 'install')

    // Nested configs inside .ask/docs/
    const docsDir = path.join(tmpDir, '.ask', 'docs')
    expect(fs.existsSync(path.join(docsDir, '.gitattributes'))).toBe(true)
    expect(fs.existsSync(path.join(docsDir, 'eslint.config.mjs'))).toBe(true)
    expect(fs.existsSync(path.join(docsDir, 'biome.json'))).toBe(true)
    expect(fs.existsSync(path.join(docsDir, '.markdownlint-cli2.jsonc'))).toBe(true)

    // AGENTS.md has the vendored notice
    const agents = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('Vendored Documentation')

    // Root .prettierignore was patched (existing content preserved)
    const prettier = fs.readFileSync(path.join(tmpDir, '.prettierignore'), 'utf-8')
    expect(prettier).toContain('node_modules')
    expect(prettier).toContain('dist')
    expect(prettier).toContain('# ask:start')
    expect(prettier).toContain('.ask/docs/')
    expect(prettier).toContain('# ask:end')
  })

  it('remove path cleans up all artifacts but preserves user files', () => {
    fs.writeFileSync(path.join(tmpDir, '.prettierignore'), 'node_modules\n')
    saveDocs(tmpDir, 'zod', '3.22.4', [{ path: 'README.md', content: '# zod' }])
    seedZodLock()
    generateAgentsMd(tmpDir)
    manageIgnoreFiles(tmpDir, 'install')

    // Simulate `ask docs remove zod` → last doc removed → cleanup.
    manageIgnoreFiles(tmpDir, 'remove')

    // Nested configs gone
    const docsDir = path.join(tmpDir, '.ask', 'docs')
    expect(fs.existsSync(path.join(docsDir, '.gitattributes'))).toBe(false)
    expect(fs.existsSync(path.join(docsDir, 'eslint.config.mjs'))).toBe(false)
    expect(fs.existsSync(path.join(docsDir, 'biome.json'))).toBe(false)
    expect(fs.existsSync(path.join(docsDir, '.markdownlint-cli2.jsonc'))).toBe(false)

    // .prettierignore still exists, user content preserved, marker removed
    const prettier = fs.readFileSync(path.join(tmpDir, '.prettierignore'), 'utf-8')
    expect(prettier).toContain('node_modules')
    expect(prettier).not.toContain('# ask:start')
    expect(prettier).not.toContain('.ask/docs/')
  })

  it('is idempotent: running install twice produces a stable result', () => {
    fs.writeFileSync(path.join(tmpDir, '.prettierignore'), 'node_modules\n')
    saveDocs(tmpDir, 'zod', '3.22.4', [{ path: 'README.md', content: '# zod' }])
    manageIgnoreFiles(tmpDir, 'install')
    const firstPrettier = fs.readFileSync(path.join(tmpDir, '.prettierignore'), 'utf-8')
    const firstGitattributes = fs.readFileSync(
      path.join(tmpDir, '.ask', 'docs', '.gitattributes'),
      'utf-8',
    )

    manageIgnoreFiles(tmpDir, 'install')
    const secondPrettier = fs.readFileSync(path.join(tmpDir, '.prettierignore'), 'utf-8')
    const secondGitattributes = fs.readFileSync(
      path.join(tmpDir, '.ask', 'docs', '.gitattributes'),
      'utf-8',
    )

    expect(secondPrettier).toBe(firstPrettier)
    expect(secondGitattributes).toBe(firstGitattributes)
  })
})
