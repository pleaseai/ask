import type { AskJson } from '@pleaseai/ask-schema'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { consola } from 'consola'
import { runInstall } from './install.js'
import { readAskJson, writeAskJson } from './io.js'
import { detectEcosystem, fetchRegistryEntry } from './registry.js'
import { entryFromSpec, specFromEntry } from './schemas.js'
import { parseSpec } from './spec.js'

/**
 * Extract dependency names from a parsed package.json, excluding those
 * already declared in ask.json.
 *
 * Exported for unit testing — the orchestrator reads the file itself.
 */
export function readProjectDeps(
  packageJson: Record<string, unknown>,
  existingSpecs: string[],
): string[] {
  const deps = {
    ...(packageJson.dependencies as Record<string, string> | undefined),
    ...(packageJson.devDependencies as Record<string, string> | undefined),
  }

  const names = Object.keys(deps)
  if (names.length === 0)
    return []

  // Build a set of npm package names already registered in ask.json
  const registered = new Set<string>()
  for (const spec of existingSpecs) {
    const parsed = parseSpec(spec)
    if (parsed.kind === 'npm') {
      registered.add(parsed.pkg)
    }
  }

  return names.filter(name => !registered.has(name)).sort()
}

export interface RegistryCheckResult {
  registered: string[]
  unregistered: string[]
}

/**
 * Check which dependency names have entries in the ASK registry.
 * Uses Promise.allSettled for parallel lookups with existing 10s timeout.
 */
export async function checkRegistryBatch(
  ecosystem: string,
  deps: string[],
): Promise<RegistryCheckResult> {
  const results = await Promise.allSettled(
    deps.map(async (name) => {
      const entry = await fetchRegistryEntry(ecosystem, name)
      return { name, found: entry !== null }
    }),
  )

  const registered: string[] = []
  const unregistered: string[] = []

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!
    if (result.status === 'fulfilled') {
      if (result.value.found) {
        registered.push(result.value.name)
      }
      else {
        unregistered.push(result.value.name)
      }
    }
    else {
      // On failure, recover dep name from parallel index
      unregistered.push(deps[i]!)
    }
  }

  return { registered, unregistered }
}

const OWNER_REPO_RE = /^[^/]+\/[^/]+$/

function normalizeAddSpec(input: string): string {
  if (!input.includes(':')) {
    // Scoped npm packages (@scope/pkg) look like owner/repo but start with @
    if (input.startsWith('@')) {
      return `npm:${input}`
    }
    if (OWNER_REPO_RE.test(input)) {
      return `github:${input}`
    }
    // Assume npm ecosystem for bare names in interactive mode
    return `npm:${input}`
  }
  return input
}

/**
 * Interactive add flow — called when `ask add` runs without arguments.
 */
export async function runInteractiveAdd(projectDir: string): Promise<void> {
  if (!process.stdout.isTTY) {
    consola.error(
      'Interactive mode requires a TTY. '
      + 'Use `ask add <spec>` to add a library non-interactively.',
    )
    process.exit(1)
  }

  const ecosystem = detectEcosystem(projectDir)
  consola.info(`Detected ecosystem: ${ecosystem}`)

  // Read project dependencies
  const pkgPath = path.join(projectDir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    consola.warn('No package.json found. Cannot scan dependencies.')
    consola.info('Use `ask add <spec>` to add a library directly.')
    return
  }

  let packageJson: Record<string, unknown>
  try {
    packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
  }
  catch {
    consola.error('Failed to parse package.json. Check for syntax errors.')
    return
  }
  const askJson: AskJson = readAskJson(projectDir) ?? { libraries: [] }
  const deps = readProjectDeps(packageJson, askJson.libraries.map(specFromEntry))

  if (deps.length === 0) {
    consola.info('All project dependencies are already registered in ask.json.')
    return
  }

  // Check registry for each dep
  consola.start(`Checking ${deps.length} dependencies against ASK registry...`)
  const { registered, unregistered } = await checkRegistryBatch(ecosystem, deps)

  // Build choices: registered first, then unregistered
  const choices = [
    ...registered.map(name => ({
      label: `${name}`,
      value: name,
      hint: 'registry',
    })),
    ...unregistered.map(name => ({
      label: `${name}`,
      value: name,
      hint: 'not in registry',
    })),
  ]

  if (choices.length === 0) {
    consola.info('No new dependencies to add.')
    return
  }

  consola.info(`Found ${registered.length} registered, ${unregistered.length} unregistered in ASK registry.`)

  // Multi-select prompt
  const selected = await consola.prompt(
    'Select libraries to add (space to toggle, enter to confirm):',
    {
      type: 'multiselect',
      options: choices,
    },
  ) as unknown as string[]

  if (!selected || selected.length === 0) {
    // Also ask for manual input
    const manual = await consola.prompt(
      'Enter a spec manually (or press enter to skip):',
      { type: 'text', placeholder: 'npm:lodash, github:owner/repo@v1' },
    ) as string

    if (!manual || manual.trim() === '') {
      consola.info('No libraries selected.')
      return
    }

    const specs = manual.split(',').map(s => normalizeAddSpec(s.trim())).filter(Boolean)
    await addSpecs(projectDir, askJson, specs)
    return
  }

  // Convert selected names to specs — always npm since deps come from package.json
  const specs = selected.map(name => `npm:${name}`)

  // Ask for additional manual input
  const manual = await consola.prompt(
    'Any additional specs to add manually? (press enter to skip):',
    { type: 'text', placeholder: 'npm:lodash, github:owner/repo@v1' },
  ) as string

  if (manual && manual.trim() !== '') {
    const manualSpecs = manual.split(',').map(s => normalizeAddSpec(s.trim())).filter(Boolean)
    specs.push(...manualSpecs)
  }

  await addSpecs(projectDir, askJson, specs)
}

async function addSpecs(
  projectDir: string,
  askJson: AskJson,
  specs: string[],
): Promise<void> {
  const added: string[] = []

  for (const spec of specs) {
    const parsed = parseSpec(spec)
    if (parsed.kind === 'unknown') {
      consola.warn(`Skipping invalid spec: ${spec}`)
      continue
    }

    if (askJson.libraries.some(e => specFromEntry(e) === spec)) {
      consola.info(`${spec} already in ask.json`)
      continue
    }

    askJson.libraries.push(entryFromSpec(spec))
    added.push(spec)
  }

  if (added.length === 0) {
    consola.info('No new libraries to add.')
    return
  }

  writeAskJson(projectDir, askJson)
  consola.success(`Added ${added.length} librar${added.length === 1 ? 'y' : 'ies'} to ask.json: ${added.join(', ')}`)

  await runInstall(projectDir, { onlySpecs: added })
}
