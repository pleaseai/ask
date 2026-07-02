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
 * than that value. The root scope has no frame — an empty stack means
 * the current line is at document level.
 */
type Frame
  = | { kind: 'importers', base: number }
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

/** Mutable state threaded through the per-frame line handlers. */
interface ParseState {
  pkg: string
  stack: Frame[]
  graph: PnpmGraph
  importerMatch: string | null
  topMatch: string | null
  packagesFallback: string | null
}

const DEP_GROUP_KEYS = new Set(['dependencies', 'devDependencies', 'optionalDependencies'])

/**
 * Split a `packages:`/`snapshots:` entry key (leading `/` already
 * stripped) into name + version + the node key used in the dep graph.
 *
 * v6–v9 keys use `<name>@<version>[<peer-suffix>]` — the node key is
 * the raw key so it matches dep values that include peer suffixes.
 *
 * v5 keys use `/<name>/<version>[_peerhash]` (slash separator, no `@`
 * between name and version): split at the LAST slash so scoped names
 * (`@scope/pkg/1.2.3`) stay intact, and strip the `_peerhash` suffix.
 * The node key is canonicalized to `<name>@<version>` because v5 dep
 * edges and top-level roots reference deps as `<name>: <version>`.
 */
function splitPackagesKey(key: string): { name: string, versionWithPeer: string, nodeKey: string } | null {
  const split = splitPkgSpec(key)
  if (split) {
    const [name, versionWithPeer] = split
    return { name, versionWithPeer, nodeKey: key }
  }
  const i = key.lastIndexOf('/')
  if (i <= 0 || i === key.length - 1)
    return null
  const name = key.slice(0, i)
  const underscore = key.indexOf('_', i)
  const version = underscore >= 0 ? key.slice(i + 1, underscore) : key.slice(i + 1)
  if (version.length === 0)
    return null
  return { name, versionWithPeer: version, nodeKey: `${name}@${version}` }
}

/**
 * Pop frames whose scope ended at this indent and return the frame the
 * line belongs to — `undefined` means document (root) level.
 */
function currentFrame(stack: Frame[], indent: number): Frame | undefined {
  let top = stack.at(-1)
  while (top && indent <= top.base) {
    stack.pop()
    top = stack.at(-1)
  }
  return top
}

/**
 * Record a direct dependency entry: seed the graph roots and capture the
 * version when the entry names the package we're looking for.
 */
function captureDirect(state: ParseState, depName: string, rawValue: string, origin: Origin): void {
  const cleaned = cleanValue(rawValue)
  const stripped = stripPeerSuffix(cleaned)
  // Add to graph roots using the raw (peer-including) value so the key
  // matches `snapshots:` entries.
  state.graph.roots.push(`${depName}@${cleaned}`)

  // Filter at capture so workspace/link/file versions in one importer
  // don't block a real version in a later importer.
  if (depName !== state.pkg || !isRegistryVersion(stripped))
    return
  if (origin === 'importer' && state.importerMatch === null)
    state.importerMatch = stripped
  else if (origin === 'root' && state.topMatch === null)
    state.topMatch = stripped
}

/** Document-level line: open the top-level sections we care about. */
function handleRootLine(state: ParseState, indent: number, content: string): void {
  if (indent !== 0 || !content.endsWith(':'))
    return
  const key = content.slice(0, -1).trim()
  if (key === 'importers')
    state.stack.push({ kind: 'importers', base: indent })
  else if (DEP_GROUP_KEYS.has(key))
    state.stack.push({ kind: 'depGroup', base: indent, origin: 'root' })
  else if (key === 'packages')
    state.stack.push({ kind: 'packages', base: indent })
  else if (key === 'snapshots')
    state.stack.push({ kind: 'snapshots', base: indent })
}

/** Inside `importers:` — every child key is an importer (workspace dir). */
function handleImportersLine(state: ParseState, indent: number, content: string): void {
  if (content.endsWith(':'))
    state.stack.push({ kind: 'importer', base: indent })
}

/** Inside one importer — open its dependency groups. */
function handleImporterLine(state: ParseState, indent: number, content: string): void {
  if (content.endsWith(':') && DEP_GROUP_KEYS.has(content.slice(0, -1).trim()))
    state.stack.push({ kind: 'depGroup', base: indent, origin: 'importer' })
}

/**
 * Inside a dependency group — either an inline `name: version` entry
 * (v5) or a block entry whose `version:` arrives on a nested line (v6+).
 */
