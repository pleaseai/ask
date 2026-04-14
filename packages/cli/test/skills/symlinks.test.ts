import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { linkSkill, SymlinkConflictError, unlinkIfOwned } from '../../src/skills/symlinks.js'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-symlink-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('linkSkill', () => {
  it('creates a relative symlink and auto-mkdirs the parent', () => {
    const targetPath = path.join(root, '.ask/skills/npm__x__1/alpha')
    fs.mkdirSync(targetPath, { recursive: true })
    const linkPath = path.join(root, '.claude/skills/alpha')

    linkSkill({ linkPath, targetPath })

    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(linkPath)).toBe('../../.ask/skills/npm__x__1/alpha')
  })

  it('is a no-op when the same symlink already exists', () => {
    const targetPath = path.join(root, '.ask/skills/npm__x__1/alpha')
    fs.mkdirSync(targetPath, { recursive: true })
    const linkPath = path.join(root, '.claude/skills/alpha')
    linkSkill({ linkPath, targetPath })
    expect(() => linkSkill({ linkPath, targetPath })).not.toThrow()
  })

  it('throws SymlinkConflictError when a real dir exists and force=false', () => {
    const targetPath = path.join(root, '.ask/skills/npm__x__1/alpha')
    fs.mkdirSync(targetPath, { recursive: true })
    const linkPath = path.join(root, '.claude/skills/alpha')
    fs.mkdirSync(linkPath, { recursive: true })

    expect(() => linkSkill({ linkPath, targetPath })).toThrow(SymlinkConflictError)
  })

  it('replaces a conflicting entry when force=true', () => {
    const targetPath = path.join(root, '.ask/skills/npm__x__1/alpha')
    fs.mkdirSync(targetPath, { recursive: true })
    const linkPath = path.join(root, '.claude/skills/alpha')
    fs.mkdirSync(linkPath, { recursive: true })

    linkSkill({ linkPath, targetPath, force: true })
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
  })
})

describe('unlinkIfOwned', () => {
  it('removes a symlink whose target matches and returns true', () => {
    const targetPath = path.join(root, '.ask/skills/npm__x__1/alpha')
    fs.mkdirSync(targetPath, { recursive: true })
    const linkPath = path.join(root, '.claude/skills/alpha')
    linkSkill({ linkPath, targetPath })

    expect(unlinkIfOwned(linkPath, targetPath)).toBe(true)
    expect(fs.existsSync(linkPath)).toBe(false)
  })

  it('leaves mismatched symlinks in place and returns false', () => {
    const target1 = path.join(root, '.ask/skills/npm__x__1/alpha')
    const target2 = path.join(root, '.ask/skills/npm__other__2/alpha')
    fs.mkdirSync(target1, { recursive: true })
    fs.mkdirSync(target2, { recursive: true })
    const linkPath = path.join(root, '.claude/skills/alpha')
    linkSkill({ linkPath, targetPath: target1 })

    expect(unlinkIfOwned(linkPath, target2)).toBe(false)
    expect(fs.existsSync(linkPath)).toBe(true)
  })

  it('never deletes a real directory', () => {
    const linkPath = path.join(root, '.claude/skills/alpha')
    fs.mkdirSync(linkPath, { recursive: true })
    expect(unlinkIfOwned(linkPath, path.join(root, 'anything'))).toBe(false)
    expect(fs.existsSync(linkPath)).toBe(true)
  })
})
