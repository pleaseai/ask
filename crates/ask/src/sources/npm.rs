//! npm source — local-first read from `node_modules/<pkg>/<docsPath>`, falling
//! back to a published-tarball download. Rust port of `sources/npm.ts`.

use std::io::Cursor;
use std::path::Path;
use std::process::Command;

use anyhow::{bail, Result};
use flate2::read::GzDecoder;

use super::{
    collect_doc_files, detect_docs_path, to_entry_files, DocFile, FetchMeta, FetchResult,
    NPM_DOC_CANDIDATES,
};
use crate::http::HttpClient;
use crate::store::{
    acquire_entry_lock, lexical_clean, npm_store_path, stamp_entry, write_entry_atomic,
};

/// Options for an npm fetch (port of `NpmSourceOptions`).
#[derive(Debug, Clone, Default)]
pub struct NpmOptions {
    pub name: String,
    pub version: String,
    pub package: Option<String>,
    pub docs_path: Option<String>,
}

/// Fetch docs for an npm package: try the installed `node_modules` copy first,
/// then a tarball download.
pub fn fetch(
    client: &dyn HttpClient,
    opts: &NpmOptions,
    project_dir: &Path,
    ask_home: &Path,
) -> Result<FetchResult> {
    let pkg = opts.package.as_deref().unwrap_or(&opts.name);

    if let Some(mut local) =
        try_local_read(project_dir, pkg, &opts.version, opts.docs_path.as_deref())
    {
        write_to_store(ask_home, pkg, &local.resolved_version, &local.files)?;
        local.store_path = Some(npm_store_path(ask_home, pkg, &local.resolved_version)?);
        return Ok(local);
    }

    fetch_from_tarball(client, opts, pkg, ask_home)
}

/// Match policy for the local-first read (node-semver semantics):
/// `latest` → any; a bare exact version → equality; a semver range → satisfies;
/// an opaque tag → equality.
fn version_matches(requested: &str, installed: &str) -> bool {
    if requested == "latest" {
        return true;
    }
    // A plain version string is an EXACT match in npm's range grammar (unlike the
    // Cargo `semver` crate, where `1.2.3` means `^1.2.3`), so compare directly.
    if semver::Version::parse(requested).is_ok() {
        return requested == installed;
    }
    if let (Ok(req), Ok(v)) = (
        semver::VersionReq::parse(requested),
        semver::Version::parse(installed),
    ) {
        return req.matches(&v);
    }
    requested == installed
}

/// Read docs directly from `node_modules/<pkg>` when the installed version
/// satisfies the request and the configured `docs_path` exists. `None` = not
/// viable (caller falls back to the tarball).
pub fn try_local_read(
    project_dir: &Path,
    pkg: &str,
    requested_version: &str,
    docs_path: Option<&str>,
) -> Option<FetchResult> {
    // No explicit docsPath: the local path exists only for the curated case.
    let docs_path = docs_path?;

    let pkg_dir = project_dir.join("node_modules").join(pkg);
    let pkg_json = pkg_dir.join("package.json");
    let meta_text = std::fs::read_to_string(&pkg_json).ok()?;
    let installed_version = serde_json::from_str::<serde_json::Value>(&meta_text)
        .ok()?
        .get("version")?
        .as_str()?
        .to_string();

    if !version_matches(requested_version, &installed_version) {
        return None;
    }

    // String-level traversal guard (before touching the fs).
    let docs_dir = pkg_dir.join(docs_path);
    if !lexical_clean(&docs_dir).starts_with(lexical_clean(&pkg_dir)) {
        return None;
    }
    if !docs_dir.exists() {
        return None;
    }
    // Realpath guard: a symlink inside the package pointing outside is caught here.
    let real_pkg = std::fs::canonicalize(&pkg_dir).ok()?;
    let real_docs = std::fs::canonicalize(&docs_dir).ok()?;
    if !real_docs.starts_with(&real_pkg) {
        return None;
    }

    let files = if docs_dir.is_file() {
        let content = std::fs::read_to_string(&docs_dir).ok()?;
        let name = docs_dir.file_name()?.to_string_lossy().into_owned();
        vec![DocFile {
            path: name,
            content,
        }]
    } else {
        collect_doc_files(&docs_dir, &docs_dir).ok()?
    };
    if files.is_empty() {
        return None;
    }

    Some(FetchResult {
        files,
        resolved_version: installed_version,
        store_path: None,
        store_subpath: None,
        from_store_cache: false,
        meta: FetchMeta {
            install_path: Some(pkg_dir),
            ..Default::default()
        },
    })
}

