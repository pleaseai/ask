import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readAskJson, writeAskJson } from '../../src/io.js'

describe('ask remove (lazy-first)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync('/tmp/ask-remove-test-')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes a spec from ask.json by name', () => {
    writeAskJson(tmpDir, { libraries: ['npm:next', 'npm:zod'] })

    const askJson = readAskJson(tmpDir)!
    const idx = askJson.libraries.findIndex(s => s === 'npm:next')
    askJson.libraries.splice(idx, 1)
    writeAskJson(tmpDir, askJson)

    const updated = readAskJson(tmpDir)!
    expect(updated.libraries).toEqual(['npm:zod'])
  })
})
