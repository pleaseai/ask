# Workflow — ASK

## Development Principles

1. **Test-Driven Development (TDD)**: Write failing tests first, then implement to make them pass, then refactor.
2. **High Code Coverage**: Maintain >80% code coverage. All new code must include tests.
3. **Atomic Commits**: One commit per task. Each commit must leave the project in a working state.
4. **Conventional Commits**: Follow `@commitlint/config-conventional` format.

## Standard Task Lifecycle

1. **RED** — Write a failing test that defines the expected behavior.
2. **GREEN** — Write the minimum code to make the test pass.
3. **REFACTOR** — Clean up while keeping tests green.
4. **COMMIT** — Create an atomic commit for the completed task.

## Quality Gates

- All tests must pass before commit
- Code coverage must be >80%
- ESLint must pass with no errors
- TypeScript must compile with no errors

## Phase Completion Protocol

- After each phase, pause for manual verification
- Run full test suite and lint before proceeding
- User confirms before moving to next phase

## Development Commands

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Dev mode (watch)
bun run dev

# Lint
bun run lint
bun run lint:fix

# CLI-specific
bun run --cwd packages/cli build
bun run --cwd packages/cli lint

# Registry-specific
bun run --cwd apps/registry dev
bun run --cwd apps/registry build
```
