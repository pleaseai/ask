import type {
  DocFile,
  DocSource,
  FetchResult,
  NpmSourceOptions,
  SourceConfig,
} from './index.js'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { consola } from 'consola'

export class NpmSource implements DocSource {
  async fetch(options: SourceConfig): Promise<FetchResult> {
    const opts = options as NpmSourceOptions
    const pkg = opts.package ?? opts.name
    const spec = `${pkg}@${opts.version}`

    // Get package info to resolve exact version and tarball URL
    const resolvedVersion = execSync(`npm view ${spec} version`, {
      encoding: 'utf-8',
    }).trim()

    const tarballUrl = execSync(`npm view ${spec} dist.tarball`, {
      encoding: 'utf-8',
    }).trim()

    // Download and extract tarball
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-npm-'))

    try {
      consola.info(`  Downloading ${pkg}@${resolvedVersion}...`)
      execSync(`curl -sL "${tarballUrl}" | tar xz -C "${tmpDir}"`, {
        encoding: 'utf-8',
      })

      // Find docs in the extracted package
      const packageDir = path.join(tmpDir, 'package')
      const docsPath = opts.docsPath ?? this.detectDocsPath(packageDir)

      if (!docsPath) {
        throw new Error(
          `No docs found in ${spec}. Specify --docs-path to point to the docs directory within the package.`,
        )
      }

      const docsDir = path.join(packageDir, docsPath)
      if (!fs.existsSync(docsDir)) {
        throw new Error(
          `Docs path "${docsPath}" not found in ${spec}. Available paths:\n${this.listDirs(packageDir)}`,
        )
      }

      let files: DocFile[]
      if (fs.statSync(docsDir).isFile()) {
        const content = fs.readFileSync(docsDir, 'utf-8')
        files = [{ path: path.basename(docsDir), content }]
      }
      else {
        files = this.collectMarkdownFiles(docsDir, docsDir)
      }
      return { files, resolvedVersion }
    }
    finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  private detectDocsPath(packageDir: string): string | null {
    const candidates = [
      'docs',
      'doc',
      'dist/docs',
      'documentation',
      'guide',
      'guides',
    ]
    for (const candidate of candidates) {
      const fullPath = path.join(packageDir, candidate)
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        return candidate
      }
    }
    return null
  }

  private listDirs(dir: string): string {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => `  - ${d.name}/`)
      .join('\n')
  }

  private collectMarkdownFiles(
    baseDir: string,
    currentDir: string,
  ): DocFile[] {
    const files: DocFile[] = []
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        files.push(...this.collectMarkdownFiles(baseDir, fullPath))
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
