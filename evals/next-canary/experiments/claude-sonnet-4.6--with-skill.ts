import type { ExperimentConfig } from '@vercel/agent-eval'

/**
 * Claude Sonnet 4.6 with Claude Code skill-based documentation.
 *
 * Tests whether a `.claude/skills/<name>-docs/SKILL.md` file — the format
 * currently emitted by `ask install` alongside AGENTS.md — is as effective
 * as the AGENTS.md pointer alone.
 *
 * Vercel's benchmark ("AGENTS.md outperforms skills in our agent evals")
 * suggests skills underperform AGENTS.md. This experiment reproduces that
 * comparison inside ASK's own suite so we can decide whether to keep
 * generating skill files.
 *
 * Isolation: only the skill file is injected. AGENTS.md and CLAUDE.md are
 * NOT written, so any pass-rate uplift is attributable to the skill alone.
 *
 * Ref: https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals
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

    // Mirror what `ask install` writes at
    // .claude/skills/next-docs/SKILL.md. Docs are referenced in-place at
    // node_modules/next/dist/docs/ (convention-based discovery path).
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
