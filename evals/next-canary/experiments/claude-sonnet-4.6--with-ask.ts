import type { ExperimentConfig } from '@vercel/agent-eval'

/**
 * Claude Sonnet 4.6 with ASK-style documentation.
 *
 * Replicates the Vercel AGENTS.md approach: a short pointer file that directs
 * the agent to read version-specific docs bundled in node_modules/next/dist/docs/.
 * This is exactly what `ask docs add npm:next` produces.
 *
 * Vercel results: Sonnet 4.6 baseline 67% → 100% with AGENTS.md (+33%)
 * Ref: https://github.com/vercel/next-evals-oss
 */
const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-sonnet-4-6',
  scripts: ['build'],
  runs: 4,
  earlyExit: true,
  timeout: 720,
  sandbox: 'docker',
  setup: async (sandbox) => {
    await sandbox.runCommand('npm', ['install', 'next@canary'])

    // Inject ASK-style documentation pointers
    // This mirrors what `ask docs add npm:next` generates
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
