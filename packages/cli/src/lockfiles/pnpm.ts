import type { LockfileReader } from './index.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  cleanValue,
  isRegistryVersion,
  splitPkgSpec,
  stripPeerSuffix,
  trimQuotes,
} from './parse-helpers.js'

/**
 * Format-aware `pnpm-lock.yaml` parser, ported from opensrc's
 * `core/version.rs` (vercel-labs/opensrc#51). Replaces the previous
 * regex-based parser, which misidentified versions in common real-world
 * cases: pnpm peer-dep suffixes like `18.2.0(react@17.0.0)` leaked false
 * matches for the inner package, and monorepos returned whichever version
 * the regex engine encountered first.
 *
 * The parser is an indent-aware stack machine covering pnpm v5 through v9,
 * including importers, devDependencies, optionalDependencies, and nested
 * peer-dep suffixes. While parsing it builds a dependency graph from
 * `snapshots:` (v9) or `packages:` (v6–v8); when a direct lookup misses,
 * a BFS from root-importer deps picks the root-reachable version instead
 * of a lexicographic first match.
 */

/**
 * Dependency-graph node built up during parsing. Keys in the containing
 * map are the full snapshot id (`<name>@<version>[<peer-suffix>]`).
 */
interface PnpmNode {
  name: string
  /** Version with peer suffix stripped — what we'd return to the caller. */
  version: string
  /** Snapshot ids of this node's direct dependencies. */
  deps: string[]
}

interface PnpmGraph {
  nodes: Map<string, PnpmNode>
  /**
   * Snapshot ids that are direct deps of any importer (or top-level
   * `dependencies:` in v5/v6 non-workspace lockfiles).
   */
  roots: string[]
}

/** Where a direct dependency entry was found. */
type Origin = 'root' | 'importer'

/**
 * A frame on the indent-aware parse stack. `base` is the indent of the
 * line that opened the frame; children must be at indent strictly greater
 * than that value. The `root` frame has no header line and is never popped.
 */
type Frame
  = | { kind: 'root' }
    | { kind: 'importers', base: number }
    | { kind: 'importer', base: number }
    | { kind: 'depGroup', base: number, origin: Origin }
    /** Block-form dep entry awaiting a nested `version:` line. */
    | { kind: 'depBlock', base: number, origin: Origin, pkgName: string }
    | { kind: 'packages', base: number }
    | { kind: 'snapshots', base: number }
    /** Inside a `packages:`/`snapshots:` entry, collecting its subkeys. */
    | { kind: 'pkgEntry', base: number, key: string }
    /**
     * Inside a pkg entry's `dependencies:`/`optionalDependencies:` block,
     * collecting dep edges for `owner`.
     */
    | { kind: 'pkgDeps', base: number, owner: string }

const DEP_GROUP_KEYS = new Set(['dependencies', 'devDependencies', 'optionalDependencies'])

/**
 * Parse a `pnpm-lock.yaml` text and return the installed version of
 * `pkg`, if found.
 *
 * Search priority:
 * 1. Direct match in `importers.<any>.{dependencies,devDependencies,optionalDependencies}`
 * 2. Direct match in top-level `{dependencies,devDependencies,optionalDependencies}` (v5/v6)
 * 3. Transitive resolution via BFS from root-importer deps through the
 *    `snapshots:` (v9) or `packages:` (v6–v8) dep graph
 * 4. Fallback: first matching `packages:` or `snapshots:` key
 */
