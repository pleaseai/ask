import { NodeHtmlMarkdown } from "node-html-markdown";
import type {
  DocSource,
  FetchResult,
  DocFile,
  SourceConfig,
  WebSourceOptions,
} from "./index.js";

export class WebSource implements DocSource {
  private nhm = new NodeHtmlMarkdown();

  async fetch(options: SourceConfig): Promise<FetchResult> {
    const opts = options as WebSourceOptions;
    const maxDepth = opts.maxDepth ?? 1;
    const visited = new Set<string>();
    const files: DocFile[] = [];

    for (const startUrl of opts.urls) {
      await this.crawl(startUrl, startUrl, maxDepth, 0, visited, files, opts);
    }

    if (files.length === 0) {
      throw new Error(
        `No documentation content found from URLs: ${opts.urls.join(", ")}`
      );
    }

    return { files, resolvedVersion: opts.version };
  }

  private async crawl(
    url: string,
    baseUrl: string,
    maxDepth: number,
    currentDepth: number,
    visited: Set<string>,
    files: DocFile[],
    opts: WebSourceOptions
  ): Promise<void> {
    const normalized = this.normalizeUrl(url);
    if (visited.has(normalized)) return;
    visited.add(normalized);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "ask-docs/0.1 (documentation downloader)",
          Accept: "text/html",
        },
      });

      if (!response.ok) {
        console.warn(`  Warning: ${url} returned ${response.status}, skipping`);
        return;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) return;

      const html = await response.text();
      const markdown = this.htmlToMarkdown(html, url);

      if (markdown.trim().length > 0) {
        const filePath = this.urlToFilePath(url, baseUrl);
        files.push({ path: filePath, content: markdown });
        console.log(`  Fetched: ${url} -> ${filePath}`);
      }

      // Crawl linked pages if depth allows
      if (currentDepth < maxDepth) {
        const links = this.extractLinks(html, url, baseUrl, opts);
        for (const link of links) {
          await this.crawl(
            link,
            baseUrl,
            maxDepth,
            currentDepth + 1,
            visited,
            files,
            opts
          );
        }
      }
    } catch (err) {
      console.warn(`  Warning: Failed to fetch ${url}: ${err}`);
    }
  }

  private htmlToMarkdown(html: string, url: string): string {
    // Extract main content area if possible
    const mainContent = this.extractMainContent(html);
    const markdown = this.nhm.translate(mainContent);

    // Add source URL as header
    return `<!-- Source: ${url} -->\n\n${markdown}`;
  }

  private extractMainContent(html: string): string {
    // Try to find main content areas, falling back to full body
    const patterns = [
      /<main[^>]*>([\s\S]*?)<\/main>/i,
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]*class="[^"]*(?:content|docs|documentation)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<body[^>]*>([\s\S]*?)<\/body>/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) return match[1];
    }

    return html;
  }

  private extractLinks(
    html: string,
    currentUrl: string,
    baseUrl: string,
    opts: WebSourceOptions
  ): string[] {
    const links: string[] = [];
    const hrefRegex = /href="([^"]+)"/g;
    const base = new URL(baseUrl);

    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
      try {
        const resolved = new URL(match[1], currentUrl);

        // Only follow same-origin links
        if (resolved.origin !== base.origin) continue;

        // Filter by path prefix if specified
        if (opts.allowedPathPrefix) {
          if (!resolved.pathname.startsWith(opts.allowedPathPrefix)) continue;
        } else {
          // Default: stay within the base URL's path
          const basePath = new URL(baseUrl).pathname;
          if (!resolved.pathname.startsWith(basePath)) continue;
        }

        // Skip non-doc links
        if (this.isSkippableUrl(resolved.pathname)) continue;

        // Remove hash and query
        resolved.hash = "";
        resolved.search = "";

        links.push(resolved.toString());
      } catch {
        // Invalid URL, skip
      }
    }

    return links;
  }

  private isSkippableUrl(pathname: string): boolean {
    const skip = [
      /\.(png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2|ttf|eot)$/i,
      /\/(api|auth|login|signup|search)\/?$/i,
    ];
    return skip.some((pattern) => pattern.test(pathname));
  }

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      u.hash = "";
      u.search = "";
      // Remove trailing slash for consistency
      u.pathname = u.pathname.replace(/\/$/, "") || "/";
      return u.toString();
    } catch {
      return url;
    }
  }

  private urlToFilePath(url: string, baseUrl: string): string {
    const u = new URL(url);
    const base = new URL(baseUrl);

    let relativePath = u.pathname.replace(base.pathname, "").replace(/^\//, "");
    if (!relativePath) relativePath = "index";

    // Clean up the path
    relativePath = relativePath.replace(/\/$/, "");
    if (!relativePath.endsWith(".md")) {
      relativePath += ".md";
    }

    return relativePath;
  }
}
