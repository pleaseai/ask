import { describe, expect, it } from 'bun:test'
import { registryEntryJsonSchema } from '../src/index.js'

describe('registryEntryJsonSchema', () => {
  it('exports a JSON Schema object', () => {
    expect(registryEntryJsonSchema).toBeDefined()
    expect(typeof registryEntryJsonSchema).toBe('object')
  })

  it('has a type of object', () => {
    expect((registryEntryJsonSchema as Record<string, unknown>).type).toBe('object')
  })

  it('has required fields: name, description, repo, packages', () => {
    const required = (registryEntryJsonSchema as Record<string, unknown>).required as string[]
    expect(required).toContain('name')
    expect(required).toContain('description')
    expect(required).toContain('repo')
    expect(required).toContain('packages')
  })

  it('has $schema property in the generated output', () => {
    // The JSON Schema should be self-describing with $schema
    expect(registryEntryJsonSchema).toHaveProperty('$schema')
  })
})
