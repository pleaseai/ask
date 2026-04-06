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
  sandbox: 'docker',
  setup: async (sandbox) => {
    await sandbox.runCommand('npm', ['install'])

    // Download and extract docs from GitHub repo
    await sandbox.runCommand('sh', [
      '-c',
      'curl -sL https://github.com/nuxt/ui/archive/refs/heads/main.tar.gz | tar xz --strip-components=2 ui-main/docs/content/docs -C /tmp && mkdir -p nuxt-ui-docs && mv /tmp/* nuxt-ui-docs/ 2>/dev/null || true',
    ])

    await sandbox.writeFiles({
      'AGENTS.md': `# Nuxt UI Documentation

Refer to the \`nuxt-ui-docs/\` directory for complete Nuxt UI documentation.
Browse the directory structure to find relevant component docs, getting started guides, and API references.
`,
      'CLAUDE.md': '@AGENTS.md\n',
    })
  },
}

export default config
