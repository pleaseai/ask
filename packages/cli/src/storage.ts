import type { IntentSkillEntry } from './discovery/types.js'
import type { DocFile } from './sources/index.js'
import fs from 'node:fs'
import path from 'node:path'
import { readIntentSkillsMap } from './agents-intent.js'
import { getAskDir, readLock } from './io.js'

export function getDocsDir(projectDir: string): string {
  return path.join(getAskDir(projectDir), 'docs')
}

export function getLibraryDocsDir(
  projectDir: string,
  name: string,
  version: string,
): string {
  return path.join(getDocsDir(projectDir), `${name}@${version}`)
}

export function saveDocs(
  projectDir: string,
  name: string,
  version: string,
  files: DocFile[],
): string {
  const docsDir = getLibraryDocsDir(projectDir, name, version)

  // Clean existing docs for this library version
  if (fs.existsSync(docsDir)) {
    fs.rmSync(docsDir, { recursive: true })
  }

  fs.mkdirSync(docsDir, { recursive: true })

  for (const file of files) {
    const filePath = path.join(docsDir, file.path)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, file.content, 'utf-8')
  }

  // Create an index file listing all docs
  const index = files
    .map(f => `- [${f.path}](./${f.path})`)
    .join('\n')
  fs.writeFileSync(
    path.join(docsDir, 'INDEX.md'),
    `# ${name}@${version} Documentation\n\n${index}\n`,
    'utf-8',
  )

  return docsDir
}

export function removeDocs(
  projectDir: string,
  name: string,
  version?: string,
): void {
  if (version) {
    const docsDir = getLibraryDocsDir(projectDir, name, version)
    if (fs.existsSync(docsDir)) {
      fs.rmSync(docsDir, { recursive: true })
    }
  }
  else {
    // Remove all versions for this library
    const baseDir = getDocsDir(projectDir)
    if (!fs.existsSync(baseDir))
      return
    const entries = fs.readdirSync(baseDir)
    for (const entry of entries) {
      if (entry.startsWith(`${name}@`)) {
        fs.rmSync(path.join(baseDir, entry), { recursive: true })
      }
    }
  }
}

/**
 * Lock-derived view of the entries installed for a project. Unlike the
 * legacy filesystem scan, this reads `.ask/ask.lock` as the source of
 * truth, so:
 *
 *   - `intent-skills`-format entries (no filesystem copy) are surfaced
 *     alongside `docs`-format entries;
 *   - the `source`, `location`, and `format` fields are accurate even
 *     for the local-first npm path that never writes a tarball.
 *
 * `fileCount` is the number of files on disk for docs entries, and the
 * number of skill mappings for intent-skills entries.
 */
export interface ListDocsEntry {
  name: string
  version: string
  format: 'docs' | 'intent-skills'
  source: 'tarball' | 'installPath' | 'github' | 'web' | 'llms-txt'
  location: string
  fileCount: number
  skills?: IntentSkillEntry[]
}

export function listDocs(projectDir: string): ListDocsEntry[] {
  const lock = readLock(projectDir)
  const names = Object.keys(lock.entries).sort()
  if (names.length === 0) {
    return []
  }

  // Lazily load the intent-skills block only when we actually need it,
  // since readIntentSkillsMap does a file read + parse.
  let intentMap: Map<string, IntentSkillEntry[]> | null = null
  const getIntentMap = (): Map<string, IntentSkillEntry[]> => {
    if (!intentMap) {
      intentMap = readIntentSkillsMap(projectDir)
    }
    return intentMap
  }

  const out: ListDocsEntry[] = []
  for (const name of names) {
    const entry = lock.entries[name]!
    if (entry.source === 'npm' && entry.format === 'intent-skills') {
      const skills = getIntentMap().get(name) ?? []
      const location = entry.installPath
        ?? path.join('node_modules', name)
      out.push({
        name,
        version: entry.version,
        format: 'intent-skills',
        source: 'installPath',
        location,
        fileCount: skills.length,
        skills,
      })
      continue
    }

    // Docs format — files live under .ask/docs/<name>@<version>.
    const docsDir = getLibraryDocsDir(projectDir, name, entry.version)
    const fileCount = fs.existsSync(docsDir) ? countFiles(docsDir) : 0
    const location = path.relative(projectDir, docsDir) || docsDir

    let source: ListDocsEntry['source']
    switch (entry.source) {
      case 'github':
        source = 'github'
        break
      case 'web':
        source = 'web'
        break
      case 'llms-txt':
        source = 'llms-txt'
        break
      case 'npm':
        source = entry.installPath && !entry.tarball ? 'installPath' : 'tarball'
        break
    }

    out.push({
      name,
      version: entry.version,
      format: 'docs',
      source,
      location,
      fileCount,
    })
  }

  return out
}

function countFiles(dir: string): number {
  let count = 0
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += countFiles(path.join(dir, entry.name))
    }
    else {
      count++
    }
  }
  return count
}
