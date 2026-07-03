//! Maven Central ecosystem resolver — Rust port of `resolvers/maven.ts`.
//!
//! Resolution walks: Search API (version + optional `scm.url`) → POM `<scm><url>`
//! → POM `<url>`, with a `maven-metadata.xml` fallback for the latest version
//! when the Search API is unavailable.

use std::sync::LazyLock;

use anyhow::{anyhow, bail};
use regex::Regex;
use serde::Deserialize;

use super::{parse_repo_url, ResolveResult};
use crate::http::{encode_uri_component, HttpClient};

static RE_SCM_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<scm>.*?<url>([^<]+)</url>").unwrap());
static RE_PROJECT_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<project[^>]*>.*?<url>([^<]+)</url>").unwrap());
static RE_RELEASE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<release>([^<]+)</release>").unwrap());
static RE_LATEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<latest>([^<]+)</latest>").unwrap());

#[derive(Deserialize)]
struct MavenSearchResponse {
    response: MavenSearchInner,
}

#[derive(Deserialize)]
struct MavenSearchInner {
    #[serde(rename = "numFound")]
    num_found: u64,
    docs: Vec<MavenSearchDoc>,
}

#[derive(Deserialize)]
struct MavenSearchDoc {
    v: String,
}

#[derive(Deserialize)]
struct MavenScmResponse {
    response: MavenScmInner,
}

#[derive(Deserialize)]
struct MavenScmInner {
    docs: Vec<MavenScmDoc>,
}

#[derive(Deserialize)]
struct MavenScmDoc {
    #[serde(rename = "scm.url")]
    scm_url: Option<String>,
}

struct VersionResult {
    version: String,
    scm_url: Option<String>,
}

/// Split `groupId:artifactId` at the LAST colon (groupId may contain dots but
/// never colons; artifactId never contains colons).
fn parse_maven_coordinate(name: &str) -> anyhow::Result<(String, String)> {
    match name.rfind(':') {
        Some(idx) if idx > 0 && idx != name.len() - 1 => {
            Ok((name[..idx].to_string(), name[idx + 1..].to_string()))
        }
        _ => bail!(
            "Invalid Maven coordinate '{name}': expected 'groupId:artifactId' format \
             (e.g. 'com.google.guava:guava')"
        ),
    }
}

fn build_pom_url(group_id: &str, artifact_id: &str, version: &str) -> String {
    let group_path = group_id.replace('.', "/");
    format!("https://repo1.maven.org/maven2/{group_path}/{artifact_id}/{version}/{artifact_id}-{version}.pom")
}

/// Extract a GitHub repo URL from POM XML: `<scm><url>` first, then top-level
/// `<url>`.
fn extract_repo_from_pom(pom_xml: &str) -> Option<String> {
    if let Some(caps) = RE_SCM_URL.captures(pom_xml) {
        if let Some(repo) = parse_repo_url(Some(caps[1].trim())) {
            return Some(repo);
        }
    }
    if let Some(caps) = RE_PROJECT_URL.captures(pom_xml) {
        if let Some(repo) = parse_repo_url(Some(caps[1].trim())) {
            return Some(repo);
        }
    }
    None
}

/// Resolve a Maven Central package to a GitHub repo + git ref (port of
/// `MavenResolver`).
pub fn resolve(
    client: &dyn HttpClient,
    name: &str,
    version: &str,
) -> anyhow::Result<ResolveResult> {
    let (group_id, artifact_id) = parse_maven_coordinate(name)?;

    let version_result = resolve_version(client, &group_id, &artifact_id, version)?;
    let resolved_version = version_result.version;

    // Repo: (1) Search API scm.url, (2/3) POM XML.
    let mut repo = version_result
        .scm_url
        .as_deref()
        .and_then(|u| parse_repo_url(Some(u)));
    if repo.is_none() {
        repo = find_repo_from_pom(client, &group_id, &artifact_id, &resolved_version);
    }
    let repo = repo.ok_or_else(|| {
        anyhow!(
            "Cannot resolve GitHub repository for Maven package '{group_id}:{artifact_id}'. \
             Neither the Search API nor the POM contains a GitHub URL. Use 'github:owner/repo' \
             format instead: ask add github:owner/repo --ref <tag>"
        )
    })?;

    Ok(ResolveResult {
        repo,
        ref_: format!("v{resolved_version}"),
        fallback_refs: vec![resolved_version.clone()],
        resolved_version,
    })
}

