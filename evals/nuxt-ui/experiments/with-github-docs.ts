import type { ExperimentConfig } from '@vercel/agent-eval'

/**
 * With GitHub docs — raw documentation files from the repo.
 * Tests whether structured multi-file docs from the source repo help the agent.
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

    // Download and extract docs from GitHub repo
    await sandbox.runCommand('sh', [
      '-c',
      'curl -sL https://github.com/nuxt/ui/archive/refs/heads/main.tar.gz | tar xz --strip-components=2 ui-main/docs/content/docs -C /tmp && mkdir -p nuxt-ui-docs && mv /tmp/* nuxt-ui-docs/ 2>/dev/null || true',
    ])

    await sandbox.writeFiles({
      'AGENTS.md': `<!-- BEGIN:ask-docs-auto-generated -->
# Documentation References

The libraries in this project may have APIs and patterns that differ from your training data.
**Always read the relevant documentation before writing code.**

## @nuxt/ui v4

> **WARNING:** This version may differ from your training data.
> Read the docs in \`nuxt-ui-docs/\` before writing any @nuxt/ui-related code.
> Heed deprecation notices and breaking changes.

- **Version**: \`4\` — use \`"^4"\` in package.json (NOT older major versions)
- Documentation: \`nuxt-ui-docs/\`
<!-- END:ask-docs-auto-generated -->
`,
      'CLAUDE.md': '@AGENTS.md\n',
    })
  },
}

export default config
