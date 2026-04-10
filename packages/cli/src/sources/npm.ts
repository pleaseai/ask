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
import process from 'node:process'
import { consola } from 'consola'
import { satisfies, validRange } from 'semver'
import {
  acquireEntryLock,
  npmStorePath,
  resolveAskHome,
  stampEntry,
  writeEntryAtomic,
} from '../store/index.js'

/**
 * npm source — fetches docs from a published tarball OR, when the package is
 * already installed in the current project, directly from
 * `node_modules/<pkg>/<docsPath>`.
 *
 * Local-first behavior was added in npm-tarball-docs-20260408 to (1) avoid
 * unnecessary network IO when the docs are already present on disk and
 * (2) keep AI agents working offline / inside CI sandboxes. The local path
 * is taken whenever the installed `package.json` version satisfies the
 * requested version (or the request is `latest`) AND the configured
 * `<docsPath>` exists. Otherwise the existing tarball download path runs.
 */
export class NpmSource implements DocSource {
  async fetch(options: SourceConfig): Promise<FetchResult> {
    const opts = options as NpmSourceOptions
    const pkg = opts.package ?? opts.name

    const local = this.tryLocalRead({
      projectDir: process.cwd(),
      pkg,
      requestedVersion: opts.version,
      docsPath: opts.docsPath,
    })
    if (local) {
      consola.info(`  Using local node_modules for ${pkg}@${local.resolvedVersion}`)
      // Also materialize into the global store for cross-project reuse
      await this.writeToStore(pkg, local.resolvedVersion, local.files)
      const askHome = resolveAskHome()
      local.storePath = npmStorePath(askHome, pkg, local.resolvedVersion)
      return local
    }

    return this.fetchFromTarball(opts, pkg)
  }

  /**
   * Read docs directly from `node_modules/<pkg>` when the installed version
   * satisfies the request and the configured `docsPath` exists. Returns
   * `null` to indicate the local path is not viable — the caller falls back
   * to the tarball download.
   *
   * Public-ish (not exported) for unit testing via `(new NpmSource()).tryLocalRead`.
   */
  tryLocalRead(args: {
    projectDir: string
    pkg: string
    requestedVersion: string
    docsPath?: string
  }): FetchResult | null {
    const { projectDir, pkg, requestedVersion, docsPath } = args

    if (!docsPath) {
      // No explicit docsPath: we don't try to auto-detect against
      // node_modules. The local path exists for the curated case.
      return null
    }

    // Resolve the package's installed root. Scoped packages (`@scope/pkg`)
    // live at `node_modules/@scope/pkg/`.
    const pkgDir = path.join(projectDir, 'node_modules', pkg)
    const pkgJsonPath = path.join(pkgDir, 'package.json')
    if (!fs.existsSync(pkgJsonPath)) {
      return null
    }

    let installedVersion: string
    try {
      const meta = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { version?: string }
      if (!meta.version) {
        return null
      }
      installedVersion = meta.version
    }
    catch {
      return null
    }

    if (!this.versionMatches(requestedVersion, installedVersion)) {
      return null
    }

    // Defense-in-depth: even though `docsPath` originates from a trusted
    // registry strategy, treat it as untrusted and reject anything that
    // resolves outside the installed package directory. A malformed entry
    // like `docsPath: '../../../etc/passwd'` would otherwise read arbitrary
    // files on local-first reads.
    //
    // Two-stage check:
    //   1. String-level: reject obvious traversal (`..`, absolute path)
    //      before touching the filesystem.
    //   2. Realpath: after confirming `docsDir` exists, resolve symlinks on
    //      both `pkgDir` and `docsDir` and re-check containment. A symlink
    //      inside the package dir that points outside (e.g.
    //      `node_modules/<pkg>/dist/docs -> /etc`) bypasses the string
    //      check but is caught here.
    const docsDir = path.resolve(pkgDir, docsPath)
    const relativeDocsDir = path.relative(pkgDir, docsDir)
    if (relativeDocsDir.startsWith('..') || path.isAbsolute(relativeDocsDir)) {
      return null
    }
    if (!fs.existsSync(docsDir)) {
      return null
    }
    let realPkgDir: string
    let realDocsDir: string
    try {
      realPkgDir = fs.realpathSync(pkgDir)
      realDocsDir = fs.realpathSync(docsDir)
    }
    catch {
      return null
    }
    const realRelative = path.relative(realPkgDir, realDocsDir)
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      return null
    }

    let files: DocFile[]
    if (fs.statSync(docsDir).isFile()) {
      const content = fs.readFileSync(docsDir, 'utf-8')
      files = [{ path: path.basename(docsDir), content }]
    }
    else {
      files = this.collectMarkdownFiles(docsDir, docsDir)
    }

    if (files.length === 0) {
      // The directory exists but holds no readable docs — treat as a miss
      // so we don't poison the lockfile with an empty entry.
      return null
    }

    return {
      files,
      resolvedVersion: installedVersion,
      meta: { installPath: pkgDir },
    }
  }

  /**
   * Match policy for the local-first read:
   *   - `latest`        → any installed version is acceptable
   *   - exact version   → must equal installed
   *   - semver range    → installed must satisfy
   *   - non-semver tag  → must equal installed (treat as opaque)
   *
   * `requestedVersion` is whatever the caller passed in (`SourceConfig.version`).
   * It originates from the registry resolution + manifest gate, so by the
   * time we get here it is usually an exact version. The semver-range branch
   * is defensive cover for callers that haven't run the gate.
   */
  private versionMatches(requested: string, installed: string): boolean {
    if (requested === 'latest') {
      return true
    }
    if (validRange(requested)) {
      return satisfies(installed, requested)
    }
    return requested === installed
  }

  private async fetchFromTarball(opts: NpmSourceOptions, pkg: string): Promise<FetchResult> {
    const spec = `${pkg}@${opts.version}`

    // Get package info to resolve exact version and tarball URL
    const resolvedVersion = execSync(`npm view ${spec} version`, {
      encoding: 'utf-8',
    }).trim()

    const tarballUrl = execSync(`npm view ${spec} dist.tarball`, {
      encoding: 'utf-8',
    }).trim()

    const integrity = (() => {
      try {
        return execSync(`npm view ${spec} dist.integrity`, {
          encoding: 'utf-8',
        }).trim() || undefined
      }
      catch {
        return undefined
      }
    })()

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
      await this.writeToStore(pkg, resolvedVersion, files)
      const askHome = resolveAskHome()

      return {
        files,
        resolvedVersion,
        storePath: npmStorePath(askHome, pkg, resolvedVersion),
        meta: { tarball: tarballUrl, integrity },
      }
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

  /**
   * Write fetched docs into the global store at
   * `<ASK_HOME>/npm/<pkg>@<version>/`. Skips if the entry already exists.
   */
  private async writeToStore(
    pkg: string,
    version: string,
    files: DocFile[],
  ): Promise<void> {
    const askHome = resolveAskHome()
    const storeDir = npmStorePath(askHome, pkg, version)

    if (fs.existsSync(storeDir)) {
      return // already stored
    }

    const lock = await acquireEntryLock(storeDir)
    if (!lock) {
      return // another process completed the write
    }

    try {
      writeEntryAtomic(storeDir, files)
      stampEntry(storeDir)
    }
    finally {
      lock.release()
    }
  }
}
