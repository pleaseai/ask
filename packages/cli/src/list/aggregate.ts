// ---------------------------------------------------------------------------
// Aggregator — reads the lock-backed listDocs view and shapes it into a
// ListModel ready for the renderer / JSON emitter.
//
// The hard work of merging docs + intent-skills lives in `storage.listDocs`
// (post-rich-list refactor) — this module only:
//
//   1. Maps ListDocsEntry → ListEntry (schema-typed),
//   2. Detects name-collisions (same name, differing versions), and
//   3. Surfaces any warnings we want to show the user.
// ---------------------------------------------------------------------------

import type { ListDocsEntry } from '../storage.js'
import type { ListConflict, ListEntry, ListModel } from './model.js'
import { listDocs } from '../storage.js'

export function buildListModel(projectDir: string): ListModel {
  const raw = listDocs(projectDir)
  const entries: ListEntry[] = raw.map(toListEntry)
  const conflicts = detectConflicts(raw)
  const warnings: string[] = []
  return { entries, conflicts, warnings }
}

function toListEntry(e: ListDocsEntry): ListEntry {
  const base: ListEntry = {
    name: e.name,
    version: e.version,
    format: e.format,
    source: e.source,
    location: e.location,
    itemCount: e.fileCount,
  }
  if (e.skills && e.skills.length > 0) {
    base.skills = e.skills.map(s => ({ task: s.task, load: s.load }))
  }
  return base
}

/**
 * A conflict is two or more entries with the same `name` but different
 * `version`. The same (name, version) pair is treated as a no-op and
 * does not produce a conflict row.
 */
export function detectConflicts(entries: readonly ListDocsEntry[]): ListConflict[] {
  const byName = new Map<string, Set<string>>()
  for (const entry of entries) {
    const set = byName.get(entry.name) ?? new Set<string>()
    set.add(entry.version)
    byName.set(entry.name, set)
  }
  const out: ListConflict[] = []
  for (const [name, versions] of byName) {
    if (versions.size >= 2) {
      out.push({ name, versions: [...versions].sort() })
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
