import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { scoreDirectory } from '../../src/discovery/quality.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-quality-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFile(relPath: string, bytes: number): void {
  const full = path.join(tmpDir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, 'a'.repeat(bytes), 'utf-8')
}

describe('scoreDirectory', () => {
  it('returns passes:false for a non-existent directory', () => {
    const score = scoreDirectory(path.join(tmpDir, 'does-not-exist'))
    expect(score).toEqual({ fileCount: 0, totalBytes: 0, passes: false })
  })

  it('returns passes:false for a file path, not a directory', () => {
    writeFile('x.md', 100)
    const score = scoreDirectory(path.join(tmpDir, 'x.md'))
    expect(score.passes).toBe(false)
  })

  it('noise-only repo fails the threshold (SC-3 guard)', () => {
    // Only CONTRIBUTING.md and CHANGELOG.md — both excluded.
    writeFile('CONTRIBUTING.md', 5000)
    writeFile('CHANGELOG.md', 5000)
    writeFile('LICENSE', 1000)
    const score = scoreDirectory(tmpDir)
    expect(score.fileCount).toBe(0)
    expect(score.passes).toBe(false)
  })

  it('passes on count threshold (>=3 markdown files)', () => {
    writeFile('one.md', 10)
    writeFile('two.md', 10)
    writeFile('three.md', 10)
    const score = scoreDirectory(tmpDir)
    expect(score.fileCount).toBe(3)
    expect(score.passes).toBe(true)
  })

  it('passes on byte threshold (>=4 KiB) even with a single file', () => {
    writeFile('big.md', 5 * 1024)
    const score = scoreDirectory(tmpDir)
    expect(score.fileCount).toBe(1)
    expect(score.totalBytes).toBeGreaterThanOrEqual(4 * 1024)
    expect(score.passes).toBe(true)
  })

  it('walks nested subdirectories', () => {
    writeFile('a.md', 100)
    writeFile('nested/b.md', 100)
    writeFile('nested/deeper/c.md', 100)
    const score = scoreDirectory(tmpDir)
    expect(score.fileCount).toBe(3)
  })

  it('ignores non-markdown files', () => {
    writeFile('a.md', 100)
    writeFile('package.json', 5000)
    writeFile('index.ts', 5000)
    const score = scoreDirectory(tmpDir)
    expect(score.fileCount).toBe(1)
  })

  it('excludes LICENSE / CODE_OF_CONDUCT / SECURITY variants', () => {
    writeFile('LICENSE.md', 100)
    writeFile('LICENCE.md', 100)
    writeFile('CODE_OF_CONDUCT.md', 100)
    writeFile('SECURITY.md', 100)
    writeFile('real-guide.md', 100)
    const score = scoreDirectory(tmpDir)
    expect(score.fileCount).toBe(1)
  })

  it('accepts .mdx alongside .md', () => {
    writeFile('one.md', 100)
    writeFile('two.mdx', 100)
    writeFile('three.mdx', 100)
    const score = scoreDirectory(tmpDir)
    expect(score.fileCount).toBe(3)
    expect(score.passes).toBe(true)
  })
})
