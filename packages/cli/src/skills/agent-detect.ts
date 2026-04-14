import fs from 'node:fs'
import path from 'node:path'

export interface AgentTarget {
  /** Stable identifier used in the lock file, e.g. `claude`. */
  name: string
  /** Human label shown in prompts, e.g. `Claude Code`. */
  label: string
  /** Marker directory whose presence enables this agent (absolute). */
  markerDir: string
  /** Absolute path where `skills/<skill-name>` symlinks are created. */
  skillsDir: string
}

const AGENTS: Array<Omit<AgentTarget, 'markerDir' | 'skillsDir'> & { marker: string, skillsRel: string }> = [
  { name: 'claude', label: 'Claude Code', marker: '.claude', skillsRel: '.claude/skills' },
  { name: 'cursor', label: 'Cursor', marker: '.cursor', skillsRel: '.cursor/skills' },
  { name: 'opencode', label: 'OpenCode', marker: '.opencode', skillsRel: '.opencode/skills' },
  { name: 'codex', label: 'Codex', marker: '.codex', skillsRel: '.codex/skills' },
]

/**
 * Scan `projectDir` and return every supported coding agent whose marker
 * directory is present. The returned `skillsDir` is where
 * `<agent>/skills/<skill-name>` symlinks will be created; it is NOT required
 * to exist yet — the install step creates it on demand.
 *
 * `AGENTS.md` by itself is not treated as an agent (it is a cross-agent
 * convention file, not an install target).
 */
export function detectAgents(projectDir: string): AgentTarget[] {
  const found: AgentTarget[] = []
  for (const a of AGENTS) {
    const markerDir = path.join(projectDir, a.marker)
    if (fs.existsSync(markerDir)) {
      found.push({
        name: a.name,
        label: a.label,
        markerDir,
        skillsDir: path.join(projectDir, a.skillsRel),
      })
    }
  }
  return found
}

/**
 * Resolve a user-supplied `--agent` CSV into {@link AgentTarget}s without
 * requiring the marker dir to exist. Unknown names throw — we prefer loud
 * failure over silently installing into an unintended location.
 */
export function resolveAgentNames(projectDir: string, names: string[]): AgentTarget[] {
  const byName = new Map(AGENTS.map(a => [a.name, a]))
  return names.map((name) => {
    const hit = byName.get(name)
    if (!hit) {
      throw new Error(`unknown agent '${name}'. Supported: ${AGENTS.map(a => a.name).join(', ')}`)
    }
    return {
      name: hit.name,
      label: hit.label,
      markerDir: path.join(projectDir, hit.marker),
      skillsDir: path.join(projectDir, hit.skillsRel),
    }
  })
}

export const SUPPORTED_AGENTS = AGENTS.map(a => a.name)
