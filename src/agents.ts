import fs from 'node:fs'
import path from 'node:path'
import { getLibraryDocsDir, listDocs } from './storage.js'

const BEGIN_MARKER = '<!-- BEGIN:ask-docs-auto-generated -->'
const END_MARKER = '<!-- END:ask-docs-auto-generated -->'

export function generateAgentsMd(projectDir: string): string {
  const docs = listDocs(projectDir)

  if (docs.length === 0)
    return ''

  const sections = docs.map(({ name, version }) => {
    const docsRelPath = path.relative(
      projectDir,
      getLibraryDocsDir(projectDir, name, version),
    )

    return `## ${name} v${version}

> **WARNING:** This version may differ from your training data.
> Read the docs in \`${docsRelPath}/\` before writing any ${name}-related code.
> Heed deprecation notices and breaking changes.

- Documentation: \`${docsRelPath}/\`
- Index: \`${docsRelPath}/INDEX.md\``
  })

  const generatedBlock = `${BEGIN_MARKER}
# Documentation References

The libraries in this project may have APIs and patterns that differ from your training data.
**Always read the relevant documentation before writing code.**

${sections.join('\n\n')}
${END_MARKER}`

  // Read existing AGENTS.md and update or create
  const agentsPath = path.join(projectDir, 'AGENTS.md')

  if (fs.existsSync(agentsPath)) {
    const existing = fs.readFileSync(agentsPath, 'utf-8')
    const beginIdx = existing.indexOf(BEGIN_MARKER)
    const endIdx = existing.indexOf(END_MARKER)

    if (beginIdx !== -1 && endIdx !== -1) {
      // Replace existing auto-generated block
      const updated
        = existing.substring(0, beginIdx)
          + generatedBlock
          + existing.substring(endIdx + END_MARKER.length)
      fs.writeFileSync(agentsPath, updated, 'utf-8')
    }
    else {
      // Append to existing file
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

  // Also create/update CLAUDE.md to reference AGENTS.md
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
