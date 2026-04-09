import { describe, expect, it } from 'bun:test'
import {
  aliasSchema,
  findPackageByAlias,
  isMonorepoEntry,
  packageSchema,
  registryEntrySchema,
  slugifyPackageName,
  sourceSchema,
} from '../src/index.js'

describe('sourceSchema', () => {
  it('parses a valid npm source', () => {
    const result = sourceSchema.parse({
      type: 'npm',
      package: '@mastra/core',
      path: 'dist/docs',
    })
    expect(result.type).toBe('npm')
  })

  it('parses a valid github source with tag', () => {
    const result = sourceSchema.parse({
      type: 'github',
      repo: 'vercel/next.js',
      tag: 'v15.0.0',
      path: 'docs',
    })
    expect(result.type).toBe('github')
  })

  it('parses a valid web source', () => {
    const result = sourceSchema.parse({
      type: 'web',
      urls: ['https://tailwindcss.com/docs'],
      maxDepth: 2,
      allowedPathPrefix: '/docs',
    })
    expect(result.type).toBe('web')
  })

  it('parses a valid llms-txt source', () => {
    const result = sourceSchema.parse({
      type: 'llms-txt',
      url: 'https://example.com/llms.txt',
    })
    expect(result.type).toBe('llms-txt')
  })

  it('rejects unknown source type', () => {
    expect(() => sourceSchema.parse({ type: 'invalid' })).toThrow()
  })

  it('rejects a github source with both branch and tag', () => {
    expect(() => sourceSchema.parse({
      type: 'github',
      repo: 'vercel/next.js',
      branch: 'main',
      tag: 'v15.0.0',
    })).toThrow(/mutually exclusive/)
  })

  it('accepts a github source with only branch', () => {
    const result = sourceSchema.parse({ type: 'github', repo: 'vercel/next.js', branch: 'canary' })
    expect(result.type).toBe('github')
  })

  it('requires npm.package (no silent default to entry name)', () => {
    expect(() => sourceSchema.parse({ type: 'npm', path: 'docs' })).toThrow()
  })

  it('rejects github without repo', () => {
    expect(() => sourceSchema.parse({ type: 'github', path: 'docs' })).toThrow()
  })

  it('rejects github with malformed repo', () => {
    expect(() => sourceSchema.parse({ type: 'github', repo: 'no-slash' })).toThrow()
  })

  it('rejects web without urls', () => {
    expect(() => sourceSchema.parse({ type: 'web' })).toThrow()
  })

  it('rejects web with empty urls array', () => {
    expect(() => sourceSchema.parse({ type: 'web', urls: [] })).toThrow()
  })
})

describe('aliasSchema', () => {
  it('parses a valid alias', () => {
    const result = aliasSchema.parse({ ecosystem: 'npm', name: 'react' })
    expect(result.ecosystem).toBe('npm')
    expect(result.name).toBe('react')
  })

  it('rejects an unknown ecosystem', () => {
    expect(() => aliasSchema.parse({ ecosystem: 'invalid', name: 'x' })).toThrow()
  })
})

describe('packageSchema', () => {
  it('parses a single-source package', () => {
    const result = packageSchema.parse({
      name: 'zod',
      aliases: [{ ecosystem: 'npm', name: 'zod' }],
      sources: [{ type: 'github', repo: 'colinhacks/zod', path: 'docs' }],
    })
    expect(result.sources).toHaveLength(1)
  })

  it('parses a package with a fallback chain', () => {
    const result = packageSchema.parse({
      name: 'ai',
      aliases: [{ ecosystem: 'npm', name: 'ai' }],
      sources: [
        { type: 'npm', package: 'ai', path: 'dist/docs' },
        { type: 'github', repo: 'vercel/ai', path: 'content/docs' },
      ],
    })
    expect(result.sources).toHaveLength(2)
  })

  it('requires at least one alias', () => {
    expect(() => packageSchema.parse({
      name: 'zod',
      aliases: [],
      sources: [{ type: 'github', repo: 'colinhacks/zod' }],
    })).toThrow()
  })

  it('requires at least one source', () => {
    expect(() => packageSchema.parse({
      name: 'zod',
      aliases: [{ ecosystem: 'npm', name: 'zod' }],
      sources: [],
    })).toThrow()
  })
})

