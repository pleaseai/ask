//! npm ecosystem resolver — Rust port of `resolvers/npm.ts`.

use anyhow::{anyhow, bail};
use serde::Deserialize;

use super::{parse_repo_url, ResolveResult};
use crate::http::HttpClient;

/// npm registry metadata (partial — only the fields we read).
#[derive(Deserialize)]
struct NpmPackageMeta {
    #[serde(default)]
    repository: Option<RepoField>,
    #[serde(rename = "dist-tags", default)]
    dist_tags: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    versions: Option<std::collections::BTreeMap<String, serde_json::Value>>,
}

/// `repository` is either a bare URL string or `{ url, directory }`.
#[derive(Deserialize)]
#[serde(untagged)]
enum RepoField {
    Str(String),
    Obj {
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        directory: Option<String>,
    },
}

impl RepoField {
    fn url(&self) -> Option<&str> {
        match self {
            RepoField::Str(s) => Some(s),
            RepoField::Obj { url, .. } => url.as_deref(),
        }
    }

    fn directory(&self) -> Option<&str> {
        match self {
            RepoField::Str(_) => None,
            RepoField::Obj { directory, .. } => directory.as_deref(),
        }
    }
}

/// Whether a version string is a semver *range* (a valid requirement that
/// actually contains a range operator), matching the TS
/// `validRange(v) && v !== v.replace(/[~^>=<|]/g, '')`.
fn is_semver_range(version: &str) -> bool {
    let has_range_char = version
        .chars()
        .any(|c| matches!(c, '~' | '^' | '>' | '=' | '<' | '|'));
    has_range_char && semver::VersionReq::parse(version).is_ok()
}

/// Highest version in `all_versions` satisfying `range`, or `None`.
fn max_satisfying(all_versions: &[String], range: &str) -> Option<String> {
    let req = semver::VersionReq::parse(range).ok()?;
    all_versions
        .iter()
        .filter_map(|v| semver::Version::parse(v).ok().map(|parsed| (parsed, v)))
        .filter(|(parsed, _)| req.matches(parsed))
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, raw)| raw.clone())
}

/// Resolve an npm package to a GitHub repo + git ref (port of `NpmResolver`).
///
/// 1. Fetch `registry.npmjs.org/<name>`.
/// 2. Resolve version: dist-tag → semver-range best match → exact passthrough.
/// 3. Extract `repository.url` → `owner/repo`.
/// 4. Return `v<version>` as the primary ref (with monorepo `<pkg>@<version>`
///    fallbacks when `repository.directory` is present).
pub fn resolve(
    client: &dyn HttpClient,
    name: &str,
    version: &str,
) -> anyhow::Result<ResolveResult> {
    let url = format!("https://registry.npmjs.org/{name}");
    let response = client.get(&url)?;
    if !response.ok() {
        bail!("npm registry returned {} for {name}", response.status);
    }
    let meta: NpmPackageMeta = serde_json::from_str(&response.body)?;

    let all_versions: Vec<String> = meta
        .versions
        .as_ref()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();

    let resolved_version = if let Some(tagged) = meta.dist_tags.get(version) {
        tagged.clone()
    } else if is_semver_range(version) {
        max_satisfying(&all_versions, version).ok_or_else(|| {
            anyhow!(
                "No version matching '{version}' found for npm package '{name}'. \
                 Available dist-tags: {}",
                dist_tag_keys(&meta),
            )
        })?
    } else {
        version.to_string()
    };

    if !all_versions.is_empty() && !all_versions.contains(&resolved_version) {
        bail!(
            "Version '{resolved_version}' not found for npm package '{name}'. \
             Available dist-tags: {}",
            dist_tag_keys(&meta),
        );
    }

    let repo_field = meta.repository.as_ref();
    let repo = parse_repo_url(repo_field.and_then(RepoField::url)).ok_or_else(|| {
        anyhow!(
            "Cannot resolve GitHub repository for npm package '{name}'. The 'repository' field is \
             missing or not a GitHub URL. Use 'github:owner/repo' format instead: \
             ask add github:owner/repo --ref <tag>"
        )
    })?;

    // Monorepo packages (repository.directory present) use changesets-style
    // `<pkgName>@<version>` / `@v<version>` tags; scoped names use the unscoped
    // part (`@vercel/ai` → `ai`).
    let mut fallback_refs = Vec::new();
    if repo_field.and_then(RepoField::directory).is_some() {
        let unscoped = if let Some(rest) = name.strip_prefix('@') {
            rest.split_once('/').map(|(_, n)| n).unwrap_or(rest)
        } else {
            name
        };
        fallback_refs.push(format!("{unscoped}@{resolved_version}"));
        fallback_refs.push(format!("{unscoped}@v{resolved_version}"));
    }
    fallback_refs.push(resolved_version.clone());

    Ok(ResolveResult {
        repo,
        ref_: format!("v{resolved_version}"),
        fallback_refs,
        resolved_version,
    })
}

