import type { ExperimentConfig } from '@vercel/agent-eval'

/**
 * With llms-full.txt — complete documentation inlined.
 * Tests whether full LLM-optimized docs outperform the summary.
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

    // Fetch llms-full.txt and inject as documentation
    await sandbox.runCommand('curl', [
      '-sL',
      'https://ui.nuxt.com/llms-full.txt',
      '-o',
      'NUXT_UI_DOCS.md',
    ])

    await sandbox.writeFiles({
      'AGENTS.md': `# Nuxt UI Documentation

Refer to \`NUXT_UI_DOCS.md\` for complete Nuxt UI component API, props, slots, and usage examples.
`,
      'CLAUDE.md': '@AGENTS.md\n',
    })
  },
}

export default config
