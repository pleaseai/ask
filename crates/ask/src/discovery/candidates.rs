//! Offline-first docs-candidate discovery for `ask add`. Rust port of
//! `discovery/candidates.ts`.
//!
//! Two locations are probed without ever triggering a network fetch:
//!   1. `node_modules/<pkg>/` for npm specs with a local install.
//!   2. The cached git checkout via `ensure_checkout(no_fetch: true)`.
//!
//! A cache miss is NOT an error — it yields fewer groups so the caller can
//! silently skip the docs-path prompt. Only genuinely unexpected failures
//! (malformed spec, bad ecosystem) surface as [`CandidateGatheringError`].

use std::path::{Path, PathBuf};

use crate::commands::ensure_checkout::{
    ensure_checkout, EnsureCheckoutDeps, EnsureCheckoutOptions, NoCacheError,
};
use crate::commands::find_doc_paths::find_doc_like_paths;
use crate::http::HttpClient;
use crate::spec::{parse_spec, split_explicit_version, ParsedSpec};

/// A contiguous discovery region. `root` is the directory the paths are
/// relative to when persisted; `paths` are absolute candidate docs directories
/// (or the fallback `[root]` when no `/doc/i` subdirs exist).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateGroup {
    pub root: PathBuf,
    pub paths: Vec<PathBuf>,
}

/// Raised only for unexpected failures (malformed spec, resolver error). A
/// missing cache or offline state is NOT an error — it yields zero groups.
/// Parity with the TS `CandidateGatheringError`, preserving the underlying
/// cause so `ask add` can print `err.cause.message`.
#[derive(Debug, thiserror::Error)]
#[error("could not gather docs candidates for {spec}: {cause}")]
pub struct CandidateGatheringError {
    pub spec: String,
    #[source]
    pub cause: anyhow::Error,
}

/// Gather candidate documentation directories for `spec` without triggering a
/// network fetch. Returns an empty vec when nothing is available — the caller
/// treats that as "skip the prompt, persist the spec without an override".
pub fn gather_docs_candidates(
    client: &dyn HttpClient,
    spec: &str,
    project_dir: &Path,
    deps: &EnsureCheckoutDeps,
) -> Result<Vec<CandidateGroup>, CandidateGatheringError> {
    let mut groups: Vec<CandidateGroup> = Vec::new();

    // 1. Direct node_modules probe for npm specs — no resolver hop.
    let (spec_body, _) = split_explicit_version(spec);
    if let ParsedSpec::Npm { pkg, .. } = parse_spec(spec_body) {
        let nm_path = project_dir.join("node_modules").join(&pkg);
        if nm_path.exists() {
            let paths = find_doc_like_paths(&nm_path);
            groups.push(CandidateGroup {
                root: nm_path,
                paths,
            });
        }
    }

    // 2. Cached checkout probe. `no_fetch: true` so a cache miss is a silent
    //    skip — we do NOT trigger a clone from `ask add`.
    match ensure_checkout(
        client,
        &EnsureCheckoutOptions {
            spec: spec.to_string(),
            project_dir: project_dir.to_path_buf(),
            no_fetch: true,
        },
        deps,
    ) {
        Ok(result) => {
            let paths = find_doc_like_paths(&result.checkout_dir);
            groups.push(CandidateGroup {
                root: result.checkout_dir,
                paths,
            });
            Ok(groups)
        }
        Err(err) => {
            // Expected on first add of a never-fetched spec — skip the checkout
            // group and proceed with whatever we collected.
            if err.downcast_ref::<NoCacheError>().is_some() {
                return Ok(groups);
            }
            // Malformed spec / bad ecosystem — a programmer-level problem.
            // Wrap to preserve the spec for caller diagnostics.
            Err(CandidateGatheringError {
                spec: spec.to_string(),
                cause: err,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;
    use crate::store::github_store_path;

    #[test]
    fn npm_local_install_yields_node_modules_group() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        // Local install with a docs dir.
        let pkg_docs = proj.path().join("node_modules/react/docs");
        std::fs::create_dir_all(&pkg_docs).unwrap();
        std::fs::write(pkg_docs.join("index.md"), "hi").unwrap();

        // npm resolver hits the registry even with no_fetch (it needs owner/repo
        // to compute the store path). Mock it so resolution succeeds, then the
        // uncached checkout yields a NoCacheError → checkout group is skipped,
        // leaving only the node_modules group.
        let client = MockClient::new().with(
            "https://registry.npmjs.org/react",
            200,
            r#"{"dist-tags":{},"versions":{"18.3.1":{}},"repository":{"url":"https://github.com/facebook/react.git"}}"#,
        );
        let deps = EnsureCheckoutDeps {
            ask_home: Some(home.path().to_path_buf()),
            fetcher: None,
        };
        let groups =
            gather_docs_candidates(&client, "npm:react@18.3.1", proj.path(), &deps).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].root, proj.path().join("node_modules/react"));
        assert!(groups[0].paths.iter().any(|p| p.ends_with("docs")));
    }

    #[test]
    fn cached_checkout_yields_group() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let dir = github_store_path(home.path(), "github.com", "o", "r", "v1.0.0").unwrap();
        std::fs::create_dir_all(dir.join("doc")).unwrap();

        let deps = EnsureCheckoutDeps {
            ask_home: Some(home.path().to_path_buf()),
            fetcher: None,
        };
        let groups =
            gather_docs_candidates(&MockClient::new(), "github:o/r@v1.0.0", proj.path(), &deps)
                .unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].root, dir);
    }

    #[test]
    fn no_cache_is_silent_skip_not_error() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let deps = EnsureCheckoutDeps {
            ask_home: Some(home.path().to_path_buf()),
            fetcher: None,
        };
        // Uncached github spec, no node_modules → zero groups, no error.
        let groups =
            gather_docs_candidates(&MockClient::new(), "github:o/r@v9.9.9", proj.path(), &deps)
                .unwrap();
        assert!(groups.is_empty());
    }
}
