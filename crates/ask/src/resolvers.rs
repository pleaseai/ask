//! Ecosystem resolvers — turn package metadata into a GitHub `owner/repo`.
//! Rust port of `packages/cli/src/resolvers/`.
//!
//! **Port status:** the shared [`parse_repo_url`] helper (resolvers/utils.ts) is
//! ported. The per-ecosystem resolvers (npm/pypi/pub/maven) fetch registry
//! metadata over HTTP and are deferred to the phase that introduces the HTTP
//! client (ureq), alongside the registry HTTP surface.

use std::sync::LazyLock;

use regex::Regex;

// `github.com` followed by `/` or `:`, then owner (no `/`), `/`, then repo up to
// the first `/`, `#`, `?`, or whitespace. Mirrors the TS `RE_GITHUB_URL`.
static RE_GITHUB_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"github\.com[/:]([^/]+)/([^/#?\s]+)").unwrap());

/// Parse a repository URL into `owner/repo` form (port of `parseRepoUrl`).
///
/// Handles `git+https://…`, `https://…`, `git://…`, `ssh://git@…`,
/// `github.com/owner/repo`, and URLs with extra path segments. A trailing
/// `.git` on the repo is stripped. Returns `None` for non-GitHub or empty input.
pub fn parse_repo_url(url: Option<&str>) -> Option<String> {
    let url = url?;
    if url.is_empty() {
        return None;
    }
    let caps = RE_GITHUB_URL.captures(url)?;
    let owner = caps.get(1)?.as_str();
    let repo = caps.get(2)?.as_str();
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    Some(format!("{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_github_url_forms() {
        let cases = [
            "git+https://github.com/owner/repo.git",
            "https://github.com/owner/repo",
            "git://github.com/owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
            "github.com/owner/repo",
            "https://github.com/owner/repo/tree/main",
        ];
        for url in cases {
            assert_eq!(
                parse_repo_url(Some(url)).as_deref(),
                Some("owner/repo"),
                "url: {url}"
            );
        }
    }

    #[test]
    fn strips_only_trailing_dot_git() {
        // `.git` mid-repo (unusual) is not stripped; only the trailing suffix.
        assert_eq!(
            parse_repo_url(Some("https://github.com/owner/repo.github.io")).as_deref(),
            Some("owner/repo.github.io")
        );
    }

    #[test]
    fn rejects_non_github_and_empty() {
        assert_eq!(parse_repo_url(Some("https://gitlab.com/owner/repo")), None);
        assert_eq!(parse_repo_url(Some("")), None);
        assert_eq!(parse_repo_url(None), None);
        assert_eq!(parse_repo_url(Some("not a url")), None);
    }
}
