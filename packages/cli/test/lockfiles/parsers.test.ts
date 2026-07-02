import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { packageJsonReader } from '../../src/lockfiles/package-json.js'
import {
  cleanValue,
  isRegistryVersion,
  splitPkgSpec,
  stripInlineComment,
  stripPeerSuffix,
} from '../../src/lockfiles/parse-helpers.js'
import { parsePnpmLock } from '../../src/lockfiles/pnpm.js'
import { parseYarnLock } from '../../src/lockfiles/yarn.js'

// Ported from opensrc's core/version.rs test suite (vercel-labs/opensrc#51).

const FIXTURES = path.join(import.meta.dir, 'fixtures')
const YARN_V1_FIXTURE = fs.readFileSync(path.join(FIXTURES, 'yarn-v1.lock'), 'utf8')
const YARN_BERRY_FIXTURE = fs.readFileSync(path.join(FIXTURES, 'yarn-berry.lock'), 'utf8')
const PNPM_V9_FIXTURE = fs.readFileSync(path.join(FIXTURES, 'pnpm-v9-workspace.yaml'), 'utf8')

describe('parse helpers', () => {
  it('splitPkgSpec handles plain names', () => {
    expect(splitPkgSpec('zod@3.22.0')).toEqual(['zod', '3.22.0'])
  })

  it('splitPkgSpec handles scoped names', () => {
    expect(splitPkgSpec('@scope/pkg@1.2.3')).toEqual(['@scope/pkg', '1.2.3'])
  })

  it('splitPkgSpec keeps npm protocol in the rest', () => {
    expect(splitPkgSpec('zod@npm:^3.22.0')).toEqual(['zod', 'npm:^3.22.0'])
  })

  it('splitPkgSpec returns null without a separator', () => {
    expect(splitPkgSpec('zod')).toBeNull()
    expect(splitPkgSpec('@scope/pkg')).toBeNull()
  })

  it('stripPeerSuffix strips single and nested peer suffixes', () => {
    expect(stripPeerSuffix('18.0.0')).toBe('18.0.0')
    expect(stripPeerSuffix('18.0.0(react@18.0.0)')).toBe('18.0.0')
    expect(stripPeerSuffix('15.5.15(a@1)(b@2(c@3))')).toBe('15.5.15')
    expect(stripPeerSuffix('3.22.0  ')).toBe('3.22.0')
  })

  it('stripInlineComment strips only whitespace-preceded #', () => {
    expect(stripInlineComment('1.2.3')).toBe('1.2.3')
    expect(stripInlineComment('1.2.3 # comment')).toBe('1.2.3')
    expect(stripInlineComment('1.2.3  # trailing')).toBe('1.2.3')
    // URL fragment (no space before #) must pass through.
    expect(stripInlineComment('github:foo/bar#branch')).toBe('github:foo/bar#branch')
  })

  it('cleanValue trims, strips comments and quotes', () => {
    expect(cleanValue('  "1.2.3"  ')).toBe('1.2.3')
    expect(cleanValue('  1.2.3 # comment')).toBe('1.2.3')
    expect(cleanValue('  \'1.2.3\' # comment')).toBe('1.2.3')
  })

  it('isRegistryVersion rejects protocol strings and sentinels', () => {
    expect(isRegistryVersion('1.2.3')).toBe(true)
    expect(isRegistryVersion('1.0.0-beta.1')).toBe(true)
    expect(isRegistryVersion('1.0.0-rc.1+build.5114f85')).toBe(true)
    expect(isRegistryVersion('')).toBe(false)
    expect(isRegistryVersion('0.0.0-use.local')).toBe(false)
    expect(isRegistryVersion('link:../pkg')).toBe(false)
    expect(isRegistryVersion('file:./tarball.tgz')).toBe(false)
    expect(isRegistryVersion('workspace:*')).toBe(false)
    expect(isRegistryVersion('workspace:^1.0.0')).toBe(false)
    expect(isRegistryVersion('portal:../pkg')).toBe(false)
    expect(isRegistryVersion('github:owner/repo')).toBe(false)
    expect(isRegistryVersion('git+https://example.com/repo.git')).toBe(false)
    expect(isRegistryVersion('npm:other-pkg@^1')).toBe(false)
  })
})

