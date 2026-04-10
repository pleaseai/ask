import type { ExperimentConfig } from '@vercel/agent-eval'

/**
 * With Claude Code skill — tests whether a `.claude/skills/<name>-docs/SKILL.md`
 * file alone (without AGENTS.md) can surface docs to the agent.
 *
 * Background: Vercel's benchmark ("AGENTS.md outperforms skills in our
 * agent evals") found the skill format underperforms AGENTS.md pointers.
 * This experiment reproduces that comparison locally for Nuxt UI v4 so we
 * can decide whether ASK should keep generating skill files.
 *
 * Isolation: only `.claude/skills/nuxt-ui-docs/SKILL.md` is written.
 * AGENTS.md and CLAUDE.md are NOT created, so any uplift over `base`
 * comes from the skill file alone.
 *
 * Ref: https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals
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

    // Download the same GitHub docs payload used by `with-github-docs`.
    // Docs live at `nuxt-ui-docs/`, and the skill file points there.
    await sandbox.runCommand('sh', [
      '-c',
      'curl -sL https://github.com/nuxt/ui/archive/refs/heads/main.tar.gz | tar xz --strip-components=2 ui-main/docs/content/docs -C /tmp && mkdir -p nuxt-ui-docs && mv /tmp/* nuxt-ui-docs/ 2>/dev/null || true',
    ])

    await sandbox.writeFiles({
      '.claude/skills/nuxt-ui-docs/SKILL.md': `---
name: nuxt-ui-docs
description: @nuxt/ui v4 documentation reference. TRIGGER when writing or modifying code that imports or uses @nuxt/ui.
---

# @nuxt/ui v4 Documentation

This project uses **@nuxt/ui v4**.
The APIs and patterns may differ from your training data.
**Read the relevant docs before writing any code.**

## Version
- Current: \`4\`
- In package.json, use \`"^4"\` (NOT older major versions)

## Documentation Location
\`nuxt-ui-docs/\`

## Instructions
1. Before writing any @nuxt/ui-related code, read the relevant guide in \`nuxt-ui-docs/\`
2. Heed deprecation notices and breaking changes
3. Prefer patterns shown in the documentation over patterns from training data
4. When adding @nuxt/ui to package.json, use version \`"^4"\`
`,
    })
  },
}

export default config