fn npm_view(spec: &str, field: &str) -> Result<String> {
    let output = Command::new("npm").args(["view", spec, field]).output()?;
    if !output.status.success() {
        bail!(
            "npm view {spec} {field} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn fetch_from_tarball(
    client: &dyn HttpClient,
    opts: &NpmOptions,
    pkg: &str,
    ask_home: &Path,
) -> Result<FetchResult> {
    let spec = format!("{pkg}@{}", opts.version);
    let resolved_version = npm_view(&spec, "version")?;
    let tarball_url = npm_view(&spec, "dist.tarball")?;
    let integrity = npm_view(&spec, "dist.integrity")
        .ok()
        .filter(|s| !s.is_empty());

    let response = client.get_bytes(&tarball_url, &[])?;
    if !response.ok() {
        bail!("Failed to download {tarball_url}: HTTP {}", response.status);
    }

    let tmp = tempfile::Builder::new().prefix("ask-npm-").tempdir()?;
    let decoder = GzDecoder::new(Cursor::new(&response.body));
    tar::Archive::new(decoder).unpack(tmp.path())?;

    let package_dir = tmp.path().join("package");
    let docs_path = opts
        .docs_path
        .clone()
        .or_else(|| detect_docs_path(&package_dir, NPM_DOC_CANDIDATES))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "No docs found in {spec}. Specify --docs-path to point to the docs directory \
                 within the package."
            )
        })?;

    let docs_dir = package_dir.join(&docs_path);
    // Containment guard: a `--docs-path` that is absolute, uses `../`, or points
    // at a symlink escaping the package must not let ask read arbitrary local
    // paths. Mirror try_local_read's lexical + realpath checks (the local-first
    // path had them; the tarball path did not).
    if !lexical_clean(&docs_dir).starts_with(lexical_clean(&package_dir)) {
        bail!("Docs path \"{docs_path}\" escapes the package directory in {spec}.");
    }
    if !docs_dir.exists() {
        bail!(
            "Docs path \"{docs_path}\" not found in {spec}. Available paths:\n{}",
            list_dirs(&package_dir)
        );
    }
    let real_pkg = std::fs::canonicalize(&package_dir)?;
    let real_docs = std::fs::canonicalize(&docs_dir)?;
    if !real_docs.starts_with(&real_pkg) {
        bail!("Docs path \"{docs_path}\" resolves outside the package directory in {spec}.");
    }

    let files = if docs_dir.is_file() {
        let content = std::fs::read_to_string(&docs_dir)?;
        let name = docs_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        vec![DocFile {
            path: name,
            content,
        }]
    } else {
        collect_doc_files(&docs_dir, &docs_dir)?
    };

    write_to_store(ask_home, pkg, &resolved_version, &files)?;

    Ok(FetchResult {
        files,
        resolved_version: resolved_version.clone(),
        store_path: Some(npm_store_path(ask_home, pkg, &resolved_version)?),
        store_subpath: None,
        from_store_cache: false,
        meta: FetchMeta {
            tarball: Some(tarball_url),
            integrity,
            ..Default::default()
        },
    })
}

fn list_dirs(dir: &Path) -> String {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return String::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| format!("  - {}/", e.file_name().to_string_lossy()))
        .collect();
    names.sort();
    names.join("\n")
}

