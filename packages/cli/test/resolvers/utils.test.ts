import { describe, expect, it } from 'bun:test'
import { parseRepoUrl } from '../../src/resolvers/utils.js'

describe('parseRepoUrl', () => {
  it('parses git+https://github.com/owner/repo.git', () => {
    expect(parseRepoUrl('git+https://github.com/owner/repo.git')).toBe('owner/repo')
  })

  it('parses https://github.com/owner/repo.git', () => {
    expect(parseRepoUrl('https://github.com/owner/repo.git')).toBe('owner/repo')
  })

  it('parses https://github.com/owner/repo', () => {
    expect(parseRepoUrl('https://github.com/owner/repo')).toBe('owner/repo')
  })

  it('parses git://github.com/owner/repo.git', () => {
    expect(parseRepoUrl('git://github.com/owner/repo.git')).toBe('owner/repo')
  })

  it('parses ssh://git@github.com/owner/repo.git', () => {
    expect(parseRepoUrl('ssh://git@github.com/owner/repo.git')).toBe('owner/repo')
  })

  it('parses github.com/owner/repo (no protocol)', () => {
    expect(parseRepoUrl('github.com/owner/repo')).toBe('owner/repo')
  })

  it('strips trailing .git', () => {
    expect(parseRepoUrl('https://github.com/lodash/lodash.git')).toBe('lodash/lodash')
  })

  it('strips trailing slashes', () => {
    expect(parseRepoUrl('https://github.com/owner/repo/')).toBe('owner/repo')
  })

  it('handles paths with extra segments (tree/main)', () => {
    expect(parseRepoUrl('https://github.com/owner/repo/tree/main')).toBe('owner/repo')
  })

  it('returns null for non-github URLs', () => {
    expect(parseRepoUrl('https://gitlab.com/owner/repo')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseRepoUrl('')).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(parseRepoUrl(undefined)).toBeNull()
  })

  it('returns null for malformed URLs', () => {
    expect(parseRepoUrl('not a url')).toBeNull()
  })
})
