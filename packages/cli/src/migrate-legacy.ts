import fs from 'node:fs'
import path from 'node:path'
import { consola } from 'consola'
import { getAskDir, getConfigPath, writeConfig } from './io.js'
import { ConfigSchema } from './schemas.js'

const LEGACY_DIR = '.please'

/**
 * One-shot migration from `.please/` (used by ASK before April 2026) to
 * `.ask/`. Triggered exactly once on the first CLI invocation in a project
 * that still has the legacy layout.
 *
 * Idempotency sentinel: the presence of `.ask/config.json` (NOT just `.ask/`)
 * marks the migration as complete. A bare `.ask/` directory may exist for
 * other reasons (created by another tool, leftover from a partial run), so
 * we require the config file specifically.
 *
 * Order of operations is critical for safety:
 *   1. Parse and validate the legacy config FIRST (in memory).
 *   2. Write the new config to .ask/config.json — atomic-ish, no destructive
 *      side effects yet.
 *   3. Move .please/docs/* into .ask/docs/.
 *   4. Remove the legacy config file.
 *
 * If step 1 or 2 throws, nothing on disk has changed and the next run can
 * retry. If step 3 throws partway through, we leave the partial state and
 * throw — the user must intervene rather than silently losing entries on
 * the next run.
 */
export function migrateLegacyWorkspace(projectDir: string): void {
  const newDir = getAskDir(projectDir)
  const newConfig = getConfigPath(projectDir)

  if (fs.existsSync(newConfig)) {
    return
  }

  const legacyDir = path.join(projectDir, LEGACY_DIR)
  const legacyDocs = path.join(legacyDir, 'docs')
  const legacyConfig = path.join(legacyDir, 'config.json')
  const hasLegacyDocs = fs.existsSync(legacyDocs)
  const hasLegacyConfig = fs.existsSync(legacyConfig)

  if (!hasLegacyDocs && !hasLegacyConfig) {
    return
  }

  consola.warn(
    'ASK legacy layout detected (.please/). Migrating to .ask/. '
    + 'This is a one-time operation; future runs will not log this message.',
  )

  let migratedConfig: ReturnType<typeof ConfigSchema.parse> | null = null
  if (hasLegacyConfig) {
    try {
      const raw = fs.readFileSync(legacyConfig, 'utf-8')
      const legacy = JSON.parse(raw) as { docs?: unknown[] }
      migratedConfig = ConfigSchema.parse({
        schemaVersion: 1,
        docs: legacy.docs ?? [],
      })
    }
    catch (err) {
      throw new Error(
        `Failed to parse legacy .please/config.json: ${err instanceof Error ? err.message : err}. `
        + 'The legacy file is left intact for manual recovery — fix or delete it and re-run.',
      )
    }
  }

  fs.mkdirSync(newDir, { recursive: true })
  writeConfig(projectDir, migratedConfig ?? { schemaVersion: 1, docs: [] })

  if (hasLegacyDocs) {
    const newDocs = path.join(newDir, 'docs')
    fs.mkdirSync(newDocs, { recursive: true })
    try {
      for (const entry of fs.readdirSync(legacyDocs)) {
        fs.renameSync(
          path.join(legacyDocs, entry),
          path.join(newDocs, entry),
        )
      }
      fs.rmSync(legacyDocs, { recursive: true, force: true })
    }
    catch (err) {
      throw new Error(
        `Failed to move legacy docs from .please/docs to .ask/docs: ${err instanceof Error ? err.message : err}. `
        + 'Workspace is now in a partial state — please move any remaining entries manually.',
      )
    }
  }

  if (hasLegacyConfig) {
    try {
      fs.rmSync(legacyConfig, { force: true })
    }
    catch {
      // best-effort: the new config is the sentinel, not the absence of the old one
    }
  }
}
