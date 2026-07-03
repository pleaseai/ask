//! pub.dev ecosystem resolver — Rust port of `resolvers/pub.ts`.
//! (Module named `pub_dev` because `pub` is a Rust keyword; the ecosystem string
//! is still `"pub"`.)

use anyhow::{anyhow, bail};
use serde::Deserialize;

use super::{parse_repo_url, ResolveResult};
use crate::http::HttpClient;

#[derive(Deserialize)]
struct PubPackageMeta {
    latest: PubLatest,
    #[serde(default)]
    versions: Option<Vec<PubVersion>>,
}

#[derive(Deserialize)]
struct PubLatest {
    version: String,
    pubspec: PubPubspec,
}

#[derive(Deserialize)]
struct PubPubspec {
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
}

#[derive(Deserialize)]
struct PubVersion {
    version: String,
}

/// Resolve a pub.dev package to a GitHub repo + git ref (port of `PubResolver`).
/// Note the ref convention is inverted vs npm/pypi: the primary ref is the bare
/// version and `v<version>` is the fallback.
pub fn resolve(
    client: &dyn HttpClient,
    name: &str,
    version: &str,
) -> anyhow::Result<ResolveResult> {
    let url = format!("https://pub.dev/api/packages/{name}");
    let response = client.get(&url)?;
    if !response.ok() {
        bail!("pub.dev returned {} for {name}", response.status);
    }

    let meta: PubPackageMeta = serde_json::from_str(&response.body)?;
    let latest_version = meta.latest.version;

    let resolved_version = if version == "latest" {
        latest_version.clone()
    } else {
        let all: Vec<&str> = meta
            .versions
            .iter()
            .flatten()
            .map(|v| v.version.as_str())
            .collect();
        if !all.is_empty() && !all.contains(&version) {
            bail!(
                "Version '{version}' not found for pub package '{name}'. \
                 Latest version: {latest_version}"
            );
        }
        version.to_string()
    };

    let repo_url = meta
        .latest
        .pubspec
        .repository
        .or(meta.latest.pubspec.homepage);
    let repo = parse_repo_url(repo_url.as_deref()).ok_or_else(|| {
        anyhow!(
            "Cannot resolve GitHub repository for pub package '{name}'. The 'repository' field is \
             missing or not a GitHub URL. Use 'github:owner/repo' format instead: \
             ask add github:owner/repo --ref <tag>"
        )
    })?;

    Ok(ResolveResult {
        repo,
        ref_: resolved_version.clone(),
        fallback_refs: vec![format!("v{resolved_version}")],
        resolved_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;

    const URL: &str = "https://pub.dev/api/packages/riverpod";

    fn meta_json() -> &'static str {
        r#"{
            "latest": { "version": "2.5.1", "pubspec": { "repository": "https://github.com/rrousselGit/riverpod" } },
            "versions": [ { "version": "2.5.0" }, { "version": "2.5.1" } ]
        }"#
    }

    #[test]
    fn resolves_latest_with_inverted_ref_convention() {
        let c = MockClient::new().with(URL, 200, meta_json());
        let r = resolve(&c, "riverpod", "latest").unwrap();
        assert_eq!(r.repo, "rrousselGit/riverpod");
        assert_eq!(r.resolved_version, "2.5.1");
        // Primary ref is the bare version; v-prefixed is the fallback.
        assert_eq!(r.ref_, "2.5.1");
        assert_eq!(r.fallback_refs, vec!["v2.5.1"]);
    }

    #[test]
    fn explicit_existing_version_ok() {
        let c = MockClient::new().with(URL, 200, meta_json());
        assert_eq!(
            resolve(&c, "riverpod", "2.5.0").unwrap().resolved_version,
            "2.5.0"
        );
    }

    #[test]
    fn explicit_missing_version_errors() {
        let c = MockClient::new().with(URL, 200, meta_json());
        assert!(resolve(&c, "riverpod", "9.9.9").is_err());
    }

    #[test]
    fn falls_back_to_homepage() {
        let meta =
            r#"{"latest":{"version":"1.0.0","pubspec":{"homepage":"https://github.com/o/r"}}}"#;
        let c = MockClient::new().with("https://pub.dev/api/packages/x", 200, meta);
        assert_eq!(resolve(&c, "x", "latest").unwrap().repo, "o/r");
    }
}
