import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { patchRootIgnores } from '../../src/ignore-files.js'

let projectDir: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-ign-skills-'))
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

describe('patchRootIgnores (skills-aware)', () => {
  it('.gitignore marker block covers .ask/skills/ and skills-lock.json', () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '')
    patchRootIgnores(projectDir)
    const content = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8')
    expect(content).toContain('.ask/docs/')
    expect(content).toContain('.ask/skills/')
    expect(content).toContain('.ask/skills-lock.json')
  })

  it('sonar.exclusions lists both .ask/docs/** and .ask/skills/**', () => {
    fs.writeFileSync(path.join(projectDir, 'sonar-project.properties'), '')
    patchRootIgnores(projectDir)
    const content = fs.readFileSync(path.join(projectDir, 'sonar-project.properties'), 'utf-8')
    expect(content).toContain('.ask/docs/**')
    expect(content).toContain('.ask/skills/**')
  })

  it('.prettierignore lists skills paths', () => {
    fs.writeFileSync(path.join(projectDir, '.prettierignore'), '')
    patchRootIgnores(projectDir)
    const content = fs.readFileSync(path.join(projectDir, '.prettierignore'), 'utf-8')
    expect(content).toContain('.ask/skills/')
    expect(content).toContain('.ask/skills-lock.json')
  })
})
