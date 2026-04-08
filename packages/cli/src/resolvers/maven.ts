import type { EcosystemResolver, ResolveResult } from './index.js'
import { consola } from 'consola'
import { parseRepoUrl } from './utils.js'

/**
 * Maven Central Search API response (partial — only fields we need).
 */
interface MavenSearchDoc {
  g: string
  a: string
  v: string
  repositoryId?: string
  ec?: string[]
}

interface MavenSearchResponse {
  response: {
    numFound: number
    docs: MavenSearchDoc[]
  }
}

interface VersionResult {
  version: string
  scmUrl?: string
}

const RE_SCM_URL = /<scm>[\s\S]*?<url>([^<]+)<\/url>/
const RE_PROJECT_URL = /<project[^>]*>[\s\S]*?<url>([^<]+)<\/url>/

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

const RE_DOT = /\./g
const RE_RELEASE = /<release>([^<]+)<\/release>/
const RE_LATEST = /<latest>([^<]+)<\/latest>/

/**
 * Build the Maven Central Repository POM URL.
 * Converts groupId dots to path separators.
 */
function buildPomUrl(groupId: string, artifactId: string, version: string): string {
  const groupPath = groupId.replace(RE_DOT, '/')
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

    // Step 1: Resolve version + optional scmUrl via Search API
    const versionResult = await this.resolveVersion(groupId, artifactId, version)
    const resolvedVersion = versionResult.version

    // Step 2: Find GitHub repo — priority: (1) Search API scmUrl, (2) POM <scm><url>, (3) POM <url>
    let repo: string | null = null

    // (1) Check Search API scmUrl first
    if (versionResult.scmUrl) {
      repo = parseRepoUrl(versionResult.scmUrl)
    }

    // (2, 3) Fall back to POM XML
    if (!repo) {
      repo = await this.findRepoFromPom(groupId, artifactId, resolvedVersion)
    }

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
   * Resolve version via Search API. Falls back to POM-based resolution
   * when the Search API is unavailable.
   *
   * For explicit versions, the version is used as-is (no Search API needed
   * for validation — the POM fetch will fail if it doesn't exist).
   */
  private async resolveVersion(groupId: string, artifactId: string, version: string): Promise<VersionResult> {
    // Explicit versions can skip Search API for version resolution
    if (version !== 'latest') {
      // Still try Search API for scmUrl, but don't fail if unavailable
      try {
        return await this.fetchSearchApi(groupId, artifactId, version)
      }
      catch {
        return { version }
      }
    }

    // For 'latest', try Search API first
    try {
      return await this.fetchSearchApi(groupId, artifactId, version)
    }
    catch {
      // Search API unavailable — try maven-metadata.xml for latest version
      consola.debug(`maven: Search API unavailable, trying maven-metadata.xml`)
      return this.resolveVersionFromMetadata(groupId, artifactId)
    }
  }

  /**
   * Fetch version and optional scmUrl from Maven Central Search API.
   */
  private async fetchSearchApi(groupId: string, artifactId: string, version: string): Promise<VersionResult> {
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

    const doc = data.response.docs[0]

    // Try to get scmUrl from artifact-level search (default core, not GAV)
    let scmUrl: string | undefined
    try {
      const extUrl = `https://search.maven.org/solrsearch/select?q=g:${encodeURIComponent(groupId)}+AND+a:${encodeURIComponent(artifactId)}&rows=1&wt=json`
      const extResponse = await fetch(extUrl)
      if (extResponse.ok) {
        const extData = await extResponse.json() as { response: { docs: Array<{ 'scm.url'?: string }> } }
        scmUrl = extData.response.docs[0]?.['scm.url']
      }
    }
    catch {
      // Non-critical — will fall back to POM
    }

    return { version: doc.v, scmUrl }
  }

  /**
   * Resolve latest version from maven-metadata.xml when Search API is unavailable.
   */
  private async resolveVersionFromMetadata(groupId: string, artifactId: string): Promise<VersionResult> {
    const groupPath = groupId.replace(RE_DOT, '/')
    const url = `https://repo1.maven.org/maven2/${groupPath}/${artifactId}/maven-metadata.xml`

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Cannot resolve Maven package '${groupId}:${artifactId}': `
        + `Search API unavailable and maven-metadata.xml returned ${response.status}`,
      )
    }

    const xml = await response.text()
    const versionMatch = RE_RELEASE.exec(xml) ?? RE_LATEST.exec(xml)

    if (!versionMatch) {
      throw new Error(
        `Cannot resolve latest version for Maven package '${groupId}:${artifactId}': `
        + `no <release> or <latest> tag in maven-metadata.xml`,
      )
    }

    return { version: versionMatch[1] }
  }

  /**
   * Find GitHub repo URL from POM XML. Priority: <scm><url> → <url>
   */
  private async findRepoFromPom(groupId: string, artifactId: string, version: string): Promise<string | null> {
    const pomUrl = buildPomUrl(groupId, artifactId, version)

    try {
      const response = await fetch(pomUrl)
      if (response.ok) {
        const pomXml = await response.text()
        return extractRepoFromPom(pomXml)
      }
    }
    catch {
      consola.debug(`maven: POM fetch failed for ${groupId}:${artifactId}@${version}`)
    }

    return null
  }
}
