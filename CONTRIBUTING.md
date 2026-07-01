# Contributing

Thanks for your interest in contributing! This guide covers how to get from a clone to a merged pull request.

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md). All documentation, code, comments, and commit messages in this repository are written in **English**.

## Getting started

This is a [bun](https://bun.sh/) workspace monorepo. It targets the Node.js version pinned in [`.nvmrc`](./.nvmrc) (Node 24) and vendors a couple of dependencies as git submodules.

```bash
git clone https://github.com/pleaseai/ask.git
cd ask
git submodule update --init --recursive   # fetch vendored submodules
bun install                               # install dependencies
```

The worktree setup in `orca.yaml` runs these same steps automatically. The project targets the Node version pinned in `.nvmrc` and uses [bun](https://bun.sh) as its package manager.

## Development workflow

1. Create a branch from `main` (e.g. `feat/short-description` or `fix/issue-123`).
2. Make focused changes — keep each pull request to one logical change.
3. Run the checks below and make sure they pass.
4. Open a pull request and fill out the template.

```bash
bun run lint                      # lint and format
bun run --cwd packages/cli test   # run the test suite
bun run build                     # ensure it builds
```

Each workspace ships its own test suite — run the ones relevant to your change: `bun run --cwd packages/cli test`, `bun run --cwd packages/schema test`, or `bun run --cwd apps/registry test`.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, where `type` is one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, etc. Breaking changes include a `BREAKING CHANGE:` footer. Versioning and the changelog are generated automatically from these messages, so accurate types matter.

## Pull requests

- Reference the issue your PR addresses (e.g. `Closes #123`).
- Use a Conventional-Commit-style PR title — it becomes the squash-merge commit.
- Make sure CI is green before requesting review.

## Reporting bugs and requesting features

Open an issue using the bug report or feature request template. For security
vulnerabilities, **do not** open a public issue — follow [SECURITY.md](./SECURITY.md).
