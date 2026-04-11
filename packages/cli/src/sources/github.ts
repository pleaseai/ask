import type {
  DocFile,
  DocSource,
  FetchResult,
  GithubSourceOptions,
  SourceConfig,
} from './index.js'
import { Buffer } from 'node:buffer'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { consola } from 'consola'
import {
  acquireEntryLock,
  cpDirAtomic,
  githubStorePath,
  quarantineEntry,
  resolveAskHome,
  stampEntry,
  verifyEntry,
} from '../store/index.js'

const RE_LEADING_V = /^v/
const RE_SHA40 = /^[0-9a-f]{40}$/
/**
 * Safe `owner/repo` pattern. Allows only alphanumerics, dots, underscores,
 * and hyphens in each segment — matches GitHub's own repo-name rules and
 * blocks any path-traversal or shell-injection characters.
 */
const RE_SAFE_REPO = /^[\w.-]+\/[\w.-]+$/
/**
 * Safe git ref pattern. Allows tags, branches, and SHAs but rejects
 * shell metacharacters, whitespace, and path traversal sequences.
 */
const RE_SAFE_REF = /^[\w./-]+$/

const DEFAULT_GITHUB_HOST = 'github.com'

/**
 * Check whether `git` is available on the system PATH.
 */
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}

/**
 * Build the candidate ref fallback chain. Tries the ref as-is first;
 * if it does not already start with `v`, also tries `v<ref>`. Never
 * emits `vv1.2.3` for already-prefixed inputs.
 */
function refCandidates(ref: string): string[] {
  if (ref.startsWith('v'))
    return [ref]
  return [ref, `v${ref}`]
}

/**
 * Clean the contents of a directory (keep the dir itself) so a failed
 * clone attempt can be retried with a different ref candidate.
 */
function clearDirContents(dir: string): void {
  if (!fs.existsSync(dir))
    return
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
  }
}

/**
 * Shallow-clone a single tag into a temp directory, strip `.git/`,
 * and return the commit SHA that the tag resolved to. Implements the
 * ref fallback chain via `refCandidates`. Throws if none succeed.
 *
 * Returns the winning candidate so callers can use it as the store
 * key (e.g. if the user asked for `1.0.0` but only `v1.0.0` exists,
 * the store lands under `.../v1.0.0/`).
 */
