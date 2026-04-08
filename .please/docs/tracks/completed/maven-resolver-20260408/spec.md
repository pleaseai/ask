# Maven Ecosystem Resolver

> Track: maven-resolver-20260408

## Overview

Add a Maven ecosystem resolver to the ASK CLI, enabling `maven:groupId:artifactId` spec format. The resolver maps Maven Central packages to their GitHub repositories, completing Maven ecosystem support alongside the existing registry aliases.

## Requirements

### Functional Requirements

- [ ] FR-1: Implement `MavenResolver` class implementing `EcosystemResolver` interface with `resolve(name, version)` method
- [ ] FR-2: Support `groupId:artifactId` package identifier format (colon-separated, Maven standard)
- [ ] FR-3: Primary lookup via Maven Central Search API (`https://search.maven.org/solrsearch/select?q=g:GROUP+AND+a:ARTIFACT&rows=1&wt=json`)
- [ ] FR-4: Fallback to direct POM XML download from Maven Central Repository (`https://repo1.maven.org/maven2/{group/path}/{artifact}/{version}/{artifact}-{version}.pom`) when Search API fails
- [ ] FR-5: Extract GitHub repository URL with priority: (1) Search API `scmUrl` field, (2) POM `<scm><url>` element, (3) POM `<url>` element. Use `parseRepoUrl()` utility for normalization
- [ ] FR-6: Version resolution — resolve `latest` to the most recent release version; support explicit version lookup via Search API `v:{version}` filter
- [ ] FR-7: Return `ResolveResult` with `repo`, `ref` (`v{version}` primary, `{version}` fallback), and `resolvedVersion`
- [ ] FR-8: Register `MavenResolver` in `resolvers/index.ts` — add `'maven'` to `SupportedEcosystem` union type and resolvers record
- [ ] FR-9: Verify integration with existing registry maven aliases (e.g., `maven:com.google.guava:guava` → registry lookup → resolver fallback)

### Non-functional Requirements

- [ ] NFR-1: Follow existing resolver patterns (NpmResolver, PypiResolver) for code structure and error handling
- [ ] NFR-2: Use `consola.debug()` for resolver trace logging
- [ ] NFR-3: Provide clear error messages when GitHub repo cannot be resolved from Maven metadata

## Acceptance Criteria

- [ ] AC-1: `ask docs add maven:com.google.guava:guava` resolves to `google/guava` GitHub repo with correct version tag
- [ ] AC-2: `ask docs add maven:com.google.guava:guava@33.4.0-jre` resolves to the specific version
- [ ] AC-3: When Search API is unavailable, POM XML fallback successfully resolves the package
- [ ] AC-4: `getResolver('maven')` returns a `MavenResolver` instance
- [ ] AC-5: All existing resolver tests continue to pass
- [ ] AC-6: Maven resolver has >80% test coverage

## Out of Scope

- Gradle-specific metadata or build file parsing
- Maven local repository (`~/.m2`) scanning
- Private/enterprise Maven repository support (e.g., Nexus, Artifactory)
- Multi-module Maven project resolution (only top-level artifact)

## Assumptions

- Maven Central Search API (`search.maven.org`) is publicly accessible without authentication
- Most popular Maven packages have a GitHub `scm.url` in their POM
- The `groupId:artifactId` colon format does not conflict with existing spec parsing (version separator is `@`)
