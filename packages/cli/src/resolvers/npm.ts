import type { EcosystemResolver, ResolveResult } from './index.js'
import { consola } from 'consola'
import { parseRepoUrl } from './utils.js'

/**
 * npm registry API response (partial — only fields we need).
 */
interface NpmPackageMeta {
  'repository'?: { type?: string, url?: string } | string
  'dist-tags'?: Record<string, string>
  'versions'?: Record<string, unknown>
}

/**
 * Resolve an npm package to a GitHub repo + git tag.
 *
 * 1. Fetch `https://registry.npmjs.org/<name>`
 * 2. If `version` is a dist-tag (e.g. `latest`, `canary`), resolve to semver
 * 3. Extract `repository.url` → `owner/repo`
 * 4. Try `v{version}` then `{version}` as the git ref
 */
export class NpmResolver implements EcosystemResolver {
  async resolve(name: string, version: string): Promise<ResolveResult> {
    const url = `https://registry.npmjs.org/${name}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`npm registry returned ${response.status} for ${name}`)
    }

    const meta = await response.json() as NpmPackageMeta

    // Resolve dist-tag → semver
    const distTags = meta['dist-tags'] ?? {}
    const resolvedVersion = distTags[version] ?? version

    // Verify the resolved version exists
    if (meta.versions && !(resolvedVersion in meta.versions)) {
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
        + `Use 'owner/repo' format instead: ask docs add owner/repo`,
      )
    }

    consola.debug(`npm: ${name}@${version} → ${repo}@${resolvedVersion}`)

    return {
      repo,
      ref: `v${resolvedVersion}`,
      resolvedVersion,
    }
  }
}