fn dist_tag_keys(meta: &NpmPackageMeta) -> String {
    meta.dist_tags
        .keys()
        .cloned()
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;

    const URL: &str = "https://registry.npmjs.org/next";

    fn meta_json() -> &'static str {
        r#"{
            "dist-tags": { "latest": "15.0.3", "canary": "15.1.0-canary.1" },
            "versions": { "14.2.3": {}, "15.0.0": {}, "15.0.3": {}, "15.1.0-canary.1": {} },
            "repository": { "type": "git", "url": "git+https://github.com/vercel/next.js.git" }
        }"#
    }

    #[test]
    fn resolves_dist_tag() {
        let c = MockClient::new().with(URL, 200, meta_json());
        let r = resolve(&c, "next", "latest").unwrap();
        assert_eq!(r.repo, "vercel/next.js");
        assert_eq!(r.resolved_version, "15.0.3");
        assert_eq!(r.ref_, "v15.0.3");
        assert_eq!(r.fallback_refs, vec!["15.0.3"]);
    }

    #[test]
    fn resolves_semver_range_to_best_match() {
        let c = MockClient::new().with(URL, 200, meta_json());
        let r = resolve(&c, "next", "^15.0.0").unwrap();
        // ^15.0.0 excludes the 14.x and the prerelease → 15.0.3.
        assert_eq!(r.resolved_version, "15.0.3");
    }

    #[test]
    fn exact_version_passthrough() {
        let c = MockClient::new().with(URL, 200, meta_json());
        let r = resolve(&c, "next", "14.2.3").unwrap();
        assert_eq!(r.resolved_version, "14.2.3");
        assert_eq!(r.ref_, "v14.2.3");
    }

    #[test]
    fn monorepo_directory_adds_scoped_fallbacks() {
        let meta = r#"{
            "dist-tags": { "latest": "5.0.0" },
            "versions": { "5.0.0": {} },
            "repository": { "url": "https://github.com/vercel/ai.git", "directory": "packages/ai" }
        }"#;
        let c = MockClient::new().with("https://registry.npmjs.org/@vercel/ai", 200, meta);
        let r = resolve(&c, "@vercel/ai", "latest").unwrap();
        assert_eq!(r.repo, "vercel/ai");
        assert_eq!(r.fallback_refs, vec!["ai@5.0.0", "ai@v5.0.0", "5.0.0"]);
    }

    #[test]
    fn repository_as_bare_string() {
        let meta = r#"{
            "dist-tags": { "latest": "1.0.0" },
            "versions": { "1.0.0": {} },
            "repository": "https://github.com/owner/repo"
        }"#;
        let c = MockClient::new().with("https://registry.npmjs.org/pkg", 200, meta);
        assert_eq!(resolve(&c, "pkg", "latest").unwrap().repo, "owner/repo");
    }

    #[test]
    fn non_github_repository_errors() {
        let meta = r#"{"dist-tags":{"latest":"1.0.0"},"versions":{"1.0.0":{}},"repository":"https://gitlab.com/o/r"}"#;
        let c = MockClient::new().with("https://registry.npmjs.org/pkg", 200, meta);
        assert!(resolve(&c, "pkg", "latest").is_err());
    }

    #[test]
    fn http_error_propagates() {
        let c = MockClient::new().with(URL, 404, "");
        assert!(resolve(&c, "next", "latest").is_err());
    }
}
