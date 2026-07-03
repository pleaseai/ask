//! Registry HTTP surface — `RegistrySource`, the flattened API response, and the
//! `fetch_registry_entry` / `resolve_from_registry` lookups. Rust port of the
//! network half of `registry.ts` (plus the `RegistrySource` type from
//! `packages/schema/src/registry.ts`).

use serde::{Deserialize, Serialize};

use super::{detect_ecosystem, parse_ecosystem, REGISTRY_BASE_URL};
use crate::http::{encode_uri_component, HttpClient};

/// A way to fetch one package's docs (discriminated on `type`). Mirrors the
/// `sourceSchema` discriminated union: `npm | github | web | llms-txt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RegistrySource {
    Npm {
        package: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    Github {
        repo: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tag: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    Web {
        urls: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_depth: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        allowed_path_prefix: Option<String>,
    },
    LlmsTxt {
        url: String,
    },
}

impl RegistrySource {
    /// The `type` discriminant as it appears on the wire.
    pub fn type_name(&self) -> &'static str {
        match self {
            RegistrySource::Npm { .. } => "npm",
            RegistrySource::Github { .. } => "github",
            RegistrySource::Web { .. } => "web",
            RegistrySource::LlmsTxt { .. } => "llms-txt",
        }
    }
}

/// The single package block in a flattened registry API response.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RegistryApiPackage {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// Flattened registry API response — one registry entry focused on a single
/// package. `resolved_name` is the CLI-facing slug (`@mastra/core` →
/// `mastra-core`); `sources` is in the author's declared priority order.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryApiResponse {
    pub name: String,
    pub description: String,
    pub repo: String,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    pub resolved_name: String,
    pub package: RegistryApiPackage,
    pub sources: Vec<RegistrySource>,
}

/// The result of resolving a spec against the registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryResolution {
    pub ecosystem: String,
    pub name: String,
    pub version: String,
    pub source: RegistrySource,
}

#[derive(Deserialize)]
struct StatusBody {
    #[serde(rename = "statusMessage")]
    status_message: Option<String>,
}

/// Fetch a registry entry from the registry API. Accepts either `(owner, repo)`
/// for a direct lookup or `(ecosystem, name)` for an alias lookup — the API
/// handles both via a catch-all slug.
///
/// Returns `None` on 404, on any non-2xx (after warning with the server's
/// `statusMessage` — e.g. the 409 monorepo-disambiguation guidance), on a
/// transport failure/timeout, or on a body that does not parse. Parity with
/// `fetchRegistryEntry`.
pub fn fetch_registry_entry(
    client: &dyn HttpClient,
    first: &str,
    second: &str,
) -> Option<RegistryApiResponse> {
    // `second` may contain `/` for scoped npm packages — encode it so the server
    // sees a single catch-all segment.
    let url = format!(
        "{REGISTRY_BASE_URL}/api/registry/{}/{}",
        encode_uri_component(first),
        encode_uri_component(second),
    );

    let response = match client.get(&url) {
        Ok(r) => r,
        // Transport failure / timeout — treat as a miss, let downstream
        // resolvers take over.
        Err(_) => return None,
    };

    if response.status == 404 {
        return None;
    }
    if !response.ok() {
        let message = serde_json::from_str::<StatusBody>(&response.body)
            .ok()
            .and_then(|b| b.status_message)
            .unwrap_or_else(|| format!("HTTP {}", response.status));
        eprintln!(
            "Registry lookup for {first}/{second} returned {}: {message}",
            response.status
        );
        return None;
    }

    serde_json::from_str::<RegistryApiResponse>(&response.body).ok()
}

