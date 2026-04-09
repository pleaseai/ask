/**
 * Integration test for the list command mount points.
 *
 * Spawns the compiled CLI (`dist/cli.js`) in a seeded tmp project and
 * verifies:
 *   1. `ask list` produces a rich table.
 *   2. `ask docs list` produces the same table AND a deprecation warning
 *      on stderr.
 *   3. `ask list --json` emits JSON that parses against ListModelSchema.
 *
 * The test depends on `dist/cli.js` being present — it is rebuilt once
 * per module via `execSync('tsc')` so the lifecycle stays self-contained.
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { writeLock } from '../../src/io.js'
import { ListModelSchema } from '../../src/list/model.js'
import { saveDocs } from '../../src/storage.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cliPath = path.resolve(__dirname, '../../dist/cli.js')
const pkgRoot = path.resolve(__dirname, '../..')

let tmpDir: string

beforeAll(() => {
  // Ensure dist/cli.js is present. `bun run build` runs tsc.
  if (!fs.existsSync(cliPath)) {
    execSync('bun run build', { cwd: pkgRoot, stdio: 'inherit' })
  }
})

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-list-cli-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

afterAll(() => {
  // keep dist/ for subsequent runs
})

function seedProject(): void {
  saveDocs(tmpDir, 'zod', '3.22.4', [
    { path: 'README.md', content: '# zod' },
    { path: 'docs/intro.md', content: 'intro' },
  ])
  writeLock(tmpDir, {
    lockfileVersion: 1,
    generatedAt: '2026-04-10T00:00:00Z',
    entries: {
      zod: {
        source: 'github',
        version: '3.22.4',
        fetchedAt: '2026-04-10T00:00:00Z',
        fileCount: 2,
        contentHash: `sha256-${'a'.repeat(64)}`,
        repo: 'colinhacks/zod',
        ref: 'v3.22.4',
      },
    },
  })
}

function runCli(args: string[]): { stdout: string, stderr: string, exitCode: number } {
  // Redirect to temp files and read them back. execSync inside
  // bun:test does not reliably return child stdout/stderr buffers.
  // Use a sibling temp dir for capture so the CLI cannot possibly
  // observe these files during its own run.
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-list-cap-'))
  const stdoutFile = path.join(capDir, 'stdout.log')
  const stderrFile = path.join(capDir, 'stderr.log')
  const exitFile = path.join(capDir, 'exit.log')
  // Write an explicit exit code to a file so we can distinguish
  // "child ran, exited zero, wrote nothing" from "child never ran".
  const cmd = `node ${JSON.stringify(cliPath)} ${args.map(a => JSON.stringify(a)).join(' ')} > ${JSON.stringify(stdoutFile)} 2> ${JSON.stringify(stderrFile)}; echo $? > ${JSON.stringify(exitFile)}`
  // Pass a minimal env so bun test internals (BUN_*, CONSOLA_*) don't
  // leak into the child and confuse consola's stream selection.
  execSync(cmd, {
    cwd: tmpDir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    shell: '/bin/sh',
  } as Parameters<typeof execSync>[1])
  const stdout = fs.existsSync(stdoutFile) ? fs.readFileSync(stdoutFile, 'utf-8') : ''
  const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf-8') : ''
  const exitCode = fs.existsSync(exitFile)
    ? Number.parseInt(fs.readFileSync(exitFile, 'utf-8').trim(), 10)
    : -1
  fs.rmSync(capDir, { recursive: true, force: true })
  return { stdout, stderr, exitCode }
}

describe('ask list CLI', () => {
  it('ask list renders a table with Name/Version/Format columns', () => {
    seedProject()
    const { stdout, stderr } = runCli(['list'])
    const combined = stdout + stderr
    expect(combined).toContain('Name')
    expect(combined).toContain('Version')
    expect(combined).toContain('Format')
    expect(combined).toContain('zod')
    expect(combined).toContain('3.22.4')
    expect(combined).not.toContain('deprecated')
  })

  it('ask docs list emits a deprecation warning', () => {
    seedProject()
    const { stdout, stderr } = runCli(['docs', 'list'])
    const combined = stdout + stderr
    expect(combined).toContain('deprecated')
    expect(combined).toContain('ask list')
    expect(combined).toContain('zod')
  })

  it('ask list --json emits JSON that parses against ListModelSchema', () => {
    seedProject()
    const { stdout } = runCli(['list', '--json'])
    // consola.log prefixes with [log] in some modes; the JSON body is
    // the line that begins with `{`.
    const jsonStart = stdout.indexOf('{')
    expect(jsonStart).toBeGreaterThanOrEqual(0)
    const jsonEnd = stdout.lastIndexOf('}')
    const jsonBody = stdout.slice(jsonStart, jsonEnd + 1)
    const parsed = JSON.parse(jsonBody)
    expect(() => ListModelSchema.parse(parsed)).not.toThrow()
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0].name).toBe('zod')
  })
})
