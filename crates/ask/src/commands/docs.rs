//! `ask docs <spec>` — print candidate documentation paths from `node_modules`
//! and the cached source tree. Rust port of `commands/docs.ts`.
//!
//! Resolves the spec via the shared `ensure_checkout` helper, then emits doc-like
//! paths (one per line, or a JSON `DocsModel` with `--json`). A persisted
//! `docsPaths` override in ask.json, when present and non-stale, restricts output
//! to those paths (resolved against both node_modules and the checkout).

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Serialize;

use crate::commands::ensure_checkout::{
    ensure_checkout, EnsureCheckoutDeps, EnsureCheckoutOptions,
};
use crate::commands::find_doc_paths::find_doc_like_paths;
use crate::http::HttpClient;
use crate::io::{find_entry, read_ask_json};
use crate::store::assert_contained;

/// Options for [`run_docs`].
#[derive(Debug, Clone)]
pub struct RunDocsOptions {
    pub spec: String,
    pub project_dir: PathBuf,
    pub no_fetch: bool,
    pub json: bool,
}

/// Which source root a candidate path came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DocsRoot {
    NodeModules,
    Checkout,
}

/// One documentation candidate path (matches `DocsCandidateSchema`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DocsCandidate {
    pub path: String,
    pub root: DocsRoot,
}

/// `ask docs <spec> --json` output (matches `DocsModelSchema`).
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DocsModel {
    pub spec: String,
    #[serde(rename = "npmPackageName")]
    pub npm_package_name: Option<String>,
    #[serde(rename = "checkoutDir")]
    pub checkout_dir: String,
    #[serde(rename = "storedOverride")]
    pub stored_override: bool,
    pub paths: Vec<DocsCandidate>,
}

/// What [`run_docs`] produces: text to print plus any non-fatal stderr warnings
/// (e.g. all stored docsPaths were stale). The CLI prints `stdout`, writes
/// `warnings` to stderr, and exits 0 — only a hard error (NoCacheError, resolver
/// failure) surfaces as `Err` and maps to exit 1.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DocsRun {
    pub stdout: String,
    pub warnings: Vec<String>,
}

fn candidate_at(p: &Path, root: DocsRoot) -> DocsCandidate {
    DocsCandidate {
        path: p.to_string_lossy().into_owned(),
        root,
    }
}

/// Resolve `spec` and collect documentation candidate paths.
pub fn run_docs(client: &dyn HttpClient, options: &RunDocsOptions) -> Result<DocsRun> {
    run_docs_with(client, options, &EnsureCheckoutDeps::default())
}

