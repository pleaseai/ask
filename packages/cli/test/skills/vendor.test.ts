import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { removeVendorDir, VENDOR_ROOT, vendorSkills } from '../../src/skills/vendor.js'

let projectDir: string
let srcRoot: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-vendor-proj-'))
  srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-vendor-src-'))
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(srcRoot, { recursive: true, force: true })
})

function writeSkill(name: string, files: Record<string, string>): string {
  const dir = path.join(srcRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const [f, c] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, f), c)
  }
  return dir
}

describe('vendorSkills', () => {
  it('copies each source dir into .ask/skills/<specKey>/<basename>/', () => {
    const a = writeSkill('alpha', { 'SKILL.md': 'a' })
    const b = writeSkill('beta', { 'SKILL.md': 'b' })
    const result = vendorSkills(projectDir, 'npm__next__14.2.3', [a, b])

    expect(result.skillNames.sort()).toEqual(['alpha', 'beta'])
    expect(result.vendorDir).toBe(path.join(projectDir, VENDOR_ROOT, 'npm__next__14.2.3'))
    expect(fs.readFileSync(path.join(result.vendorDir, 'alpha', 'SKILL.md'), 'utf-8')).toBe('a')
    expect(fs.readFileSync(path.join(result.vendorDir, 'beta', 'SKILL.md'), 'utf-8')).toBe('b')
  })

  it('refreshes: a second call replaces the prior vendor dir', () => {
    const a = writeSkill('alpha', { 'SKILL.md': 'v1' })
    vendorSkills(projectDir, 'npm__x__1', [a])
    fs.writeFileSync(path.join(srcRoot, 'alpha', 'SKILL.md'), 'v2')
    vendorSkills(projectDir, 'npm__x__1', [a])
    expect(fs.readFileSync(path.join(projectDir, VENDOR_ROOT, 'npm__x__1', 'alpha', 'SKILL.md'), 'utf-8')).toBe('v2')
  })

  it('skips missing/non-directory sources', () => {
    const a = writeSkill('alpha', {})
    const missing = path.join(srcRoot, 'does-not-exist')
    const result = vendorSkills(projectDir, 'npm__x__1', [a, missing])
    expect(result.skillNames).toEqual(['alpha'])
  })

  it('removeVendorDir wipes the vendored tree', () => {
    const a = writeSkill('alpha', {})
    vendorSkills(projectDir, 'npm__x__1', [a])
    removeVendorDir(projectDir, 'npm__x__1')
    expect(fs.existsSync(path.join(projectDir, VENDOR_ROOT, 'npm__x__1'))).toBe(false)
  })
})
