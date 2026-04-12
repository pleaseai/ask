import type { IntentSkillEntry } from './discovery/types.js'
import type { StoreMode } from './schemas.js'
import type { DocFile } from './sources/index.js'
import fs from 'node:fs'
import path from 'node:path'
import { consola } from 'consola'
import { readIntentSkillsMap } from './agents-intent.js'
import { getAskDir, readAskJson, readResolvedJson } from './io.js'
import { libraryNameFromSpec } from './spec.js'

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

export interface SaveDocsOptions {
  storeMode?: StoreMode
  storePath?: string
  /**
   * Relative subpath inside `storePath` that contains the actual docs
   * tree. For github entries with a `docsPath`, link/ref modes need
   * to resolve `path.join(storePath, storeSubpath)` so the symlink
   * target points at the docs directory, not the repo root. For
   * npm/web/llms-txt entries this is undefined and the behaviour is
   * identical to the pre-storeSubpath contract.
   */
  storeSubpath?: string
}

/**
 * Join `storeSubpath` onto `storePath`. Returns `storePath` unchanged
 * when `storeSubpath` is undefined or the empty string so npm/web/
 * llms-txt entries keep the pre-T007 contract.
 */
function effectiveStorePath(storePath: string, storeSubpath: string | undefined): string {
  return storeSubpath ? path.join(storePath, storeSubpath) : storePath
}

export function saveDocs(
  projectDir: string,
  name: string,
  version: string,
  files: DocFile[],
  options: SaveDocsOptions = {},
): string {
  const docsDir = getLibraryDocsDir(projectDir, name, version)
  const mode = options.storeMode ?? 'copy'

  // ref mode: no project-local materialization at all. Return the
  // joined path so AGENTS.md (and any downstream consumer) points at
  // the docs subdirectory, not the repo root.
  if (mode === 'ref') {
    if (options.storePath) {
      return effectiveStorePath(options.storePath, options.storeSubpath)
    }
    return docsDir
  }

  // link mode: create a symlink from project-local to store. The
  // symlink target is the docs subdirectory when storeSubpath is set.
  if (mode === 'link' && options.storePath) {
    const linkTarget = effectiveStorePath(options.storePath, options.storeSubpath)
    // Clean existing docs for this library version
    if (fs.existsSync(docsDir)) {
      fs.rmSync(docsDir, { recursive: true })
    }
    fs.mkdirSync(path.dirname(docsDir), { recursive: true })

    try {
      fs.symlinkSync(linkTarget, docsDir, 'dir')
      return docsDir
    }
    catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      // Clean up any partial symlink state before falling through
      // or rethrowing. symlinkSync may leave nothing, a broken
      // symlink, or (on some platforms) a zero-length file behind.
      try {
        if (fs.existsSync(docsDir) || fs.lstatSync(docsDir).isSymbolicLink()) {
          fs.rmSync(docsDir, { recursive: true, force: true })
        }
      }
      catch {
        // lstat may throw ENOENT if there's nothing to clean up
      }
      if (code === 'EPERM' || code === 'EACCES') {
        consola.warn(`  Symlink creation failed (${code}), falling back to copy mode`)
        // Fall through to copy mode below
      }
      else {
        throw new Error(
          `Failed to create symlink at ${docsDir}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  // copy mode (default): write files into project-local directory
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
 * View of one library entry, joined from `ask.json` (intent) and
 * `.ask/resolved.json` (last successful materialization). Entries that
 * are declared in `ask.json` but never installed surface with
 * `version: 'unresolved'` and `fileCount: 0` so users can spot them in
 * `ask list`.
 */
export interface ListDocsEntry {
  /** Library slug — directory under `.ask/docs/` and skill dir name. */
  name: string
  /** Resolved version (or 'unresolved' if not yet installed). */
  version: string
  format: 'docs' | 'intent-skills'
  source: 'pm-driven' | 'github' | 'unresolved'
  /** Spec from `ask.json`. */
  spec: string
  location: string
  fileCount: number
  skills?: IntentSkillEntry[]
}

export function listDocs(projectDir: string): ListDocsEntry[] {
  const askJson = readAskJson(projectDir)
  if (!askJson) {
    return []
  }
  const resolved = readResolvedJson(projectDir)
  let intentMap: Map<string, IntentSkillEntry[]> | null = null
  const getIntentMap = (): Map<string, IntentSkillEntry[]> => {
    if (!intentMap) {
      intentMap = readIntentSkillsMap(projectDir)
    }
    return intentMap
  }

  const out: ListDocsEntry[] = []
  for (const spec of askJson.libraries) {
    const name = libraryNameFromSpec(spec)
    const cached = resolved.entries[name]
    const sourceKind: ListDocsEntry['source'] = spec.startsWith('github:')
      ? 'github'
      : 'pm-driven'

    if (!cached) {
      out.push({
        name,
        version: 'unresolved',
        format: 'docs',
        source: 'unresolved',
        spec,
        location: '(not installed — run `ask install`)',
        fileCount: 0,
      })
      continue
    }

    if (cached.format === 'intent-skills') {
      const skills = getIntentMap().get(name) ?? []
      out.push({
        name,
        version: cached.resolvedVersion,
        format: 'intent-skills',
        source: sourceKind,
        spec,
        location: `node_modules/${pkgFromSpec(spec)}`,
        fileCount: skills.length,
        skills,
      })
      continue
    }

    if (cached.materialization === 'in-place' && cached.inPlacePath) {
      out.push({
        name,
        version: cached.resolvedVersion,
        format: 'docs',
        source: sourceKind,
        spec,
        location: cached.inPlacePath,
        fileCount: cached.fileCount,
      })
      continue
    }

    const docsDir = getLibraryDocsDir(projectDir, name, cached.resolvedVersion)
    const fileCount = fs.existsSync(docsDir) ? countFiles(docsDir) : cached.fileCount
    out.push({
      name,
      version: cached.resolvedVersion,
      format: 'docs',
      source: sourceKind,
      spec,
      location: path.relative(projectDir, docsDir) || docsDir,
      fileCount,
    })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function pkgFromSpec(spec: string): string {
  const colonIdx = spec.indexOf(':')
  return colonIdx >= 0 ? spec.slice(colonIdx + 1) : spec
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
