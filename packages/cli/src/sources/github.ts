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
import { withBareClone } from '../store/github-bare.js'
import {
  acquireEntryLock,
  githubCheckoutPath,
  resolveAskHome,
  stampEntry,
} from '../store/index.js'

const RE_LEADING_V = /^v/
const RE_SHA40 = /^[0-9a-f]{40}$/
const RE_WHITESPACE = /\s+/
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

export class GithubSource implements DocSource {
  async fetch(options: SourceConfig): Promise<FetchResult> {
    const opts = options as GithubSourceOptions
    const { repo, docsPath } = opts
    const ref = opts.tag ?? opts.branch ?? 'main'
    const [owner, repoName] = repo.split('/')

    // Resolve the ref to get the actual version (strip leading "v" from tags)
    const tagVersion = opts.tag?.replace(RE_LEADING_V, '')
    const resolvedVersion = tagVersion ?? opts.version

    // Try bare clone first (reuses shared git object store across refs)
    const askHome = resolveAskHome()
    const storeCheckoutDir = githubCheckoutPath(askHome, owner, repoName, ref)

    // Check store hit
    if (fs.existsSync(storeCheckoutDir)) {
      const files = this.extractDocsFromDir(storeCheckoutDir, repo, ref, docsPath)
      const commit = this.resolveCommit(repo, ref)
      return { files, resolvedVersion, storePath: storeCheckoutDir, meta: { commit, ref } }
    }

    // Try bare clone path
    const bareResult = withBareClone(askHome, owner, repoName, ref)
    if (bareResult) {
      const files = this.extractDocsFromDir(bareResult, repo, ref, docsPath)
      const commit = this.resolveCommit(repo, ref)
      return { files, resolvedVersion, storePath: bareResult, meta: { commit, ref } }
    }

    // Fallback: tar.gz download
    return this.fetchFromTarGz(opts, repo, ref, resolvedVersion, docsPath)
  }

  private async fetchFromTarGz(
    opts: GithubSourceOptions,
    repo: string,
    ref: string,
    resolvedVersion: string,
    docsPath?: string,
  ): Promise<FetchResult> {
    // Validate repo + ref as defense-in-depth against path-traversal and
    // shell-injection attacks. Both are already validated at the schema
    // layer for `ask.json` entries, but source adapters can be called
    // from other contexts (add command, tests).
    if (!RE_SAFE_REPO.test(repo)) {
      throw new Error(`Invalid repo '${repo}': must be owner/repo with safe characters`)
    }
    if (!RE_SAFE_REF.test(ref)) {
      throw new Error(`Invalid ref '${ref}': must contain only [A-Za-z0-9._/-]`)
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-gh-'))

    try {
      const archiveUrl = `https://github.com/${repo}/archive/refs/${opts.tag ? 'tags' : 'heads'}/${ref}.tar.gz`

      // Download via Node fetch (no shell), pipe body to `tar -xz` via
      // spawnSync with discrete arguments. This eliminates the shell
      // pipeline that previously interpolated `repo`/`ref` into a
      // command string.
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

      // Write the FULL extracted repo root to the store so subsequent
      // store-hit reads can re-parse with different docsPath. The
      // previous implementation wrote only flat docs files, which broke
      // the store-hit fast path on git-less machines.
      const [owner, repoName] = repo.split('/')
      const askHome = resolveAskHome()
      const storeDir = githubCheckoutPath(askHome, owner, repoName, ref)
      const lock = await acquireEntryLock(storeDir)
      if (lock) {
        try {
          // Use fs.cpSync to copy the entire extracted repo into the store
          fs.mkdirSync(path.dirname(storeDir), { recursive: true })
          if (fs.existsSync(storeDir)) {
            fs.rmSync(storeDir, { recursive: true })
          }
          fs.cpSync(extractedDir, storeDir, { recursive: true })
          stampEntry(storeDir)
        }
        finally {
          lock.release()
        }
      }

      // Parse docs from the extracted tree (same shape as the store
      // will hold, so subsequent store hits parse identically).
      const files = this.extractDocsFromDir(extractedDir, repo, ref, docsPath)
      const commit = this.resolveCommit(repo, ref)
      return { files, resolvedVersion, storePath: storeDir, meta: { commit, ref } }
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

  /**
   * Resolve a ref (tag or branch) to a full commit sha via `git ls-remote`.
   * Returns undefined when git is unavailable or the ref cannot be resolved
   * — the lockfile leaves `commit` undefined rather than guessing.
   */
  private resolveCommit(repo: string, ref: string): string | undefined {
    try {
      // execFileSync (not execSync) to bypass the shell — `ref` originates
      // from user-supplied tag/branch and must not be interpolated into a
      // shell command line.
      const out = execFileSync(
        'git',
        ['ls-remote', `https://github.com/${repo}.git`, ref],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      // ls-remote may return multiple lines (e.g. tag + ^{} dereference).
      // Prefer the dereferenced commit if present.
      const lines = out.split('\n').filter(Boolean)
      const dereferenced = lines.find(l => l.includes(`refs/tags/${ref}^{}`))
      const sha = (dereferenced ?? lines[0])?.split(RE_WHITESPACE)[0]
      return sha && RE_SHA40.test(sha) ? sha : undefined
    }
    catch (err) {
      consola.warn(
        `Could not resolve commit for ${repo}@${ref}: ${err instanceof Error ? err.message : err}. `
        + 'Lockfile will not pin a commit sha for this entry.',
      )
      return undefined
    }
  }

  private isDocFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase()
    return ['.md', '.mdx', '.txt', '.rst'].includes(ext)
  }
}