describe('registryEntrySchema', () => {
  const singlePackageEntry = {
    name: 'Zod',
    description: 'TypeScript-first schema validation',
    repo: 'colinhacks/zod',
    packages: [
      {
        name: 'zod',
        aliases: [{ ecosystem: 'npm' as const, name: 'zod' }],
        sources: [{ type: 'github' as const, repo: 'colinhacks/zod', path: 'docs' }],
      },
    ],
  }

  const monorepoEntry = {
    name: 'Mastra',
    description: 'AI agent framework',
    repo: 'mastra-ai/mastra',
    packages: [
      {
        name: '@mastra/core',
        aliases: [{ ecosystem: 'npm' as const, name: '@mastra/core' }],
        sources: [{ type: 'npm' as const, package: '@mastra/core', path: 'dist/docs' }],
      },
      {
        name: '@mastra/memory',
        aliases: [{ ecosystem: 'npm' as const, name: '@mastra/memory' }],
        sources: [{ type: 'npm' as const, package: '@mastra/memory', path: 'dist/docs' }],
      },
    ],
  }

  it('parses a single-package entry', () => {
    const result = registryEntrySchema.parse(singlePackageEntry)
    expect(result.packages).toHaveLength(1)
  })

  it('parses a monorepo entry', () => {
    const result = registryEntrySchema.parse(monorepoEntry)
    expect(result.packages).toHaveLength(2)
  })

  it('rejects invalid repo format', () => {
    expect(() => registryEntrySchema.parse({
      ...singlePackageEntry,
      repo: 'no-slash',
    })).toThrow()
  })

  it('rejects entries without packages', () => {
    expect(() => registryEntrySchema.parse({
      name: 'Empty',
      description: 'empty',
      repo: 'foo/bar',
      packages: [],
    })).toThrow()
  })

  it('rejects duplicate aliases across packages', () => {
    expect(() => registryEntrySchema.parse({
      name: 'Clash',
      description: 'duplicate alias test',
      repo: 'foo/bar',
      packages: [
        {
          name: 'a',
          aliases: [{ ecosystem: 'npm' as const, name: 'shared' }],
          sources: [{ type: 'github' as const, repo: 'foo/bar' }],
        },
        {
          name: 'b',
          aliases: [{ ecosystem: 'npm' as const, name: 'shared' }],
          sources: [{ type: 'github' as const, repo: 'foo/bar' }],
        },
      ],
    })).toThrow(/Duplicate alias/)
  })

  it('rejects package names that slugify to the same directory', () => {
    // Different names, same slug: `@a/b-c` and `a-b-c` both → `a-b-c`
    expect(() => registryEntrySchema.parse({
      name: 'SlugClash',
      description: 'slug collision test',
      repo: 'foo/bar',
      packages: [
        {
          name: '@a/b-c',
          aliases: [{ ecosystem: 'npm' as const, name: '@a/b-c' }],
          sources: [{ type: 'github' as const, repo: 'foo/bar' }],
        },
        {
          name: 'a-b-c',
          aliases: [{ ecosystem: 'npm' as const, name: 'a-b-c' }],
          sources: [{ type: 'github' as const, repo: 'foo/bar' }],
        },
      ],
    })).toThrow(/slugifies/)
  })

  it('rejects duplicate package names', () => {
    expect(() => registryEntrySchema.parse({
      name: 'Clash',
      description: 'duplicate package name',
      repo: 'foo/bar',
      packages: [
        {
          name: 'dup',
          aliases: [{ ecosystem: 'npm' as const, name: 'a' }],
          sources: [{ type: 'github' as const, repo: 'foo/bar' }],
        },
        {
          name: 'dup',
          aliases: [{ ecosystem: 'npm' as const, name: 'b' }],
          sources: [{ type: 'github' as const, repo: 'foo/bar' }],
        },
      ],
    })).toThrow(/Duplicate package name/)
  })
})

describe('findPackageByAlias', () => {
  const entry = registryEntrySchema.parse({
    name: 'Mastra',
    description: 'AI agent framework',
    repo: 'mastra-ai/mastra',
    packages: [
      {
        name: '@mastra/core',
        aliases: [{ ecosystem: 'npm' as const, name: '@mastra/core' }],
        sources: [{ type: 'npm' as const, package: '@mastra/core', path: 'dist/docs' }],
      },
      {
        name: '@mastra/memory',
        aliases: [{ ecosystem: 'npm' as const, name: '@mastra/memory' }],
        sources: [{ type: 'npm' as const, package: '@mastra/memory', path: 'dist/docs' }],
      },
    ],
  })

  it('finds the matching package', () => {
    const pkg = findPackageByAlias(entry, 'npm', '@mastra/memory')
    expect(pkg?.name).toBe('@mastra/memory')
  })

  it('returns undefined on alias miss', () => {
    const pkg = findPackageByAlias(entry, 'npm', 'not-present')
    expect(pkg).toBeUndefined()
  })

  it('returns undefined on ecosystem mismatch', () => {
    const pkg = findPackageByAlias(entry, 'pypi', '@mastra/core')
    expect(pkg).toBeUndefined()
  })
})

describe('isMonorepoEntry', () => {
  it('returns true for multi-package entries', () => {
    const entry = registryEntrySchema.parse({
      name: 'Mastra',
      description: 'x',
      repo: 'mastra-ai/mastra',
      packages: [
        {
          name: '@mastra/core',
          aliases: [{ ecosystem: 'npm' as const, name: '@mastra/core' }],
          sources: [{ type: 'npm' as const, package: '@mastra/core', path: 'dist/docs' }],
        },
        {
          name: '@mastra/memory',
          aliases: [{ ecosystem: 'npm' as const, name: '@mastra/memory' }],
          sources: [{ type: 'npm' as const, package: '@mastra/memory', path: 'dist/docs' }],
        },
      ],
    })
    expect(isMonorepoEntry(entry)).toBe(true)
  })

  it('returns false for single-package entries', () => {
    const entry = registryEntrySchema.parse({
      name: 'Zod',
      description: 'x',
      repo: 'colinhacks/zod',
      packages: [
        {
          name: 'zod',
          aliases: [{ ecosystem: 'npm' as const, name: 'zod' }],
          sources: [{ type: 'github' as const, repo: 'colinhacks/zod', path: 'docs' }],
        },
      ],
    })
    expect(isMonorepoEntry(entry)).toBe(false)
  })
})

describe('slugifyPackageName', () => {
  it('leaves bare names unchanged', () => {
    expect(slugifyPackageName('zod')).toBe('zod')
    expect(slugifyPackageName('next')).toBe('next')
  })

  it('slugifies scoped packages', () => {
    expect(slugifyPackageName('@mastra/core')).toBe('mastra-core')
    expect(slugifyPackageName('@scope/pkg-name')).toBe('scope-pkg-name')
  })
})
