const RE_GITHUB_URL = /github\.com[/:]([^/]+)\/([^/#?\s]+)/
const RE_DOT_GIT = /\.git$/

/**
 * Parse a repository URL into `owner/repo` form.
 *
 * Handles common formats:
 *   - `git+https://github.com/owner/repo.git`
 *   - `https://github.com/owner/repo`
 *   - `git://github.com/owner/repo.git`
 *   - `ssh://git@github.com/owner/repo.git`
 *   - `github.com/owner/repo`
 *   - URLs with extra path segments (`/tree/main`, etc.)
 *
 * Returns `null` for non-GitHub URLs, empty strings, or undefined.
 */
export function parseRepoUrl(url: string | undefined | null): string | null {
  if (!url)
    return null

  const match = RE_GITHUB_URL.exec(url)
  if (!match)
    return null

  const owner = match[1]
  const repo = match[2].replace(RE_DOT_GIT, '')
  return `${owner}/${repo}`
}
