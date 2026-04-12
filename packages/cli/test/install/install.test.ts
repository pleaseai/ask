import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runInstall } from '../../src/install.js'
import { readAskJson, writeAskJson } from '../../src/io.js'

describe('runInstall (lazy-first)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync('/tmp/ask-install-test-')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('bootstraps an empty ask.json when none exists', async () => {
    const result = await runInstall(tmpDir)
    expect(result.installed).toBe(0)
    expect(result.skipped).toBe(0)

    const askJson = readAskJson(tmpDir)
    expect(askJson).not.toBeNull()
    expect(askJson!.libraries).toEqual([])
  })

  it('returns zero counts when ask.json is empty', async () => {
    writeAskJson(tmpDir, { libraries: [] })

    const result = await runInstall(tmpDir)
    expect(result.installed).toBe(0)
    expect(result.skipped).toBe(0)
  })

  it('skips npm entries with no lockfile match', async () => {
    writeAskJson(tmpDir, { libraries: ['npm:nonexistent-pkg-12345'] })

    const result = await runInstall(tmpDir)
    expect(result.skipped).toBe(1)
    expect(result.installed).toBe(0)
  })

  it('does NOT create .ask/docs/<pkg>@<ver> directories (lazy mode)', async () => {
    writeAskJson(tmpDir, { libraries: ['npm:nonexistent-pkg-12345'] })

    await runInstall(tmpDir)
    // .ask/docs/ may exist (manageIgnoreFiles writes nested configs)
    // but no actual library doc directories should be created
    const docsDir = path.join(tmpDir, '.ask', 'docs')
    if (fs.existsSync(docsDir)) {
      const entries = fs.readdirSync(docsDir).filter(e => e.includes('@'))
      expect(entries).toHaveLength(0)
    }
  })

  it('does NOT create .ask/resolved.json (lazy mode)', async () => {
    writeAskJson(tmpDir, { libraries: ['npm:nonexistent-pkg-12345'] })

    await runInstall(tmpDir)
    expect(fs.existsSync(path.join(tmpDir, '.ask', 'resolved.json'))).toBe(false)
  })

  it('generates AGENTS.md for resolved libraries', async () => {
    // Create a minimal package.json + bun.lock so the lockfile reader resolves
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { next: '^16.0.0' } }),
    )
    fs.writeFileSync(
      path.join(tmpDir, 'bun.lock'),
      JSON.stringify({
        lockfileVersion: 0,
        packages: { next: ['next@16.2.3', '', {}, 'sha512-abc'] },
      }),
    )

    writeAskJson(tmpDir, { libraries: ['npm:next'] })
    await runInstall(tmpDir)

    const agentsPath = path.join(tmpDir, 'AGENTS.md')
    expect(fs.existsSync(agentsPath)).toBe(true)

    const content = fs.readFileSync(agentsPath, 'utf-8')
    expect(content).toContain('ask docs next')
    expect(content).toContain('ask src next')
  })

  it('generates SKILL.md for resolved libraries', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { next: '^16.0.0' } }),
    )
    fs.writeFileSync(
      path.join(tmpDir, 'bun.lock'),
      JSON.stringify({
        lockfileVersion: 0,
        packages: { next: ['next@16.2.3', '', {}, 'sha512-abc'] },
      }),
    )

    writeAskJson(tmpDir, { libraries: ['npm:next'] })
    await runInstall(tmpDir)

    const skillPath = path.join(tmpDir, '.claude', 'skills', 'next-docs', 'SKILL.md')
    expect(fs.existsSync(skillPath)).toBe(true)

    const content = fs.readFileSync(skillPath, 'utf-8')
    expect(content).toContain('ask src next')
  })
})
