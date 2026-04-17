import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runMain } from 'citty'
import { main } from '../../src/index.js'
import { runInstall } from '../../src/install.js'
import { readAskJson, writeAskJson } from '../../src/io.js'

async function runCli(cwd: string, args: string[]): Promise<void> {
  const original = process.cwd()
  const originalArgv = process.argv
  process.chdir(cwd)
  process.argv = ['node', 'ask', ...args]
  try {
    await runMain(main)
  }
  finally {
    process.chdir(original)
    process.argv = originalArgv
  }
}

function writeLockedPkg(
  tmpDir: string,
  deps: Record<string, { range: string, resolved: string }>,
): void {
  const depsJson: Record<string, string> = {}
  const lockPackages: Record<string, [string, string, Record<string, unknown>, string]> = {}
  for (const [name, { range, resolved }] of Object.entries(deps)) {
    depsJson[name] = range
    lockPackages[name] = [`${name}@${resolved}`, '', {}, 'sha512-abc']
  }
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ dependencies: depsJson }),
  )
  fs.writeFileSync(
    path.join(tmpDir, 'bun.lock'),
    JSON.stringify({ lockfileVersion: 0, packages: lockPackages }),
  )
}

describe('ask remove (lazy-first)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync('/tmp/ask-remove-test-')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes a spec from ask.json by name', () => {
    writeAskJson(tmpDir, { libraries: ['npm:next', 'npm:zod'] })

    const askJson = readAskJson(tmpDir)!
    const idx = askJson.libraries.findIndex(s => s === 'npm:next')
    askJson.libraries.splice(idx, 1)
    writeAskJson(tmpDir, askJson)

    const updated = readAskJson(tmpDir)!
    expect(updated.libraries).toEqual(['npm:zod'])
  })

  it('strips the removed library section from AGENTS.md', async () => {
    writeLockedPkg(tmpDir, {
      next: { range: '^16.0.0', resolved: '16.2.3' },
      zod: { range: '^3.0.0', resolved: '3.22.1' },
    })
    writeAskJson(tmpDir, { libraries: ['npm:next', 'npm:zod'] })
    await runCli(tmpDir, ['install'])

    const agentsPath = path.join(tmpDir, 'AGENTS.md')
    const beforeRemove = fs.readFileSync(agentsPath, 'utf-8')
    expect(beforeRemove).toContain('next v16.2.3')
    expect(beforeRemove).toContain('zod v3.22.1')

    await runCli(tmpDir, ['remove', 'next'])

    const afterRemove = fs.readFileSync(agentsPath, 'utf-8')
    expect(afterRemove).not.toContain('next v16.2.3')
    expect(afterRemove).not.toContain('ask docs next')
    expect(afterRemove).toContain('zod v3.22.1')
  })

  it('strips the whole auto-generated block when the last library is removed', async () => {
    writeLockedPkg(tmpDir, {
      next: { range: '^16.0.0', resolved: '16.2.3' },
    })
    writeAskJson(tmpDir, { libraries: ['npm:next'] })
    await runCli(tmpDir, ['install'])

    const agentsPath = path.join(tmpDir, 'AGENTS.md')
    const beforeRemove = fs.readFileSync(agentsPath, 'utf-8')
    expect(beforeRemove).toContain('<!-- BEGIN:ask-docs-auto-generated -->')
    expect(beforeRemove).toContain('next v16.2.3')

    await runCli(tmpDir, ['remove', 'next'])

    // AGENTS.md had ONLY the auto-generated block, so after stripping it
    // the file is empty and gets deleted.
    expect(fs.existsSync(agentsPath)).toBe(false)
  })

  it('preserves user content in AGENTS.md when the last library is removed', async () => {
    writeLockedPkg(tmpDir, {
      next: { range: '^16.0.0', resolved: '16.2.3' },
    })
    writeAskJson(tmpDir, { libraries: ['npm:next'] })

    const agentsPath = path.join(tmpDir, 'AGENTS.md')
    fs.writeFileSync(agentsPath, '# My Project\n\nHand-written notes here.\n')

    await runCli(tmpDir, ['install'])
    const beforeRemove = fs.readFileSync(agentsPath, 'utf-8')
    expect(beforeRemove).toContain('# My Project')
    expect(beforeRemove).toContain('<!-- BEGIN:ask-docs-auto-generated -->')

    await runCli(tmpDir, ['remove', 'next'])

    const afterRemove = fs.readFileSync(agentsPath, 'utf-8')
    expect(afterRemove).toContain('# My Project')
    expect(afterRemove).toContain('Hand-written notes here.')
    expect(afterRemove).not.toContain('<!-- BEGIN:ask-docs-auto-generated -->')
    expect(afterRemove).not.toContain('<!-- END:ask-docs-auto-generated -->')
    expect(afterRemove).not.toContain('next v16.2.3')
  })

  it('preserves user content written AFTER the auto-generated block', async () => {
    writeLockedPkg(tmpDir, {
      next: { range: '^16.0.0', resolved: '16.2.3' },
    })
    writeAskJson(tmpDir, { libraries: ['npm:next'] })

    await runCli(tmpDir, ['install'])
    const agentsPath = path.join(tmpDir, 'AGENTS.md')

    // Append user content AFTER the auto-generated block so the block sits
    // at the top, not the bottom. Exercises the `head.length === 0 ? tail`
    // branch of the strip logic.
    const afterInstall = fs.readFileSync(agentsPath, 'utf-8')
    fs.writeFileSync(agentsPath, `${afterInstall}\n# Post-block notes\n\nHand-written after install.\n`)

    await runCli(tmpDir, ['remove', 'next'])

    const afterRemove = fs.readFileSync(agentsPath, 'utf-8')
    expect(afterRemove).toContain('# Post-block notes')
    expect(afterRemove).toContain('Hand-written after install.')
    expect(afterRemove).not.toContain('<!-- BEGIN:ask-docs-auto-generated -->')
    expect(afterRemove).not.toContain('next v16.2.3')
  })

  it('leaves AGENTS.md untouched and warns when only one marker is present', async () => {
    writeLockedPkg(tmpDir, {
      next: { range: '^16.0.0', resolved: '16.2.3' },
    })
    writeAskJson(tmpDir, { libraries: ['npm:next'] })

    // Hand-corrupt AGENTS.md: BEGIN marker only, no END.
    const agentsPath = path.join(tmpDir, 'AGENTS.md')
    const corruptedContent
      = '# Project\n\n<!-- BEGIN:ask-docs-auto-generated -->\n(block was truncated)\n\n## Notes\nUser text after orphan marker.\n'
    fs.writeFileSync(agentsPath, corruptedContent)

    await runCli(tmpDir, ['remove', 'next'])

    const afterRemove = fs.readFileSync(agentsPath, 'utf-8')
    expect(afterRemove).toBe(corruptedContent)
  })

  it('leaves AGENTS.md untouched when onlySpecs matches nothing in ask.json', async () => {
    writeLockedPkg(tmpDir, {
      next: { range: '^16.0.0', resolved: '16.2.3' },
    })
    writeAskJson(tmpDir, { libraries: ['npm:next'] })
    await runCli(tmpDir, ['install'])

    const agentsPath = path.join(tmpDir, 'AGENTS.md')
    const beforeScoped = fs.readFileSync(agentsPath, 'utf-8')
    expect(beforeScoped).toContain('next v16.2.3')

    // Scoped install where onlySpecs is not in ask.json → targets=[] but the
    // !options.onlySpecs guard must skip the AGENTS.md wipe. Regression test
    // for the guard in runInstall at the empty-targets branch.
    await runInstall(tmpDir, { onlySpecs: ['npm:not-in-ask-json'] })

    const afterScoped = fs.readFileSync(agentsPath, 'utf-8')
    expect(afterScoped).toBe(beforeScoped)
  })
})
