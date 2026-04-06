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
  sandbox: 'docker',
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
      'AGENTS.md': `# Nuxt UI Documentation

Refer to \`NUXT_UI_DOCS.md\` for Nuxt UI component API and usage guidance.
`,
      'CLAUDE.md': '@AGENTS.md\n',
    })
  },
}

export default config
