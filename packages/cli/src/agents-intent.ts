import type { IntentSkillEntry } from './discovery/types.js'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Writer for the `<!-- intent-skills:start --> ... <!-- intent-skills:end -->`
 * marker block in `AGENTS.md`. Operates on a byte range that is strictly
 * disjoint from the `<!-- BEGIN:ask-docs-auto-generated -->` block managed
 * by `agents.ts` — see the Marker Isolation constraint in the spec.
 *
 * Block format (reproduced from `@tanstack/intent`'s install command text
 * at `@tanstack/intent/dist/install-*.mjs`):
 *
 *   <!-- intent-skills:start -->
 *   # Skill mappings - when working in these areas, load the linked skill file into context.
 *   skills:
 *     - task: "describe the task or code area here"
 *       load: "node_modules/package-name/skills/skill-name/SKILL.md"
 *   <!-- intent-skills:end -->
 *
 * Byte-identical output against the Intent CLI is SC-2; the block header
 * and the `  - task: / load:` indentation levels are fixed strings.
 */

const BEGIN_MARKER = '<!-- intent-skills:start -->'
const END_MARKER = '<!-- intent-skills:end -->'
const BLOCK_HEADER
  = '# Skill mappings - when working in these areas, load the linked skill file into context.\nskills:'

/** Module-scope regex — stripped on every rebuild, don't recompile. */
const TASK_LINE_RE = /^\s*-\s+task:\s*"((?:[^"\\]|\\.)*)"\s*$/
const LOAD_LINE_RE = /^\s+load:\s*"((?:[^"\\]|\\.)*)"\s*$/
const BACKSLASH_RE = /\\/g
const DQUOTE_RE = /"/g
const ESCAPED_BACKSLASH_RE = /\\\\/g
const ESCAPED_DQUOTE_RE = /\\"/g
const TRAILING_NEWLINES_RE = /\n+$/
const LEADING_NEWLINES_RE = /^\n+/

/**
 * Escape a string for YAML double-quoted scalar embedding. Only `"` and
 * `\` need escaping for the format we emit — tasks and load paths do not
 * contain control characters in practice, and the Intent CLI's sample
 * output never emits escapes for them either, so keeping this narrow
 * preserves byte-identicality with the reference.
 */
function escapeDq(value: string): string {
  return value.replace(BACKSLASH_RE, '\\\\').replace(DQUOTE_RE, '\\"')
}

function unescapeDq(value: string): string {
  return value.replace(ESCAPED_BACKSLASH_RE, '\\').replace(ESCAPED_DQUOTE_RE, '"')
}

/**
 * Parse the body between `BEGIN_MARKER` and `END_MARKER` into a list of
 * `IntentSkillEntry`. Lenient: lines that do not match the expected
 * `task:` / `load:` shape are ignored so that manual edits outside the
 * recognised pattern are preserved only when the caller re-emits them
 * verbatim — since we do not re-emit unknown lines, users should treat
 * the block as fully auto-generated. The docs in the writer announce
 * this.
 */
function parseBlockBody(body: string): IntentSkillEntry[] {
  const lines = body.split('\n')
  const entries: IntentSkillEntry[] = []
  let pendingTask: string | null = null
  for (const line of lines) {
    const taskMatch = TASK_LINE_RE.exec(line)
    if (taskMatch) {
      pendingTask = unescapeDq(taskMatch[1]!)
      continue
    }
    const loadMatch = LOAD_LINE_RE.exec(line)
    if (loadMatch && pendingTask != null) {
      entries.push({ task: pendingTask, load: unescapeDq(loadMatch[1]!) })
      pendingTask = null
    }
  }
  return entries
}

function serializeEntries(entries: IntentSkillEntry[]): string {
  const body = entries
    .map(e => `  - task: "${escapeDq(e.task)}"\n    load: "${escapeDq(e.load)}"`)
    .join('\n')
  return `${BEGIN_MARKER}\n${BLOCK_HEADER}\n${body}\n${END_MARKER}`
}

/**
 * Extract existing entries from the current `AGENTS.md`, returning `null`
 * when the file does not exist or does not contain the marker block.
 * The returned object also includes the byte indices so callers can
 * splice the block in place without disturbing surrounding content.
 */