/// Resolve a spec against the registry: split the ecosystem/name/version, look
/// up the entry, and return its primary (first) source. Parity with
/// `resolveFromRegistry`.
pub fn resolve_from_registry(
    client: &dyn HttpClient,
    input: &str,
    project_dir: &std::path::Path,
) -> Option<RegistryResolution> {
    let (explicit_ecosystem, spec) = parse_ecosystem(input);

    // Split a trailing `@version` (last `@`, but not a leading scope marker).
    let (name, version) = match spec.rfind('@') {
        Some(idx) if idx > 0 => (&spec[..idx], &spec[idx + 1..]),
        _ => (spec, "latest"),
    };

    let ecosystem = explicit_ecosystem
        .map(str::to_string)
        .unwrap_or_else(|| detect_ecosystem(project_dir).to_string());

    let entry = fetch_registry_entry(client, &ecosystem, name)?;

    let Some(primary) = entry.sources.first() else {
        eprintln!("Registry entry for {name} has no sources");
        return None;
    };

    Some(RegistryResolution {
        ecosystem,
        name: entry.resolved_name.clone(),
        version: version.to_string(),
        source: primary.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;

    const BASE: &str = "https://ask-registry.pages.dev";

    fn entry_json() -> &'static str {
        r#"{
            "name": "next.js",
            "description": "The React Framework",
            "repo": "vercel/next.js",
            "resolvedName": "next",
            "package": { "name": "next" },
            "sources": [
                { "type": "npm", "package": "next", "path": "dist/docs" },
                { "type": "github", "repo": "vercel/next.js", "path": "docs" }
            ]
        }"#
    }

    #[test]
    fn source_discriminated_union_roundtrips() {
        let src: RegistrySource =
            serde_json::from_str(r#"{"type":"llms-txt","url":"https://x/llms.txt"}"#).unwrap();
        assert_eq!(
            src,
            RegistrySource::LlmsTxt {
                url: "https://x/llms.txt".into()
            }
        );
        assert_eq!(src.type_name(), "llms-txt");
        // camelCase field on a web source.
        let web: RegistrySource = serde_json::from_str(
            r#"{"type":"web","urls":["https://x"],"maxDepth":2,"allowedPathPrefix":"/docs"}"#,
        )
        .unwrap();
        assert!(matches!(
            web,
            RegistrySource::Web {
                max_depth: Some(2),
                ..
            }
        ));
    }

    #[test]
    fn fetch_entry_ok() {
        let client =
            MockClient::new().with(&format!("{BASE}/api/registry/npm/next"), 200, entry_json());
        let entry = fetch_registry_entry(&client, "npm", "next").unwrap();
        assert_eq!(entry.resolved_name, "next");
        assert_eq!(entry.sources.len(), 2);
        assert_eq!(entry.sources[0].type_name(), "npm");
    }

    #[test]
    fn fetch_entry_scoped_name_is_url_encoded() {
        // `@mastra/client-js` → catch-all segment `%40mastra%2Fclient-js`.
        let url = format!("{BASE}/api/registry/npm/%40mastra%2Fclient-js");
        let client = MockClient::new().with(&url, 200, entry_json());
        assert!(fetch_registry_entry(&client, "npm", "@mastra/client-js").is_some());
    }

    #[test]
    fn fetch_entry_404_and_transport_error_are_none() {
        let client = MockClient::new().with(&format!("{BASE}/api/registry/npm/missing"), 404, "");
        assert!(fetch_registry_entry(&client, "npm", "missing").is_none());
        // Unregistered URL → MockClient errors (transport failure) → None.
        assert!(fetch_registry_entry(&client, "npm", "never").is_none());
    }

    #[test]
    fn fetch_entry_non_ok_warns_and_returns_none() {
        let client = MockClient::new().with(
            &format!("{BASE}/api/registry/mastra-ai/mastra"),
            409,
            r#"{"statusMessage":"Monorepo entry — use npm:@mastra/core"}"#,
        );
        assert!(fetch_registry_entry(&client, "mastra-ai", "mastra").is_none());
    }

    #[test]
    fn resolve_splits_version_and_returns_primary_source() {
        let client =
            MockClient::new().with(&format!("{BASE}/api/registry/npm/next"), 200, entry_json());
        let dir = tempfile::tempdir().unwrap();
        // Explicit ecosystem prefix + version.
        let res = resolve_from_registry(&client, "npm:next@14.2.3", dir.path()).unwrap();
        assert_eq!(res.ecosystem, "npm");
        assert_eq!(res.name, "next");
        assert_eq!(res.version, "14.2.3");
        assert_eq!(res.source.type_name(), "npm");
    }

    #[test]
    fn resolve_detects_ecosystem_from_project_when_prefix_absent() {
        let client =
            MockClient::new().with(&format!("{BASE}/api/registry/npm/next"), 200, entry_json());
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), "{}").unwrap();
        // No prefix, no version → ecosystem from package.json, version "latest".
        let res = resolve_from_registry(&client, "next", dir.path()).unwrap();
        assert_eq!(res.ecosystem, "npm");
        assert_eq!(res.version, "latest");
    }
}
