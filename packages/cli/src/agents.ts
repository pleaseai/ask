import fs from 'node:fs'
import path from 'node:path'

const BEGIN_MARKER = '<!-- BEGIN:ask-docs-auto-generated -->'
const END_MARKER = '<!-- END:ask-docs-auto-generated -->'
const TRAILING_NEWLINES_RE = /\n+$/
const LEADING_NEWLINES_RE = /^\n+/

export interface LazyLibraryInfo {
  name: string
  version: string
  spec: string
}

export function generateAgentsMd(
  projectDir: string,
  libraries: LazyLibraryInfo[],
): string {
  const agentsPath = path.join(projectDir, 'AGENTS.md')

  if (libraries.length === 0) {
    // Strip any previously generated block so removed libraries don't
    // linger in AGENTS.md after the last entry is removed from ask.json.
    if (fs.existsSync(agentsPath)) {
      const existing = fs.readFileSync(agentsPath, 'utf-8')
      const beginIdx = existing.indexOf(BEGIN_MARKER)
      const endIdx = existing.indexOf(END_MARKER)
      if (beginIdx !== -1 && endIdx !== -1) {
        const head = existing.substring(0, beginIdx).replace(TRAILING_NEWLINES_RE, '')
        const tail = existing.substring(endIdx + END_MARKER.length).replace(LEADING_NEWLINES_RE, '')
        const stripped = head.length === 0
          ? tail
          : tail.length === 0
            ? `${head}\n`
            : `${head}\n\n${tail}`
        if (stripped.length === 0) {
          fs.rmSync(agentsPath)
        }
        else {
          fs.writeFileSync(agentsPath, stripped, 'utf-8')
        }
      }
    }
    return ''
  }

  const sections = libraries.map(({ name, version }) => {
    const major = version.split('.')[0]

    return `## ${name} v${version}

> **WARNING:** This version may differ from your training data.
> Use \`ask docs ${name}\` to read the documentation before writing any ${name}-related code.
> Heed deprecation notices and breaking changes.

- **Version**: \`${version}\` — use \`"^${major}"\` in package.json (NOT older major versions)
- **Docs**: \`ask docs ${name}\` — prints documentation paths (lazy fetch on first use)
- **Source**: \`ask src ${name}\` — prints the cached source tree path`
  })

  const generatedBlock = `${BEGIN_MARKER}
# Documentation References

The libraries in this project may have APIs and patterns that differ from your training data.
**Always read the relevant documentation before writing code.**

## Accessing Library Documentation

Use the lazy commands \`ask src <package>\` and \`ask docs <package>\` to access
documentation on-demand. They print absolute paths to the cached source tree
(and any \`*doc*\` directories), with automatic fetch on cache miss:

\`\`\`bash
rg "pattern" $(ask src <package>)
cat "$(ask src <package>)/README.md"
fd "\\.md$" "$(ask docs <package> | head -n 1)"
\`\`\`

${sections.join('\n\n')}
${END_MARKER}`

  if (fs.existsSync(agentsPath)) {
    const existing = fs.readFileSync(agentsPath, 'utf-8')
    const beginIdx = existing.indexOf(BEGIN_MARKER)
    const endIdx = existing.indexOf(END_MARKER)

    if (beginIdx !== -1 && endIdx !== -1) {
      const updated
        = existing.substring(0, beginIdx)
          + generatedBlock
          + existing.substring(endIdx + END_MARKER.length)
      fs.writeFileSync(agentsPath, updated, 'utf-8')
    }
    else {
      fs.writeFileSync(
        agentsPath,
        `${existing.trimEnd()}\n\n${generatedBlock}\n`,
        'utf-8',
      )
    }
  }
  else {
    fs.writeFileSync(agentsPath, `${generatedBlock}\n`, 'utf-8')
  }

  // Create/update CLAUDE.md to reference AGENTS.md
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md')
  const claudeRef = '@AGENTS.md'
  if (fs.existsSync(claudeMdPath)) {
    const claudeContent = fs.readFileSync(claudeMdPath, 'utf-8')
    if (!claudeContent.includes(claudeRef)) {
      fs.writeFileSync(
        claudeMdPath,
        `${claudeContent.trimEnd()}\n${claudeRef}\n`,
        'utf-8',
      )
    }
  }
  else {
    fs.writeFileSync(claudeMdPath, `${claudeRef}\n`, 'utf-8')
  }

  return agentsPath
}
