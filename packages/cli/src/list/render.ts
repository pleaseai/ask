// ---------------------------------------------------------------------------
// Renderer — converts a ListModel into the user-facing text output.
//
// Output sections (in order):
//   1. Header line (total count + format breakdown)
//   2. Table (Name, Version, Format, Source, Items, Location)
//   3. Intent-skills tree (only when at least one intent entry has skills)
//   4. Conflicts section (only when non-empty)
//   5. Warnings section (only when non-empty)
//
// For testability, `formatList(model)` returns a string, and `renderList`
// is a thin consola.log wrapper over it. The empty-model message
// ("No docs downloaded yet…") is preserved byte-for-byte from the
// pre-rich-list output so the one existing contract stays intact.
// ---------------------------------------------------------------------------

import type { SkillDisplay } from '../display/tree.js'
import type { ListEntry, ListModel } from './model.js'
import { consola } from 'consola'
import { formatTable } from '../display/table.js'
import { computeSkillNameWidth, formatSkillTree } from '../display/tree.js'

const EMPTY_MESSAGE = 'No libraries declared in ask.json. Use `ask add npm:<pkg>` or `ask add github:<owner>/<repo> --ref <tag>` to get started.'

export function formatList(model: ListModel): string {
  if (model.entries.length === 0) {
    return EMPTY_MESSAGE
  }
  const sections: string[] = []
  sections.push(formatHeader(model))
  sections.push(formatEntryTable(model.entries))

  const tree = formatIntentTree(model.entries)
  if (tree !== '') {
    sections.push('Skill mappings:')
    sections.push(tree)
  }

  if (model.conflicts.length > 0) {
    sections.push(formatConflicts(model))
  }
  if (model.warnings.length > 0) {
    sections.push(formatWarnings(model))
  }
  return sections.join('\n\n')
}

function formatHeader(model: ListModel): string {
  const docs = model.entries.filter(e => e.format === 'docs').length
  const intent = model.entries.filter(e => e.format === 'intent-skills').length
  const parts: string[] = []
  parts.push(`${model.entries.length} ${pluralize(model.entries.length, 'entry', 'entries')}`)
  if (docs > 0)
    parts.push(`${docs} docs`)
  if (intent > 0)
    parts.push(`${intent} intent-skills`)
  return `Downloaded documentation: ${parts.join(', ')}`
}

function formatEntryTable(entries: readonly ListEntry[]): string {
  const headers = ['Name', 'Version', 'Format', 'Source', 'Items', 'Location']
  const rows = entries.map(e => [
    e.name,
    e.version,
    e.format,
    e.source,
    String(e.itemCount ?? 0),
    e.location,
  ])
  return formatTable(headers, rows)
}

function formatIntentTree(entries: readonly ListEntry[]): string {
  const intentEntries = entries.filter(
    e => e.format === 'intent-skills' && e.skills && e.skills.length > 0,
  )
  if (intentEntries.length === 0)
    return ''

  const sections: string[] = []
  const allSkillSets: SkillDisplay[][] = intentEntries.map(e =>
    (e.skills ?? []).map(s => ({ name: s.task, description: s.load })),
  )
  const nameWidth = computeSkillNameWidth(allSkillSets)

  for (let i = 0; i < intentEntries.length; i++) {
    const entry = intentEntries[i]!
    const header = `${entry.name}@${entry.version}`
    const tree = formatSkillTree(allSkillSets[i]!, { nameWidth, showTypes: false })
    sections.push([header, tree].filter(Boolean).join('\n'))
  }
  return sections.join('\n\n')
}

function formatConflicts(model: ListModel): string {
  const lines = ['Conflicts:']
  for (const c of model.conflicts) {
    lines.push(`  ${c.name}: ${c.versions.join(', ')}`)
  }
  return lines.join('\n')
}

function formatWarnings(model: ListModel): string {
  const lines = ['Warnings:']
  for (const w of model.warnings) {
    lines.push(`  ${w}`)
  }
  return lines.join('\n')
}

function pluralize(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/**
 * Emit `formatList(model)` via consola, one line per newline-separated
 * chunk. Empty models use `consola.info` to match the pre-rich-list
 * behaviour; all other sections go through `consola.log` so they
 * appear unadorned.
 */
export function renderList(model: ListModel): void {
  if (model.entries.length === 0) {
    consola.info(EMPTY_MESSAGE)
    return
  }
  for (const line of formatList(model).split('\n')) {
    consola.log(line)
  }
}
