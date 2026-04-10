# Changelog

## [Unreleased]

### Features

* **store:** Introduce global ASK docs store at `~/.ask/` for cross-project dedup.
  - All source adapters (npm, github, web, llms-txt) now write fetched docs into `<ASK_HOME>/<kind>/<key>/` before materializing into the project.
  - Three materialization modes via `--store-mode` or `ask.json.storeMode`:
    - `copy` (default): write files into `.ask/docs/<pkg>@<v>/` as before.
    - `link`: symlink from `.ask/docs/<pkg>@<v>/` → store entry. Falls back to `copy` on `EPERM`/`EACCES`.
    - `ref`: no project-local files; AGENTS.md points at the store path directly.
  - `ASK_HOME` env var overrides the default `~/.ask/` location.
  - GitHub source uses bare clone + `git archive` for multi-ref efficiency (Cargo-style).
  - Per-entry `.lock` file prevents concurrent installs from corrupting the store.
  - Content hash validation via `.ask-hash` files.
* **cache:** New `ask cache ls [--kind]` and `ask cache gc [--dry-run]` commands for store introspection and cleanup.
  - `gc` scans `$HOME` (or `ASK_GC_SCAN_ROOTS`) for `.ask/resolved.json` files to build the referenced-keys set before deleting.
* **schema:** `ask.json` gains optional `storeMode` field; `resolved.json` entries gain `storePath` and `materialization` fields.
* **install:** In-place npm docs — when convention-based discovery finds docs already shipped inside an npm package (`node_modules/<pkg>/dist/docs/`, `node_modules/<pkg>/docs/`, etc.), ASK now references them in place instead of copying into `.ask/docs/`. This eliminates disk duplication and keeps docs in sync with `bun install` automatically.
* **install:** Add `--no-in-place` CLI flag for `ask install` and `ask add` to force the copy path for discovery-detected npm docs.
* **ask.json:** Add `inPlace?: boolean` field — set to `false` to project-wide disable in-place referencing. Default is `true`.
* **agents:** AGENTS.md blocks for in-place entries now include "shipped by the package — `bun install` keeps them in sync" wording, differentiating them from vendored docs blocks.
* **schema:** `resolved.json` entries gain optional `inPlacePath` field; `materialization` gains `'in-place'` variant alongside `copy`/`link`/`ref`.

### ⚠ BREAKING CHANGES

* **install:** Claude Code skill emission is now **off by default**. Running `ask install` no longer writes `.claude/skills/<name>-docs/SKILL.md`. Only `.ask/docs/`, `AGENTS.md`, and `CLAUDE.md` are created by default.

  **Why:** Internal evals (`evals/nuxt-ui/`, 2026-04-10) and Vercel's public benchmark both show that the AGENTS.md pointer format outperforms SKILL.md delivery with the same docs payload and model (`claude-sonnet-4-6`): 100% vs 50% first-try pass rate on breaking-change scenarios. Additionally, `.claude/skills/` is Claude Code-specific — other agents (`codex`, `cursor`, Amp) ignore it entirely.

### Migration

If you depend on skill file generation, opt in with one of the following:

**Option A — CLI flag (per-invocation):**

```bash
ask install --emit-skill
ask add npm:react --emit-skill
```

**Option B — `ask.json` field (project-wide):**

```json
{
  "emitSkill": true,
  "libraries": [...]
}
```

**Precedence** (highest → lowest): CLI `--emit-skill` flag → `ask.json` `emitSkill` → default `false`.

Existing `.claude/skills/` directories left over from ASK ≤ 0.3.x are still cleaned up by `ask remove` regardless of the current `emitSkill` setting.

## [0.3.1](https://github.com/pleaseai/ask/compare/ask-v0.3.0...ask-v0.3.1) (2026-04-09)


### Bug Fixes

