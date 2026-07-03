//! `ask src <spec>` — print the absolute path to a cached library source tree,
//! fetching on cache miss unless `--no-fetch`. Rust port of `commands/src.ts`.
//!
//! `run_src` returns the exact stdout string on success and an error on failure;
//! the thin CLI wrapper prints it and maps any error to a non-zero exit. This
//! keeps the resolution logic unit-testable without process exits or real I/O.

use std::path::PathBuf;

use anyhow::Result;
use serde::Serialize;

use crate::commands::ensure_checkout::{
    ensure_checkout, EnsureCheckoutDeps, EnsureCheckoutOptions,
};
use crate::http::HttpClient;

/// Options for [`run_src`].
#[derive(Debug, Clone)]
pub struct RunSrcOptions {
    pub spec: String,
    pub project_dir: PathBuf,
    pub no_fetch: bool,
    pub json: bool,
}

/// `ask src <spec> --json` output — the stable machine-readable handoff that
/// downstream tools (e.g. csp) consume. `checkout_dir` is the version-pinned,
/// content-stable store path they index. Mirrors `SrcModelSchema`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SrcModel {
    pub spec: String,
    pub owner: String,
    pub repo: String,
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(rename = "resolvedVersion")]
    pub resolved_version: String,
    #[serde(rename = "checkoutDir")]
    pub checkout_dir: String,
    #[serde(rename = "npmPackageName")]
    pub npm_package_name: Option<String>,
}

/// Resolve `spec` via the shared checkout helper and return the text to print:
/// the checkout path (default) or a JSON [`SrcModel`] (`json`). On a
/// `NoCacheError` or any resolver failure this returns an error whose message
/// the CLI writes to stderr before exiting non-zero — matching the TS behaviour
/// where both cases route through `error()` + `exit(1)`.
pub fn run_src(client: &dyn HttpClient, options: &RunSrcOptions) -> Result<String> {
    run_src_with(client, options, &EnsureCheckoutDeps::default())
}

/// [`run_src`] with injectable checkout deps (tests pass an offline fetcher /
/// overridden ASK home).
pub fn run_src_with(
    client: &dyn HttpClient,
    options: &RunSrcOptions,
    deps: &EnsureCheckoutDeps,
) -> Result<String> {
    let result = ensure_checkout(
        client,
        &EnsureCheckoutOptions {
            spec: options.spec.clone(),
            project_dir: options.project_dir.clone(),
            no_fetch: options.no_fetch,
        },
        deps,
    )?;

    if options.json {
        let model = SrcModel {
            spec: options.spec.clone(),
            owner: result.owner,
            repo: result.repo,
            reference: result.reference,
            resolved_version: result.resolved_version,
            checkout_dir: result.checkout_dir.to_string_lossy().into_owned(),
            npm_package_name: result.npm_package_name,
        };
        Ok(serde_json::to_string_pretty(&model)?)
    } else {
        Ok(result.checkout_dir.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ensure_checkout::NoCacheError;
    use crate::http::mock::MockClient;
    use crate::store::github_store_path;

    fn deps_home(home: &std::path::Path) -> EnsureCheckoutDeps<'static> {
        EnsureCheckoutDeps {
            ask_home: Some(home.to_path_buf()),
            fetcher: None,
        }
    }

    #[test]
    fn prints_checkout_dir_on_cache_hit() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let dir =
            github_store_path(home.path(), "github.com", "facebook", "react", "v18.2.0").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let out = run_src_with(
            &MockClient::new(),
            &RunSrcOptions {
                spec: "github:facebook/react@v18.2.0".into(),
                project_dir: proj.path().to_path_buf(),
                no_fetch: false,
                json: false,
            },
            &deps_home(home.path()),
        )
        .unwrap();
        assert_eq!(out, dir.to_string_lossy());
    }

    #[test]
    fn json_output_matches_schema_field_names() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let dir =
            github_store_path(home.path(), "github.com", "facebook", "react", "v18.2.0").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let out = run_src_with(
            &MockClient::new(),
            &RunSrcOptions {
                spec: "github:facebook/react@v18.2.0".into(),
                project_dir: proj.path().to_path_buf(),
                no_fetch: false,
                json: true,
            },
            &deps_home(home.path()),
        )
        .unwrap();
        assert!(out.contains(r#""ref": "v18.2.0""#));
        assert!(out.contains(r#""resolvedVersion": "v18.2.0""#));
        assert!(out.contains(r#""npmPackageName": null"#));
        assert!(out.contains(r#""checkoutDir""#));
    }

    #[test]
    fn no_cache_error_propagates() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let err = run_src_with(
            &MockClient::new(),
            &RunSrcOptions {
                spec: "github:owner/repo@v1.2.3".into(),
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
