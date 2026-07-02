import { describe, expect, it } from 'bun:test'
import { authenticatedCloneUrl } from '../../src/sources/github.js'

// Ported from opensrc's authenticated-clone host-validation tests
// (vercel-labs/opensrc#52 + #66).

const TOKEN = 'ghp_test_token'

describe('authenticatedCloneUrl', () => {
  it('injects credentials on an exact github.com host match', () => {
    expect(authenticatedCloneUrl('https://github.com/owner/repo.git', TOKEN))
      .toBe(`https://x-access-token:${TOKEN}@github.com/owner/repo.git`)
  })

  it('matches the host case-insensitively', () => {
    expect(authenticatedCloneUrl('https://GitHub.com/owner/repo.git', TOKEN))
      .toContain(`x-access-token:${TOKEN}@`)
  })

  it('returns the URL unchanged when no token is set', () => {
    expect(authenticatedCloneUrl('https://github.com/owner/repo.git', undefined))
      .toBe('https://github.com/owner/repo.git')
    expect(authenticatedCloneUrl('https://github.com/owner/repo.git', ''))
      .toBe('https://github.com/owner/repo.git')
  })

  it('rejects host-prefix confusion (github.com.evil.com)', () => {
    expect(authenticatedCloneUrl('https://github.com.evil.com/owner/repo.git', TOKEN))
      .toBe('https://github.com.evil.com/owner/repo.git')
  })

  it('rejects host-suffix confusion (evilgithub.com)', () => {
    expect(authenticatedCloneUrl('https://evilgithub.com/owner/repo.git', TOKEN))
      .toBe('https://evilgithub.com/owner/repo.git')
  })

  it('rejects subdomains (gist.github.com)', () => {
    expect(authenticatedCloneUrl('https://gist.github.com/owner/repo.git', TOKEN))
      .toBe('https://gist.github.com/owner/repo.git')
  })

  it('rejects non-https schemes', () => {
    expect(authenticatedCloneUrl('http://github.com/owner/repo.git', TOKEN))
      .toBe('http://github.com/owner/repo.git')
    expect(authenticatedCloneUrl('git://github.com/owner/repo.git', TOKEN))
      .toBe('git://github.com/owner/repo.git')
  })

  it('leaves ssh remotes untouched', () => {
    expect(authenticatedCloneUrl('git@github.com:owner/repo.git', TOKEN))
      .toBe('git@github.com:owner/repo.git')
  })

  it('leaves unparseable URLs untouched', () => {
    expect(authenticatedCloneUrl('not a url', TOKEN)).toBe('not a url')
  })
})
