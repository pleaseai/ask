import { describe, expect, it } from 'bun:test'
import { resolveCsp } from '../../src/commands/resolve-csp.js'

describe('resolveCsp', () => {
  it('returns CSP_BIN override verbatim without a filesystem probe', () => {
    expect(
      resolveCsp({
        env: { CSP_BIN: '/opt/csp/bin/csp', PATH: '/usr/bin' },
        platform: 'linux',
        isExecutable: () => false, // even if nothing is executable, override wins
      }),
    ).toBe('/opt/csp/bin/csp')
  })

  it('finds csp on PATH (POSIX)', () => {
    const found = resolveCsp({
      env: { PATH: '/usr/bin:/usr/local/bin' },
      platform: 'linux',
      isExecutable: (p: string) => p === '/usr/local/bin/csp',
    })
    expect(found).toBe('/usr/local/bin/csp')
  })

  it('returns null when csp is not on PATH', () => {
    expect(
      resolveCsp({
        env: { PATH: '/usr/bin:/bin' },
        platform: 'linux',
        isExecutable: () => false,
      }),
    ).toBeNull()
  })

  it('returns null when PATH is empty and no override', () => {
    expect(resolveCsp({ env: {}, platform: 'linux', isExecutable: () => false })).toBeNull()
  })

  it('honours PATHEXT on win32 (csp.exe)', () => {
    const found = resolveCsp({
      env: { Path: 'C\\\\tools', PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      isExecutable: (p: string) => p.toLowerCase().endsWith('csp.exe'),
    })
    expect(found?.toLowerCase().endsWith('csp.exe')).toBe(true)
  })

  it('does not resolve .cmd/.bat shims (unspawnable without a shell)', () => {
    const found = resolveCsp({
      env: { Path: 'C\\\\tools', PATHEXT: '.CMD;.BAT' },
      platform: 'win32',
      // even though a csp.cmd "exists", it must be filtered out
      isExecutable: (p: string) => p.toLowerCase().endsWith('csp.cmd'),
    })
    expect(found).toBeNull()
  })

  it('ignores a blank CSP_BIN and falls through to PATH', () => {
    const found = resolveCsp({
      env: { CSP_BIN: '   ', PATH: '/bin' },
      platform: 'linux',
      isExecutable: (p: string) => p === '/bin/csp',
    })
    expect(found).toBe('/bin/csp')
  })
})
