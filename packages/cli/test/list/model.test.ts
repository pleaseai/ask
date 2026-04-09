import { describe, expect, it } from 'bun:test'
import { ListModelSchema } from '../../src/list/model.js'

describe('ListModelSchema', () => {
  it('round-trips a minimal empty model', () => {
    const input = { entries: [], conflicts: [], warnings: [] }
    const parsed = ListModelSchema.parse(input)
    const json = JSON.stringify(parsed)
    const reparsed = ListModelSchema.parse(JSON.parse(json))
    expect(reparsed).toEqual(parsed)
  })

  it('round-trips a mixed docs + intent-skills fixture', () => {
    const input = {
      entries: [
        {
          name: 'zod',
          version: '3.22.4',
          format: 'docs',
          source: 'github',
          location: '.ask/docs/zod@3.22.4',
          itemCount: 14,
        },
        {
          name: '@tanstack/router',
          version: '1.2.3',
          format: 'intent-skills',
          source: 'installPath',
          location: 'node_modules/@tanstack/router',
          skills: [
            { task: 'setup', load: 'node_modules/@tanstack/router/skills/setup/SKILL.md' },
          ],
        },
      ],
      conflicts: [{ name: 'dup', versions: ['1.0.0', '2.0.0'] }],
      warnings: ['scanned 2 packages'],
    }
    const parsed = ListModelSchema.parse(input)
    const json = JSON.stringify(parsed)
    const reparsed = ListModelSchema.parse(JSON.parse(json))
    expect(reparsed).toEqual(parsed)
    expect(reparsed.entries[0]!.format).toBe('docs')
    expect(reparsed.entries[1]!.skills).toHaveLength(1)
  })

  it('rejects an invalid format enum value', () => {
    const bad = {
      entries: [
        {
          name: 'x',
          version: '1.0.0',
          format: 'unknown',
          source: 'github',
          location: '.',
        },
      ],
      conflicts: [],
      warnings: [],
    }
    expect(() => ListModelSchema.parse(bad)).toThrow()
  })

  it('requires at least two versions in a conflict', () => {
    const bad = {
      entries: [],
      conflicts: [{ name: 'x', versions: ['1.0.0'] }],
      warnings: [],
    }
    expect(() => ListModelSchema.parse(bad)).toThrow()
  })
})
