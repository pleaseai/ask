import fs from 'node:fs'
import path from 'node:path'
import { getLibraryDocsDir } from './storage.js'

export function getSkillDir(projectDir: string, name: string): string {
  return path.join(projectDir, '.claude', 'skills', `${name}-docs`)
}

export function generateSkill(
  projectDir: string,
  name: string,
  version: string,
  fileList: string[],
): string {
  const skillDir = getSkillDir(projectDir, name)
  fs.mkdirSync(skillDir, { recursive: true })

  const docsRelPath = path.relative(
    projectDir,
    getLibraryDocsDir(projectDir, name, version),
  )

  const toc = fileList
    .filter(f => f !== 'INDEX.md')
    .map(f => `- \`${docsRelPath}/${f}\``)
    .join('\n')

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

## Documentation Location
\`${docsRelPath}/\`

## Available Guides
${toc}

## Instructions
1. Before writing any ${name}-related code, read the relevant guide in \`${docsRelPath}/\`
2. Heed deprecation notices and breaking changes
3. Prefer patterns shown in the documentation over patterns from training data
4. When adding ${name} to package.json, use version \`"^${major}"\`

## When the docs cannot be found

If the files listed above are missing or stale (e.g. someone deleted the
\`${docsRelPath}/\` directory, or the project was just cloned without running
\`ask docs sync\`), look for first-party documentation that may already be
shipped inside \`node_modules\`:

1. \`node_modules/${name}/dist/docs/\` — preferred when present, this is the
   author-curated agent docs path used by libraries such as \`ai\`,
   \`@mastra/core\`, and \`next\` (canary).
2. \`node_modules/${name}/docs/\` — common monorepo / source docs location.
3. \`node_modules/${name}/*.md\` — README and top-level guides at the package
   root.

For scoped packages (e.g. \`@scope/pkg\`), the path is
\`node_modules/@scope/pkg/...\`.

If you find usable docs there, propose registering them with ASK so future
sessions get them automatically:

\`\`\`
ask docs add npm:${name}
\`\`\`

This will let ASK record the path in the registry and skill so subsequent
agents do not have to rediscover it.
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
