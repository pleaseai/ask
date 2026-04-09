# Changelog

## [0.3.0](https://github.com/pleaseai/ask/compare/ask-schema-v0.2.1...ask-schema-v0.3.0) (2026-04-09)


### ⚠ BREAKING CHANGES

* **registry:** all consumers of RegistryStrategy/expandStrategies must migrate to the new Package/Source types. See ADR-0001.

### Code Refactoring

* **registry:** restructure entries as Entry → Package → Source (ADR-0001) ([#43](https://github.com/pleaseai/ask/issues/43)) ([9da66eb](https://github.com/pleaseai/ask/commit/9da66eb21a0181b600c582af5cb20d4c9e5de299))

## [0.2.1](https://github.com/pleaseai/ask/compare/ask-schema-v0.2.0...ask-schema-v0.2.1) (2026-04-08)


### Features

* **cli:** npm tarball dist/docs support with monorepo disambiguation ([#35](https://github.com/pleaseai/ask/issues/35)) ([4fd822b](https://github.com/pleaseai/ask/commit/4fd822b03d4e4ed5a1fd4ada8e3bae65ca71c41a)), closes [#33](https://github.com/pleaseai/ask/issues/33)

## [0.2.0](https://github.com/pleaseai/ask/compare/ask-schema-v0.1.0...ask-schema-v0.2.0) (2026-04-08)


### ⚠ BREAKING CHANGES

* **schema:** The package has been renamed from @pleaseai/registry-schema to @pleaseai/ask-schema, and the directory has moved from packages/registry-schema to packages/schema.

### Code Refactoring

* **schema:** rename to @pleaseai/ask-schema and extract config/lock schemas ([#31](https://github.com/pleaseai/ask/issues/31)) ([941edec](https://github.com/pleaseai/ask/commit/941edec7edce75c644af63961a8ece4e558165c2))
