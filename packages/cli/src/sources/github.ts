import type {
  DocFile,
  DocSource,
  FetchResult,
  GithubSourceOptions,
  SourceConfig,
} from './index.js'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RE_LEADING_V = /^v/
const RE_SHA40 = /^[0-9a-f]{40}$/
const RE_WHITESPACE = /\s+/

export class GithubSource implements DocSource {
  async fetch(options: SourceConfig): Promise<FetchResult> {
    const opts = options as GithubSourceOptions
    const { repo, docsPath } = opts
    const ref = opts.tag ?? opts.branch ?? 'main'

    // Resolve the ref to get the actual version (strip leading "v" from tags)
    const tagVersion = opts.tag?.replace(RE_LEADING_V, '')
    const resolvedVersion = tagVersion ?? opts.version

    // Download repo archive and extract docs
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-gh-'))

    try {
      const archiveUrl = `https://github.com/${repo}/archive/refs/${opts.tag ? 'tags' : 'heads'}/${ref}.tar.gz`
      execSync(`curl -sL "${archiveUrl}" | tar xz -C "${tmpDir}"`, {
        encoding: 'utf-8',
      })

      // Find extracted directory (format: reponame-ref)
      const extractedDirs = fs.readdirSync(tmpDir)
      if (extractedDirs.length === 0) {
        throw new Error(`Failed to extract archive from ${repo}@${ref}`)
      }
      const extractedDir = path.join(tmpDir, extractedDirs[0])

      // Find docs
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

      let files: DocFile[]
      if (fs.statSync(docsDir).isFile()) {
        // Single file specified
        const content = fs.readFileSync(docsDir, 'utf-8')
        files = [{ path: path.basename(docsDir), content }]
      }
      else {
        files = this.collectDocFiles(docsDir, docsDir)
      }

      const commit = this.resolveCommit(repo, ref)
      return {
        files,
        resolvedVersion,
        meta: { commit, ref },
      }
    }
    finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
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
      const out = execSync(
        `git ls-remote https://github.com/${repo}.git ${ref}`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      // ls-remote may return multiple lines (e.g. tag + ^{} dereference).
      // Prefer the dereferenced commit if present.
      const lines = out.split('\n').filter(Boolean)
      const dereferenced = lines.find(l => l.includes(`refs/tags/${ref}^{}`))
      const sha = (dereferenced ?? lines[0])?.split(RE_WHITESPACE)[0]
      return sha && RE_SHA40.test(sha) ? sha : undefined
    }
    catch {
      return undefined
    }
  }

  private isDocFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase()
    return ['.md', '.mdx', '.txt', '.rst'].includes(ext)
  }
}