/// Resolve version (+ optional scm.url). Explicit versions skip Search-API
/// validation (the POM fetch fails if absent) but still try it for the scm.url;
/// `latest` falls back to `maven-metadata.xml` when the Search API is down.
fn resolve_version(
    client: &dyn HttpClient,
    group_id: &str,
    artifact_id: &str,
    version: &str,
) -> anyhow::Result<VersionResult> {
    if version != "latest" {
        return Ok(
            fetch_search_api(client, group_id, artifact_id, version).unwrap_or_else(|_| {
                VersionResult {
                    version: version.to_string(),
                    scm_url: None,
                }
            }),
        );
    }
    match fetch_search_api(client, group_id, artifact_id, version) {
        Ok(vr) => Ok(vr),
        Err(_) => resolve_version_from_metadata(client, group_id, artifact_id),
    }
}

fn fetch_search_api(
    client: &dyn HttpClient,
    group_id: &str,
    artifact_id: &str,
    version: &str,
) -> anyhow::Result<VersionResult> {
    let is_latest = version == "latest";
    let (g, a) = (
        encode_uri_component(group_id),
        encode_uri_component(artifact_id),
    );
    let query = if is_latest {
        format!("q=g:{g}+AND+a:{a}&rows=1&wt=json")
    } else {
        let v = encode_uri_component(version);
        format!("q=g:{g}+AND+a:{a}+AND+v:{v}&rows=1&wt=json&core=gav")
    };
    let url = format!("https://search.maven.org/solrsearch/select?{query}");
    let response = client.get(&url)?;
    if !response.ok() {
        bail!(
            "Maven Central Search API returned {} for {group_id}:{artifact_id}",
            response.status
        );
    }
    let data: MavenSearchResponse = serde_json::from_str(&response.body)?;
    if data.response.num_found == 0 {
        let suffix = if is_latest {
            String::new()
        } else {
            format!("@{version}")
        };
        bail!("Maven package '{group_id}:{artifact_id}'{suffix} not found on Maven Central");
    }
    let doc_version = data
        .response
        .docs
        .into_iter()
        .next()
        .map(|d| d.v)
        .ok_or_else(|| {
            anyhow!("Maven Central Search API returned no docs for {group_id}:{artifact_id}")
        })?;

    // Best-effort scm.url from the artifact-level (non-GAV) core.
    let scm_url = fetch_scm_url(client, group_id, artifact_id).ok().flatten();

    Ok(VersionResult {
        version: doc_version,
        scm_url,
    })
}

fn fetch_scm_url(
    client: &dyn HttpClient,
    group_id: &str,
    artifact_id: &str,
) -> anyhow::Result<Option<String>> {
    let (g, a) = (
        encode_uri_component(group_id),
        encode_uri_component(artifact_id),
    );
    let url =
        format!("https://search.maven.org/solrsearch/select?q=g:{g}+AND+a:{a}&rows=1&wt=json");
    let response = client.get(&url)?;
    if !response.ok() {
        return Ok(None);
    }
    let data: MavenScmResponse = serde_json::from_str(&response.body)?;
    Ok(data
        .response
        .docs
        .into_iter()
        .next()
        .and_then(|d| d.scm_url))
}

fn resolve_version_from_metadata(
    client: &dyn HttpClient,
    group_id: &str,
    artifact_id: &str,
) -> anyhow::Result<VersionResult> {
    let group_path = group_id.replace('.', "/");
    let url =
        format!("https://repo1.maven.org/maven2/{group_path}/{artifact_id}/maven-metadata.xml");
    let response = client.get(&url)?;
    if !response.ok() {
        bail!(
            "Cannot resolve Maven package '{group_id}:{artifact_id}': Search API unavailable and \
             maven-metadata.xml returned {}",
            response.status
        );
    }
    let version = RE_RELEASE
        .captures(&response.body)
        .or_else(|| RE_LATEST.captures(&response.body))
        .map(|c| c[1].to_string())
        .ok_or_else(|| {
            anyhow!(
                "Cannot resolve latest version for Maven package '{group_id}:{artifact_id}': \
                 no <release> or <latest> tag in maven-metadata.xml"
            )
        })?;
    Ok(VersionResult {
        version,
        scm_url: None,
    })
}

