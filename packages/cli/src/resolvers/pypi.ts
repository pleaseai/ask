import type { EcosystemResolver, ResolveResult } from './index.js'
import { consola } from 'consola'
import { parseRepoUrl } from './utils.js'

/**
 * PyPI JSON API response (partial — only fields we need).
 */
interface PypiPackageMeta {
  info: {
    version: string
    project_urls?: Record<string, string> | null
    home_page?: string | null
  }
}

/** Keys under `project_urls` most likely to contain a source-code link. */
const SOURCE_URL_KEYS = [
  'Source',
  'Source Code',
  'Repository',
  'GitHub',
  'Code',
  'Homepage',
]

/**
 * Resolve a PyPI package to a GitHub repo + git tag.
 *
 * 1. Fetch `https://pypi.org/pypi/<name>/json` (or `<name>/<version>/json`)
 * 2. Extract `info.project_urls` → find a GitHub URL
 * 3. Use the PyPI version as the git ref
 */
export class PypiResolver implements EcosystemResolver {
  async resolve(name: string, version: string): Promise<ResolveResult> {
    const isExplicit = version !== 'latest'
    const url = isExplicit
      ? `https://pypi.org/pypi/${name}/${version}/json`
      : `https://pypi.org/pypi/${name}/json`

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`PyPI returned ${response.status} for ${name}${isExplicit ? `@${version}` : ''}`)
    }

    const meta = await response.json() as PypiPackageMeta
    const resolvedVersion = meta.info.version

    // Find GitHub URL from project_urls
    const projectUrls = meta.info.project_urls ?? {}
    let repoUrl: string | null = null

    for (const key of SOURCE_URL_KEYS) {
      const candidate = projectUrls[key]
      if (candidate && candidate.includes('github.com')) {
        repoUrl = candidate
        break
      }
    }

    // Fall back to home_page
    if (!repoUrl && meta.info.home_page?.includes('github.com')) {
      repoUrl = meta.info.home_page
    }

    const repo = parseRepoUrl(repoUrl)
    if (!repo) {
      throw new Error(
        `Cannot resolve GitHub repository for PyPI package '${name}'. `
        + `The 'project_urls' field does not contain a GitHub URL. `
        + `Use 'owner/repo' format instead: ask docs add owner/repo`,
      )
    }

    consola.debug(`pypi: ${name}@${version} → ${repo}@${resolvedVersion}`)

    return {
      repo,
      ref: `v${resolvedVersion}`,
      fallbackRefs: [resolvedVersion],
      resolvedVersion,
    }
  }
}
