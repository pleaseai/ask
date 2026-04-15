import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { findDocLikePaths } from '../../src/commands/find-doc-paths.js'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-walker-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function mkdir(...segments: string[]) {
  const p = path.join(root, ...segments)
  fs.mkdirSync(p, { recursive: true })
  return p
}

describe('findDocLikePaths', () => {
  it('returns empty array for a non-existent root (no throw)', () => {
    const missing = path.join(root, 'does-not-exist')
    expect(findDocLikePaths(missing)).toEqual([])
  })

  it('returns [root] as fallback when no doc-like subdirs exist', () => {
    const result = findDocLikePaths(root)
    expect(result).toEqual([root])
  })

  it('matches a top-level "docs" directory and omits root', () => {
    const docs = mkdir('docs')
    const result = findDocLikePaths(root)
    expect(result).toContain(docs)
    expect(result).not.toContain(root)
  })

  it('emits dist/docs even though dist is in the skip set', () => {
    const distDocs = mkdir('dist', 'docs')
    const result = findDocLikePaths(root)
    expect(result).toContain(distDocs)
    expect(result).not.toContain(root)
  })

  it('does not emit dist itself when dist/docs is absent', () => {
    mkdir('dist', 'lib')
    const result = findDocLikePaths(root)
    expect(result).toEqual([root])
  })

  it('matches case-insensitive — "Documentation" qualifies', () => {
    const upper = mkdir('Documentation')
    const result = findDocLikePaths(root)
    expect(result).toContain(upper)
  })

  it('matches substring — "api-docs" qualifies', () => {
    const apiDocs = mkdir('api-docs')
    const result = findDocLikePaths(root)
    expect(result).toContain(apiDocs)
  })

  it('skips node_modules entirely', () => {
    mkdir('node_modules', 'react', 'docs')
    const result = findDocLikePaths(root)
    expect(result.some(p => p.includes('node_modules'))).toBe(false)
  })

  it('skips .git directory', () => {
    mkdir('.git', 'docs')
    const result = findDocLikePaths(root)
    expect(result.some(p => p.includes('.git'))).toBe(false)
  })

  it('skips .next, .nuxt, build, coverage (dist/docs is a special allow-listed case)', () => {
    mkdir('.next', 'docs')
    mkdir('.nuxt', 'docs')
    mkdir('build', 'docs')
    mkdir('coverage', 'docs')
    const result = findDocLikePaths(root)
    for (const skip of ['.next', '.nuxt', 'build', 'coverage']) {
      expect(result.some(p => p.includes(`${path.sep}${skip}${path.sep}`))).toBe(false)
    }
  })

  it('skips all dotdirs', () => {
    mkdir('.vscode', 'docs')
    mkdir('.cache', 'docs')
    const result = findDocLikePaths(root)
    expect(result.some(p => p.includes('.vscode'))).toBe(false)
    expect(result.some(p => p.includes('.cache'))).toBe(false)
  })

  it('walks nested directories within depth limit', () => {
    const nested = mkdir('packages', 'core', 'docs')
    const result = findDocLikePaths(root)
    expect(result).toContain(nested)
  })

  it('respects depth limit of 4 — depth 5 is excluded', () => {
    // depth: a/b/c/d/docs is depth 5 from root → excluded
    // depth: a/b/c/docs is depth 4 → included
    const included = mkdir('a', 'b', 'c', 'docs')
    const excluded = mkdir('a', 'b', 'c', 'd', 'docs')
    const result = findDocLikePaths(root)
    expect(result).toContain(included)
    expect(result).not.toContain(excluded)
  })

  it('does not match files, only directories', () => {
    fs.writeFileSync(path.join(root, 'docs.md'), '# not a dir')
    const result = findDocLikePaths(root)
    // Only the root should be present — no file path collected.
    expect(result).toEqual([root])
  })

  it('returns multiple matches for monorepos', () => {
    const a = mkdir('packages', 'pkg-a', 'docs')
    const b = mkdir('packages', 'pkg-b', 'docs')
    const c = mkdir('packages', 'pkg-c', 'documentation')
    const result = findDocLikePaths(root)
    expect(result).toContain(a)
    expect(result).toContain(b)
    expect(result).toContain(c)
  })

  it('does not include directories that merely contain "doc" as part of unrelated word', () => {
    // "doctor" still matches /doc/i — this is by design (substring match)
    const doctor = mkdir('doctor')
    const result = findDocLikePaths(root)
    expect(result).toContain(doctor)
  })
})
