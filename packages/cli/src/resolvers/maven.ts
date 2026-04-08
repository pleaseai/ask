import type { EcosystemResolver, ResolveResult } from './index.js'
import { consola } from 'consola'
import { parseRepoUrl } from './utils.js'

/**
 * Maven Central Search API response (partial — only fields we need).
 */
interface MavenSearchResponse {
  response: {
    numFound: number
    docs: Array<{
      g: string
      a: string
      v: string
      repositoryId?: string
    }>
  }
}

const RE_SCM_URL = /<scm>\s*[\s\S]*?<url>\s*([^<]+)\s*<\/url>/
const RE_PROJECT_URL = /<project[^>]*>[\s\S]*?<url>\s*([^<]+)\s*<\/url>/

/**
 * Parse `groupId:artifactId` from the combined name string.
 * Splits at the last colon — groupId may contain dots but never colons,
 * while artifactId never contains colons.
 */
function parseMavenCoordinate(name: string): { groupId: string, artifactId: string } {
  const lastColon = name.lastIndexOf(':')
  if (lastColon <= 0 || lastColon === name.length - 1) {
    throw new Error(
      `Invalid Maven coordinate '${name}': expected 'groupId:artifactId' format (e.g. 'com.google.guava:guava')`,
    )
  }
  return {
    groupId: name.substring(0, lastColon),
    artifactId: name.substring(lastColon + 1),
  }
}

/**
 * Build the Maven Central Repository POM URL.
 * Converts groupId dots to path separators.
 */
function buildPomUrl(groupId: string, artifactId: string, version: string): string {
  const groupPath = groupId.replace(/\./g, '/')
  return `https://repo1.maven.org/maven2/${groupPath}/${artifactId}/${version}/${artifactId}-${version}.pom`
}

/**
 * Extract a GitHub repository URL from POM XML content.
 * Priority: <scm><url> → top-level <url>
 */
function extractRepoFromPom(pomXml: string): string | null {
  // Try <scm><url> first
  const scmMatch = RE_SCM_URL.exec(pomXml)
  if (scmMatch) {
    const repo = parseRepoUrl(scmMatch[1].trim())
    if (repo)
      return repo
  }

  // Fall back to top-level <url>
  const urlMatch = RE_PROJECT_URL.exec(pomXml)
  if (urlMatch) {
    const repo = parseRepoUrl(urlMatch[1].trim())
    if (repo)
      return repo
  }

  return null
}

/**
 * Resolve a Maven Central package to a GitHub repo + git tag.
 *
 * 1. Fetch latest version from Maven Central Search API
 * 2. For explicit versions, use the version directly
 * 3. Extract GitHub repo from Search API scmUrl, or fallback to POM XML
 * 4. Return `v{version}` as the git ref with `{version}` fallback
 */
export class MavenResolver implements EcosystemResolver {
  async resolve(name: string, version: string): Promise<ResolveResult> {
    const { groupId, artifactId } = parseMavenCoordinate(name)

    // Step 1: Resolve version via Search API
    const resolvedVersion = await this.resolveVersion(groupId, artifactId, version)

    // Step 2: Try to find GitHub repo from POM XML
    const repo = await this.findRepo(groupId, artifactId, resolvedVersion)
    if (!repo) {
      throw new Error(
        `Cannot resolve GitHub repository for Maven package '${groupId}:${artifactId}'. `
        + `Neither the Search API nor the POM contains a GitHub URL. `
        + `Use 'owner/repo' format instead: ask docs add owner/repo`,
      )
    }

    consola.debug(`maven: ${groupId}:${artifactId}@${version} → ${repo}@${resolvedVersion}`)

    return {
      repo,
      ref: `v${resolvedVersion}`,
      fallbackRefs: [resolvedVersion],
      resolvedVersion,
    }
  }

  /**
   * Resolve version: 'latest' → fetch from Search API, explicit → passthrough with validation.
   */
  private async resolveVersion(groupId: string, artifactId: string, version: string): Promise<string> {
    const isLatest = version === 'latest'
    const query = isLatest
      ? `q=g:${encodeURIComponent(groupId)}+AND+a:${encodeURIComponent(artifactId)}&rows=1&wt=json`
      : `q=g:${encodeURIComponent(groupId)}+AND+a:${encodeURIComponent(artifactId)}+AND+v:${encodeURIComponent(version)}&rows=1&wt=json&core=gav`

    const url = `https://search.maven.org/solrsearch/select?${query}`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(
        `Maven Central Search API returned ${response.status} for ${groupId}:${artifactId}`,
      )
    }

    const data = await response.json() as MavenSearchResponse

    if (data.response.numFound === 0) {
      throw new Error(
        `Maven package '${groupId}:${artifactId}'${isLatest ? '' : `@${version}`} not found on Maven Central`,
      )
    }

    return data.response.docs[0].v
  }

  /**
   * Find GitHub repo URL. Try POM XML download and extract from <scm><url> or <url>.
   */
  private async findRepo(groupId: string, artifactId: string, version: string): Promise<string | null> {
    const pomUrl = buildPomUrl(groupId, artifactId, version)

    try {
      const response = await fetch(pomUrl)
      if (response.ok) {
        const pomXml = await response.text()
        const repo = extractRepoFromPom(pomXml)
        if (repo)
          return repo
      }
    }
    catch {
      consola.debug(`maven: POM fetch failed for ${groupId}:${artifactId}@${version}`)
    }

    return null
  }
}
