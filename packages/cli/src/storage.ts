import type { DocFile } from './sources/index.js'
import fs from 'node:fs'
import path from 'node:path'
import { getAskDir } from './io.js'

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

export function listDocs(
  projectDir: string,
): Array<{ name: string, version: string, fileCount: number }> {
  const baseDir = getDocsDir(projectDir)
  if (!fs.existsSync(baseDir))
    return []

  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.includes('@'))
    .map((d) => {
      const [name, version] = d.name.split('@')
      const dirPath = path.join(baseDir, d.name)
      const fileCount = countFiles(dirPath)
      return { name, version, fileCount }
    })
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
