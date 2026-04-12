import type { LazyLibraryInfo } from './agents.js'
import path from 'node:path'
import { consola } from 'consola'
import { generateAgentsMd } from './agents.js'
import { splitExplicitVersion } from './commands/ensure-checkout.js'
import { manageIgnoreFiles } from './ignore-files.js'
import { getAskJsonPath, readAskJson, writeAskJson } from './io.js'
import { npmEcosystemReader } from './lockfiles/index.js'
import { generateSkill } from './skill.js'
import { parseSpec } from './spec.js'

export interface RunInstallOptions {
  /** Subset of libraries to install (by spec). When omitted, install all. */
  onlySpecs?: string[]
}

export interface InstallSummary {
  installed: number
  skipped: number
}

/**
 * Lazy-first `ask install` orchestrator.
 *
 * Reads `ask.json` (a simple spec string array), resolves versions from
 * lockfiles, and generates AGENTS.md + SKILL.md with lazy references
 * (`ask src` / `ask docs`). No documentation is downloaded — agents
 * access docs on-demand via the lazy commands.
 */
export async function runInstall(
  projectDir: string,
  options: RunInstallOptions = {},
): Promise<InstallSummary> {
  let askJson = readAskJson(projectDir)
  if (!askJson) {
    askJson = { libraries: [] }
    writeAskJson(projectDir, askJson)
    consola.info(
      `Created empty ${path.relative(projectDir, getAskJsonPath(projectDir))}. `
      + 'Add libraries with `ask add npm:<package>` or `ask add github:<owner>/<repo>@<ref>`.',
    )
    return { installed: 0, skipped: 0 }
  }

  const targets = options.onlySpecs
    ? askJson.libraries.filter(s => options.onlySpecs!.includes(s))
    : askJson.libraries

  if (targets.length === 0) {
    consola.info('No libraries to install.')
    return { installed: 0, skipped: 0 }
  }

  consola.start(`Resolving ${targets.length} librar${targets.length === 1 ? 'y' : 'ies'}...`)

  const summary: InstallSummary = { installed: 0, skipped: 0 }
  const resolved: LazyLibraryInfo[] = []

  for (const spec of targets) {
    const result = resolveOne(projectDir, spec)
    if (result) {
      resolved.push(result)
      generateSkill(projectDir, result.name, result.version)
      summary.installed++
    }
    else {
      summary.skipped++
    }
  }

  // Generate AGENTS.md from all resolved libraries (not just this batch)
  const allResolved = resolveAll(projectDir)
  generateAgentsMd(projectDir, allResolved)
  manageIgnoreFiles(projectDir, 'install')

  consola.success(
    `Install complete: ${summary.installed} resolved, ${summary.skipped} skipped.`,
  )
  return summary
}

/**
 * Resolve version for a single spec string. Returns null when the spec
 * cannot be resolved (missing from lockfile, unsupported ecosystem).
 */
function resolveOne(
  projectDir: string,
  spec: string,
): LazyLibraryInfo | null {
  const { spec: specBody, version: explicitVersion } = splitExplicitVersion(spec)
  const parsed = parseSpec(specBody)

  if (parsed.kind === 'github') {
    // github specs encode version in the spec string: github:owner/repo@v1.2.3
    const version = explicitVersion ?? 'latest'
    consola.info(`  ${spec}: ${parsed.name}@${version}`)
    return { name: parsed.name, version, spec }
  }

  if (parsed.kind === 'npm') {
    // Resolve version from lockfile
    let version = explicitVersion
    if (!version) {
      const hit = npmEcosystemReader.read(parsed.pkg, projectDir)
      if (!hit) {
        consola.warn(
          `  ${spec}: not found in any lockfile — skipping`,
        )
        return null
      }
      version = hit.version
    }
    consola.info(`  ${spec}: ${parsed.name}@${version}`)
    return { name: parsed.name, version, spec }
  }

  consola.warn(`  ${spec}: unsupported ecosystem — skipping`)
  return null
}

/**
 * Resolve all libraries in ask.json for AGENTS.md generation.
 */
function resolveAll(projectDir: string): LazyLibraryInfo[] {
  const askJson = readAskJson(projectDir)
  if (!askJson)
    return []

  const results: LazyLibraryInfo[] = []
  for (const spec of askJson.libraries) {
    const result = resolveOne(projectDir, spec)
    if (result)
      results.push(result)
  }
  return results
}
