import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runInstall } from '../../src/install.js'
import { readResolvedJson } from '../../src/io.js'
import { npmStorePath, stampEntry, writeEntryAtomic } from '../../src/store/index.js'

let tmpDir: string
let origAskHome: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-e2e-'))
  origAskHome = process.env.ASK_HOME
  process.env.ASK_HOME = path.join(tmpDir, 'ask-home')
})

afterEach(() => {
  if (origAskHome === undefined) {
    delete process.env.ASK_HOME
  }
  else {
    process.env.ASK_HOME = origAskHome
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Set up a project directory with an ask.json pointing at a package
 * that's already "installed" in node_modules.
 */
function setupProject(storeMode: 'copy' | 'link' | 'ref' | undefined): string {
  const projectDir = path.join(tmpDir, 'project')
  fs.mkdirSync(projectDir, { recursive: true })

  // Create node_modules/fake-pkg so lockfile reader finds a version
  const pkgDir = path.join(projectDir, 'node_modules', 'fake-pkg')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'fake-pkg', version: '1.0.0' }),
    'utf-8',
  )
  // Don't create docs in node_modules — we want the store-hit path.

  // Create a package-lock.json so the lockfile reader can resolve
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'test-project',
      dependencies: { 'fake-pkg': '1.0.0' },
    }),
    'utf-8',
  )
  fs.writeFileSync(
    path.join(projectDir, 'package-lock.json'),
    JSON.stringify({
      name: 'test-project',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'test-project',
          dependencies: { 'fake-pkg': '1.0.0' },
        },
        'node_modules/fake-pkg': {
          version: '1.0.0',
        },
      },
    }),
    'utf-8',
  )

  // ask.json
  const askJson: { libraries: { spec: string }[], storeMode?: string } = {
    libraries: [{ spec: 'npm:fake-pkg' }],
  }
  if (storeMode)
    askJson.storeMode = storeMode
  fs.writeFileSync(
    path.join(projectDir, 'ask.json'),
    JSON.stringify(askJson),
    'utf-8',
  )

  return projectDir
}

function prepopulateStore(): void {
  const storeDir = npmStorePath(process.env.ASK_HOME!, 'fake-pkg', '1.0.0')
  writeEntryAtomic(storeDir, [
    { path: 'intro.md', content: '# Fake Package\n\nIntroduction' },
    { path: 'api.md', content: '# API\n\nMethods' },
  ])
  stampEntry(storeDir)
}

describe('runInstall E2E — store-hit short-circuit', () => {
  it('uses store entry when available, persists storePath + materialization', async () => {
    const projectDir = setupProject('copy')
    prepopulateStore()

    const summary = await runInstall(projectDir)

    // One package was installed from the store
    expect(summary.installed).toBe(1)
    expect(summary.failed).toBe(0)

    // Project-local docs exist with the expected content
    const docsDir = path.join(projectDir, '.ask', 'docs', 'fake-pkg@1.0.0')
    expect(fs.existsSync(docsDir)).toBe(true)
    expect(fs.readFileSync(path.join(docsDir, 'intro.md'), 'utf-8')).toBe('# Fake Package\n\nIntroduction')

    // resolved.json records storePath + materialization
    const resolved = readResolvedJson(projectDir)
    const entry = resolved.entries['fake-pkg']!
    expect(entry.materialization).toBe('copy')
    expect(entry.storePath).toBe(npmStorePath(process.env.ASK_HOME!, 'fake-pkg', '1.0.0'))
  })

  it('respects storeMode: ref in ask.json (no project-local docs)', async () => {
    const projectDir = setupProject('ref')
    prepopulateStore()

    const summary = await runInstall(projectDir)
    expect(summary.installed).toBe(1)

    // No project-local docs in ref mode
    const docsDir = path.join(projectDir, '.ask', 'docs', 'fake-pkg@1.0.0')
    expect(fs.existsSync(docsDir)).toBe(false)

    // resolved.json records ref mode
    const resolved = readResolvedJson(projectDir)
    expect(resolved.entries['fake-pkg']!.materialization).toBe('ref')
  })

  it('CLI storeMode option overrides ask.json.storeMode', async () => {
    const projectDir = setupProject('copy') // ask.json says copy
    prepopulateStore()

    // But we pass ref at CLI
    const summary = await runInstall(projectDir, { storeMode: 'ref' })
    expect(summary.installed).toBe(1)

    // ref mode — no project-local docs
    const docsDir = path.join(projectDir, '.ask', 'docs', 'fake-pkg@1.0.0')
    expect(fs.existsSync(docsDir)).toBe(false)

    const resolved = readResolvedJson(projectDir)
    expect(resolved.entries['fake-pkg']!.materialization).toBe('ref')
  })

  it('defaults to copy mode when storeMode is unspecified', async () => {
    const projectDir = setupProject(undefined)
    prepopulateStore()

    const summary = await runInstall(projectDir)
    expect(summary.installed).toBe(1)

    const docsDir = path.join(projectDir, '.ask', 'docs', 'fake-pkg@1.0.0')
    expect(fs.existsSync(docsDir)).toBe(true)

    const resolved = readResolvedJson(projectDir)
    expect(resolved.entries['fake-pkg']!.materialization).toBe('copy')
  })
})
