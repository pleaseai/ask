# Product Guidelines — ASK

## Prose & Tone

- **Concise and technical**: Target audience is developers. Avoid marketing fluff.
- **Action-oriented**: Lead with what to do, not why. Examples over explanations.
- **CLI-first**: All user-facing interactions happen through the CLI. Prioritize clear command output via `consola`.

## UX Principles

- **Zero-config by default**: `ask docs add next@canary` should work without flags when the library is in the registry.
- **Explicit over magic**: When auto-detection is used (ecosystem, source), always log what was resolved so the user understands what happened.
- **Idempotent operations**: Running the same command twice should produce the same result without errors.
- **Graceful degradation**: If the registry is unreachable, fall back to manual source flags. Never fail silently.

## CLI Output Standards

- Use `consola.info` for progress, `consola.success` for completion, `consola.warn` for fallbacks, `consola.error` for failures.
- Always show the resolved version and source in success output.
- File paths in output should be relative to the project root.

## Registry Guidelines

- Each entry must have at least one working strategy.
- Prefer npm source when docs are bundled in the package (smallest download).
- Include `description` and `tags` for discoverability.
- Version notes in the markdown body for breaking changes between major versions.

## Naming Conventions

- CLI command: `ask docs {verb}` — verbs are `add`, `sync`, `list`, `remove`.
- Doc storage: `.please/docs/<name>@<version>/`
- Skills: `.claude/skills/<name>-docs/SKILL.md`
- Registry entries: `content/registry/<ecosystem>/<name>.md`
