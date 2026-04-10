import type { ExperimentConfig } from '@vercel/agent-eval'

/**
 * Claude Opus 4.6 with Claude Code skill-based documentation.
 *
 * Opus counterpart to `claude-sonnet-4.6--with-skill`. See that file for
 * rationale.
 *
 * Ref: https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals
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
      '.claude/skills/next-docs/SKILL.md': `---
name: next-docs
description: next canary documentation reference. TRIGGER when writing or modifying code that imports or uses next.
---

# next canary Documentation

This project uses **next canary**.
The APIs and patterns may differ from your training data.
**Read the relevant docs before writing any code.**

## Documentation Location
\`node_modules/next/dist/docs/\`

## Instructions
1. Before writing any next-related code, read the relevant guide in \`node_modules/next/dist/docs/\`
2. Heed deprecation notices and breaking changes
3. Prefer patterns shown in the documentation over patterns from training data
`,
    })
  },
}

export default config
