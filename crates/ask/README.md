# ask (`ask-please`)

Rust port of [`@pleaseai/ask`](https://github.com/pleaseai/ask) — the Agent
Skills Kit CLI. It downloads version-specific library documentation and
generates `AGENTS.md` + Claude Code skills so AI agents reference accurate docs
instead of relying on training data.

The crate is published to crates.io as **`ask-please`** (the short name `ask` is
taken); it installs an **`ask`** binary:

```bash
cargo install ask-please
ask --help
```

The same binary is also distributed via npm (`@pleaseai/ask`, a copy-over shim
wrapper) and Homebrew (`pleaseai/homebrew-tap`).

> **Status:** in-progress port. The command surface is stable; per-command logic
> is being ported from the TypeScript implementation module by module. See
> `.please/docs/tracks/active/rust-port-20260704/` in the repo.
