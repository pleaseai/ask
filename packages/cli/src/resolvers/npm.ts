import type { EcosystemResolver, ResolveResult } from './index.js'
import { consola } from 'consola'
import { maxSatisfying, validRange } from 'semver'
import { parseRepoUrl } from './utils.js'

const RE_SEMVER_RANGE_CHARS = /[~^>=<|]/g

/**
 * npm registry API response (partial — only fields we need).
 */
interface NpmPackageMeta {
  'repository'?: { type?: string, url?: string, directory?: string } | string
  'dist-tags'?: Record<string, string>
  'versions'?: Record<string, unknown>
}

/**
 * Resolve an npm package to a GitHub repo + git tag.
 *
 * 1. Fetch `https://registry.npmjs.org/<name>`
 * 2. Resolve version: dist-tag → exact, semver range → best match, exact → passthrough
 * 3. Extract `repository.url` → `owner/repo`
 * 4. Return `v{version}` as the git ref
 */
export class NpmResolver implements EcosystemResolver {
  async resolve(name: string, version: string): Promise<ResolveResult> {
    const url = `https://registry.npmjs.org/${name}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`npm registry returned ${response.status} for ${name}`)
    }

    const meta = await response.json() as NpmPackageMeta

    const distTags = meta['dist-tags'] ?? {}
    const allVersions = meta.versions ? Object.keys(meta.versions) : []

    // Resolve version: dist-tag → semver range → exact
    let resolvedVersion: string
    if (distTags[version]) {
      // dist-tag (e.g. 'latest', 'canary')
      resolvedVersion = distTags[version]
    }
    else if (validRange(version) && version !== version.replace(RE_SEMVER_RANGE_CHARS, '')) {
      // Semver range (e.g. '^15', '~3.22', '>=18.0.0')
      const best = maxSatisfying(allVersions, version)
      if (!best) {
        throw new Error(
          `No version matching '${version}' found for npm package '${name}'. `
          + `Available dist-tags: ${Object.keys(distTags).join(', ')}`,
        )
      }
      resolvedVersion = best
    }
    else {
      // Exact version string
      resolvedVersion = version
    }

    // Verify the resolved version exists
    if (allVersions.length > 0 && !allVersions.includes(resolvedVersion)) {
      throw new Error(
        `Version '${resolvedVersion}' not found for npm package '${name}'. `
        + `Available dist-tags: ${Object.keys(distTags).join(', ')}`,
      )
    }

    // Extract repository URL
    const repoField = meta.repository
    const repoUrl = typeof repoField === 'string'
      ? repoField
      : repoField?.url

    const repo = parseRepoUrl(repoUrl)
    if (!repo) {
      throw new Error(
        `Cannot resolve GitHub repository for npm package '${name}'. `
        + `The 'repository' field is missing or not a GitHub URL. `
        + `Use 'github:owner/repo' format instead: ask add github:owner/repo --ref <tag>`,
      )
    }

    consola.debug(`npm: ${name}@${version} → ${repo}@${resolvedVersion}`)

    // For monorepo packages (those with repository.directory), prepend pkg-name@version tags.
    // Changesets convention uses `<pkgName>@<version>` and `<pkgName>@v<version>`.
    // Scoped packages like `@vercel/ai` use only the unscoped part (e.g. `ai`).
    const monorepoFallbacks: string[] = []
    if (typeof repoField === 'object' && repoField?.directory) {
      const unscopedName = name.startsWith('@') ? name.split('/')[1] : name
      monorepoFallbacks.push(`${unscopedName}@${resolvedVersion}`, `${unscopedName}@v${resolvedVersion}`)
    }

    return {
      repo,
      ref: `v${resolvedVersion}`,
      fallbackRefs: [...monorepoFallbacks, resolvedVersion],
      resolvedVersion,
    }
  }
}