describe('parsePnpmLock (direct lookup)', () => {
  it('parses v5 top-level string form', () => {
    const text = `lockfileVersion: '5.4'

specifiers:
  zod: ^3.22.0

dependencies:
  zod: 3.22.0

packages:
  /zod/3.22.0:
    resolution: {}
`
    expect(parsePnpmLock(text, 'zod')).toBe('3.22.0')
  })

  it('parses v6 top-level object form', () => {
    const text = `lockfileVersion: '6.0'

dependencies:
  zod:
    specifier: ^3.22.0
    version: 3.22.0

packages:
  /zod@3.22.0:
    resolution: {}
`
    expect(parsePnpmLock(text, 'zod')).toBe('3.22.0')
  })

  it('parses v9 importer with peer suffix', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      react-dom:
        specifier: ^18.0.0
        version: 18.2.0(react@18.0.0)

packages:
  react-dom@18.2.0:
    resolution: {}
`
    expect(parsePnpmLock(text, 'react-dom')).toBe('18.2.0')
  })

  it('parses scoped package in importer', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      '@scope/pkg':
        specifier: ^1.0.0
        version: 1.2.3
`
    expect(parsePnpmLock(text, '@scope/pkg')).toBe('1.2.3')
  })

  it('falls back to packages key', () => {
    const text = `lockfileVersion: '9.0'

packages:
  zod@3.22.0:
    resolution: {}
`
    expect(parsePnpmLock(text, 'zod')).toBe('3.22.0')
  })

  it('falls back to scoped packages key', () => {
    const text = `lockfileVersion: '9.0'

packages:
  '@scope/pkg@1.2.3':
    resolution: {}
`
    expect(parsePnpmLock(text, '@scope/pkg')).toBe('1.2.3')
  })

  it('returns null when absent', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      react:
        specifier: ^18.0.0
        version: 18.0.0
`
    expect(parsePnpmLock(text, 'zod')).toBeNull()
  })

  it('does not false-match inside a peer suffix', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      react-dom:
        specifier: ^18.0.0
        version: 18.2.0(react@17.0.0)
`
    expect(parsePnpmLock(text, 'react')).toBeNull()
  })

  it('first importer wins across multiple importers', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      zod:
        specifier: ^3.22.0
        version: 3.22.0
  apps/docs:
    dependencies:
      zod:
        specifier: ^3.23.0
        version: 3.23.0
`
    expect(parsePnpmLock(text, 'zod')).toBe('3.22.0')
  })

  it('reads devDependencies in importers', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    devDependencies:
      typescript:
        specifier: ^5.0.0
        version: 5.4.5
`
    expect(parsePnpmLock(text, 'typescript')).toBe('5.4.5')
  })

  it('reads optionalDependencies in importers', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    optionalDependencies:
      fsevents:
        specifier: ^2.3.0
        version: 2.3.3
`
    expect(parsePnpmLock(text, 'fsevents')).toBe('2.3.3')
  })

  it('handles CRLF line endings', () => {
    const text = 'lockfileVersion: \'9.0\'\r\n\r\nimporters:\r\n  .:\r\n    dependencies:\r\n      zod:\r\n        specifier: ^3.22.0\r\n        version: 3.22.0\r\n'
    expect(parsePnpmLock(text, 'zod')).toBe('3.22.0')
  })

  it('handles empty files', () => {
    expect(parsePnpmLock('', 'zod')).toBeNull()
  })

  it('handles comment-only files', () => {
    expect(parsePnpmLock('# just a comment\n# another one\n', 'zod')).toBeNull()
  })

  it('strips inline comments', () => {
    const text = `lockfileVersion: '9.0'

dependencies:
  zod: 3.22.0 # pinned
`
    expect(parsePnpmLock(text, 'zod')).toBe('3.22.0')
  })

  it('skips link: versions in importers', () => {
    const text = `lockfileVersion: '9.0'

importers:
  apps/web:
    dependencies:
      my-ui-lib:
        specifier: workspace:^
        version: link:../../packages/ui
`
    expect(parsePnpmLock(text, 'my-ui-lib')).toBeNull()
  })

  it('workspace link in first importer does not block later real version', () => {
    const text = `lockfileVersion: '9.0'

importers:
  apps/web:
    dependencies:
      shared:
        specifier: workspace:^
        version: link:../../packages/shared
  apps/docs:
    dependencies:
      shared:
        specifier: ^1.2.3
        version: 1.2.3
`
    expect(parsePnpmLock(text, 'shared')).toBe('1.2.3')
  })

  it('skips link: versions in top-level deps', () => {
    const text = `lockfileVersion: '6.0'

dependencies:
  my-lib: link:../my-lib
`
    expect(parsePnpmLock(text, 'my-lib')).toBeNull()
  })

  it('skips file: protocol in importers', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      tarball-pkg:
        specifier: file:./pkg.tgz
        version: file:pkg.tgz
`
    expect(parsePnpmLock(text, 'tarball-pkg')).toBeNull()
  })

  it('parses indent-relative 4-space files', () => {
    const text = `lockfileVersion: '9.0'

importers:
    .:
        dependencies:
            zod:
                specifier: ^3.22.0
                version: 3.22.0
`
    expect(parsePnpmLock(text, 'zod')).toBe('3.22.0')
  })
})

