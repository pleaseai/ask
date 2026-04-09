import { describe, expect, it } from 'bun:test'
import { formatList } from '../../src/list/render.js'
import { ListModelSchema, type ListModel } from '../../src/list/model.js'

function parse(input: unknown): ListModel {
  return ListModelSchema.parse(input)
}

describe('formatList', () => {
  it('emits the legacy empty message for an empty model', () => {
    const out = formatList(parse({ entries: [], conflicts: [], warnings: [] }))
    expect(out).toBe('No docs downloaded yet. Use `ask docs add` to get started.')
  })

  it('scenario 1: docs-only renders a table with no tree', () => {
    const model = parse({
      entries: [
        {
          name: 'zod',
          version: '3.22.4',
          format: 'docs',
          source: 'github',
          location: '.ask/docs/zod@3.22.4',
          itemCount: 12,
        },
        {
          name: 'react',
          version: '19.0.0',
          format: 'docs',
          source: 'github',
          location: '.ask/docs/react@19.0.0',
          itemCount: 7,
        },
      ],
      conflicts: [],
      warnings: [],
    })
    const out = formatList(model)
    expect(out).toContain('2 entries, 2 docs')
    expect(out).toContain('Name')
    expect(out).toContain('zod')
    expect(out).toContain('react')
    expect(out).toContain('.ask/docs/zod@3.22.4')
    expect(out).not.toContain('Skill mappings')
  })

  it('scenario 2: intent-only renders a tree section per package', () => {
    const model = parse({
      entries: [
        {
          name: '@a/one',
          version: '1.0.0',
          format: 'intent-skills',
          source: 'installPath',
          location: 'node_modules/@a/one',
          itemCount: 1,
          skills: [
            { task: 'setup', load: 'node_modules/@a/one/skills/setup/SKILL.md' },
          ],
        },
      ],
      conflicts: [],
      warnings: [],
    })
    const out = formatList(model)
    expect(out).toContain('1 intent-skills')
    expect(out).toContain('Skill mappings')
    expect(out).toContain('@a/one@1.0.0')
    expect(out).toContain('setup')
  })

  it('scenario 3: mixed renders table + tree + correct totals', () => {
    const model = parse({
      entries: [
        {
          name: 'zod',
          version: '3.22.4',
          format: 'docs',
          source: 'github',
          location: '.ask/docs/zod@3.22.4',
          itemCount: 10,
        },
        {
          name: 'alpha',
          version: '1.0.0',
          format: 'intent-skills',
          source: 'installPath',
          location: 'node_modules/alpha',
          itemCount: 1,
          skills: [
            { task: 'x', load: 'node_modules/alpha/skills/x/SKILL.md' },
          ],
        },
      ],
      conflicts: [],
      warnings: [],
    })
    const out = formatList(model)
    expect(out).toContain('2 entries, 1 docs, 1 intent-skills')
    expect(out).toContain('zod')
    expect(out).toContain('alpha')
    expect(out).toContain('Skill mappings')
  })

  it('scenario 4: conflicts section appears only when non-empty', () => {
    const model = parse({
      entries: [
        {
          name: 'x',
          version: '1.0.0',
          format: 'docs',
          source: 'github',
          location: '.ask/docs/x@1.0.0',
          itemCount: 1,
        },
      ],
      conflicts: [{ name: 'x', versions: ['1.0.0', '2.0.0'] }],
      warnings: ['scanned'],
    })
    const out = formatList(model)
    expect(out).toContain('Conflicts:')
    expect(out).toContain('x: 1.0.0, 2.0.0')
    expect(out).toContain('Warnings:')
    expect(out).toContain('scanned')
  })
})