function cloneAtTag(
  remoteUrl: string,
  ref: string,
  tmpDir: string,
): { commit: string, winningCandidate: string } {
  const candidates = refCandidates(ref)
  let lastErr: unknown
  for (const candidate of candidates) {
    try {
      clearDirContents(tmpDir)
      execFileSync('git', [
        'clone',
        '--depth',
        '1',
        '--branch',
        candidate,
        '--single-branch',
        remoteUrl,
        tmpDir,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })

      // Capture the commit SHA before we strip `.git/`.
      const commit = execFileSync(
        'git',
        ['-C', tmpDir, 'rev-parse', 'HEAD'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      if (!RE_SHA40.test(commit)) {
        throw new Error(`git rev-parse returned invalid SHA '${commit}'`)
      }

      // Remove `.git/` so the store entry contains only the working
      // tree — matches the opensrc convention and prevents downstream
      // callers from accidentally treating the entry as a live repo.
      fs.rmSync(path.join(tmpDir, '.git'), { recursive: true, force: true })
      return { commit, winningCandidate: candidate }
    }
    catch (err) {
      lastErr = err
      // Fall through to the next candidate
    }
  }
  throw new Error(
    `Failed to clone ${remoteUrl} at ${ref} (tried: ${candidates.join(', ')}): `
    + `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  )
}

export class GithubSource implements DocSource {
  async fetch(options: SourceConfig): Promise<FetchResult> {
    const opts = options as GithubSourceOptions
    const { repo, docsPath } = opts
    const ref = opts.tag ?? opts.branch ?? 'main'
    const [owner, repoName] = repo.split('/')

    // Defense-in-depth validation. Both fields are also validated at
    // the schema layer, but sources can be invoked from other
    // contexts (add command, tests).
    if (!RE_SAFE_REPO.test(repo)) {
      throw new Error(`Invalid repo '${repo}': must be owner/repo with safe characters`)
    }
    if (!RE_SAFE_REF.test(ref)) {
      throw new Error(`Invalid ref '${ref}': must contain only [A-Za-z0-9._/-]`)
    }

    const tagVersion = opts.tag?.replace(RE_LEADING_V, '')
    const resolvedVersion = tagVersion ?? opts.version
    const askHome = resolveAskHome()

    // Store-hit path: for each candidate key, check the new nested
    // layout and verify integrity before trusting it. Callers may have
    // given us `1.0.0` while the store holds `v1.0.0`, or vice versa.
    for (const candidate of refCandidates(ref)) {
      const storeDir = githubStorePath(askHome, DEFAULT_GITHUB_HOST, owner, repoName, candidate)
      if (!fs.existsSync(storeDir))
        continue
      if (verifyEntry(storeDir)) {
        const files = this.extractDocsFromDir(storeDir, repo, ref, docsPath)
        return {
          files,
          resolvedVersion,
          storePath: storeDir,
          storeSubpath: docsPath,
          meta: { ref },
        }
      }
      quarantineEntry(askHome, storeDir)
    }

    // Fresh fetch. Prefer shallow clone; fall back to tar.gz if git is
    // unavailable or the clone itself fails for a non-fatal reason.
    const remoteUrl = opts.remoteUrl ?? `https://github.com/${repo}.git`
    if (hasGit()) {
      try {
        return await this.fetchViaShallowClone(
          opts,
          repo,
          owner,
          repoName,
          ref,
          resolvedVersion,
          docsPath,
          remoteUrl,
          askHome,
        )
      }
      catch (err) {
        consola.warn(
          `git clone failed for ${repo}@${ref}: `
          + `${err instanceof Error ? err.message : err}. `
          + 'Falling back to tar.gz download.',
        )
      }
    }

    return this.fetchFromTarGz(opts, repo, owner, repoName, ref, resolvedVersion, docsPath, askHome)
  }

  private async fetchViaShallowClone(
    opts: GithubSourceOptions,
    repo: string,
    owner: string,
    repoName: string,
    ref: string,
    resolvedVersion: string,
    docsPath: string | undefined,
    remoteUrl: string,
    askHome: string,
  ): Promise<FetchResult> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-gh-clone-'))
    try {
      const { commit, winningCandidate } = cloneAtTag(remoteUrl, ref, tmpDir)
      const storeDir = githubStorePath(askHome, DEFAULT_GITHUB_HOST, owner, repoName, winningCandidate)

      const lock = await acquireEntryLock(storeDir)
      if (lock) {
        try {
          fs.mkdirSync(path.dirname(storeDir), { recursive: true })
          cpDirAtomic(tmpDir, storeDir)
          stampEntry(storeDir)
        }
        finally {
          lock.release()
        }
      }

      const files = this.extractDocsFromDir(storeDir, repo, ref, docsPath)
      return {
        files,
        resolvedVersion,
        storePath: storeDir,
        storeSubpath: docsPath,
        meta: { commit, ref: winningCandidate },
      }
    }
    finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  private async fetchFromTarGz(
    opts: GithubSourceOptions,
    repo: string,
    owner: string,
    repoName: string,
    ref: string,
    resolvedVersion: string,
    docsPath: string | undefined,
    askHome: string,
  ): Promise<FetchResult> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-gh-tar-'))

    try {
      const archiveUrl = `https://github.com/${repo}/archive/refs/${opts.tag ? 'tags' : 'heads'}/${ref}.tar.gz`

      const response = await fetch(archiveUrl)
      if (!response.ok) {
        throw new Error(
          `Failed to download ${archiveUrl}: HTTP ${response.status} ${response.statusText}`,
        )
      }
      const archiveBuffer = Buffer.from(await response.arrayBuffer())
      const tarResult = spawnSync('tar', ['xz', '-C', tmpDir], {
        input: archiveBuffer,
        stdio: ['pipe', 'ignore', 'pipe'],
      })
      if (tarResult.status !== 0) {
        const stderr = tarResult.stderr?.toString() ?? ''
        throw new Error(
          `tar extraction failed for ${repo}@${ref}: ${stderr.trim() || `exit code ${tarResult.status}`}`,
        )
      }

      const extractedDirs = fs.readdirSync(tmpDir)
      if (extractedDirs.length === 0) {
        throw new Error(`Failed to extract archive from ${repo}@${ref}`)
      }
      const extractedDir = path.join(tmpDir, extractedDirs[0])

      // Write to the new nested layout. We use the ref as given because
      // the tar.gz fallback has no fallback chain of its own.
      const storeDir = githubStorePath(askHome, DEFAULT_GITHUB_HOST, owner, repoName, ref)
      const lock = await acquireEntryLock(storeDir)
      if (lock) {
        try {
          fs.mkdirSync(path.dirname(storeDir), { recursive: true })
          cpDirAtomic(extractedDir, storeDir)
          stampEntry(storeDir)
        }
        finally {
          lock.release()
        }
      }

      const files = this.extractDocsFromDir(storeDir, repo, ref, docsPath)
      return {
        files,
        resolvedVersion,
        storePath: storeDir,
        storeSubpath: docsPath,
        meta: { ref },
      }
    }
    finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  private extractDocsFromDir(
    extractedDir: string,
    repo: string,
    ref: string,
    docsPath?: string,
  ): DocFile[] {
    const targetPath = docsPath ?? this.detectDocsPath(extractedDir)
    if (!targetPath) {
      throw new Error(
        `No docs directory found in ${repo}@${ref}. Specify --path to point to the docs directory.`,
      )
    }

    const docsDir = path.join(extractedDir, targetPath)
    if (!fs.existsSync(docsDir)) {
      throw new Error(`Path "${targetPath}" not found in ${repo}@${ref}`)
    }

    if (fs.statSync(docsDir).isFile()) {
      const content = fs.readFileSync(docsDir, 'utf-8')
      return [{ path: path.basename(docsDir), content }]
    }
    return this.collectDocFiles(docsDir, docsDir)
  }

  private detectDocsPath(dir: string): string | null {
    const candidates = ['docs', 'doc', 'documentation', 'guide', 'guides']
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate)
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        return candidate
      }
    }
    return null
  }

  private collectDocFiles(baseDir: string, currentDir: string): DocFile[] {
    const files: DocFile[] = []
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        files.push(...this.collectDocFiles(baseDir, fullPath))
      }
      else if (this.isDocFile(entry.name)) {
        const relativePath = path.relative(baseDir, fullPath)
        const content = fs.readFileSync(fullPath, 'utf-8')
        files.push({ path: relativePath, content })
      }
    }

    return files
  }

  private isDocFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase()
    return ['.md', '.mdx', '.txt', '.rst'].includes(ext)
  }
}
