import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  manageIgnoreFiles,
  patchRootIgnores,
  removeNestedConfigs,
  unpatchRootIgnores,
  writeNestedConfigs,
} from '../src/ignore-files.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-ignore-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const NESTED_FILES = [
  '.gitattributes',
  'eslint.config.mjs',
  'biome.json',
  '.markdownlint-cli2.jsonc',
]

function docsFile(name: string): string {
  return path.join(tmpDir, '.ask', 'docs', name)
}

describe('writeNestedConfigs', () => {
  it('creates all four nested config files', () => {
    writeNestedConfigs(tmpDir)
    for (const name of NESTED_FILES) {
      expect(fs.existsSync(docsFile(name))).toBe(true)
    }
  })

  it('writes a .gitattributes with linguist-vendored and linguist-generated', () => {
    writeNestedConfigs(tmpDir)
    const content = fs.readFileSync(docsFile('.gitattributes'), 'utf-8')
    expect(content).toContain('linguist-vendored=true')
    expect(content).toContain('linguist-generated=true')
  })

  it('writes an eslint.config.mjs that ignores everything', () => {
    writeNestedConfigs(tmpDir)
    const content = fs.readFileSync(docsFile('eslint.config.mjs'), 'utf-8')
    expect(content).toContain('ignores')
    expect(content).toContain('**/*')
  })

  it('returns the list of written files on first call', () => {
    const result = writeNestedConfigs(tmpDir)
    expect(result.length).toBe(NESTED_FILES.length)
  })

  it('is idempotent: second call writes nothing new', () => {
    writeNestedConfigs(tmpDir)
    const result = writeNestedConfigs(tmpDir)
    expect(result).toEqual([])
  })
})

describe('removeNestedConfigs', () => {
  it('deletes all nested config files', () => {
    writeNestedConfigs(tmpDir)
    removeNestedConfigs(tmpDir)
    for (const name of NESTED_FILES) {
      expect(fs.existsSync(docsFile(name))).toBe(false)
    }
  })

  it('leaves unrelated files inside .ask/docs/ alone', () => {
    writeNestedConfigs(tmpDir)
    const otherFile = docsFile('user-notes.md')
    fs.writeFileSync(otherFile, '# notes\n')
    removeNestedConfigs(tmpDir)
    expect(fs.existsSync(otherFile)).toBe(true)
  })

  it('is a no-op when .ask/docs/ does not exist', () => {
    expect(() => removeNestedConfigs(tmpDir)).not.toThrow()
  })
})

describe('patchRootIgnores', () => {
  it('patches .prettierignore only when the file exists', () => {
    const prettierPath = path.join(tmpDir, '.prettierignore')
    fs.writeFileSync(prettierPath, 'node_modules\n')
    patchRootIgnores(tmpDir)
    const content = fs.readFileSync(prettierPath, 'utf-8')
    expect(content).toContain('node_modules')
    expect(content).toContain('# ask:start')
    expect(content).toContain('.ask/docs/')
    expect(content).toContain('# ask:end')
  })

  it('does not create .prettierignore when absent', () => {
    patchRootIgnores(tmpDir)
    expect(fs.existsSync(path.join(tmpDir, '.prettierignore'))).toBe(false)
  })

  it('patches sonar-project.properties when present', () => {
    const sonarPath = path.join(tmpDir, 'sonar-project.properties')
    fs.writeFileSync(sonarPath, 'sonar.projectKey=demo\n')
    patchRootIgnores(tmpDir)
    const content = fs.readFileSync(sonarPath, 'utf-8')
    expect(content).toContain('sonar.projectKey=demo')
    expect(content).toContain('sonar.exclusions=.ask/docs/**')
  })

  it('is idempotent across repeat invocations', () => {
    const prettierPath = path.join(tmpDir, '.prettierignore')
    fs.writeFileSync(prettierPath, 'node_modules\n')
    patchRootIgnores(tmpDir)
    const first = fs.readFileSync(prettierPath, 'utf-8')
    patchRootIgnores(tmpDir)
    const second = fs.readFileSync(prettierPath, 'utf-8')
    expect(second).toBe(first)
  })
})

describe('unpatchRootIgnores', () => {
  it('removes the marker block but leaves the file and user content', () => {
    const prettierPath = path.join(tmpDir, '.prettierignore')
    fs.writeFileSync(prettierPath, 'node_modules\n')
    patchRootIgnores(tmpDir)
    unpatchRootIgnores(tmpDir)
    const content = fs.readFileSync(prettierPath, 'utf-8')
    expect(content).toContain('node_modules')
    expect(content).not.toContain('# ask:start')
    expect(content).not.toContain('.ask/docs/')
  })

  it('is a no-op when no marker block is present', () => {
    const prettierPath = path.join(tmpDir, '.prettierignore')
    fs.writeFileSync(prettierPath, 'node_modules\n')
    unpatchRootIgnores(tmpDir)
    expect(fs.readFileSync(prettierPath, 'utf-8')).toBe('node_modules\n')
  })
})

describe('manageIgnoreFiles', () => {
  it('installs both nested configs and root patches', () => {
    fs.writeFileSync(path.join(tmpDir, '.prettierignore'), 'node_modules\n')
    manageIgnoreFiles(tmpDir, 'install')
    expect(fs.existsSync(docsFile('.gitattributes'))).toBe(true)
    const prettier = fs.readFileSync(path.join(tmpDir, '.prettierignore'), 'utf-8')
    expect(prettier).toContain('.ask/docs/')
  })

  it('removes both nested configs and root patches', () => {
    fs.writeFileSync(path.join(tmpDir, '.prettierignore'), 'node_modules\n')
    manageIgnoreFiles(tmpDir, 'install')
    manageIgnoreFiles(tmpDir, 'remove')
    expect(fs.existsSync(docsFile('.gitattributes'))).toBe(false)
    const prettier = fs.readFileSync(path.join(tmpDir, '.prettierignore'), 'utf-8')
    expect(prettier).not.toContain('# ask:start')
  })

  it('is a no-op when manageIgnores is false in config', () => {
    const askDir = path.join(tmpDir, '.ask')
    fs.mkdirSync(askDir, { recursive: true })
    fs.writeFileSync(
      path.join(askDir, 'config.json'),
      JSON.stringify({ schemaVersion: 1, docs: [], manageIgnores: false }),
    )
    manageIgnoreFiles(tmpDir, 'install')
    expect(fs.existsSync(docsFile('.gitattributes'))).toBe(false)
  })

  it('surfaces corrupt config errors instead of silently mutating files', () => {
    const askDir = path.join(tmpDir, '.ask')
    fs.mkdirSync(askDir, { recursive: true })
    fs.writeFileSync(path.join(askDir, 'config.json'), '{ not valid json')
    expect(() => manageIgnoreFiles(tmpDir, 'install')).toThrow()
    expect(fs.existsSync(docsFile('.gitattributes'))).toBe(false)
  })
})
