# Changelog

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
