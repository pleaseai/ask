import { describe, expect, it } from 'vitest'
import { extractFrontmatter, parseFrontmatter } from './migrate-registry-to-json.js'

describe('extractFrontmatter', () => {
  it('extracts yaml content between --- delimiters', () => {
    const md = `---
name: React
description: Library for building user interfaces
---

# React

Some body content.
`
    const result = extractFrontmatter(md)
    expect(result).toBe('name: React\ndescription: Library for building user interfaces')
  })

  it('throws when no frontmatter delimiters found', () => {
    const md = '# No frontmatter here\n\nJust body.'
    expect(() => extractFrontmatter(md)).toThrow('No frontmatter found')
  })

  it('throws when only one delimiter found', () => {
    const md = '---\nname: React\n\nNo closing delimiter.'
    expect(() => extractFrontmatter(md)).toThrow('No frontmatter found')
  })
})

describe('parseFrontmatter', () => {
  it('parses simple key-value yaml', () => {
    const yaml = 'name: React\ndescription: Library for building user interfaces\nrepo: facebook/react'
    const result = parseFrontmatter(yaml)
    expect(result).toEqual({
      name: 'React',
      description: 'Library for building user interfaces',
      repo: 'facebook/react',
    })
  })

  it('parses yaml with string arrays (tags)', () => {
    const yaml = `name: React
tags:
  - ui
  - components
  - virtual-dom`
    const result = parseFrontmatter(yaml)
    expect(result).toEqual({
      name: 'React',
      tags: ['ui', 'components', 'virtual-dom'],
    })
  })

  it('parses yaml with nested objects (packages with aliases and sources)', () => {
    const yaml = `name: React
packages:
  - name: react
    aliases:
      - ecosystem: npm
        name: react
    sources:
      - type: github
        repo: facebook/react`
    const result = parseFrontmatter(yaml)
    expect(result).toEqual({
      name: 'React',
      packages: [
        {
          name: 'react',
          aliases: [{ ecosystem: 'npm', name: 'react' }],
          sources: [{ type: 'github', repo: 'facebook/react' }],
        },
      ],
    })
  })

  it('parses optional fields like homepage and license', () => {
    const yaml = `name: React
repo: facebook/react
homepage: https://react.dev
license: MIT`
    const result = parseFrontmatter(yaml)
    expect(result).toEqual({
      name: 'React',
      repo: 'facebook/react',
      homepage: 'https://react.dev',
      license: 'MIT',
    })
  })

  it('parses full registry entry frontmatter', () => {
    const yaml = `name: React
description: Library for building user interfaces
repo: facebook/react
homepage: https://react.dev
license: MIT
tags:
  - ui
  - components
packages:
  - name: react
    aliases:
      - ecosystem: npm
        name: react
      - ecosystem: npm
        name: react-dom
    sources:
      - type: github
        repo: facebook/react`
    const result = parseFrontmatter(yaml)
    expect(result.name).toBe('React')
    expect(result.tags).toEqual(['ui', 'components'])
    expect(result.packages).toHaveLength(1)
    expect(result.packages[0].aliases).toHaveLength(2)
    expect(result.packages[0].aliases[1]).toEqual({ ecosystem: 'npm', name: 'react-dom' })
  })

  it('parses scoped package names with quotes', () => {
    const yaml = `name: Angular
packages:
  - name: "@angular/core"
    aliases:
      - ecosystem: npm
        name: "@angular/core"
    sources:
      - type: github
        repo: angular/angular`
    const result = parseFrontmatter(yaml)
    expect(result.packages[0].name).toBe('@angular/core')
    expect(result.packages[0].aliases[0].name).toBe('@angular/core')
  })
})