/// Write fetched docs into `<ASK_HOME>/npm/<pkg>@<version>/` (skip if present).
fn write_to_store(ask_home: &Path, pkg: &str, version: &str, files: &[DocFile]) -> Result<()> {
    let store_dir = npm_store_path(ask_home, pkg, version)?;
    if store_dir.exists() {
        return Ok(());
    }
    if let Some(lock) = acquire_entry_lock(&store_dir)? {
        write_entry_atomic(&store_dir, &to_entry_files(files))?;
        stamp_entry(&store_dir)?;
        drop(lock);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_node_semver_semantics() {
        assert!(version_matches("latest", "9.9.9"));
        // Bare version → exact.
        assert!(version_matches("1.2.3", "1.2.3"));
        assert!(!version_matches("1.2.3", "1.2.4"));
        // Range → satisfies.
        assert!(version_matches("^1.2.0", "1.5.0"));
        assert!(!version_matches("^1.2.0", "2.0.0"));
        assert!(version_matches("~3.22.0", "3.22.9"));
        // Opaque tag → exact.
        assert!(version_matches("canary", "canary"));
        assert!(!version_matches("canary", "1.0.0"));
    }

    fn setup_pkg(project: &Path, pkg: &str, version: &str) -> std::path::PathBuf {
        let pkg_dir = project.join("node_modules").join(pkg);
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(
            pkg_dir.join("package.json"),
            format!(r#"{{"name":"{pkg}","version":"{version}"}}"#),
        )
        .unwrap();
        pkg_dir
    }

    #[test]
    fn local_read_returns_docs_when_version_matches() {
        let dir = tempfile::tempdir().unwrap();
        let pkg_dir = setup_pkg(dir.path(), "acme", "2.0.0");
        std::fs::create_dir_all(pkg_dir.join("dist/docs")).unwrap();
        std::fs::write(pkg_dir.join("dist/docs/a.md"), "A").unwrap();

        let result = try_local_read(dir.path(), "acme", "2.0.0", Some("dist/docs")).unwrap();
        assert_eq!(result.resolved_version, "2.0.0");
        assert_eq!(
            result.files,
            vec![DocFile {
                path: "a.md".into(),
                content: "A".into()
            }]
        );
        assert_eq!(result.meta.install_path.as_deref(), Some(pkg_dir.as_path()));
    }

    #[test]
    fn local_read_none_without_docs_path() {
        let dir = tempfile::tempdir().unwrap();
        setup_pkg(dir.path(), "acme", "2.0.0");
        assert!(try_local_read(dir.path(), "acme", "2.0.0", None).is_none());
    }

    #[test]
    fn local_read_none_on_version_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let pkg_dir = setup_pkg(dir.path(), "acme", "1.0.0");
        std::fs::create_dir_all(pkg_dir.join("docs")).unwrap();
        std::fs::write(pkg_dir.join("docs/a.md"), "A").unwrap();
        assert!(try_local_read(dir.path(), "acme", "2.0.0", Some("docs")).is_none());
    }

    #[test]
    fn local_read_none_on_traversal_docs_path() {
        let dir = tempfile::tempdir().unwrap();
        setup_pkg(dir.path(), "acme", "2.0.0");
        assert!(try_local_read(dir.path(), "acme", "2.0.0", Some("../../etc")).is_none());
    }

    #[test]
    fn local_read_none_when_empty_docs_dir() {
        let dir = tempfile::tempdir().unwrap();
        let pkg_dir = setup_pkg(dir.path(), "acme", "2.0.0");
        std::fs::create_dir_all(pkg_dir.join("docs")).unwrap();
        // No doc files inside → treated as a miss.
        assert!(try_local_read(dir.path(), "acme", "2.0.0", Some("docs")).is_none());
    }

    #[test]
    fn local_read_single_file_docs_path() {
        let dir = tempfile::tempdir().unwrap();
        let pkg_dir = setup_pkg(dir.path(), "acme", "2.0.0");
        std::fs::write(pkg_dir.join("README.md"), "readme").unwrap();
        let result = try_local_read(dir.path(), "acme", "2.0.0", Some("README.md")).unwrap();
        assert_eq!(
            result.files,
            vec![DocFile {
                path: "README.md".into(),
                content: "readme".into()
            }]
        );
    }

    #[test]
    fn fetch_writes_local_read_into_store() {
        let dir = tempfile::tempdir().unwrap();
        let ask_home = dir.path().join("ask-home");
        let pkg_dir = setup_pkg(dir.path(), "acme", "2.0.0");
        std::fs::create_dir_all(pkg_dir.join("docs")).unwrap();
        std::fs::write(pkg_dir.join("docs/a.md"), "A").unwrap();

        let client = crate::http::mock::MockClient::new();
        let opts = NpmOptions {
            name: "acme".into(),
            version: "2.0.0".into(),
            docs_path: Some("docs".into()),
            ..Default::default()
        };
        let result = fetch(&client, &opts, dir.path(), &ask_home).unwrap();
        let store = result.store_path.unwrap();
        assert!(store.ends_with("npm/acme@2.0.0"));
        assert!(store.join("a.md").exists());
    }
}
