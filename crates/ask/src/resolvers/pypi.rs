//! PyPI ecosystem resolver — Rust port of `resolvers/pypi.ts`.

use anyhow::{anyhow, bail};
use serde::Deserialize;

use super::{parse_repo_url, ResolveResult};
use crate::http::HttpClient;

#[derive(Deserialize)]
struct PypiPackageMeta {
    info: PypiInfo,
}

#[derive(Deserialize)]
struct PypiInfo {
    version: String,
    #[serde(default)]
    project_urls: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    home_page: Option<String>,
}

/// Keys under `project_urls` most likely to hold a source-code link, in order.
const SOURCE_URL_KEYS: &[&str] = &[
    "Source",
    "Source Code",
    "Repository",
    "GitHub",
    "Code",
    "Homepage",
];

/// Resolve a PyPI package to a GitHub repo + git ref (port of `PypiResolver`).
pub fn resolve(
    client: &dyn HttpClient,
    name: &str,
    version: &str,
) -> anyhow::Result<ResolveResult> {
    let is_explicit = version != "latest";
    let url = if is_explicit {
        format!("https://pypi.org/pypi/{name}/{version}/json")
    } else {
        format!("https://pypi.org/pypi/{name}/json")
    };

    let response = client.get(&url)?;
    if !response.ok() {
        let suffix = if is_explicit {
            format!("@{version}")
        } else {
            String::new()
        };
        bail!("PyPI returned {} for {name}{suffix}", response.status);
    }

    let meta: PypiPackageMeta = serde_json::from_str(&response.body)?;
    let resolved_version = meta.info.version;

    let project_urls = meta.info.project_urls.unwrap_or_default();
    let mut repo_url: Option<&str> = None;
    for key in SOURCE_URL_KEYS {
        if let Some(candidate) = project_urls.get(*key) {
            if candidate.contains("github.com") {
                repo_url = Some(candidate);
                break;
            }
        }
    }
    // Fall back to home_page.
    if repo_url.is_none() {
        if let Some(hp) = &meta.info.home_page {
            if hp.contains("github.com") {
                repo_url = Some(hp);
            }
        }
    }

    let repo = parse_repo_url(repo_url).ok_or_else(|| {
        anyhow!(
            "Cannot resolve GitHub repository for PyPI package '{name}'. The 'project_urls' field \
             does not contain a GitHub URL. Use 'github:owner/repo' format instead: \
             ask add github:owner/repo --ref <tag>"
        )
    })?;

    Ok(ResolveResult {
        repo,
        ref_: format!("v{resolved_version}"),
        fallback_refs: vec![resolved_version.clone()],
        resolved_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;

    #[test]
    fn resolves_from_project_urls() {
        let meta = r#"{"info":{"version":"2.5.0","project_urls":{"Source":"https://github.com/psf/requests"}}}"#;
        let c = MockClient::new().with("https://pypi.org/pypi/requests/json", 200, meta);
        let r = resolve(&c, "requests", "latest").unwrap();
        assert_eq!(r.repo, "psf/requests");
        assert_eq!(r.ref_, "v2.5.0");
        assert_eq!(r.fallback_refs, vec!["2.5.0"]);
    }

    #[test]
    fn explicit_version_uses_versioned_url_and_falls_back_to_home_page() {
        let meta = r#"{"info":{"version":"1.0.0","home_page":"https://github.com/o/r"}}"#;
        let c = MockClient::new().with("https://pypi.org/pypi/pkg/1.0.0/json", 200, meta);
        let r = resolve(&c, "pkg", "1.0.0").unwrap();
        assert_eq!(r.repo, "o/r");
    }

    #[test]
    fn no_github_url_errors() {
        let meta =
            r#"{"info":{"version":"1.0.0","project_urls":{"Docs":"https://readthedocs.io"}}}"#;
        let c = MockClient::new().with("https://pypi.org/pypi/pkg/json", 200, meta);
        assert!(resolve(&c, "pkg", "latest").is_err());
    }
}
