#!/usr/bin/env node
/**
 * PreToolUse hook for WebFetch.
 *
 * When the fetched URL points at a GitHub repo (repo root, blob/tree/raw
 * file view, code search) or a known library documentation site, inject
 * `additionalContext` suggesting the equivalent `ask` CLI commands so the
 * agent reads version-pinned local files instead of scraped HTML.
 *
 * The hook never blocks: it emits no `permissionDecision`, so the normal
 * permission flow proceeds unchanged. On any parse failure it exits 0
 * silently — a broken hint must never break fetching.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// GitHub top-level paths that are not `<owner>/<repo>` repository routes.
const GITHUB_RESERVED_OWNERS = new Set([
  'about', 'apps', 'collections', 'contact', 'customer-stories', 'events',
  'features', 'issues', 'login', 'marketplace', 'new', 'notifications',
  'orgs', 'pricing', 'pulls', 'search', 'security', 'settings', 'sponsors',
  'topics', 'trending',
])

// Repo sub-routes where fetching the live page is the right call
// (dynamic content the local checkout cannot serve).
const GITHUB_LIVE_ROUTES = new Set([
  'actions', 'commits', 'commit', 'compare', 'discussions', 'graphs',
  'issues', 'labels', 'milestones', 'network', 'projects', 'pull', 'pulls',
  'releases', 'security', 'stargazers', 'tags', 'wiki',
])

const COMMANDS_CHEATSHEET = `Available \`ask\` commands (spec forms: \`npm:<pkg>\`, \`github:<owner>/<repo>\`, \`pypi:<pkg>\`, \`pub:<pkg>\`):
- \`ask src <spec> [--ref <ref>]\` — prints a version-pinned local checkout dir; Read files under it (add \`--json\` for \`{checkoutDir,...}\`)
- \`ask docs <spec>\` — prints candidate documentation paths (node_modules docs, README, docs/ dirs in the checkout)
- \`ask search <spec> "<query>"\` — semantic code search over the pinned source (requires csp)
- \`ask add <spec>\` + \`ask install\` — persist docs into \`.ask/docs/\` and generate agent skills for repeated use
Proceed with WebFetch only if the rendered web page itself is required.`

function loadKnownHosts(baseDir) {
  try {
    return JSON.parse(readFileSync(join(baseDir, 'known-docs-hosts.json'), 'utf8'))
  }
  catch {
    return {}
  }
}

/**
 * Look up a host in the curated map, retrying with leading labels
 * stripped so `docs.astro.build` matches an `astro.build` entry.
 */
function lookupHost(host, knownHosts) {
  let candidate = host
  while (candidate.includes('.')) {
    if (knownHosts[candidate])
      return knownHosts[candidate]
    candidate = candidate.slice(candidate.indexOf('.') + 1)
  }
  return null
}

/** Parse raw.githubusercontent.com paths, including the /refs/heads|tags/ form. */
function parseRawGithubPath(segments) {
  const [owner, repo, ...rest] = segments
  if (!owner || !repo || rest.length === 0)
    return null
  if (rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags') && rest[2])
    return { owner, repo, ref: rest[2], filePath: rest.slice(3).join('/') }
  return { owner, repo, ref: rest[0], filePath: rest.slice(1).join('/') }
}

function githubHint(url) {
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2 || GITHUB_RESERVED_OWNERS.has(segments[0]))
    return null
  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/, '')
  const spec = `github:${owner}/${repo}`
  const route = segments[2]
  const rest = segments.slice(3)

  if (route === undefined) {
    return `This WebFetch targets the GitHub repo \`${owner}/${repo}\`. Instead of scraping repo-page HTML, run \`ask docs ${spec}\` to get README/docs paths from a local checkout, or \`ask src ${spec}\` to browse the full source tree.`
  }
  if (route === 'blob' || route === 'raw' || route === 'tree') {
    const ref = rest[0]
    const filePath = rest.slice(1).join('/')
    if (!ref)
      return null
    return `This WebFetch targets \`${filePath || '/'}\` at ref \`${ref}\` in GitHub repo \`${owner}/${repo}\`. GitHub HTML is noisy and truncates large files. Instead run \`ask src ${spec} --ref ${ref}\` — it prints a pinned checkout dir; then Read \`<checkoutDir>/${filePath || ''}\` to get the content verbatim.`
  }
  if (route === 'search') {
    const query = url.searchParams.get('q')
    const quoted = query ? `"${query.replaceAll('"', '\\"')}"` : '"<query>"'
    return `This WebFetch targets GitHub code search in \`${owner}/${repo}\`. Instead run \`ask search ${spec} ${quoted}\` for semantic search over a pinned local checkout (or \`ask src ${spec}\` then Grep the checkout dir).`
  }
  if (GITHUB_LIVE_ROUTES.has(route))
    return null
  return null
}

function rawGithubHint(url) {
  const parsed = parseRawGithubPath(url.pathname.split('/').filter(Boolean))
  if (!parsed)
    return null
  const { owner, repo, ref, filePath } = parsed
  return `This WebFetch targets the raw file \`${filePath || '/'}\` at ref \`${ref}\` in GitHub repo \`${owner}/${repo}\`. Instead run \`ask src github:${owner}/${repo} --ref ${ref}\` — it prints a pinned checkout dir; then Read \`<checkoutDir>/${filePath}\` locally (no size truncation, reusable for sibling files).`
}

/**
 * Returns the hint string for a URL, or null when WebFetch should
 * proceed without commentary.
 */
export function buildHint(rawUrl, knownHosts) {
  let url
  try {
    url = new URL(rawUrl)
  }
  catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return null
  const host = url.hostname.replace(/^www\./, '').toLowerCase()

  let hint = null
  if (host === 'github.com')
    hint = githubHint(url)
  else if (host === 'raw.githubusercontent.com')
    hint = rawGithubHint(url)
  else {
    const spec = lookupHost(host, knownHosts)
    if (spec)
      hint = `This WebFetch targets the documentation site for \`${spec}\`. The docs site shows the latest version, which may not match the version installed in this project. Prefer \`ask docs ${spec}\` (version-matched local docs) or \`ask src ${spec}\` (real source).`
  }

  if (!hint)
    return null
  return `[ask] ${hint}\n\n${COMMANDS_CHEATSHEET}`
}

function main() {
  let input
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  }
  catch {
    process.exit(0)
  }
  const rawUrl = input?.tool_input?.url
  if (typeof rawUrl !== 'string')
    process.exit(0)

  const baseDir = dirname(fileURLToPath(import.meta.url))
  const hint = buildHint(rawUrl, loadKnownHosts(baseDir))
  if (hint) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: hint,
      },
    }))
  }
  process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