interface ExistingBlock {
  entries: IntentSkillEntry[]
  beginIdx: number
  endIdx: number
}

function readExistingBlock(agentsPath: string): { content: string, block: ExistingBlock | null } {
  if (!fs.existsSync(agentsPath)) {
    return { content: '', block: null }
  }
  const content = fs.readFileSync(agentsPath, 'utf-8')
  const beginIdx = content.indexOf(BEGIN_MARKER)
  const endIdx = content.indexOf(END_MARKER)
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    return { content, block: null }
  }
  const bodyStart = beginIdx + BEGIN_MARKER.length
  const body = content.slice(bodyStart, endIdx)
  return {
    content,
    block: {
      entries: parseBlockBody(body),
      beginIdx,
      endIdx: endIdx + END_MARKER.length,
    },
  }
}

/**
 * Return `true` when the load path belongs to `packageName`, i.e. starts
 * with `node_modules/<packageName>/`. Matching is string-prefix based so
 * scoped packages (`@scope/pkg`) and dotted paths resolve correctly
 * without needing a runtime parser.
 */
function loadPathBelongsTo(load: string, packageName: string): boolean {
  const prefix = `node_modules/${packageName}/`
  return load.startsWith(prefix)
}

/**
 * Idempotently insert / replace every entry whose `load:` path belongs
 * to `packageName`. Other packages' entries are preserved byte-for-byte
 * in their original order.
 *
 * Writes `AGENTS.md` at the project root. Creates the file with just
 * the marker block when it does not exist. The `agents.ts`
 * `ask-docs-auto-generated` block is not touched and does not need to
 * exist for this writer to succeed.
 */
export function upsertIntentSkillsBlock(
  projectDir: string,
  packageName: string,
  skills: IntentSkillEntry[],
): string {
  const agentsPath = path.join(projectDir, 'AGENTS.md')
  const { content, block } = readExistingBlock(agentsPath)

  // Drop any existing entries for this package; preserve the rest.
  const preserved = (block?.entries ?? []).filter(
    e => !loadPathBelongsTo(e.load, packageName),
  )
  const merged = [...preserved, ...skills]
  const newBlock = serializeEntries(merged)

  let updated: string
  if (block) {
    updated = content.slice(0, block.beginIdx) + newBlock + content.slice(block.endIdx)
  }
  else if (content.length > 0) {
    // File exists but has no block yet — append with a separator so the
    // block always sits on its own paragraph.
    updated = `${content.trimEnd()}\n\n${newBlock}\n`
  }
  else {
    updated = `${newBlock}\n`
  }

  fs.writeFileSync(agentsPath, updated, 'utf-8')
  return agentsPath
}

/**
 * Remove every entry whose `load:` path belongs to `packageName`. When
 * the resulting block would be empty, the entire block (including the
 * markers) is stripped so `AGENTS.md` does not carry an empty skeleton.
 * Returns `true` when something was removed, `false` when the block did
 * not exist or had no entries for the package.
 */
export function removeFromIntentSkillsBlock(
  projectDir: string,
  packageName: string,
): boolean {
  const agentsPath = path.join(projectDir, 'AGENTS.md')
  const { content, block } = readExistingBlock(agentsPath)
  if (!block) {
    return false
  }

  const before = block.entries.length
  const preserved = block.entries.filter(
    e => !loadPathBelongsTo(e.load, packageName),
  )
  if (preserved.length === before) {
    return false
  }

  let updated: string
  if (preserved.length === 0) {
    // Drop the whole block and any lone separator newline after it.
    const head = content.slice(0, block.beginIdx).replace(TRAILING_NEWLINES_RE, '')
    const tail = content.slice(block.endIdx).replace(LEADING_NEWLINES_RE, '')
    updated = head.length === 0
      ? tail
      : tail.length === 0
        ? `${head}\n`
        : `${head}\n\n${tail}`
  }
  else {
    const newBlock = serializeEntries(preserved)
    updated = content.slice(0, block.beginIdx) + newBlock + content.slice(block.endIdx)
  }

  fs.writeFileSync(agentsPath, updated, 'utf-8')
  return true
}