describe('parsePnpmLock (transitive resolution)', () => {
  it('resolves transitively via snapshots', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      next:
        specifier: ^14
        version: 14.0.0(react@18.2.0)

packages:

  foo@1.0.0:
    resolution: {}

  next@14.0.0:
    resolution: {}

  react@18.2.0:
    resolution: {}

snapshots:

  foo@1.0.0: {}

  next@14.0.0(react@18.2.0):
    dependencies:
      foo: 1.0.0
      react: 18.2.0

  react@18.2.0: {}
`
    expect(parsePnpmLock(text, 'foo')).toBe('1.0.0')
  })

  it('picks the root-reachable version among multiple candidates', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      next:
        specifier: ^14
        version: 14.0.0(react@18.2.0)

snapshots:

  next@14.0.0(react@18.2.0):
    dependencies:
      react: 18.2.0

  react@17.0.0: {}

  react@18.2.0: {}
`
    expect(parsePnpmLock(text, 'react')).toBe('18.2.0')
  })

  it('falls back to packages key when unreachable', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      zod:
        specifier: ^3
        version: 3.22.0

packages:

  unused@9.9.9:
    resolution: {}

  zod@3.22.0:
    resolution: {}

snapshots:

  zod@3.22.0: {}
`
    expect(parsePnpmLock(text, 'unused')).toBe('9.9.9')
  })

  it('handles dependency cycles', () => {
    const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      a:
        specifier: ^1
        version: 1.0.0

snapshots:

  a@1.0.0:
    dependencies:
      b: 1.0.0

  b@1.0.0:
    dependencies:
      a: 1.0.0
      target: 2.0.0

  target@2.0.0: {}
`
    expect(parsePnpmLock(text, 'target')).toBe('2.0.0')
  })
})

