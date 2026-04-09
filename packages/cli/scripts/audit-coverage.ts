#!/usr/bin/env bun
/**
 * Coverage audit for SC-1 of convention-based-discovery-20260409 (#46).
 *
 * Iterates every entry in `apps/registry/content/registry/**\/*.md`,
 * extracts `{owner, repo, aliases, docsPath}`, and for each entry
 * attempts to resolve the docs via the **convention scan alone** (no
 * registry call). A resolution counts as "covered" when the scan
 * produces a `kind: 'docs'` DiscoveryResult whose file list is
 * non-empty.
 *
 * This script is a scaffold: running it against the real registry
 * requires a sandbox with the packages installed to `node_modules/` so
 * `localAskAdapter` / `localConventionsAdapter` can read them in place.
 * CI integration is left as a follow-up (see Phase 5 track notes).
 *
 * Usage (from repo root):
 *   bun run packages/cli/scripts/audit-coverage.ts [--registry <dir>]
 *
 * Output (stdout):
 *   one JSON line per entry: {entry, covered, adapter, reason}
 *   final line: {total, covered, percentage}
 *
 * Exit code:
 *   0 if percentage >= 80
 *   1 otherwise (SC-1 failure)
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { runLocalDiscovery } from '../src/discovery/index.js'

interface RegistryEntry {
  slug: string
  owner: string
  repo: string
  npmName?: string
  docsPath?: string
}

/**
 * Registry alias entries are structured YAML objects, not the shorthand
 * `- npm:<name>` strings an earlier draft of this script expected. A
 * typical entry looks like:
 *
 *     aliases:
 *       - ecosystem: npm
 *         name: zod
 *
 * The regex below matches that two-line pair anywhere in the
 * frontmatter. `[\s\S]*?` is a non-greedy wildcard that lets the
 * `name:` line be any distance below the `ecosystem: npm` line (the
 * real registry files put them on adjacent lines, but staying lenient
 * keeps the audit robust across hand-edits).
 */
const NPM_ALIAS_RE = /ecosystem:\s*npm[\s\S]*?name:\s*['"]?([^'"\s]+)['"]?/g
const REPO_RE = /^repo:\s*['"]?([^'"\s]+)['"]?/m
const DOCS_PATH_RE = /^docsPath:\s*['"]?([^'"\s]+)['"]?/m

function parseEntry(mdPath: string): RegistryEntry | null {
  const content = fs.readFileSync(mdPath, 'utf-8')
  const fmEnd = content.indexOf('\n---', 4)
  if (fmEnd === -1) {
    return null
  }
  const frontmatter = content.slice(0, fmEnd)
  const repoMatch = REPO_RE.exec(frontmatter)
  if (!repoMatch) {
    return null
  }
  const [owner, repo] = repoMatch[1]!.split('/')
  if (!owner || !repo) {
    return null
  }
  const docsPathMatch = DOCS_PATH_RE.exec(frontmatter)
  const npmAliases: string[] = []
  NPM_ALIAS_RE.lastIndex = 0
  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = NPM_ALIAS_RE.exec(frontmatter))) {
    npmAliases.push(m[1]!)
  }
  return {
    slug: `${owner}/${repo}`,
    owner,
    repo,
    npmName: npmAliases[0],
    docsPath: docsPathMatch?.[1],
  }
}

async function auditEntry(
  entry: RegistryEntry,
  projectDir: string,
): Promise<{ covered: boolean, adapter?: string, reason?: string }> {
  const pkgName = entry.npmName
  if (!pkgName) {
    return { covered: false, reason: 'no npm alias' }
  }
  try {
    const result = await runLocalDiscovery({
      projectDir,
      pkg: pkgName,
      requestedVersion: 'latest',
    })
    if (!result) {
      return { covered: false, reason: 'discovery miss' }
    }
    if (result.kind !== 'docs') {
      return { covered: false, reason: `unexpected kind: ${result.kind}` }
    }
    if (result.files.length === 0) {
      return { covered: false, reason: 'empty file list' }
    }
    return { covered: true, adapter: result.adapter }
  }
  catch (err) {
    return {
      covered: false,
      reason: `error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let registryDir = 'apps/registry/content/registry'
  const idx = args.indexOf('--registry')
  if (idx !== -1 && args[idx + 1]) {
    registryDir = args[idx + 1]!
  }
  if (!fs.existsSync(registryDir)) {
    console.error(`registry dir not found: ${registryDir}`)
    process.exit(2)
  }

  const mdFiles: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
      }
      else if (e.isFile() && e.name.endsWith('.md')) {
        mdFiles.push(full)
      }
    }
  }
  walk(registryDir)

  const projectDir = process.cwd()
  let total = 0
  let covered = 0
  for (const md of mdFiles) {
    const entry = parseEntry(md)
    if (!entry) {
      continue
    }
    total++
    const result = await auditEntry(entry, projectDir)
    if (result.covered) {
      covered++
    }
    console.log(
      JSON.stringify({ entry: entry.slug, npmName: entry.npmName, ...result }),
    )
  }
  const percentage = total === 0 ? 0 : Math.round((covered / total) * 100)
  console.log(JSON.stringify({ total, covered, percentage }))
  process.exit(percentage >= 80 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(3)
})
