import type { CandidateGroup } from '../../src/discovery/candidates.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { runAdd } from '../../src/commands/add.js'
import { CandidateGatheringError } from '../../src/discovery/candidates.js'

let projectDir: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-add-'))
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

function noopInstaller() {
  return async () => ({ installed: 0, skipped: 0 })
}

describe('runAdd — discovery prompt integration', () => {
  it('stores selected relative docs paths as an object entry', async () => {
    const checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-add-checkout-'))
    fs.mkdirSync(path.join(checkoutDir, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(checkoutDir, 'api-docs'), { recursive: true })

    const groups: CandidateGroup[] = [
      {
        root: checkoutDir,
        paths: [path.join(checkoutDir, 'docs'), path.join(checkoutDir, 'api-docs')],
      },
    ]
    const gatherCandidates = mock(async () => groups)
    const prompt = mock(async () => [path.join(checkoutDir, 'docs')] as any)

    try {
      await runAdd(
        { projectDir, spec: 'npm:next' },
        {
          gatherCandidates,
          prompt: prompt as any,
          isTTY: () => true,
          installer: noopInstaller(),
        },
      )

      const askJson = readJson(path.join(projectDir, 'ask.json'))
      expect(askJson.libraries).toHaveLength(1)
      expect(askJson.libraries[0]).toEqual({
        spec: 'npm:next',
        docsPaths: ['docs'],
      })
      expect(prompt).toHaveBeenCalledTimes(1)
    }
    finally {
      fs.rmSync(checkoutDir, { recursive: true, force: true })
    }
  })

  it('skips the prompt when only one candidate exists', async () => {
    const checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-add-checkout-'))
    fs.mkdirSync(path.join(checkoutDir, 'docs'), { recursive: true })

    try {
      const groups: CandidateGroup[] = [
        { root: checkoutDir, paths: [path.join(checkoutDir, 'docs')] },
      ]
      const gatherCandidates = mock(async () => groups)
      const prompt = mock(async () => [])

      await runAdd(
        { projectDir, spec: 'npm:next' },
        {
          gatherCandidates,
          prompt: prompt as any,
          isTTY: () => true,
          installer: noopInstaller(),
        },
      )

      expect(prompt).not.toHaveBeenCalled()
      const askJson = readJson(path.join(projectDir, 'ask.json'))
      expect(askJson.libraries).toEqual(['npm:next'])
    }
    finally {
      fs.rmSync(checkoutDir, { recursive: true, force: true })
    }
  })

  it('skips the prompt when every candidate is a root-only fallback', async () => {
    const checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-add-checkout-'))

    try {
      const groups: CandidateGroup[] = [
        { root: checkoutDir, paths: [checkoutDir] },
      ]
      const gatherCandidates = mock(async () => groups)
      const prompt = mock(async () => [])

      await runAdd(
        { projectDir, spec: 'npm:next' },
        {
          gatherCandidates,
          prompt: prompt as any,
          isTTY: () => true,
          installer: noopInstaller(),
        },
      )

      expect(prompt).not.toHaveBeenCalled()
      const askJson = readJson(path.join(projectDir, 'ask.json'))
      expect(askJson.libraries).toEqual(['npm:next'])
    }
    finally {
      fs.rmSync(checkoutDir, { recursive: true, force: true })
    }
  })

  it('skips the prompt when stdout is not a TTY even with multiple candidates', async () => {
    const checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-add-checkout-'))
    fs.mkdirSync(path.join(checkoutDir, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(checkoutDir, 'api-docs'), { recursive: true })

    try {
      const groups: CandidateGroup[] = [
        {
          root: checkoutDir,
          paths: [path.join(checkoutDir, 'docs'), path.join(checkoutDir, 'api-docs')],
        },
      ]
      const gatherCandidates = mock(async () => groups)
      const prompt = mock(async () => [])

      await runAdd(
        { projectDir, spec: 'npm:next' },
        {
          gatherCandidates,
          prompt: prompt as any,
          isTTY: () => false,
          installer: noopInstaller(),
        },
      )

      expect(prompt).not.toHaveBeenCalled()
      const askJson = readJson(path.join(projectDir, 'ask.json'))
      expect(askJson.libraries).toEqual(['npm:next'])
    }
    finally {
      fs.rmSync(checkoutDir, { recursive: true, force: true })
    }
  })
})

describe('runAdd — --docs-paths flag', () => {
  it('parses CSV and stores the values as an object entry without prompting', async () => {
    const gatherCandidates = mock(async () => [])
    const prompt = mock(async () => [])

    await runAdd(
      { projectDir, spec: 'npm:zod', docsPathsArg: 'docs/API.md,README.md' },
      {
        gatherCandidates,
        prompt: prompt as any,
        isTTY: () => true,
        installer: noopInstaller(),
      },
    )

    expect(gatherCandidates).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    const askJson = readJson(path.join(projectDir, 'ask.json'))
    expect(askJson.libraries[0]).toEqual({
      spec: 'npm:zod',
      docsPaths: ['docs/API.md', 'README.md'],
    })
  })

  it('treats an empty --docs-paths value as no override', async () => {
    await runAdd(
      { projectDir, spec: 'npm:zod', docsPathsArg: '  ,,  ' },
      {
        gatherCandidates: mock(async () => []) as any,
        installer: noopInstaller(),
      },
    )

    const askJson = readJson(path.join(projectDir, 'ask.json'))
    expect(askJson.libraries).toEqual(['npm:zod'])
  })
})

describe('runAdd — --clear-docs-paths', () => {
  it('downgrades an existing object entry back to a plain string', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'ask.json'),
      JSON.stringify({
        libraries: [{ spec: 'npm:zod', docsPaths: ['docs/API.md'] }],
      }),
    )

    await runAdd(
      { projectDir, spec: 'npm:zod', clearDocsPaths: true },
      {
        gatherCandidates: mock(async () => []) as any,
        installer: noopInstaller(),
      },
    )

    const askJson = readJson(path.join(projectDir, 'ask.json'))
    expect(askJson.libraries).toEqual(['npm:zod'])
  })
})

describe('runAdd — string→object upgrade and replacement', () => {
  it('replaces an existing string entry with an object entry in-place', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'ask.json'),
      JSON.stringify({ libraries: ['npm:react', 'npm:zod', 'npm:vite'] }),
    )

    await runAdd(
      { projectDir, spec: 'npm:zod', docsPathsArg: 'docs' },
      {
        gatherCandidates: mock(async () => []) as any,
        installer: noopInstaller(),
      },
    )

    const askJson = readJson(path.join(projectDir, 'ask.json'))
    expect(askJson.libraries).toHaveLength(3)
    expect(askJson.libraries[0]).toBe('npm:react')
    expect(askJson.libraries[1]).toEqual({ spec: 'npm:zod', docsPaths: ['docs'] })
    expect(askJson.libraries[2]).toBe('npm:vite')
  })
})

describe('runAdd — offline / fetch failure', () => {
  it('records the spec without an override when candidate gathering fails', async () => {
    const gatherCandidates = mock(async () => {
      throw new CandidateGatheringError('npm:next', new Error('no network'))
    })

    await runAdd(
      { projectDir, spec: 'npm:next' },
      {
        gatherCandidates: gatherCandidates as any,
        isTTY: () => true,
        installer: noopInstaller(),
      },
    )

    const askJson = readJson(path.join(projectDir, 'ask.json'))
    expect(askJson.libraries).toEqual(['npm:next'])
  })
})