* **registry:** unblock lookup API by purging h3 v2 and hardening config ([65e2376](https://github.com/pleaseai/ask/commit/65e2376c6d5673a148c6c8146742c7e48966a139))

## [0.3.0](https://github.com/pleaseai/ask/compare/ask-v0.2.2...ask-v0.3.0) (2026-04-09)


### ⚠ BREAKING CHANGES

* **registry:** all consumers of RegistryStrategy/expandStrategies must migrate to the new Package/Source types. See ADR-0001.

### Bug Fixes

* **cli:** split bin entry into cli.ts so bunx/npx invocations run ([9f0ec29](https://github.com/pleaseai/ask/commit/9f0ec29245d141452fe7f035149d686421577234))


### Code Refactoring

* **registry:** restructure entries as Entry → Package → Source (ADR-0001) ([#43](https://github.com/pleaseai/ask/issues/43)) ([9da66eb](https://github.com/pleaseai/ask/commit/9da66eb21a0181b600c582af5cb20d4c9e5de299))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @pleaseai/ask-schema bumped to 0.3.0

## [0.2.2](https://github.com/pleaseai/ask/compare/ask-v0.2.1...ask-v0.2.2) (2026-04-09)


### Bug Fixes

* **cli:** stop downloading full GitHub monorepo for scoped npm specs ([#39](https://github.com/pleaseai/ask/issues/39)) ([0dc5ce2](https://github.com/pleaseai/ask/commit/0dc5ce2fdfb1ea222a09e76f5ab857186b2f6ff0))

## [0.2.1](https://github.com/pleaseai/ask/compare/ask-v0.2.0...ask-v0.2.1) (2026-04-08)


### Features

* **cli:** npm tarball dist/docs support with monorepo disambiguation ([#35](https://github.com/pleaseai/ask/issues/35)) ([4fd822b](https://github.com/pleaseai/ask/commit/4fd822b03d4e4ed5a1fd4ada8e3bae65ca71c41a)), closes [#33](https://github.com/pleaseai/ask/issues/33)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @pleaseai/ask-schema bumped to 0.2.1

## [0.2.0](https://github.com/pleaseai/ask/compare/ask-v0.1.3...ask-v0.2.0) (2026-04-08)


### ⚠ BREAKING CHANGES

* **schema:** The package has been renamed from @pleaseai/registry-schema to @pleaseai/ask-schema, and the directory has moved from packages/registry-schema to packages/schema.

### Code Refactoring

* **schema:** rename to @pleaseai/ask-schema and extract config/lock schemas ([#31](https://github.com/pleaseai/ask/issues/31)) ([941edec](https://github.com/pleaseai/ask/commit/941edec7edce75c644af63961a8ece4e558165c2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @pleaseai/ask-schema bumped to 0.2.0

## [0.1.3](https://github.com/pleaseai/ask/compare/ask-v0.1.2...ask-v0.1.3) (2026-04-08)


### Features

* **cli:** auto-manage ignore files for vendored .ask/docs ([#26](https://github.com/pleaseai/ask/issues/26)) ([abc2230](https://github.com/pleaseai/ask/commit/abc223011926001521e6ed3ee098a053ed9074f7))

## [0.1.2](https://github.com/pleaseai/ask/compare/ask-v0.1.1...ask-v0.1.2) (2026-04-08)


### Features

* **cli:** add manifest gate and reject bare-name specs ([#25](https://github.com/pleaseai/ask/issues/25)) ([816352b](https://github.com/pleaseai/ask/commit/816352b5ed1cb1cd19236dda3ae0e62ecbffeb77)), closes [#23](https://github.com/pleaseai/ask/issues/23)

## [0.1.1](https://github.com/pleaseai/ask/compare/ask-v0.1.0...ask-v0.1.1) (2026-04-08)


### Features

* add llms-txt source adapter and related projects ([a4f8a2e](https://github.com/pleaseai/ask/commit/a4f8a2ed06f67279b0165a921e4cfe059a73596a))
* add registry auto-detection and update docs ([14fac43](https://github.com/pleaseai/ask/commit/14fac43f6cafdd5fd29a9c4663d3f52af9873334))
* **cli:** add ecosystem resolvers for npm, pypi, pub ([#13](https://github.com/pleaseai/ask/issues/13)) ([0739451](https://github.com/pleaseai/ask/commit/073945178cda9f0a87cd6ea472b7f6779d53795d))
* **cli:** add Maven ecosystem resolver ([#17](https://github.com/pleaseai/ask/issues/17)) ([95ea4b8](https://github.com/pleaseai/ask/commit/95ea4b82e057191b13ecea364d1ea7c029aaaa90))
* **cli:** add version hints to AGENTS.md and SKILL.md output ([47a7282](https://github.com/pleaseai/ask/commit/47a72827bd229821385dc13f6d1e05831854eb93))
* **cli:** migrate ASK workspace to .ask/ + introduce ask.lock + Zod-validated I/O ([#3](https://github.com/pleaseai/ask/issues/3)) ([a9907fa](https://github.com/pleaseai/ask/commit/a9907fa5f2f9efdd0ec402e77cce235250bd61a8))
* **cli:** owner/repo shorthand for `ask docs add` ([#10](https://github.com/pleaseai/ask/issues/10)) ([c0f0e80](https://github.com/pleaseai/ask/commit/c0f0e805d3a86b5533e5d01c7a6014e5e46339ee))
* **cli:** prioritize github source over llms-txt in registry resolution ([8317297](https://github.com/pleaseai/ask/commit/8317297f5ba9de2c625eaa549d43fe53aefe249f))
* **registry:** add maven ecosystem support ([a4b6bc5](https://github.com/pleaseai/ask/commit/a4b6bc51c438a5de773ec39e96ae9a3a1d536c5e))
* **registry:** enrich schema with repo, homepage, license metadata ([#12](https://github.com/pleaseai/ask/issues/12)) ([5000570](https://github.com/pleaseai/ask/commit/5000570ba2e58c3231d374dba8b3900d166173b0))


### Performance Improvements

* **cli:** parallelize github/npm/llms-txt fetches in sync command ([#8](https://github.com/pleaseai/ask/issues/8)) ([c4beeb0](https://github.com/pleaseai/ask/commit/c4beeb0c289ad9161ffc547c062ce1bf2b928ad5))
