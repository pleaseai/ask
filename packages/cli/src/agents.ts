import fs from 'node:fs'
import path from 'node:path'
import { readResolvedJson } from './io.js'
import { getLibraryDocsDir, listDocs } from './storage.js'

const BEGIN_MARKER = '<!-- BEGIN:ask-docs-auto-generated -->'
const END_MARKER = '<!-- END:ask-docs-auto-generated -->'

/**
 * Search subsection appended to the auto-generated block. Documents the
 * lazy `ask src` and `ask docs` commands so coding agents know how to
 * grep across cached library sources without needing entries in
 * `ask.json`. See FR-10 of the lazy-ask-src-docs track.
 */
const SEARCH_SUBSECTION = `## Searching across cached libraries

For libraries NOT in this list, use the lazy commands \`ask src <package>\`
and \`ask docs <package>\`. They print absolute paths to the cached source
tree (and any \`*doc*\` directories), with on-demand fetch on cache miss.
Both commands work with shell substitution:

\`\`\`bash
rg "pattern" $(ask src <package>)
cat $(ask docs <package>)/api.md
fd "\\.md$" $(ask docs <package>)
\`\`\`

\`ask src\` outputs a single line (the source root); \`ask docs\` outputs
multiple lines (every \`*doc*\` directory plus the root). Decide which
path is the real documentation by reading the contents.`

export function generateAgentsMd(projectDir: string): string {
  const docs = listDocs(projectDir).filter(e => e.format === 'docs')

  if (docs.length === 0)
    return ''

  const resolved = readResolvedJson(projectDir)

  const sections = docs.map(({ name, version }) => {
    const entry = resolved.entries[name]

    // In-place mode: docs are referenced directly from node_modules.
    // The section wording differs so users understand that `bun install`
    // keeps them in sync — not `ask install`.
    if (entry?.materialization === 'in-place' && entry.inPlacePath) {
      const docsRelPath = entry.inPlacePath
      const major = version.split('.')[0]
      return `## ${name} v${version}

> **WARNING:** This version may differ from your training data.
> Read the docs in \`${docsRelPath}/\` before writing any ${name}-related code.
> These docs are shipped by the package — \`bun install\` keeps them in sync.
> Heed deprecation notices and breaking changes.

- **Version**: \`${version}\` — use \`"^${major}"\` in package.json (NOT older major versions)
- Documentation: \`${docsRelPath}/\``
    }

    // For ref mode, use the storePath directly instead of project-local path.
    // copy/link modes fall through to the project-local path.
    const docsRelPath = entry?.materialization === 'ref' && entry.storePath
      ? entry.storePath
      : path.relative(projectDir, getLibraryDocsDir(projectDir, name, version))

    const major = version.split('.')[0]

    return `## ${name} v${version}

> **WARNING:** This version may differ from your training data.
> Read the docs in \`${docsRelPath}/\` before writing any ${name}-related code.
> Heed deprecation notices and breaking changes.

- **Version**: \`${version}\` — use \`"^${major}"\` in package.json (NOT older major versions)
- Documentation: \`${docsRelPath}/\`
- Index: \`${docsRelPath}/INDEX.md\``
  })

  const generatedBlock = `${BEGIN_MARKER}
# Documentation References

The libraries in this project may have APIs and patterns that differ from your training data.
**Always read the relevant documentation before writing code.**

## .ask/docs/ — Vendored Documentation

\`.ask/docs/\` contains third-party library documentation downloaded by ASK.
Treat it as **read-only**: AI context should reference these files, but they are
**not** subject to modification, lint, format, or code review. Updates are
performed via \`ask install\`.

${sections.join('\n\n')}

${SEARCH_SUBSECTION}
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
