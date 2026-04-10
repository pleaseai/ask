import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runInstall } from '../../src/install.js'
import { writeAskJson } from '../../src/io.js'

/**
 * Integration tests for emitSkill precedence (T006, SC-1 through SC-4).
 *
 * Uses a local node_modules fixture so NpmSource.tryLocalRead fires and
 * we never hit the network. A bun.lock fixture provides the version pin.
 *
 * SC-1: default install omits .claude/skills/<name>-docs/SKILL.md
 * SC-2: --emit-skill flag creates SKILL.md
 * SC-3: ask.json emitSkill: true creates SKILL.md
 * SC-4: CLI flag (--emit-skill) overrides ask.json emitSkill: false
 */

const FIXTURE_PKG = 'test-lib'
const FIXTURE_VERSION = '1.2.3'
const FIXTURE_DOCS_PATH = 'dist/docs'

/**
 * Create a minimal project directory with:
 * - bun.lock pinning FIXTURE_PKG@FIXTURE_VERSION
 * - node_modules/FIXTURE_PKG with package.json + dist/docs/index.md
 */
function createFixtureProject(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-emit-skill-'))

  // bun.lock: text-based format; the reader scans for "<name>@<version>" tokens
  fs.writeFileSync(
    path.join(tmpDir, 'bun.lock'),
    `{\n  "packages": {\n    "${FIXTURE_PKG}": ["${FIXTURE_PKG}@${FIXTURE_VERSION}", "https://registry.npmjs.org/${FIXTURE_PKG}/-/${FIXTURE_PKG}-${FIXTURE_VERSION}.tgz", {}, "sha512-fake"]\n  }\n}\n`,
  )

  // node_modules/test-lib/package.json
  const pkgDir = path.join(tmpDir, 'node_modules', FIXTURE_PKG)
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: FIXTURE_PKG, version: FIXTURE_VERSION }),
  )

  // node_modules/test-lib/dist/docs/index.md
  const docsDir = path.join(pkgDir, FIXTURE_DOCS_PATH)
  fs.mkdirSync(docsDir, { recursive: true })
  fs.writeFileSync(path.join(docsDir, 'index.md'), `# ${FIXTURE_PKG} docs\n`)

  return tmpDir
}

describe('emitSkill precedence in runInstall (SC-1 through SC-4)', () => {
  let tmpDir: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tmpDir = createFixtureProject()
    // NpmSource.tryLocalRead reads from process.cwd(), so we must cd in.
    process.chdir(tmpDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function skillPath(): string {
    return path.join(tmpDir, '.claude', 'skills', `${FIXTURE_PKG}-docs`, 'SKILL.md')
  }

  it('SC-1: default install does NOT create SKILL.md', async () => {
    writeAskJson(tmpDir, {
      libraries: [{ spec: `npm:${FIXTURE_PKG}`, docsPath: FIXTURE_DOCS_PATH }],
    })

    await runInstall(tmpDir)

    expect(fs.existsSync(skillPath())).toBe(false)
  })

  it('SC-3: ask.json emitSkill: true DOES create SKILL.md', async () => {
    writeAskJson(tmpDir, {
      libraries: [{ spec: `npm:${FIXTURE_PKG}`, docsPath: FIXTURE_DOCS_PATH }],
      emitSkill: true,
    })

    await runInstall(tmpDir)

    expect(fs.existsSync(skillPath())).toBe(true)
  })

  it('SC-2: --emit-skill CLI flag DOES create SKILL.md (ask.json omits emitSkill)', async () => {
    writeAskJson(tmpDir, {
      libraries: [{ spec: `npm:${FIXTURE_PKG}`, docsPath: FIXTURE_DOCS_PATH }],
    })

    await runInstall(tmpDir, { emitSkill: true })

    expect(fs.existsSync(skillPath())).toBe(true)
  })

  it('SC-4: CLI flag true overrides ask.json emitSkill: false', async () => {
    writeAskJson(tmpDir, {
      libraries: [{ spec: `npm:${FIXTURE_PKG}`, docsPath: FIXTURE_DOCS_PATH }],
      emitSkill: false,
    })

    await runInstall(tmpDir, { emitSkill: true })

    expect(fs.existsSync(skillPath())).toBe(true)
  })

  it('SC-5: toggling emitSkill on after cached install generates SKILL.md without --force', async () => {
    writeAskJson(tmpDir, {
      libraries: [{ spec: `npm:${FIXTURE_PKG}`, docsPath: FIXTURE_DOCS_PATH }],
    })

    // First install: no emitSkill → docs cached, no SKILL.md
    await runInstall(tmpDir)
    expect(fs.existsSync(skillPath())).toBe(false)

    // Second install: emitSkill toggled on → cache hits but SKILL.md generated
    await runInstall(tmpDir, { emitSkill: true })
    expect(fs.existsSync(skillPath())).toBe(true)
  })
})
