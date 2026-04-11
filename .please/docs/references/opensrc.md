# opensrc

> Analysis of [vercel-labs/opensrc](https://github.com/vercel-labs/opensrc) — a Rust CLI that gives coding agents access to any package's source code by resolving + shallow-cloning upstream repos into a shared global cache.

Vendored at [`vendor/opensrc/`](../../../vendor/opensrc/) (git submodule, reference only).
Analyzed against version **0.7.1** (`packages/opensrc/cli/Cargo.toml`).

## Why this is in our repo

ASK and opensrc both solve "give the AI accurate, version-specific source material for installed libraries," but from opposite ends:

| Axis | ASK | opensrc |
|---|---|---|
| **Output** | Markdown docs + Claude Code skill files (`.claude/skills/<lib>-docs/SKILL.md`) | Raw upstream source trees at `~/.opensrc/repos/<host>/<owner>/<repo>/<version>/` |
| **Declarativity** | Declarative: `ask.json` + `ask install` is the contract | Imperative / on-demand: `opensrc path <spec>` fetches lazily |
| **Cache scope** | Per-project (`.ask/docs/`, gitignored) | Global (`~/.opensrc/`) shared across all projects |
| **Surface for agents** | `AGENTS.md` auto-block enumerating available libraries | `AGENTS.md` `<!-- opensrc:start -->` block telling the agent to run `opensrc path` itself |
| **Consumption model** | Agent reads pre-rendered markdown | Agent composes shell tools (`rg`, `cat`, `find`) against a path substitution |
| **Version resolution** | Lockfile-driven at install time (`bun.lock → package-lock.json → pnpm → yarn → package.json`) | Lockfile at call time (npm only) + explicit `@<ver>` + latest fallback |
| **Registry coverage** | npm, pypi, pub, go, crates, hex, nuget, maven (via ASK Registry) | npm, PyPI, crates.io, GitHub, GitLab (direct API lookups — no central registry) |
| **Build/runtime** | TypeScript, distributed as `@pleaseai/ask` via npm | Rust, distributed as `opensrc` via npm with prebuilt cross-platform binaries |

Where the designs **converge** (both resolve a package → git repo URL → clone at the right tag) and where they **diverge** (pre-render markdown vs. lazy path substitution) informs several decisions in `packages/cli/src/` — particularly the resolver/source split in `src/resolvers/` + `src/sources/` and the `parseSpec` discriminated union in `src/spec.ts`. opensrc's inverted model (agent composes tools over a path) is a useful counterpoint to ASK's "pre-generate AGENTS.md + SKILL.md" approach.

## Repo layout

```
opensrc/                              # Turborepo + pnpm workspaces
├── packages/opensrc/                 # "opensrc" npm package
│   ├── bin/opensrc.js                # Node.js shim → selects + execs native binary
│   ├── scripts/                      # postinstall, version sync, copy-native
│   ├── cli/                          # Rust crate (binary: opensrc)
│   │   ├── Cargo.toml                # version 0.7.1 (kept in sync with package.json)
│   │   └── src/
│   │       ├── main.rs               # clap Cli/Subcommand definitions
│   │       ├── commands/             # path, list, remove, clean
│   │       └── core/
│   │           ├── cache.rs          # ~/.opensrc layout, sources.json index
│   │           ├── git.rs            # shallow clone at tag/ref with fallbacks
│   │           ├── version.rs        # npm lockfile version detection
│   │           └── registries/      # npm, pypi, crates, repo (GitHub/GitLab)
│   └── package.json                  # bin: opensrc → bin/opensrc.js
├── apps/docs/                        # Next.js docs site (apps/docs)
└── skills/opensrc/                   # Agent skill markdown (shipped in the npm package)
```

The single `packages/opensrc/` npm package ships three things: the Node shim (`bin/opensrc.js`), the cross-platform native Rust binary (downloaded by `scripts/postinstall.js` or built locally via `build:native`), and the agent skill files under `skills/`.

## CLI surface

```
opensrc path <spec...> [--cwd <dir>] [--verbose]   # fetch (if needed) and print absolute path to cached source
opensrc list [--json]                               # list all globally cached packages + repos
opensrc remove <spec...>                            # remove cached source for packages or repos (alias: rm)
opensrc clean [--packages] [--repos] [--npm] [--pypi] [--crates]
```

`opensrc path` is the load-bearing command — everything else is cache management. It is designed to be composed via command substitution:

```bash
rg "parse" $(opensrc path zod)
cat $(opensrc path zod)/src/types.ts
rg "pattern" $(opensrc path zod react next)   # multiple specs → multiple paths printed
```

### Supported spec formats

From `core/registries/mod.rs:REGISTRY_PREFIXES` + `core/registries/repo.rs:parse_repo_spec`:

| Form | Example | Resolved via |
|---|---|---|
| bare name | `zod` | npm (default) |
| `npm:<name>[@ver]` | `npm:react@18.2.0` | npm |
| `pypi:` / `pip:` / `python:` | `pypi:requests==2.31.0` | PyPI (also accepts `==` and `@` separators) |
| `crates:` / `cargo:` / `rust:` | `crates:serde@1.0.200` | crates.io |
| `owner/repo[@ref]` | `vercel/next.js@canary` | GitHub (default host) |
| `github:` / `gitlab:` / `bitbucket:` | `gitlab:group/project` | corresponding host |
| full URL | `https://github.com/vercel/next.js/tree/canary` | parsed host + `/tree/`/`/blob/` ref |
| scoped npm | `@babel/core@7.0.0` | npm (handled by `RE_SCOPED_PKG` regex) |

`detect_input_type()` in `registries/mod.rs` decides "package spec" vs "repo spec": any registry prefix forces package mode; otherwise `repo::is_repo_spec()` checks against supported hosts and a strict `owner/repo` regex.

## Fetch pipeline (`commands/path.rs`)

For **packages** (`handle_package`):

1. **Parse** — `parse_package_spec(spec)` → `PackageSpec { registry, name, version? }`.
2. **Cache pre-check** — if an explicit version is provided and `sources.json` already has it, print the path and return. Zero network.
3. **Version detection** (npm only, no explicit version) — `core/version::detect_installed_version(name, cwd)` walks a priority chain and strips range prefixes from `package.json` as the last-resort fallback:
   ```
   node_modules/<pkg>/package.json
     → package-lock.json (v7+ "packages", then v6 "dependencies")
     → pnpm-lock.yaml   (regex extract of `'?name@<ver>` first occurrence)
     → yarn.lock        (regex extract of a "name@..." block's "version" line)
     → package.json     (strip ^~>=< from dependencies/devDependencies/peerDependencies)
   ```
   (This is an interesting counterpoint to ASK's equivalent at `packages/cli/src/lockfiles/index.ts:npmEcosystemReader`, which uses the same priority order but parses each lockfile into structured data instead of regex.)
4. **Cache re-check** — if detected version matches an existing entry, return.
5. **Resolve** — `registries::resolve_package()` dispatches on registry:
   - **npm** (`registries/npm.rs`): `GET https://registry.npmjs.org/<encoded_name>` → read `dist-tags.latest` or validate requested version exists → extract `repository.url` (top-level or version-specific), normalize `git+`, `git://`, `ssh://git@`, `github:` shorthand, strip `.git`. Includes `repository.directory` for monorepo packages. Errors with "Recent versions: x, y, z" when the requested version isn't published.
   - **PyPI** (`registries/pypi.rs`): `GET https://pypi.org/pypi/<name>[/<version>]/json` → scan `project_urls` by priority keys (`Source`, `Source Code`, `Repository`, `GitHub`, `Code`, `Homepage`), fall back to `home_page`, fall back to any URL in `project_urls` that matches `github.com|gitlab.com|bitbucket.org`.
   - **crates.io** (`registries/crates.rs`): `GET https://crates.io/api/v1/crates/<name>` → use `crate.max_version` or verify requested version with a second `GET /crates/<name>/<ver>` call. Repo extracted from `repository` or `homepage` field.
6. **Clone** — `core/git::fetch_source(resolved)`:
   - Short-circuits on cache hit (`~/.opensrc/repos/<host>/<owner>/<repo>/<version>/` already exists).
   - `authenticated_clone_url()` (defined in `core/registries/mod.rs`, called from `core/git.rs`) rewrites `https://github.com/...` → `https://x-access-token:$GITHUB_TOKEN@github.com/...` (and equivalent for GitLab with `$GITLAB_TOKEN`). This is the private-repo auth added in 0.7.1.
   - `clone_at_tag()` tries `git clone --depth 1 --branch v<version> --single-branch`, then `--branch <version>`, then falls back to the default branch with a warning ("Could not find tag for version X, cloned default branch instead"). Each failed attempt `rm -rf`s the target dir before retrying.
   - Strips `.git/` after clone so the cached tree is a clean source snapshot, not a working git repo.
   - If the npm `repository.directory` field is set, the printed path is `<cache_root>/<subdir>` — this is how a Lerna/pnpm monorepo package points to its actual source without cloning each package separately (all `@babel/*` packages share one clone of `babel/babel`).
7. **Index** — `core/cache::write_sources()` atomically updates `~/.opensrc/sources.json` (temp-file + rename for concurrency safety). Corrupt reads back up the bad file to `sources.json.bak` and proceed with an empty index.
8. **Print** — absolute path to stdout. One line per input spec, so `$(opensrc path a b c)` expands to three space-separated paths.

For **repos** (`handle_repo`, when `detect_input_type` returns `"repo"`), the flow is similar but version resolution goes through `registries/repo::resolve_repo`:
- **GitHub** — `GET https://api.github.com/repos/<owner>/<repo>` → uses `default_branch` when no explicit ref. 404 hints at `GITHUB_TOKEN` for private repos; 403 hints at rate-limit.
- **GitLab** — `GET https://gitlab.com/api/v4/projects/<urlencoded owner/repo>` → `default_branch` or `"main"` fallback.
- **Bitbucket** — no API call; assumes `main` as the ref.

## Cache layout

From `core/cache.rs`:

```
~/.opensrc/                          # or $OPENSRC_HOME
├── sources.json                     # { updatedAt, packages: [...], repos: [...] }
└── repos/
    └── <host>/<owner>/<repo>/<version>/
        ├── ...source tree...
        └── (no .git/ — stripped post-clone)
```

`sources.json` is the sole index. `read_sources()` deserializes it (with `list_sources()` as a thin wrapper that returns the `(packages, repos)` tuple); `write_sources()` replaces it atomically. The "path" field stored per entry is a relative path like `repos/github.com/colinhacks/zod/3.22.0` (plus an optional `/packages/sub` for monorepo packages with a `repository.directory`). `get_absolute_path(rel)` joins it onto `$OPENSRC_HOME`.

Two entries can share the same on-disk clone when they point to different subdirectories of the same monorepo. `remove_package_source` checks `extract_repo_base_path` against all remaining entries before deleting the cloned tree — it only removes the versioned directory if no other package still references it. `cleanup_empty_parent_dirs` walks up and prunes now-empty `owner/` and `host/` wrappers.

## Node.js ↔ Rust binary shim

Two relevant scripts:

- `bin/opensrc.js` — the `"bin"` entry. Detects `platform() + arch() + (musl?)`, maps to `opensrc-<osKey>-<archKey>[.exe]`, `chmod +x` if needed, then `spawn(..., { stdio: 'inherit' })` and forwards exit code. Supports darwin/linux/linux-musl/win32 × x64/arm64. If the binary is missing, prints a build instruction.

- `scripts/postinstall.js` — runs after `npm install`:
  1. If the native binary already exists in `bin/<name>`, `chmod +x` and exit.
  2. Otherwise download from `https://github.com/vercel-labs/opensrc/releases/download/v<version>/<binaryName>` via `https.get` with manual 301/302 redirect handling.
  3. Verify SHA256 against `CHECKSUMS.txt` in the same release. Missing checksums are treated as a warning (not fatal); mismatches delete the downloaded binary and print build instructions.
  4. **Shim optimization**: `fixUnixSymlink` reads `npm prefix -g`, checks whether `$prefix/bin/opensrc` is a symlink (npm's default JS-wrapper shim), and replaces it with a direct symlink to the native binary so globally-installed invocations skip the Node startup overhead entirely. `fixWindowsShims` does the analogous trick for `.cmd`/`.ps1` shims. These are best-effort — if the symlink/shim replacement fails, the Node wrapper still works.

The "fix the global symlink to point straight at the native binary" move is the reason 0.7.0's "Rust rewrite" claimed 10× faster startup: on a `global -g` install, the first `opensrc` invocation goes through Node → spawn, but after postinstall every subsequent invocation is `exec` of the Rust binary with zero Node overhead.

## Agent-facing surface

`AGENTS.md` in the repo contains an `<!-- opensrc:start --> ... <!-- opensrc:end -->` block. The block tells the agent:

- Sources are cached at `~/.opensrc/`.
- The index lives at `~/.opensrc/sources.json` — use it to discover what's available.
- Compose `opensrc path` inside other commands:
  ```
  rg "pattern" $(opensrc path <package>)
  cat $(opensrc path <package>)/path/to/file
  find $(opensrc path <package>) -name "*.ts"
  ```

This is a **very different** instruction shape from ASK's `<!-- BEGIN:ask-docs-auto-generated -->` block, which lists pre-generated markdown files the agent should read directly. opensrc's block doesn't name any libraries — it names a protocol ("check sources.json, then substitute `opensrc path`").

The trade-off:
- **ASK** gets deterministic, reviewable doc content checked into the project (or at least reproducibly generated) and zero runtime network. But the doc is whatever the source adapter extracts, which is often a curated `docs/` subset, not the full source.
- **opensrc** gets _the actual source tree_, which the agent can grep and cross-reference, but requires the agent to be capable of running shell commands, requires network at first access, and bleeds state into a global cache outside the project.

## Environment variables

| Variable | Effect |
|---|---|
| `OPENSRC_HOME` | Override the default cache directory (`~/.opensrc`) |
| `GITHUB_TOKEN` | GitHub API calls (`Authorization: Bearer <token>`, rate-limit relief + private repo access) **and** embedded in clone URLs as `https://x-access-token:<token>@github.com/...` |
| `GITLAB_TOKEN` | GitLab API calls (`PRIVATE-TOKEN: <token>` header on `gitlab.com/api/v4/projects/...`) **and** embedded in clone URLs as `https://oauth2:<token>@gitlab.com/...`. Note the two mechanisms differ: API uses a header, clone uses URL injection. |

No other configuration file, no per-project settings. opensrc is intentionally stateless apart from the cache index.

## Rust crate dependencies

From `cli/Cargo.toml`:

- `clap` (4, `derive`) — CLI parsing, `#[derive(Parser, Subcommand)]`
- `reqwest` (0.12, `blocking`, `rustls-tls-webpki-roots`) — synchronous HTTP; rustls + webpki roots means no OpenSSL system dependency (important for distributing prebuilt binaries)
- `serde` + `serde_json` — JSON parsing for npm/PyPI/crates.io responses and `sources.json`
- `dirs` — home directory detection
- `chrono` — RFC3339 timestamps in the index (`fetchedAt`, `updatedAt`)
- `regex` — lockfile parsing, URL parsing, scoped-package regex. All patterns use `LazyLock` because they're compiled once at startup.
- `url`, `urlencoding` — URL parsing, percent-encoding for npm scope + GitLab project paths

Release profile is aggressive: `opt-level = 3`, `lto = true`, `codegen-units = 1`, `strip = true`. This plus `rustls-tls-webpki-roots` is what makes the distributed binaries small and self-contained.

## Things worth borrowing (or avoiding) in ASK

**Worth considering**:
- **Atomic index write** (`cache.rs:write_sources`). ASK's `upsertResolvedEntry` in `packages/cli/src/io.ts` should be audited for the same temp-file + rename pattern — concurrent `ask install` runs inside monorepo workspaces could race the same way.
- **Tag fallback chain** (`git.rs:clone_at_tag`): try `v<version>`, then `<version>`, then default branch with a warning. ASK currently trusts whatever tag a resolver returns.
- **Explicit error hint for rate-limit vs not-found** in GitHub API calls. Good UX to copy.
- **Corrupt-index recovery**: back up the bad file, continue with an empty index. ASK's `.ask/resolved.json` has no such guard; a corrupt JSON will hard-fail `list`/`install`.

**Worth not borrowing**:
- **Global cache outside the project** — conflicts directly with ASK's "everything the agent needs is checked in / gitignored under `.ask/` per-project" principle. An opensrc-style shared cache would need a very different trust model.
- **Regex-based pnpm/yarn lockfile parsing** — fragile. `npmEcosystemReader` in `src/lockfiles/` is the better design for our use case.
- **Stripping `.git/` from cached clones** — we don't clone, we download tarballs/archives, so this is a non-issue for us.

## References

- Upstream repo: <https://github.com/vercel-labs/opensrc>
- Docs site: <https://opensrc.sh>
- Pinned version in our vendor tree: 0.7.1 (see `vendor/opensrc/packages/opensrc/cli/Cargo.toml`)
- Related ASK modules for comparison: `packages/cli/src/sources/`, `packages/cli/src/resolvers/`, `packages/cli/src/lockfiles/index.ts`, `packages/cli/src/spec.ts`