describe('parseYarnLock', () => {
  it('parses v1 single specifier', () => {
    const text = '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT DIRECTLY.\n'
      + '# yarn lockfile v1\n\n\n'
      + '"zod@^3.22.0":\n  version "3.22.0"\n'
      + '  resolved "https://registry.yarnpkg.com/zod/-/zod-3.22.0.tgz"\n'
    expect(parseYarnLock(text, 'zod')).toBe('3.22.0')
  })

  it('parses v1 multi-specifier where match is not first', () => {
    const text = '# yarn lockfile v1\n\n\n'
      + '"foo@^1.0.0":\n  version "1.0.0"\n\n'
      + '"bar@^1.0.0", "bar@~1.2.0":\n  version "1.2.3"\n'
    expect(parseYarnLock(text, 'bar')).toBe('1.2.3')
  })

  it('parses v1 scoped packages', () => {
    const text = '# yarn lockfile v1\n\n\n'
      + '"@scope/pkg@^1.0.0":\n  version "1.0.0"\n'
    expect(parseYarnLock(text, '@scope/pkg')).toBe('1.0.0')
  })

  it('parses Berry npm protocol', () => {
    const text = '# This file is generated by running "yarn install".\n\n'
      + '__metadata:\n  version: 6\n  cacheKey: 8\n\n'
      + '"zod@npm:^3.22.0":\n  version: 3.22.0\n  resolution: "zod@npm:3.22.0"\n'
    expect(parseYarnLock(text, 'zod')).toBe('3.22.0')
  })

  it('parses Berry comma-separated specifiers', () => {
    const text = '__metadata:\n  version: 6\n\n'
      + '"foo@npm:^1.0.0, foo@workspace:*":\n  version: 1.2.3\n  resolution: "foo@npm:1.2.3"\n'
    expect(parseYarnLock(text, 'foo')).toBe('1.2.3')
  })

  it('parses Berry scoped packages', () => {
    const text = '__metadata:\n  version: 6\n\n'
      + '"@scope/pkg@npm:^1.0.0":\n  version: 1.2.3\n'
    expect(parseYarnLock(text, '@scope/pkg')).toBe('1.2.3')
  })

  it('returns null when absent', () => {
    const text = '# yarn lockfile v1\n\n\n'
      + '"foo@^1.0.0":\n  version "1.0.0"\n'
    expect(parseYarnLock(text, 'zod')).toBeNull()
  })

  it('skips the __metadata block', () => {
    const text = '__metadata:\n  version: 6\n'
    expect(parseYarnLock(text, '__metadata')).toBeNull()
  })

  it('handles CRLF line endings', () => {
    const text = '# yarn lockfile v1\r\n\r\n\r\n"zod@^3.22.0":\r\n  version "3.22.0"\r\n'
    expect(parseYarnLock(text, 'zod')).toBe('3.22.0')
  })

  it('handles empty files', () => {
    expect(parseYarnLock('', 'zod')).toBeNull()
  })

  it('strips v1 inline comments', () => {
    const text = '# yarn lockfile v1\n\n\n'
      + '"zod@^3.22.0":\n  version "3.22.0" # pinned\n'
    expect(parseYarnLock(text, 'zod')).toBe('3.22.0')
  })

  it('strips Berry inline comments', () => {
    const text = '__metadata:\n  version: 6\n\n'
      + '"zod@npm:^3.22.0":\n  version: 3.22.0 # pinned\n'
    expect(parseYarnLock(text, 'zod')).toBe('3.22.0')
  })

  it('skips the Berry workspace-root sentinel', () => {
    const text = '__metadata:\n  version: 6\n\n'
      + '"myproject@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "myproject@workspace:."\n'
    expect(parseYarnLock(text, 'myproject')).toBeNull()
  })

  it('workspace block does not block a later real block', () => {
    const text = '__metadata:\n  version: 6\n\n'
      + '"foo@workspace:packages/foo":\n  version: 0.0.0-use.local\n  resolution: "foo@workspace:packages/foo"\n\n'
      + '"foo@npm:^1.0.0":\n  version: 1.2.3\n  resolution: "foo@npm:1.2.3"\n'
    expect(parseYarnLock(text, 'foo')).toBe('1.2.3')
  })

  it('skips v1 link/file protocol versions', () => {
    const text = '# yarn lockfile v1\n\n\n'
      + '"my-lib@file:../my-lib":\n  version "file:../my-lib"\n'
    expect(parseYarnLock(text, 'my-lib')).toBeNull()
  })
})