export function parsePnpmLock(text: string, pkg: string): string | null {
  const stack: Frame[] = [{ kind: 'root' }]
  const graph: PnpmGraph = { nodes: new Map(), roots: [] }

  let importerMatch: string | null = null
  let topMatch: string | null = null
  let packagesFallback: string | null = null

  const captureDirect = (depName: string, rawValue: string, origin: Origin): void => {
    const cleaned = cleanValue(rawValue)
    const stripped = stripPeerSuffix(cleaned)
    // Add to graph roots using the raw (peer-including) value so the key
    // matches `snapshots:` entries.
    graph.roots.push(`${depName}@${cleaned}`)

    // Filter at capture so workspace/link/file versions in one importer
    // don't block a real version in a later importer.
    if (depName === pkg && isRegistryVersion(stripped)) {
      if (origin === 'importer' && importerMatch === null)
        importerMatch = stripped
      else if (origin === 'root' && topMatch === null)
        topMatch = stripped
    }
  }

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim().length === 0)
      continue
    if (line.trimStart().startsWith('#'))
      continue
    const indent = line.length - line.trimStart().length
    const content = line.slice(indent)

    // Pop frames whose scope has ended. Root (no base) never pops, so
    // the stack is never empty and the `at(-1)!` assertions are safe.
    while (true) {
      const frame = stack.at(-1)!
      if (frame.kind !== 'root' && indent <= frame.base) {
        stack.pop()
        continue
      }
      break
    }

    const top = stack.at(-1)!
    switch (top.kind) {
      case 'root': {
        if (indent === 0 && content.endsWith(':')) {
          const key = content.slice(0, -1).trim()
          if (key === 'importers')
            stack.push({ kind: 'importers', base: indent })
          else if (DEP_GROUP_KEYS.has(key))
            stack.push({ kind: 'depGroup', base: indent, origin: 'root' })
          else if (key === 'packages')
            stack.push({ kind: 'packages', base: indent })
          else if (key === 'snapshots')
            stack.push({ kind: 'snapshots', base: indent })
        }
        break
      }
      case 'importers': {
        if (content.endsWith(':'))
          stack.push({ kind: 'importer', base: indent })
        break
      }
      case 'importer': {
        if (content.endsWith(':') && DEP_GROUP_KEYS.has(content.slice(0, -1).trim()))
          stack.push({ kind: 'depGroup', base: indent, origin: 'importer' })
        break
      }
      case 'depGroup': {
        const sep = content.indexOf(':')
        if (sep >= 0) {
          const depName = trimQuotes(content.slice(0, sep).trim())
          const rawValue = content.slice(sep + 1).trim()
          if (rawValue.length === 0) {
            // Block form: version comes on a nested line.
            stack.push({ kind: 'depBlock', base: indent, origin: top.origin, pkgName: depName })
          }
          else {
            captureDirect(depName, rawValue, top.origin)
          }
        }
        break
      }
      case 'depBlock': {
        if (content.startsWith('version:')) {
          captureDirect(top.pkgName, content.slice('version:'.length), top.origin)
          stack.pop()
        }
        break
      }
      case 'packages':
      case 'snapshots': {
        const sep = content.indexOf(':')
        if (sep >= 0) {
          const rawKey = trimQuotes(content.slice(0, sep).trim())
          const key = rawKey.startsWith('/') ? rawKey.slice(1) : rawKey
          const valuePart = content.slice(sep + 1)

          const split = splitPkgSpec(key)
          if (split) {
            const [name, versionWithPeer] = split
            const version = stripPeerSuffix(versionWithPeer)

            if (!graph.nodes.has(key))
              graph.nodes.set(key, { name, version, deps: [] })

            if (name === pkg && packagesFallback === null && isRegistryVersion(version))
              packagesFallback = version

            if (valuePart.trim().length === 0)
              stack.push({ kind: 'pkgEntry', base: indent, key })
            // Else: inline value like `{}` — no children to parse.
          }
        }
        break
      }
      case 'pkgEntry': {
        if (content.endsWith(':')) {
          const subKey = content.slice(0, -1).trim()
          if (subKey === 'dependencies' || subKey === 'optionalDependencies')
            stack.push({ kind: 'pkgDeps', base: indent, owner: top.key })
          // Ignore resolution/engines/peerDependencies/transitivePeerDependencies/etc.
        }
        break
      }
      case 'pkgDeps': {
        const sep = content.indexOf(':')
        if (sep >= 0) {
          const depName = trimQuotes(content.slice(0, sep).trim())
          const depValue = cleanValue(content.slice(sep + 1))
          if (depValue.length > 0)
            graph.nodes.get(top.owner)?.deps.push(`${depName}@${depValue}`)
        }
        break
      }
    }
  }

  return importerMatch ?? topMatch ?? resolveTransitive(graph, pkg) ?? packagesFallback
}

/**
 * Breadth-first search from `graph.roots` through the snapshot dep graph,
 * returning the version of the first reached node whose name matches
 * `pkg`. Depth-first would pick a less-predictable version; BFS picks the
 * version at the shallowest transitive depth, which is closer to what's
 * actually hoisted in `node_modules`.
 */
function resolveTransitive(graph: PnpmGraph, pkg: string): string | null {
  if (graph.nodes.size === 0 || graph.roots.length === 0)
    return null
  const visited = new Set<string>()
  const queue = [...graph.roots]
  while (queue.length > 0) {
    const key = queue.shift()!
    if (visited.has(key))
      continue
    visited.add(key)
    const node = graph.nodes.get(key)
    if (!node)
      continue
    if (node.name === pkg && isRegistryVersion(node.version))
      return node.version
    for (const dep of node.deps) {
      if (!visited.has(dep))
        queue.push(dep)
    }
  }
  return null
}

export const pnpmLockReader: LockfileReader = {
  file: 'pnpm-lock.yaml',
  exact: true,
  read(name, projectDir) {
    const filePath = path.join(projectDir, 'pnpm-lock.yaml')
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    }
    catch {
      return null
    }
    const version = parsePnpmLock(content, name)
    return version ? { version, source: 'pnpm-lock.yaml', exact: true } : null
  },
}