fn find_repo_from_pom(
    client: &dyn HttpClient,
    group_id: &str,
    artifact_id: &str,
    version: &str,
) -> Option<String> {
    let pom_url = build_pom_url(group_id, artifact_id, version);
    let response = client.get(&pom_url).ok()?;
    if response.ok() {
        return extract_repo_from_pom(&response.body);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;

    #[test]
    fn parse_coordinate_valid_and_invalid() {
        assert_eq!(
            parse_maven_coordinate("com.google.guava:guava").unwrap(),
            ("com.google.guava".to_string(), "guava".to_string())
        );
        assert!(parse_maven_coordinate("noguava").is_err());
        assert!(parse_maven_coordinate("g:").is_err());
        assert!(parse_maven_coordinate(":a").is_err());
    }

    #[test]
    fn build_pom_url_converts_group_dots() {
        assert_eq!(
            build_pom_url("com.google.guava", "guava", "33.0.0"),
            "https://repo1.maven.org/maven2/com/google/guava/guava/33.0.0/guava-33.0.0.pom"
        );
    }

    #[test]
    fn extract_repo_prefers_scm_over_project_url() {
        let pom = r#"<project><url>https://github.com/proj/site</url><scm><url>https://github.com/real/repo</url></scm></project>"#;
        assert_eq!(extract_repo_from_pom(pom).as_deref(), Some("real/repo"));
        let pom_no_scm = r#"<project xmlns="x"><url>https://github.com/o/r</url></project>"#;
        assert_eq!(extract_repo_from_pom(pom_no_scm).as_deref(), Some("o/r"));
    }

    #[test]
    fn resolve_via_search_api_scm_url() {
        let latest =
            "https://search.maven.org/solrsearch/select?q=g:com.example+AND+a:lib&rows=1&wt=json";
        let client = MockClient::new()
            .with(latest, 200, r#"{"response":{"numFound":1,"docs":[{"v":"1.2.3","scm.url":"https://github.com/example/lib"}]}}"#);
        let r = resolve(&client, "com.example:lib", "latest").unwrap();
        assert_eq!(r.repo, "example/lib");
        assert_eq!(r.resolved_version, "1.2.3");
        assert_eq!(r.ref_, "v1.2.3");
        assert_eq!(r.fallback_refs, vec!["1.2.3"]);
    }

    #[test]
    fn resolve_explicit_version_falls_back_to_pom() {
        // Search API is down (unregistered → transport error), explicit version
        // is used as-is, and the repo comes from the POM.
        let pom = build_pom_url("com.example", "lib", "9.9.9");
        let client = MockClient::new().with(
            &pom,
            200,
            r#"<project><scm><url>https://github.com/example/lib</url></scm></project>"#,
        );
        let r = resolve(&client, "com.example:lib", "9.9.9").unwrap();
        assert_eq!(r.repo, "example/lib");
        assert_eq!(r.resolved_version, "9.9.9");
    }

    #[test]
    fn latest_falls_back_to_metadata_when_search_down() {
        // Search API url is unregistered (transport error) → metadata.xml.
        let meta = "https://repo1.maven.org/maven2/com/example/lib/maven-metadata.xml";
        let pom = build_pom_url("com.example", "lib", "4.5.6");
        let client = MockClient::new()
            .with(
                meta,
                200,
                "<metadata><versioning><release>4.5.6</release></versioning></metadata>",
            )
            .with(
                &pom,
                200,
                r#"<project><url>https://github.com/example/lib</url></project>"#,
            );
        let r = resolve(&client, "com.example:lib", "latest").unwrap();
        assert_eq!(r.resolved_version, "4.5.6");
        assert_eq!(r.repo, "example/lib");
    }

    #[test]
    fn no_repo_anywhere_errors() {
        let latest =
            "https://search.maven.org/solrsearch/select?q=g:com.example+AND+a:lib&rows=1&wt=json";
        let pom = build_pom_url("com.example", "lib", "1.0.0");
        let client = MockClient::new()
            .with(
                latest,
                200,
                r#"{"response":{"numFound":1,"docs":[{"v":"1.0.0"}]}}"#,
            )
            .with(&pom, 200, "<project></project>");
        assert!(resolve(&client, "com.example:lib", "latest").is_err());
    }
}