describe('fixture-backed tests', () => {
  it('yarn v1 fixture: scoped packages', () => {
    expect(parseYarnLock(YARN_V1_FIXTURE, '@babel/core')).toBe('7.23.0')
    expect(parseYarnLock(YARN_V1_FIXTURE, '@types/react')).toBe('18.2.45')
  })

  it('yarn v1 fixture: multi-specifier header', () => {
    expect(parseYarnLock(YARN_V1_FIXTURE, 'lodash')).toBe('4.17.21')
  })

  it('yarn v1 fixture: direct deps', () => {
    expect(parseYarnLock(YARN_V1_FIXTURE, 'react')).toBe('18.2.0')
    expect(parseYarnLock(YARN_V1_FIXTURE, 'typescript')).toBe('5.3.3')
    expect(parseYarnLock(YARN_V1_FIXTURE, 'zod')).toBe('3.22.4')
  })

  it('yarn v1 fixture: absent package', () => {
    expect(parseYarnLock(YARN_V1_FIXTURE, 'not-installed-anywhere')).toBeNull()
  })

  it('yarn Berry fixture: scoped with npm protocol', () => {
    expect(parseYarnLock(YARN_BERRY_FIXTURE, '@types/react')).toBe('18.2.45')
  })

  it('yarn Berry fixture: comma specifier', () => {
    expect(parseYarnLock(YARN_BERRY_FIXTURE, 'lodash')).toBe('4.17.21')
  })

  it('yarn Berry fixture: direct deps', () => {
    expect(parseYarnLock(YARN_BERRY_FIXTURE, 'react')).toBe('18.2.0')
    expect(parseYarnLock(YARN_BERRY_FIXTURE, 'typescript')).toBe('5.3.3')
  })

  it('yarn Berry fixture: absent package', () => {
    expect(parseYarnLock(YARN_BERRY_FIXTURE, 'not-installed-anywhere')).toBeNull()
  })

  it('pnpm v9 fixture: direct importer dep', () => {
    expect(parsePnpmLock(PNPM_V9_FIXTURE, 'next')).toBe('14.0.0')
  })

  it('pnpm v9 fixture: scoped direct dep', () => {
    expect(parsePnpmLock(PNPM_V9_FIXTURE, '@types/react')).toBe('18.2.45')
  })

  it('pnpm v9 fixture: first importer wins', () => {
    // apps/web (react@18.2.0) is listed before apps/legacy (react@17.0.2).
    expect(parsePnpmLock(PNPM_V9_FIXTURE, 'react')).toBe('18.2.0')
  })

  it('pnpm v9 fixture: transitive via BFS', () => {
    // js-tokens is only reachable via loose-envify; not a direct dep.
    expect(parsePnpmLock(PNPM_V9_FIXTURE, 'js-tokens')).toBe('4.0.0')
  })

  it('pnpm v9 fixture: BFS prefers version reachable from first importer', () => {
    // Both scheduler@0.20.2 (via legacy) and scheduler@0.23.0 (via web)
    // exist. BFS from roots in file order reaches 0.23.0 first.
    expect(parsePnpmLock(PNPM_V9_FIXTURE, 'scheduler')).toBe('0.23.0')
  })

  it('pnpm v9 fixture: absent package', () => {
    expect(parsePnpmLock(PNPM_V9_FIXTURE, 'definitely-not-here')).toBeNull()
  })

  it('pnpm v9 fixture: top-level typescript dev dep', () => {
    expect(parsePnpmLock(PNPM_V9_FIXTURE, 'typescript')).toBe('5.3.3')
  })
})

describe('packageJsonReader protocol filtering', () => {
  function withPackageJson(json: object, fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-pkgjson-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json))
      fn(dir)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('still returns plain ranges', () => {
    withPackageJson({ dependencies: { zod: '^3.22.0' } }, (dir) => {
      expect(packageJsonReader.read('zod', dir)).toEqual({
        version: '^3.22.0',
        source: 'package.json',
        exact: false,
      })
    })
  })

  it('skips workspace protocol', () => {
    withPackageJson({ dependencies: { 'my-lib': 'workspace:*' } }, (dir) => {
      expect(packageJsonReader.read('my-lib', dir)).toBeNull()
    })
  })

  it('skips link and file protocols', () => {
    withPackageJson({
      dependencies: { linked: 'link:../linked', tarball: 'file:./pkg.tgz' },
    }, (dir) => {
      expect(packageJsonReader.read('linked', dir)).toBeNull()
      expect(packageJsonReader.read('tarball', dir)).toBeNull()
    })
  })
})
