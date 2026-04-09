// ---------------------------------------------------------------------------
// Skill tree rendering helper.
//
// Ported from @tanstack/intent (MIT, https://github.com/tanstack/intent)
// `packages/intent/src/display.ts`. Adapted to return a string
// (`formatSkillTree`) so it is unit-testable, with a thin `printSkillTree`
// wrapper that emits via consola.
// ---------------------------------------------------------------------------

import { consola } from 'consola'

export interface SkillDisplay {
  name: string
  description: string
  type?: string
  path?: string
}

export interface SkillTreeOptions {
  nameWidth: number
  showTypes: boolean
}

function formatSkillLine(
  displayName: string,
  skill: SkillDisplay,
  indent: number,
  opts: SkillTreeOptions,
): string[] {
  const nameStr = ' '.repeat(indent) + displayName
  const padding = ' '.repeat(Math.max(2, opts.nameWidth - nameStr.length))
  const typeCol = opts.showTypes
    ? (skill.type ? `[${skill.type}]` : '').padEnd(14)
    : ''
  const lines = [`${nameStr}${padding}${typeCol}${skill.description}`]
  if (skill.path) {
    lines.push(`${' '.repeat(indent + 2)}${skill.path}`)
  }
  return lines
}

/**
 * Compute a name column width wide enough to align descriptions across
 * every package's skill list passed in.
 */
export function computeSkillNameWidth(
  allPackageSkills: ReadonlyArray<ReadonlyArray<SkillDisplay>>,
): number {
  let max = 0
  for (const skills of allPackageSkills) {
    for (const s of skills) {
      const slashIdx = s.name.indexOf('/')
      const displayName = slashIdx === -1 ? s.name : s.name.slice(slashIdx + 1)
      const indent = slashIdx === -1 ? 4 : 6
      max = Math.max(max, indent + displayName.length)
    }
  }
  return max + 2
}

/**
 * Format a two-level skill tree (root skills and `root/child` sub-skills)
 * as a multi-line string. Returns the empty string for an empty input.
 */
export function formatSkillTree(
  skills: readonly SkillDisplay[],
  opts: SkillTreeOptions,
): string {
  if (skills.length === 0) {
    return ''
  }

  const roots: string[] = []
  const children = new Map<string, SkillDisplay[]>()

  for (const skill of skills) {
    const slashIdx = skill.name.indexOf('/')
    if (slashIdx === -1) {
      roots.push(skill.name)
    }
    else {
      const parent = skill.name.slice(0, slashIdx)
      if (!children.has(parent))
        children.set(parent, [])
      children.get(parent)!.push(skill)
    }
  }

  if (roots.length === 0) {
    for (const skill of skills) {
      if (!roots.includes(skill.name))
        roots.push(skill.name)
    }
  }

  const out: string[] = []
  for (const rootName of roots) {
    const rootSkill = skills.find(s => s.name === rootName)
    if (!rootSkill)
      continue
    out.push(...formatSkillLine(rootName, rootSkill, 4, opts))
    for (const sub of children.get(rootName) ?? []) {
      const childName = sub.name.slice(sub.name.indexOf('/') + 1)
      out.push(...formatSkillLine(childName, sub, 6, opts))
    }
  }
  return out.join('\n')
}

export function printSkillTree(
  skills: readonly SkillDisplay[],
  opts: SkillTreeOptions,
): void {
  const out = formatSkillTree(skills, opts)
  if (out === '')
    return
  for (const line of out.split('\n')) {
    consola.log(line)
  }
}
