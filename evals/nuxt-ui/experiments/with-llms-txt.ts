import type { ExperimentConfig } from '@vercel/agent-eval'

/**
 * With llms.txt — concise overview + doc links.
 * Tests whether a lightweight doc summary helps the agent.
 */
const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-sonnet-4-6',
  scripts: [],
  runs: 4,
  earlyExit: true,
  timeout: 720,
  sandbox: process.env.SANDBOX_BACKEND as 'docker' | 'vercel' || 'docker',
  setup: async (sandbox) => {
    await sandbox.runCommand('npm', ['install'])

    // Fetch llms.txt and inject as documentation
    await sandbox.runCommand('curl', [
      '-sL',
      'https://ui.nuxt.com/llms.txt',
      '-o',
      'NUXT_UI_DOCS.md',
    ])

    await sandbox.writeFiles({
      'AGENTS.md': `<!-- BEGIN:ask-docs-auto-generated -->
# Documentation References

The libraries in this project may have APIs and patterns that differ from your training data.
**Always read the relevant documentation before writing code.**

## @nuxt/ui v4

> **WARNING:** This version may differ from your training data.
> Read the docs in \`NUXT_UI_DOCS.md\` before writing any @nuxt/ui-related code.
> Heed deprecation notices and breaking changes.

- **Version**: \`4\` — use \`"^4"\` in package.json (NOT older major versions)
- Documentation: \`NUXT_UI_DOCS.md\`
<!-- END:ask-docs-auto-generated -->
`,
      'CLAUDE.md': '@AGENTS.md\n',
    })
  },
}

export default config
