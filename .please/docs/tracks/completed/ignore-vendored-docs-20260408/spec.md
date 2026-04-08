---
product_spec_domain: cli/ignore-management
---

# Vendored Docs Ignore Management

> Track: ignore-vendored-docs-20260408

## Overview

The `ask docs add` command marks `.ask/docs/` as **vendored third-party documentation**, achieving two goals simultaneously:

1. **AI agents must still be able to read it** (ASK's core value — docs are for reference)
2. **Excluded from lint / format / code review / modification** (because it's vendored)

To accomplish this, ASK (A) creates self-contained config files inside `.ask/docs/`, (B) injects an intent notice into ASK marker blocks in AGENTS.md/CLAUDE.md, and (C) patches root files only for tools that do not support nested ignore.

## Requirements

### Functional Requirements

#### A. Self-contained local config (created inside `.ask/docs/`)

- [ ] FR-A1: Create `.ask/docs/.gitattributes` — `* linguist-vendored=true` + `* linguist-generated=true` (collapses GitHub PR diffs + excludes from language statistics).
- [ ] FR-A2: Create `.ask/docs/eslint.config.mjs` — `export default [{ ignores: ['**/*'] }]` (ESLint flat config auto-discovers nested configs).
- [ ] FR-A3: Create `.ask/docs/biome.json` — exclude all files from processing (Biome auto-discovers nested configs).
- [ ] FR-A4: Create `.ask/docs/.markdownlint-cli2.jsonc` — `{ "ignores": ["**/*"] }` (markdownlint-cli2 supports nested config).

#### B. Intent notice (inside ASK marker block in AGENTS.md / CLAUDE.md)

- [ ] FR-B1: Auto-inject the following notice inside an ASK-managed marker block (`<!-- ask:start --> ... <!-- ask:end -->`):
  > `.ask/docs/` contains vendored third-party documentation downloaded by ASK. Treat it as **read-only**: AI context should reference these files, but they are NOT subject to modification, lint, format, or code review. Updates are performed via `ask docs sync`.
- [ ] FR-B2: If AGENTS.md exists, inject into AGENTS.md. If CLAUDE.md exists, inject into CLAUDE.md. If both exist, inject into both. If neither exists, create AGENTS.md (standard preference).
- [ ] FR-B3: This single notice transitively affects the following AI tools (verified): CodeRabbit, cubic, Claude Code, Codex, Cursor (rules), GitHub Copilot, Continue, Aider, etc.

#### C. Root file patching (only for tools without nested support, only if detected)

- [ ] FR-C1: If root `.prettierignore` exists, add `.ask/docs/` exclusion patterns inside a marker block. (Prettier does not support nested ignore.)
- [ ] FR-C2: If root `sonar-project.properties` exists, append `.ask/docs/**` to `sonar.exclusions` inside a marker block.
- [ ] FR-C3: If root legacy `.markdownlintignore` (markdownlint-cli legacy) exists, add `.ask/docs/` inside a marker block. Also emit a recommendation to migrate to markdownlint-cli2.
- [ ] FR-C4: Do not create these files if absent — patch only when detected.

#### D. Marker block management

- [ ] FR-D1: Injection format follows each file's comment syntax. Properties/ignore files: `# <!-- ask:start -->` ... `# <!-- ask:end -->`. Markdown: `<!-- ask:start --> ... <!-- ask:end -->`. Properties (FR-C2): `# ask:start` ... `# ask:end`.
- [ ] FR-D2: Idempotent: running `add` repeatedly does not duplicate marker blocks; only the contents inside are refreshed.
- [ ] FR-D3: `ask docs sync` refreshes marker blocks. When `ask docs remove` removes the last docs entry, ASK deletes the local config files in (A) and removes the marker blocks in (B) and (C). Empty blocks are not left behind.
- [ ] FR-D4: ASK never modifies user content outside marker blocks.

#### E. Configuration and logging

- [ ] FR-E1: Add `manageIgnores: boolean` (default `true`) to `ask.config.json`. When `false`, all of categories A/B/C are skipped.
- [ ] FR-E2: During `add` / `sync` / `remove`, report the list of created/updated/removed files and skip reasons via consola.

### Non-functional Requirements

- [ ] NFR-1: Do **not** auto-patch root ESLint flat config (`eslint.config.{js,mjs,ts}`) — replaced by `.ask/docs/eslint.config.mjs` (FR-A2). Same applies to root `biome.json` and `.cursorignore` (the latter is intentionally avoided since it would block AI context access).
- [ ] NFR-2: Preserve existing EOL and encoding when writing files.
- [ ] NFR-3: Unit tests cover (A) local file creation, (B) AGENTS.md/CLAUDE.md injection·refresh·removal, (C) Prettier/Sonar marker block injection·refresh·removal, idempotency, and the `manageIgnores: false` skip path.
- [ ] NFR-4: All generated files follow the project's ESM conventions (2-space indent, single quotes, no semicolons where applicable).

## Acceptance Criteria

- [ ] AC-1: In an empty project, running `ask docs add npm:react` creates `.gitattributes`, `eslint.config.mjs`, `biome.json`, and `.markdownlint-cli2.jsonc` inside `.ask/docs/`.
- [ ] AC-2: In a project without AGENTS.md, after `add`, `AGENTS.md` is created and contains the vendored notice inside the ASK marker block.
- [ ] AC-3: In a project where `CLAUDE.md` exists, the same marker block is also injected into CLAUDE.md.
- [ ] AC-4: In a project with a root `.prettierignore`, after `add`, the marker block is appended to `.prettierignore`. In a project without `.prettierignore`, no file is created.
- [ ] AC-5: Running the same `add` command twice does not duplicate marker blocks in any file (idempotency).
- [ ] AC-6: When `ask docs remove` removes the last docs entry:
  - Local config files inside `.ask/docs/` are deleted
  - Marker blocks are removed from AGENTS.md/CLAUDE.md
  - Marker blocks are removed from root `.prettierignore`/`sonar-project.properties` (the files themselves remain)
- [ ] AC-7: Setting `"manageIgnores": false` in `ask.config.json` causes categories A/B/C to be entirely skipped.
- [ ] AC-8: Root `.gitattributes` is left untouched (verified that `.ask/docs/.gitattributes` works correctly via Git's nested resolution).

## Out of Scope

- Auto-patching root ESLint flat config (`eslint.config.{js,mjs,ts}`) — replaced by `.ask/docs/eslint.config.mjs` nested config.
- Auto-patching root `biome.json` — replaced by `.ask/docs/biome.json` nested config.
- Creating `.cursorignore` — `.cursorignore` blocks AI access to file contents, which is the opposite of ASK's goal (AI must reference docs). Replaced by AGENTS.md notice.
- Auto-patching `.coderabbit.yaml` `path_filters` — CodeRabbit auto-reads AGENTS.md, so (B) suffices.
- Automating cubic cloud dashboard settings — cubic also auto-reads AGENTS.md/CLAUDE.md, so (B) suffices.
- `.gitignore` patching — whether to commit `.ask/docs/` is a user policy.
- IDE-specific settings (`.vscode/settings.json`, JetBrains scopes) — personal scope.
- Reorganizing/sorting other parts of existing ignore files.

## Assumptions

- The user does not directly edit `.ask/docs/` and treats it as vendored (`ask docs sync` overwrites it).
- The user's existing root ignore file content must be preserved; ASK only modifies marker blocks it owns.
- AI code review tools "respect" the AGENTS.md/CLAUDE.md notice but are not mechanically enforced. However, since CodeRabbit / cubic / Claude Code / Cursor all structurally consume context files, the practical effect is high.
- `manageIgnores` is a global switch applied to add/sync/remove uniformly.
