import fs from 'node:fs'
import path from 'node:path'
import { consola } from 'consola'
import { writeConfig } from './io.js'
import { ConfigSchema } from './schemas.js'

const LEGACY_DIR = '.please'
const NEW_DIR = '.ask'

/**
 * One-shot migration from `.please/` (used by ASK before April 2026) to
 * `.ask/`. Triggered exactly once on the first CLI invocation in a project
 * that still has the legacy layout. The presence of `.ask/` is the
 * idempotency sentinel — once migrated, this function is a no-op.
 *
 * What moves:
 * - `.please/docs/<lib>@<ver>/` → `.ask/docs/<lib>@<ver>/`
 * - `.please/config.json`      → `.ask/config.json` (parsed and rewritten
 *                                through the Zod-validated writer)
 *
 * What does NOT move:
 * - `ask.lock` does not exist in the legacy layout. The next `sync` or
 *   `add` run will populate it.
 *
 * The function is intentionally cheap on the happy path (no migration
 * needed): a single `existsSync` check on `.ask/`.
 */
export function migrateLegacyWorkspace(projectDir: string): void {
  const newDir = path.join(projectDir, NEW_DIR)
  if (fs.existsSync(newDir)) {
    // Already migrated (or never had legacy layout) — fast path.
    return
  }

  const legacyDir = path.join(projectDir, LEGACY_DIR)
  const legacyDocs = path.join(legacyDir, 'docs')
  const legacyConfig = path.join(legacyDir, 'config.json')
  const hasLegacyDocs = fs.existsSync(legacyDocs)
  const hasLegacyConfig = fs.existsSync(legacyConfig)

  if (!hasLegacyDocs && !hasLegacyConfig) {
    // No legacy layout at all — also a fast path, nothing to do.
    return
  }

  consola.warn(
    'ASK legacy layout detected (.please/). Migrating to .ask/. '
    + 'This is a one-time operation; future runs will not log this message.',
  )

  fs.mkdirSync(newDir, { recursive: true })

  // Move .please/docs/* into .ask/docs/
  if (hasLegacyDocs) {
    const newDocs = path.join(newDir, 'docs')
    fs.mkdirSync(newDocs, { recursive: true })
    for (const entry of fs.readdirSync(legacyDocs)) {
      fs.renameSync(
        path.join(legacyDocs, entry),
        path.join(newDocs, entry),
      )
    }
    fs.rmSync(legacyDocs, { recursive: true, force: true })
  }

  // Migrate config.json: parse the legacy file (which had no schemaVersion)
  // and rewrite it through the Zod-validated, deterministic writer.
  if (hasLegacyConfig) {
    try {
      const raw = fs.readFileSync(legacyConfig, 'utf-8')
      const legacy = JSON.parse(raw) as { docs?: unknown[] }
      const migrated = ConfigSchema.parse({
        schemaVersion: 1,
        docs: legacy.docs ?? [],
      })
      writeConfig(projectDir, migrated)
      fs.rmSync(legacyConfig, { force: true })
    }
    catch (err) {
      consola.error(
        `Failed to migrate .please/config.json: ${err instanceof Error ? err.message : err}. `
        + 'Leaving the legacy file in place; please migrate manually.',
      )
    }
  }

  // If .please/ is now empty, leave it for the user to delete (it may
  // contain unrelated files like the please plugin's workspace).
}
