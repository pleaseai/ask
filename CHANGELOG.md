# Changelog

## [0.4.0](https://github.com/pleaseai/ask/compare/ask-plugin-v0.3.4...ask-plugin-v0.4.0) (2026-04-12)


### ⚠ BREAKING CHANGES

* **registry:** all consumers of RegistryStrategy/expandStrategies must migrate to the new Package/Source types. See ADR-0001.
* **schema:** The package has been renamed from @pleaseai/registry-schema to @pleaseai/ask-schema, and the directory has moved from packages/registry-schema to packages/schema.

### Features

* add ask-registry skill and nuxt registry entry ([fd0ec57](https://github.com/pleaseai/ask/commit/fd0ec575f9fe9d1be44ae24a79a2943932b061d3))
* add llms-txt source adapter and related projects ([a4f8a2e](https://github.com/pleaseai/ask/commit/a4f8a2ed06f67279b0165a921e4cfe059a73596a))
* add registry auto-detection and update docs ([14fac43](https://github.com/pleaseai/ask/commit/14fac43f6cafdd5fd29a9c4663d3f52af9873334))
* ASK (Agent Skills Kit) - library docs downloader for AI agents ([65ed307](https://github.com/pleaseai/ask/commit/65ed30761e1caada7dbe880b02baa931d0d38bc1))
* **cli:** add ecosystem resolvers for npm, pypi, pub ([#13](https://github.com/pleaseai/ask/issues/13)) ([0739451](https://github.com/pleaseai/ask/commit/073945178cda9f0a87cd6ea472b7f6779d53795d))
* **cli:** add manifest gate and reject bare-name specs ([#25](https://github.com/pleaseai/ask/issues/25)) ([816352b](https://github.com/pleaseai/ask/commit/816352b5ed1cb1cd19236dda3ae0e62ecbffeb77)), closes [#23](https://github.com/pleaseai/ask/issues/23)
* **cli:** add Maven ecosystem resolver ([#17](https://github.com/pleaseai/ask/issues/17)) ([95ea4b8](https://github.com/pleaseai/ask/commit/95ea4b82e057191b13ecea364d1ea7c029aaaa90))
* **cli:** add version hints to AGENTS.md and SKILL.md output ([47a7282](https://github.com/pleaseai/ask/commit/47a72827bd229821385dc13f6d1e05831854eb93))
* **cli:** auto-manage ignore files for vendored .ask/docs ([#26](https://github.com/pleaseai/ask/issues/26)) ([abc2230](https://github.com/pleaseai/ask/commit/abc223011926001521e6ed3ee098a053ed9074f7))
* **cli:** convention-based docs discovery pipeline ([#48](https://github.com/pleaseai/ask/issues/48)) ([d9f8529](https://github.com/pleaseai/ask/commit/d9f85296405aa421cbe4cff9fe32835d595d7aaa))
* **cli:** global ASK docs store at ~/.ask/ ([#60](https://github.com/pleaseai/ask/issues/60)) ([51c77c8](https://github.com/pleaseai/ask/commit/51c77c87cf75fbf393e10630d4c330eb7b9935cb))
* **cli:** in-place npm docs — reference node_modules directly ([#59](https://github.com/pleaseai/ask/issues/59)) ([d05025f](https://github.com/pleaseai/ask/commit/d05025f89fb6a211b0055e3ebbc7b0be055cc4a4))
* **cli:** lazy ask src and ask docs commands ([#63](https://github.com/pleaseai/ask/issues/63)) ([cbd8e30](https://github.com/pleaseai/ask/commit/cbd8e30a6b80750d8871076b068c768b0e0cd414))
* **cli:** migrate ASK workspace to .ask/ + introduce ask.lock + Zod-validated I/O ([#3](https://github.com/pleaseai/ask/issues/3)) ([a9907fa](https://github.com/pleaseai/ask/commit/a9907fa5f2f9efdd0ec402e77cce235250bd61a8))
* **cli:** npm tarball dist/docs support with monorepo disambiguation ([#35](https://github.com/pleaseai/ask/issues/35)) ([4fd822b](https://github.com/pleaseai/ask/commit/4fd822b03d4e4ed5a1fd4ada8e3bae65ca71c41a)), closes [#33](https://github.com/pleaseai/ask/issues/33)
* **cli:** owner/repo shorthand for `ask docs add` ([#10](https://github.com/pleaseai/ask/issues/10)) ([c0f0e80](https://github.com/pleaseai/ask/commit/c0f0e805d3a86b5533e5d01c7a6014e5e46339ee))
* **cli:** PM-driven install flow with ask.json ([#52](https://github.com/pleaseai/ask/issues/52)) ([e360cba](https://github.com/pleaseai/ask/commit/e360cbac1e35d3581252ef5ff0fa9ca1b05885af))
* **cli:** PM-unified github store layout with shallow clones ([#67](https://github.com/pleaseai/ask/issues/67)) ([88cdcdf](https://github.com/pleaseai/ask/commit/88cdcdff315faa45401d72dede07835516ae97ab))
* **cli:** prioritize github source over llms-txt in registry resolution ([8317297](https://github.com/pleaseai/ask/commit/8317297f5ba9de2c625eaa549d43fe53aefe249f))
* **cli:** rich ask list command with --json output ([#50](https://github.com/pleaseai/ask/issues/50)) ([feb2ba3](https://github.com/pleaseai/ask/commit/feb2ba3efafa2b48ba01a192ea63b5aa657506d8))
* **registry:** add maven ecosystem support ([a4b6bc5](https://github.com/pleaseai/ask/commit/a4b6bc51c438a5de773ec39e96ae9a3a1d536c5e))
* **registry:** add nuxt-ui entry and llms-txt source support ([212d294](https://github.com/pleaseai/ask/commit/212d29451207b50df3d092868bf7fb41ec9652f4))
* **registry:** edge cache /api/registry/** via Nitro routeRules ([#36](https://github.com/pleaseai/ask/issues/36)) ([1c9b7db](https://github.com/pleaseai/ask/commit/1c9b7dba637eef003c71792915752164655a345e)), closes [#34](https://github.com/pleaseai/ask/issues/34)
* **registry:** enrich schema with repo, homepage, license metadata ([#12](https://github.com/pleaseai/ask/issues/12)) ([5000570](https://github.com/pleaseai/ask/commit/5000570ba2e58c3231d374dba8b3900d166173b0))
* **setup-docs:** default to runtime deps with deny-list filter ([63197dc](https://github.com/pleaseai/ask/commit/63197dcc2e599b363520bae0e92e4e93697365cd))
* **skills:** add ask plugin skills for docs management ([dc1d694](https://github.com/pleaseai/ask/commit/dc1d6942f9bd77506f881fc0e547b7023674e498))


### Bug Fixes

* **ci:** correct setup-node v4.4.0 SHA in release workflow ([88997af](https://github.com/pleaseai/ask/commit/88997afba98c5110ce1b2206f970488be7397dcf))
* **ci:** pin release-please-action to v4.4.0 with valid SHA ([#20](https://github.com/pleaseai/ask/issues/20)) ([2a885bb](https://github.com/pleaseai/ask/commit/2a885bb1824d5c63be3caaef6570ff024ac18bcf))
* **ci:** skip already-published versions in npm publish steps ([b039b29](https://github.com/pleaseai/ask/commit/b039b2928cac4bad10d89b17ba5bf0ec275f4633))
* **ci:** sync lockfile workspace versions before npm publish ([7330564](https://github.com/pleaseai/ask/commit/7330564796cba7173842b636fca9d8a33e7c0d3d))
* **ci:** use default bun pm pack filename for npm publish ([8fc5581](https://github.com/pleaseai/ask/commit/8fc558123118df744ab620ad1e08c417ea2c420c))
* **cli:** split bin entry into cli.ts so bunx/npx invocations run ([9f0ec29](https://github.com/pleaseai/ask/commit/9f0ec29245d141452fe7f035149d686421577234))
* **cli:** stop downloading full GitHub monorepo for scoped npm specs ([#39](https://github.com/pleaseai/ask/issues/39)) ([0dc5ce2](https://github.com/pleaseai/ask/commit/0dc5ce2fdfb1ea222a09e76f5ab857186b2f6ff0))
* **cli:** use workspace:^ for ask-schema dependency ([fb50399](https://github.com/pleaseai/ask/commit/fb5039939ae7c8320f29a213c113fb0a9264c0b6))
* configure D1 database and fix better-sqlite3 native build ([4c69bf5](https://github.com/pleaseai/ask/commit/4c69bf5e3b9dc87dd7d09af94cbc5c8d54f46a41))
* correct model flag and vitest file pattern in eval runner ([5ee5479](https://github.com/pleaseai/ask/commit/5ee5479b4d950df13f784b4d12de4715fa1e2924))
* registry app improvements ([d7751e9](https://github.com/pleaseai/ask/commit/d7751e94237dd3b7b66ff968b9cc165997a6cab0))
* **registry:** unblock lookup API by purging h3 v2 and hardening config ([65e2376](https://github.com/pleaseai/ask/commit/65e2376c6d5673a148c6c8146742c7e48966a139))


### Performance Improvements

* **cli:** parallelize github/npm/llms-txt fetches in sync command ([#8](https://github.com/pleaseai/ask/issues/8)) ([c4beeb0](https://github.com/pleaseai/ask/commit/c4beeb0c289ad9161ffc547c062ce1bf2b928ad5))


### Code Refactoring

* **registry:** restructure entries as Entry → Package → Source (ADR-0001) ([#43](https://github.com/pleaseai/ask/issues/43)) ([9da66eb](https://github.com/pleaseai/ask/commit/9da66eb21a0181b600c582af5cb20d4c9e5de299))
* **schema:** rename to @pleaseai/ask-schema and extract config/lock schemas ([#31](https://github.com/pleaseai/ask/issues/31)) ([941edec](https://github.com/pleaseai/ask/commit/941edec7edce75c644af63961a8ece4e558165c2))

## [0.3.4](https://github.com/pleaseai/ask/compare/ask-plugin-v0.3.3...ask-plugin-v0.3.4) (2026-04-12)


### Bug Fixes

* **cli:** use workspace:^ for ask-schema dependency ([fb50399](https://github.com/pleaseai/ask/commit/fb5039939ae7c8320f29a213c113fb0a9264c0b6))

## [0.3.3](https://github.com/pleaseai/ask/compare/ask-plugin-v0.3.2...ask-plugin-v0.3.3) (2026-04-12)


### Bug Fixes

* **ci:** sync lockfile workspace versions before npm publish ([7330564](https://github.com/pleaseai/ask/commit/7330564796cba7173842b636fca9d8a33e7c0d3d))

## [0.3.2](https://github.com/pleaseai/ask/compare/ask-plugin-v0.3.1...ask-plugin-v0.3.2) (2026-04-12)


### Features

* **cli:** convention-based docs discovery pipeline ([#48](https://github.com/pleaseai/ask/issues/48)) ([d9f8529](https://github.com/pleaseai/ask/commit/d9f85296405aa421cbe4cff9fe32835d595d7aaa))
* **cli:** global ASK docs store at ~/.ask/ ([#60](https://github.com/pleaseai/ask/issues/60)) ([51c77c8](https://github.com/pleaseai/ask/commit/51c77c87cf75fbf393e10630d4c330eb7b9935cb))
* **cli:** in-place npm docs — reference node_modules directly ([#59](https://github.com/pleaseai/ask/issues/59)) ([d05025f](https://github.com/pleaseai/ask/commit/d05025f89fb6a211b0055e3ebbc7b0be055cc4a4))
* **cli:** lazy ask src and ask docs commands ([#63](https://github.com/pleaseai/ask/issues/63)) ([cbd8e30](https://github.com/pleaseai/ask/commit/cbd8e30a6b80750d8871076b068c768b0e0cd414))
* **cli:** PM-driven install flow with ask.json ([#52](https://github.com/pleaseai/ask/issues/52)) ([e360cba](https://github.com/pleaseai/ask/commit/e360cbac1e35d3581252ef5ff0fa9ca1b05885af))
* **cli:** PM-unified github store layout with shallow clones ([#67](https://github.com/pleaseai/ask/issues/67)) ([88cdcdf](https://github.com/pleaseai/ask/commit/88cdcdff315faa45401d72dede07835516ae97ab))
* **cli:** rich ask list command with --json output ([#50](https://github.com/pleaseai/ask/issues/50)) ([feb2ba3](https://github.com/pleaseai/ask/commit/feb2ba3efafa2b48ba01a192ea63b5aa657506d8))

## [0.3.1](https://github.com/pleaseai/ask/compare/ask-plugin-v0.3.0...ask-plugin-v0.3.1) (2026-04-09)


### Bug Fixes

* **registry:** unblock lookup API by purging h3 v2 and hardening config ([65e2376](https://github.com/pleaseai/ask/commit/65e2376c6d5673a148c6c8146742c7e48966a139))

## [0.3.0](https://github.com/pleaseai/ask/compare/ask-plugin-v0.2.3...ask-plugin-v0.3.0) (2026-04-09)


### ⚠ BREAKING CHANGES

* **registry:** all consumers of RegistryStrategy/expandStrategies must migrate to the new Package/Source types. See ADR-0001.

### Bug Fixes

* **cli:** split bin entry into cli.ts so bunx/npx invocations run ([9f0ec29](https://github.com/pleaseai/ask/commit/9f0ec29245d141452fe7f035149d686421577234))


### Code Refactoring

* **registry:** restructure entries as Entry → Package → Source (ADR-0001) ([#43](https://github.com/pleaseai/ask/issues/43)) ([9da66eb](https://github.com/pleaseai/ask/commit/9da66eb21a0181b600c582af5cb20d4c9e5de299))

## [0.2.3](https://github.com/pleaseai/ask/compare/ask-plugin-v0.2.2...ask-plugin-v0.2.3) (2026-04-09)


### Features

* **setup-docs:** default to runtime deps with deny-list filter ([63197dc](https://github.com/pleaseai/ask/commit/63197dcc2e599b363520bae0e92e4e93697365cd))


### Bug Fixes

* **cli:** stop downloading full GitHub monorepo for scoped npm specs ([#39](https://github.com/pleaseai/ask/issues/39)) ([0dc5ce2](https://github.com/pleaseai/ask/commit/0dc5ce2fdfb1ea222a09e76f5ab857186b2f6ff0))

## [0.2.2](https://github.com/pleaseai/ask/compare/ask-plugin-v0.2.1...ask-plugin-v0.2.2) (2026-04-08)


### Features

* **registry:** edge cache /api/registry/** via Nitro routeRules ([#36](https://github.com/pleaseai/ask/issues/36)) ([1c9b7db](https://github.com/pleaseai/ask/commit/1c9b7dba637eef003c71792915752164655a345e)), closes [#34](https://github.com/pleaseai/ask/issues/34)

## [0.2.1](https://github.com/pleaseai/ask/compare/ask-plugin-v0.2.0...ask-plugin-v0.2.1) (2026-04-08)


### Features

* **cli:** npm tarball dist/docs support with monorepo disambiguation ([#35](https://github.com/pleaseai/ask/issues/35)) ([4fd822b](https://github.com/pleaseai/ask/commit/4fd822b03d4e4ed5a1fd4ada8e3bae65ca71c41a)), closes [#33](https://github.com/pleaseai/ask/issues/33)

## [0.2.0](https://github.com/pleaseai/ask/compare/ask-plugin-v0.1.5...ask-plugin-v0.2.0) (2026-04-08)


### ⚠ BREAKING CHANGES

* **schema:** The package has been renamed from @pleaseai/registry-schema to @pleaseai/ask-schema, and the directory has moved from packages/registry-schema to packages/schema.

### Code Refactoring

* **schema:** rename to @pleaseai/ask-schema and extract config/lock schemas ([#31](https://github.com/pleaseai/ask/issues/31)) ([941edec](https://github.com/pleaseai/ask/commit/941edec7edce75c644af63961a8ece4e558165c2))

## [0.1.5](https://github.com/pleaseai/ask/compare/ask-plugin-v0.1.4...ask-plugin-v0.1.5) (2026-04-08)


### Bug Fixes

* **ci:** use default bun pm pack filename for npm publish ([8fc5581](https://github.com/pleaseai/ask/commit/8fc558123118df744ab620ad1e08c417ea2c420c))

## [0.1.4](https://github.com/pleaseai/ask/compare/ask-plugin-v0.1.3...ask-plugin-v0.1.4) (2026-04-08)


### Features

* **cli:** auto-manage ignore files for vendored .ask/docs ([#26](https://github.com/pleaseai/ask/issues/26)) ([abc2230](https://github.com/pleaseai/ask/commit/abc223011926001521e6ed3ee098a053ed9074f7))

## [0.1.3](https://github.com/pleaseai/ask/compare/ask-plugin-v0.1.2...ask-plugin-v0.1.3) (2026-04-08)


### Features

* **cli:** add manifest gate and reject bare-name specs ([#25](https://github.com/pleaseai/ask/issues/25)) ([816352b](https://github.com/pleaseai/ask/commit/816352b5ed1cb1cd19236dda3ae0e62ecbffeb77)), closes [#23](https://github.com/pleaseai/ask/issues/23)

## [0.1.2](https://github.com/pleaseai/ask/compare/ask-plugin-v0.1.1...ask-plugin-v0.1.2) (2026-04-08)


### Features

* add ask-registry skill and nuxt registry entry ([fd0ec57](https://github.com/pleaseai/ask/commit/fd0ec575f9fe9d1be44ae24a79a2943932b061d3))
* add llms-txt source adapter and related projects ([a4f8a2e](https://github.com/pleaseai/ask/commit/a4f8a2ed06f67279b0165a921e4cfe059a73596a))
* add registry auto-detection and update docs ([14fac43](https://github.com/pleaseai/ask/commit/14fac43f6cafdd5fd29a9c4663d3f52af9873334))
* ASK (Agent Skills Kit) - library docs downloader for AI agents ([65ed307](https://github.com/pleaseai/ask/commit/65ed30761e1caada7dbe880b02baa931d0d38bc1))
* **cli:** add ecosystem resolvers for npm, pypi, pub ([#13](https://github.com/pleaseai/ask/issues/13)) ([0739451](https://github.com/pleaseai/ask/commit/073945178cda9f0a87cd6ea472b7f6779d53795d))
* **cli:** add Maven ecosystem resolver ([#17](https://github.com/pleaseai/ask/issues/17)) ([95ea4b8](https://github.com/pleaseai/ask/commit/95ea4b82e057191b13ecea364d1ea7c029aaaa90))
* **cli:** add version hints to AGENTS.md and SKILL.md output ([47a7282](https://github.com/pleaseai/ask/commit/47a72827bd229821385dc13f6d1e05831854eb93))
* **cli:** migrate ASK workspace to .ask/ + introduce ask.lock + Zod-validated I/O ([#3](https://github.com/pleaseai/ask/issues/3)) ([a9907fa](https://github.com/pleaseai/ask/commit/a9907fa5f2f9efdd0ec402e77cce235250bd61a8))
* **cli:** owner/repo shorthand for `ask docs add` ([#10](https://github.com/pleaseai/ask/issues/10)) ([c0f0e80](https://github.com/pleaseai/ask/commit/c0f0e805d3a86b5533e5d01c7a6014e5e46339ee))
* **cli:** prioritize github source over llms-txt in registry resolution ([8317297](https://github.com/pleaseai/ask/commit/8317297f5ba9de2c625eaa549d43fe53aefe249f))
* **registry:** add maven ecosystem support ([a4b6bc5](https://github.com/pleaseai/ask/commit/a4b6bc51c438a5de773ec39e96ae9a3a1d536c5e))
* **registry:** add nuxt-ui entry and llms-txt source support ([212d294](https://github.com/pleaseai/ask/commit/212d29451207b50df3d092868bf7fb41ec9652f4))
* **registry:** enrich schema with repo, homepage, license metadata ([#12](https://github.com/pleaseai/ask/issues/12)) ([5000570](https://github.com/pleaseai/ask/commit/5000570ba2e58c3231d374dba8b3900d166173b0))
* **skills:** add ask plugin skills for docs management ([dc1d694](https://github.com/pleaseai/ask/commit/dc1d6942f9bd77506f881fc0e547b7023674e498))


### Bug Fixes

* **ci:** correct setup-node v4.4.0 SHA in release workflow ([88997af](https://github.com/pleaseai/ask/commit/88997afba98c5110ce1b2206f970488be7397dcf))
* **ci:** pin release-please-action to v4.4.0 with valid SHA ([#20](https://github.com/pleaseai/ask/issues/20)) ([2a885bb](https://github.com/pleaseai/ask/commit/2a885bb1824d5c63be3caaef6570ff024ac18bcf))
* configure D1 database and fix better-sqlite3 native build ([4c69bf5](https://github.com/pleaseai/ask/commit/4c69bf5e3b9dc87dd7d09af94cbc5c8d54f46a41))
* correct model flag and vitest file pattern in eval runner ([5ee5479](https://github.com/pleaseai/ask/commit/5ee5479b4d950df13f784b4d12de4715fa1e2924))
* registry app improvements ([d7751e9](https://github.com/pleaseai/ask/commit/d7751e94237dd3b7b66ff968b9cc165997a6cab0))


### Performance Improvements

* **cli:** parallelize github/npm/llms-txt fetches in sync command ([#8](https://github.com/pleaseai/ask/issues/8)) ([c4beeb0](https://github.com/pleaseai/ask/commit/c4beeb0c289ad9161ffc547c062ce1bf2b928ad5))
