import type { ExperimentConfig } from '@vercel/agent-eval'

/**
 * Baseline — no documentation provided.
 * Tests what the agent can do with only training data knowledge.
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
  },
}

export default config
