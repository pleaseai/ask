import { describe, expect, it } from 'bun:test'
import {
  ConfigSchema,
  LockEntrySchema,
  LockSchema,
  SourceConfigSchema,
} from '../src/schemas.js'

describe('SourceConfigSchema', () => {
  it('accepts a valid github source', () => {
    const result = SourceConfigSchema.safeParse({
      source: 'github',
      name: 'zod',
      version: '3.22.4',
      repo: 'colinhacks/zod',
      tag: 'v3.22.4',
      docsPath: 'docs',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a github source missing repo', () => {
    const result = SourceConfigSchema.safeParse({
      source: 'github',
      name: 'zod',
      version: '3.22.4',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a valid npm source', () => {
    const result = SourceConfigSchema.safeParse({
      source: 'npm',
      name: 'hono',
      version: '4.6.5',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a valid web source with at least one url', () => {
    const result = SourceConfigSchema.safeParse({
      source: 'web',
      name: 'somelib',
      version: 'latest',
      urls: ['https://example.com/docs'],
      maxDepth: 2,
    })
    expect(result.success).toBe(true)
  })

  it('rejects a web source with empty urls', () => {
    const result = SourceConfigSchema.safeParse({
      source: 'web',
      name: 'somelib',
      version: 'latest',
      urls: [],
    })
    expect(result.success).toBe(false)
  })

  it('accepts a valid llms-txt source', () => {
    const result = SourceConfigSchema.safeParse({
      source: 'llms-txt',
      name: 'somelib',
      version: 'latest',
      url: 'https://example.com/llms.txt',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown source type', () => {
    const result = SourceConfigSchema.safeParse({
      source: 'ftp',
      name: 'x',
      version: '1.0.0',
    })
    expect(result.success).toBe(false)
  })
})

describe('ConfigSchema', () => {
  it('accepts an empty config', () => {
    const result = ConfigSchema.safeParse({
      schemaVersion: 1,
      docs: [],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a config without schemaVersion', () => {
    const result = ConfigSchema.safeParse({ docs: [] })
    expect(result.success).toBe(false)
  })

  it('rejects a config with the wrong schemaVersion literal', () => {
    const result = ConfigSchema.safeParse({ schemaVersion: 2, docs: [] })
    expect(result.success).toBe(false)
  })

  it('accepts a config with manageIgnores flag', () => {
    const result = ConfigSchema.safeParse({
      schemaVersion: 1,
      docs: [],
      manageIgnores: false,
    })
    expect(result.success).toBe(true)
  })

  it('treats manageIgnores as optional', () => {
    const result = ConfigSchema.safeParse({ schemaVersion: 1, docs: [] })
    expect(result.success).toBe(true)
  })
})

describe('LockEntrySchema', () => {
  const base = {
    version: '3.22.4',
    fetchedAt: '2026-04-07T06:00:00Z',
    fileCount: 23,
    contentHash: `sha256-${'a'.repeat(64)}`,
  }

  it('accepts a valid github lock entry', () => {
    const result = LockEntrySchema.safeParse({
      ...base,
      source: 'github',
      repo: 'colinhacks/zod',
      ref: 'v3.22.4',
      commit: 'a'.repeat(40),
    })
    expect(result.success).toBe(true)
  })

  it('accepts a github lock entry without commit', () => {
    const result = LockEntrySchema.safeParse({
      ...base,
      source: 'github',
      repo: 'colinhacks/zod',
      ref: 'v3.22.4',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a github lock entry with malformed commit', () => {
    const result = LockEntrySchema.safeParse({
      ...base,
      source: 'github',
      repo: 'colinhacks/zod',
      ref: 'v3.22.4',
      commit: 'not-a-sha',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a content hash with wrong format', () => {
    const result = LockEntrySchema.safeParse({
      ...base,
      contentHash: 'md5-abc',
      source: 'npm',
      tarball: 'https://registry.npmjs.org/hono/-/hono-4.6.5.tgz',
      integrity: `sha512-${'A'.repeat(86)}==`,
    })
    expect(result.success).toBe(false)
  })

  it('accepts a valid npm lock entry', () => {
    const result = LockEntrySchema.safeParse({
      ...base,
      source: 'npm',
      tarball: 'https://registry.npmjs.org/hono/-/hono-4.6.5.tgz',
      integrity: `sha512-${'A'.repeat(86)}==`,
    })
    expect(result.success).toBe(true)
  })
})

describe('LockSchema', () => {
  it('accepts an empty lock', () => {
    const result = LockSchema.safeParse({
      lockfileVersion: 1,
      generatedAt: '2026-04-07T06:00:00Z',
      entries: {},
    })
    expect(result.success).toBe(true)
  })

  it('rejects a lock without lockfileVersion', () => {
    const result = LockSchema.safeParse({
      generatedAt: '2026-04-07T06:00:00Z',
      entries: {},
    })
    expect(result.success).toBe(false)
  })
})