function handleDepGroupLine(state: ParseState, frame: Extract<Frame, { kind: 'depGroup' }>, indent: number, content: string): void {
  const sep = content.indexOf(':')
  if (sep < 0)
    return
  const depName = trimQuotes(content.slice(0, sep).trim())
  const rawValue = content.slice(sep + 1).trim()
  if (rawValue.length === 0)
    state.stack.push({ kind: 'depBlock', base: indent, origin: frame.origin, pkgName: depName })
  else
    captureDirect(state, depName, rawValue, frame.origin)
}

/** Block-form dep entry — capture its nested `version:` line. */
function handleDepBlockLine(state: ParseState, frame: Extract<Frame, { kind: 'depBlock' }>, content: string): void {
  if (!content.startsWith('version:'))
    return
  captureDirect(state, frame.pkgName, content.slice('version:'.length), frame.origin)
  state.stack.pop()
}

/**
 * Inside `packages:`/`snapshots:` — register a graph node per entry and
 * remember the first key matching the package as a last-resort fallback.
 */
function handlePackagesLine(state: ParseState, indent: number, content: string): void {
  const sep = content.indexOf(':')
  if (sep < 0)
    return
  const rawKey = trimQuotes(content.slice(0, sep).trim())
  const key = rawKey.startsWith('/') ? rawKey.slice(1) : rawKey
  const valuePart = content.slice(sep + 1)

  const split = splitPackagesKey(key)
  if (!split)
    return
  const { name, versionWithPeer, nodeKey } = split
  const version = stripPeerSuffix(versionWithPeer)

  if (!state.graph.nodes.has(nodeKey))
    state.graph.nodes.set(nodeKey, { name, version, deps: [] })

  if (name === state.pkg && state.packagesFallback === null && isRegistryVersion(version))
    state.packagesFallback = version

  if (valuePart.trim().length === 0)
    state.stack.push({ kind: 'pkgEntry', base: indent, key: nodeKey })
  // Else: inline value like `{}` — no children to parse.
}

/** Inside one pkg entry — open its dependency blocks, ignore the rest. */
function handlePkgEntryLine(state: ParseState, frame: Extract<Frame, { kind: 'pkgEntry' }>, indent: number, content: string): void {
  if (!content.endsWith(':'))
    return
  const subKey = content.slice(0, -1).trim()
  if (subKey === 'dependencies' || subKey === 'optionalDependencies')
    state.stack.push({ kind: 'pkgDeps', base: indent, owner: frame.key })
  // Ignore resolution/engines/peerDependencies/transitivePeerDependencies/etc.
}

/** Inside a pkg entry's dependency block — record a graph edge. */
function handlePkgDepsLine(state: ParseState, frame: Extract<Frame, { kind: 'pkgDeps' }>, content: string): void {
  const sep = content.indexOf(':')
  if (sep < 0)
    return
  const depName = trimQuotes(content.slice(0, sep).trim())
  const depValue = cleanValue(content.slice(sep + 1))
  if (depValue.length > 0)
    state.graph.nodes.get(frame.owner)?.deps.push(`${depName}@${depValue}`)
}

/** Route one content line to the handler for the frame it belongs to. */
function dispatchLine(state: ParseState, indent: number, content: string): void {
  const top = currentFrame(state.stack, indent)
  if (!top) {
    handleRootLine(state, indent, content)
    return
  }
  switch (top.kind) {
    case 'importers':
      handleImportersLine(state, indent, content)
      break
    case 'importer':
      handleImporterLine(state, indent, content)
      break
    case 'depGroup':
      handleDepGroupLine(state, top, indent, content)
      break
    case 'depBlock':
      handleDepBlockLine(state, top, content)
      break
    case 'packages':
    case 'snapshots':
      handlePackagesLine(state, indent, content)
      break
    case 'pkgEntry':
      handlePkgEntryLine(state, top, indent, content)
      break
    case 'pkgDeps':
      handlePkgDepsLine(state, top, content)
      break
  }
}

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
  const state: ParseState = {
    pkg,
    stack: [],
    graph: { nodes: new Map(), roots: [] },
    importerMatch: null,
    topMatch: null,
    packagesFallback: null,
  }

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim().length === 0 || line.trimStart().startsWith('#'))
      continue
    const indent = line.length - line.trimStart().length
    dispatchLine(state, indent, line.slice(indent))
  }

  return state.importerMatch
    ?? state.topMatch
    ?? resolveTransitive(state.graph, pkg)
    ?? state.packagesFallback
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
  // Index-pointer BFS: `queue` only grows, so iterating by index visits
  // entries in insertion order without shift()'s O(n) reindexing.
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i]
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
