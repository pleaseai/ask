import type { ExperimentConfig } from '@vercel/agent-eval'

/**
 * Claude Opus 4.6 with ASK-style documentation.
 *
 * Vercel results: Opus 4.6 baseline 71% → 100% with AGENTS.md (+29%)
 * Ref: https://github.com/vercel/next-evals-oss
 */
const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-opus-4-6',
  scripts: ['build'],
  runs: 4,
  earlyExit: true,
  timeout: 720,
  sandbox: 'docker',
  setup: async (sandbox) => {
    await sandbox.runCommand('npm', ['install', 'next@canary'])

    await sandbox.writeFiles({
      'AGENTS.md': `<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in \`node_modules/next/dist/docs/\` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
`,
      'CLAUDE.md': '@AGENTS.md\n',
    })
  },
}

export default config
