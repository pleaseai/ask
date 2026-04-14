---
product_spec_domain: cli/skills
---

# `ask skills` Command

> Track: ask-skills-command-20260414

## Overview

Add an `ask skills` CLI namespace that surfaces and installs **producer-side skills** (agent-facing instruction bundles) shipped by libraries. Parallel to `ask docs`/`ask src` (which surface documentation), `ask skills` targets `skills/` directories embedded in packages so AI coding agents can consume library-provided skill files directly.

This is distinct from the consumer-side `.claude/skills/<name>-docs/SKILL.md` that `ask install` auto-generates — those are references TO docs; producer-side skills ARE skills authored by the library maintainer.

**Install model**: skills are vendored once into `.ask/skills/<spec-key>/<skill-name>/` (gitignored), then **symlinked** into each selected agent directory (`.claude/skills/`, `.cursor/skills/`, `.opencode/skills/`, `.codex/skills/`). A lock file tracks installed entries so double-install is a no-op and `remove` is deterministic.

## Requirements

### Functional Requirements

- [ ] FR-1 `ask skills <spec>` (no subcommand) = implicit `list`: prints one absolute path per line for every candidate skills directory found. Same spec format as `ask docs`.
- [ ] FR-2 Skill source locations walked (in order):
  - `node_modules/<pkg>/skills/` when the spec is an npm-ecosystem entry AND the package is installed locally.
  - The cached checkout root from `ensureCheckout` and every nested dir whose basename matches `/skill/i`, up to depth 4.
- [ ] FR-3 Output format mirrors `ask docs`: one absolute path per line, root of each source always included, subdirectories whose basename matches `/skill/i` appended.
- [ ] FR-4 `ask skills list <spec>` = explicit alias of FR-1.
- [ ] FR-5 `ask skills install <spec>`:
  1. Resolves source skills via the same walker used by `list`.
  2. **Vendor step**: copies every discovered skill directory into `.ask/skills/<spec-key>/<skill-name>/` where `<spec-key>` is a filesystem-safe form of the resolved spec (e.g. `npm__next__14.2.3`, `github__vercel__ai__v5.0.0`). This is the canonical on-disk copy.
  3. **Agent detection**: scans project root for `.claude/`, `.cursor/`, `.opencode/`, `.codex/`, `AGENTS.md`.
  4. **Agent selection**: if >1 agent detected, prompts via `consola.prompt({ type: 'multiselect' })`; if exactly 1, auto-selects it; if 0, errors with a helpful message.
  5. **Symlink step**: creates a relative symlink from `<agent-dir>/skills/<skill-name>` → `.ask/skills/<spec-key>/<skill-name>/`. If a symlink already exists and points to the same target, no-op. If a symlink exists with a different target OR a real directory exists, errors unless `--force` is passed.
  6. **Lock step**: updates `.ask/skills-lock.json` with an entry `{ spec, specKey, skills: [{ name, agents: [...] }], installedAt }`. Lock is the single source of truth for `remove`.
- [ ] FR-6 `ask skills remove <spec>` uses `.ask/skills-lock.json` to enumerate installed symlinks and the vendored copy, then:
  1. Removes every agent symlink recorded in the lock (safe: only unlinks when the link target matches the vendored path — never touches user-authored skills).
  2. Removes `.ask/skills/<spec-key>/` directory.
  3. Removes the spec's entry from `.ask/skills-lock.json`.
- [ ] FR-7 `--no-fetch` flag on `list` / default: cache-hit-only, exits 1 on cache miss (same as `ask docs`).
- [ ] FR-8 Exit codes: 0 on success, 1 on cache miss with `--no-fetch`, 1 on resolver/ecosystem failures, 1 on symlink conflicts without `--force`.
- [ ] FR-9 **Idempotence**: `ask skills install` twice produces the same final state — vendor copy is refreshed, symlinks are re-verified, lock entry is updated-in-place (not appended).
- [ ] FR-10 Reuses the shared `ensureCheckout` helper; no new resolver logic.
- [ ] FR-11 `ask skills install|remove` also manages ignore markers so `.ask/skills/` and `.ask/skills-lock.json` are marked vendored (extends the existing `# ask:start ... # ask:end` block in `.gitignore`).
- [ ] FR-12 Symlink flavor: relative POSIX symlinks (`ln -s ../../.ask/skills/...`) so the project tree stays portable across clones. Windows junction fallback deferred.

### Non-functional Requirements

- [ ] NFR-1 Zero overlap with the existing `ask install` generated `.claude/skills/<name>-docs/` block — those are **files** authored by ask; producer skills live under a different path (the skill's own name, not `<name>-docs`) and are symlinks, not generated files.
- [ ] NFR-2 Walk behavior mirrors `findDocLikePaths` (skip `node_modules`, `.git`, `dist`, `build`, `coverage`, dotdirs; MAX_DEPTH=4).
- [ ] NFR-3 All user-facing output via `consola`; path listings via `stdout` so shell substitution works.
- [ ] NFR-4 Lock file format is stable, documented in the plan, and safe to hand-edit (no embedded hashes or opaque blobs in v1).

## Acceptance Criteria

- [ ] AC-1 `ask skills vercel/ai` prints `node_modules/<pkg>/skills/` paths (if installed) then the cached checkout and nested skill dirs.
- [ ] AC-2 `ask skills install npm:some-pkg@1.0.0` in a project with both `.claude/` and `.cursor/` prompts the user, vendors skills into `.ask/skills/`, and symlinks into the selected agent dirs.
- [ ] AC-3 Running the same `install` a second time is a no-op (same lock entry, same symlinks, no errors).
- [ ] AC-4 `ask skills remove npm:some-pkg@1.0.0` deletes every symlink listed in the lock, removes `.ask/skills/<spec-key>/`, and purges the lock entry.
- [ ] AC-5 If a user has a pre-existing `.claude/skills/<skill-name>` real directory, `install` fails with a clear message and suggests `--force`.
- [ ] AC-6 `.gitignore` picks up `.ask/skills/` and `.ask/skills-lock.json` within the `# ask:start ... # ask:end` marker block after the first `install`.
- [ ] AC-7 No regression in `ask install` output.

## Out of Scope

- Declarative `ask.json` entries for skills (future track).
- Publishing user-authored skills to the ASK Registry.
- Agent-specific format translation (Cursor-rules vs Claude-SKILL.md). v1 copies skill dirs as-is.
- Global install target (`~/.claude/skills/`). v1 is project-local only.
- Windows native junction support (Linux/macOS symlink only in v1).
- Auto-discovery of skills via `package.json` keywords / intent adapter (may be added when wiring convention-based discovery later).

## Assumptions

- A library ships its producer-side skills under a top-level `skills/` directory (convention inherited from tanstack-intent). The walker also surfaces any `/skill/i`-named subdirectory for forgiving discovery.
- `.ask/skills/` is safe to vendor alongside `.ask/docs/` — both are cache-like and gitignored.
- Symlinks are viable on every developer platform this project targets today (macOS + Linux; CI is Linux). Windows users can unblock manually until FR-12's junction fallback lands.
- `ensureCheckout` already guarantees the checkout tree is read-only from the consumer's perspective — vendoring into `.ask/skills/` avoids future cache cleanup invalidating active symlinks.
- `<spec-key>` encoding scheme is decided in the plan phase (proposed: replace `/`, `@`, `:` with `__` for a flat, grep-friendly structure).
