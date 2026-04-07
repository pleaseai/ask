import type { EcosystemResolver, ResolveResult } from './index.js'
import { consola } from 'consola'
import { parseRepoUrl } from './utils.js'

/**
 * pub.dev API response (partial — only fields we need).
 */
interface PubPackageMeta {
  latest: {
    version: string
    pubspec: {
      repository?: string
      homepage?: string
    }
  }
  versions?: Array<{ version: string }>
}

/**
 * Resolve a pub.dev package to a GitHub repo + git tag.
 *
 * 1. Fetch `https://pub.dev/api/packages/<name>`
 * 2. If version is explicit, verify it exists
 * 3. Extract `latest.pubspec.repository` → `owner/repo`
 * 4. Use the version as the git ref
 */
export class PubResolver implements EcosystemResolver {
  async resolve(name: string, version: string): Promise<ResolveResult> {
    const url = `https://pub.dev/api/packages/${name}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`pub.dev returned ${response.status} for ${name}`)
    }

    const meta = await response.json() as PubPackageMeta
    const latestVersion = meta.latest.version

    let resolvedVersion: string
    if (version === 'latest') {
      resolvedVersion = latestVersion
    }
    else {
      // Verify the requested version exists
      const allVersions = meta.versions?.map(v => v.version) ?? []
      if (allVersions.length > 0 && !allVersions.includes(version)) {
        throw new Error(
          `Version '${version}' not found for pub package '${name}'. `
          + `Latest version: ${latestVersion}`,
        )
      }
      resolvedVersion = version
    }

    // Extract repository URL
    const repoUrl = meta.latest.pubspec.repository ?? meta.latest.pubspec.homepage
    const repo = parseRepoUrl(repoUrl)
    if (!repo) {
      throw new Error(
        `Cannot resolve GitHub repository for pub package '${name}'. `
        + `The 'repository' field is missing or not a GitHub URL. `
        + `Use 'owner/repo' format instead: ask docs add owner/repo`,
      )
    }

    consola.debug(`pub: ${name}@${version} → ${repo}@${resolvedVersion}`)

    return {
      repo,
      ref: resolvedVersion,
      resolvedVersion,
    }
  }
}