/// [`run_docs`] with injectable checkout deps.
pub fn run_docs_with(
    client: &dyn HttpClient,
    options: &RunDocsOptions,
    deps: &EnsureCheckoutDeps,
) -> Result<DocsRun> {
    let result = ensure_checkout(
        client,
        &EnsureCheckoutOptions {
            spec: options.spec.clone(),
            project_dir: options.project_dir.clone(),
            no_fetch: options.no_fetch,
        },
        deps,
    )?;

    let mut run = DocsRun::default();
    let mut paths: Vec<DocsCandidate> = Vec::new();

    let nm_path = result
        .npm_package_name
        .as_ref()
        .map(|pkg| options.project_dir.join("node_modules").join(pkg));

    // Persisted docsPaths override: emit ONLY the stored paths (resolved against
    // both roots that `ask add` probed). Falls back to the unfiltered walk when
    // every stored path is stale — silent empty output would be worse.
    let stored: Option<Vec<String>> =
        read_ask_json(&options.project_dir)
            .ok()
            .flatten()
            .and_then(|aj| {
                find_entry(&aj, &options.spec).and_then(|e| e.docs_paths().map(|d| d.to_vec()))
            });
    let mut stored_override = false;

    if let Some(stored) = stored.as_ref().filter(|s| !s.is_empty()) {
        // Roots in priority order: node_modules (if present) then checkout.
        let mut roots: Vec<(PathBuf, DocsRoot)> = Vec::new();
        if let Some(nm) = nm_path.as_ref().filter(|p| p.exists()) {
            roots.push((nm.clone(), DocsRoot::NodeModules));
        }
        roots.push((result.checkout_dir.clone(), DocsRoot::Checkout));

        for rel in stored {
            for (root, kind) in &roots {
                // Containment guard: a `..`/absolute docsPaths entry must not
                // escape its root. `join` mirrors path.resolve (absolute rel
                // replaces root); assert_contained rejects escapes.
                let candidate = root.join(rel);
                let Ok(abs) = assert_contained(root, &candidate) else {
                    continue;
                };
                if abs.exists() {
                    paths.push(candidate_at(&abs, *kind));
                    break;
                }
            }
        }

        if !paths.is_empty() {
            stored_override = true;
        } else {
            run.warnings.push(format!(
                "ask: stored docsPaths for {} are all stale; emitting all candidates",
                options.spec
            ));
            // fall through to the default walk
        }
    }

    if !stored_override {
        // node_modules/<pkg>/ first when the spec is an npm package and it is
        // actually installed. Non-npm / missing installs are silently skipped.
        if let Some(nm) = nm_path.as_ref().filter(|p| p.exists()) {
            for p in find_doc_like_paths(nm) {
                paths.push(candidate_at(&p, DocsRoot::NodeModules));
            }
        }
        // The cached source tree. Always emits the root as the first line even
        // when no /doc/i subdirs are found.
        for p in find_doc_like_paths(&result.checkout_dir) {
            paths.push(candidate_at(&p, DocsRoot::Checkout));
        }
    }

    run.stdout = if options.json {
        let model = DocsModel {
            spec: options.spec.clone(),
            npm_package_name: result.npm_package_name.clone(),
            checkout_dir: result.checkout_dir.to_string_lossy().into_owned(),
            stored_override,
            paths,
        };
        serde_json::to_string_pretty(&model)?
    } else {
        paths
            .iter()
            .map(|c| c.path.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ensure_checkout::NoCacheError;
    use crate::http::mock::MockClient;
    use crate::store::github_store_path;

    fn deps_home(home: &Path) -> EnsureCheckoutDeps<'static> {
        EnsureCheckoutDeps {
            ask_home: Some(home.to_path_buf()),
            fetcher: None,
        }
    }

    /// Pre-warm a github checkout and return (home, proj, checkout_dir).
    fn warmed() -> (tempfile::TempDir, tempfile::TempDir, PathBuf) {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let dir = github_store_path(home.path(), "github.com", "owner", "repo", "v1.0.0").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        (home, proj, dir)
    }

    fn opts(spec: &str, proj: &Path, json: bool) -> RunDocsOptions {
        RunDocsOptions {
            spec: spec.to_string(),
            project_dir: proj.to_path_buf(),
            no_fetch: false,
            json,
        }
    }

    #[test]
    fn emits_doc_subdir_from_checkout() {
        let (home, proj, dir) = warmed();
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        let run = run_docs_with(
            &MockClient::new(),
            &opts("github:owner/repo@v1.0.0", proj.path(), false),
            &deps_home(home.path()),
        )
        .unwrap();
        assert!(run.stdout.contains("docs"));
        assert!(run.warnings.is_empty());
    }

    #[test]
    fn readme_only_checkout_emits_root() {
        let (home, proj, dir) = warmed();
        std::fs::write(dir.join("README.md"), "x").unwrap();
        let run = run_docs_with(
            &MockClient::new(),
            &opts("github:owner/repo@v1.0.0", proj.path(), false),
            &deps_home(home.path()),
        )
        .unwrap();
        assert_eq!(run.stdout, dir.to_string_lossy());
    }

    #[test]
    fn json_model_has_schema_fields() {
        let (home, proj, dir) = warmed();
        std::fs::write(dir.join("README.md"), "x").unwrap();
        let run = run_docs_with(
            &MockClient::new(),
            &opts("github:owner/repo@v1.0.0", proj.path(), true),
            &deps_home(home.path()),
        )
        .unwrap();
        assert!(run.stdout.contains(r#""storedOverride": false"#));
        assert!(run.stdout.contains(r#""npmPackageName": null"#));
        assert!(run.stdout.contains(r#""root": "checkout""#));
        assert!(run.stdout.contains(r#""checkoutDir""#));
    }

    #[test]
    fn stored_docs_paths_override_restricts_output() {
        let (home, proj, dir) = warmed();
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::create_dir_all(dir.join("guides")).unwrap();
        std::fs::write(dir.join("guides/intro.md"), "x").unwrap();
        // ask.json pins docsPaths to guides/intro.md only.
        std::fs::write(
            proj.path().join("ask.json"),
            r#"{"libraries":[{"spec":"github:owner/repo@v1.0.0","docsPaths":["guides/intro.md"]}]}"#,
        )
        .unwrap();
        let run = run_docs_with(
            &MockClient::new(),
            &opts("github:owner/repo@v1.0.0", proj.path(), true),
            &deps_home(home.path()),
        )
        .unwrap();
        assert!(run.stdout.contains(r#""storedOverride": true"#));
        assert!(run.stdout.contains("guides/intro.md"));
        // Exactly one candidate — the override restricted output to the pin,
        // so the unfiltered `docs` subdir walk did not run.
        assert_eq!(run.stdout.matches(r#""path""#).count(), 1);
    }

    #[test]
    fn stale_stored_paths_warn_and_fall_through() {
        let (home, proj, dir) = warmed();
        std::fs::write(dir.join("README.md"), "x").unwrap();
        std::fs::write(
            proj.path().join("ask.json"),
            r#"{"libraries":[{"spec":"github:owner/repo@v1.0.0","docsPaths":["nonexistent/gone.md"]}]}"#,
        )
        .unwrap();
        let run = run_docs_with(
            &MockClient::new(),
            &opts("github:owner/repo@v1.0.0", proj.path(), false),
            &deps_home(home.path()),
        )
        .unwrap();
        assert_eq!(run.warnings.len(), 1);
        assert!(run.warnings[0].contains("all stale"));
        // Fell through to the unfiltered walk → root emitted.
        assert_eq!(run.stdout, dir.to_string_lossy());
    }

    #[test]
    fn containment_guard_rejects_traversal() {
        let (home, proj, dir) = warmed();
        std::fs::write(dir.join("README.md"), "x").unwrap();
        // A `..` escape must be rejected, so the override yields nothing → stale.
        std::fs::write(
            proj.path().join("ask.json"),
            r#"{"libraries":[{"spec":"github:owner/repo@v1.0.0","docsPaths":["../../../etc/hosts"]}]}"#,
        )
        .unwrap();
        let run = run_docs_with(
            &MockClient::new(),
            &opts("github:owner/repo@v1.0.0", proj.path(), false),
            &deps_home(home.path()),
        )
        .unwrap();
        assert_eq!(run.warnings.len(), 1);
        assert!(!run.stdout.contains("etc/hosts"));
    }

    #[test]
    fn no_cache_error_propagates() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let err = run_docs_with(
            &MockClient::new(),
            &RunDocsOptions {
                spec: "github:owner/repo@v9.9.9".into(),
                project_dir: proj.path().to_path_buf(),
                no_fetch: true,
                json: false,
            },
            &deps_home(home.path()),
        )
        .unwrap_err();
        assert!(err.downcast_ref::<NoCacheError>().is_some());
    }
}
