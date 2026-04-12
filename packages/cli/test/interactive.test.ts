import { describe, expect, it } from 'bun:test'
import { readProjectDeps } from '../src/interactive.js'

describe('readProjectDeps', () => {
  it('returns dep names from dependencies and devDependencies', () => {
    const packageJson = {
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }
    const result = readProjectDeps(packageJson, [])
    expect(result).toEqual(['next', 'react', 'typescript'])
  })

  it('excludes deps already in ask.json', () => {
    const packageJson = {
      dependencies: { next: '^14.0.0', react: '^18.0.0', zod: '^3.0.0' },
    }
    const existing = ['npm:next', 'npm:zod']
    const result = readProjectDeps(packageJson, existing)
    expect(result).toEqual(['react'])
  })

  it('returns empty array when no dependencies', () => {
    const packageJson = { name: 'my-app' }
    const result = readProjectDeps(packageJson, [])
    expect(result).toEqual([])
  })

  it('excludes scoped packages already registered', () => {
    const packageJson = {
      dependencies: { '@vercel/ai': '^3.0.0', lodash: '^4.0.0' },
    }
    const existing = ['npm:@vercel/ai']
    const result = readProjectDeps(packageJson, existing)
    expect(result).toEqual(['lodash'])
  })

  it('handles github specs in existing list', () => {
    const packageJson = {
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
    }
    // github specs do not match npm dep names — all deps should appear
    const existing = ['github:vercel/next.js@v14.2.3']
    const result = readProjectDeps(packageJson, existing)
    expect(result).toEqual(['next', 'react'])
  })
})
