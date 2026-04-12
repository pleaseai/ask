import fs from 'node:fs'
import path from 'node:path'

export function getSkillDir(projectDir: string, name: string): string {
  return path.join(projectDir, '.claude', 'skills', `${name}-docs`)
}

/**
 * Generate a lazy-first SKILL.md that references `ask src` / `ask docs`
 * commands for on-demand documentation access. No pre-downloaded files
 * are required — the agent fetches docs at first use via the global
 * store.
 */
export function generateSkill(
  projectDir: string,
  name: string,
  version: string,
): string {
  const skillDir = getSkillDir(projectDir, name)
  fs.mkdirSync(skillDir, { recursive: true })

  const major = version.split('.')[0]

  const content = `---
name: ${name}-docs
description: ${name} v${version} documentation reference. TRIGGER when writing or modifying code that imports or uses ${name}.
---

# ${name} v${version} Documentation

This project uses **${name} v${version}**.
The APIs and patterns may differ from your training data.
**Read the relevant docs before writing any code.**

## Version
- Current: \`${version}\`
- In package.json, use \`"^${major}"\` (NOT older major versions)

## Quick Access

\`\`\`bash
# Get the cached source tree path (lazy fetch on first use)
ask src ${name}

# Get all candidate documentation paths
ask docs ${name}

# Search across the library source
rg "pattern" $(ask src ${name})

# Read a specific doc file
cat "$(ask src ${name})/README.md"

# Find all markdown files in doc directories
fd "\\.md$" $(ask docs ${name})
\`\`\`

## Instructions
1. Before writing any ${name}-related code, run \`ask docs ${name}\` and read the relevant guides
2. Heed deprecation notices and breaking changes
3. Prefer patterns shown in the documentation over patterns from training data
4. When adding ${name} to package.json, use version \`"^${major}"\`
`

  const skillPath = path.join(skillDir, 'SKILL.md')
  fs.writeFileSync(skillPath, content, 'utf-8')
  return skillPath
}

export function removeSkill(projectDir: string, name: string): void {
  const skillDir = getSkillDir(projectDir, name)
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true })
  }
}
