//! `ask fetch <spec...>` — warm the source cache for one or more specs without
//! printing paths. Rust port of `commands/fetch.ts` (itself ported from
//! opensrc's `opensrc fetch`, vercel-labs/opensrc#53).
//!
//! Per-spec failures are reported and the remaining specs still run; the CLI
//! exits non-zero at the end if any spec failed. `run_fetch` returns a
//! structured report so the streaming/exit behaviour is unit-testable offline.

use std::path::PathBuf;

use crate::commands::ensure_checkout::{
    ensure_checkout, EnsureCheckoutDeps, EnsureCheckoutOptions,
};
use crate::http::HttpClient;

/// Options for [`run_fetch`].
#[derive(Debug, Clone)]
pub struct RunFetchOptions {
    pub specs: Vec<String>,
    pub project_dir: PathBuf,
    pub quiet: bool,
}

/// Outcome of [`run_fetch`]. The CLI writes `stdout` lines to stdout, `stderr`
/// lines to stderr, and exits non-zero when `had_errors`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FetchReport {
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
    pub had_errors: bool,
}

/// Warm the cache for each spec via the shared checkout helper.
pub fn run_fetch(client: &dyn HttpClient, options: &RunFetchOptions) -> FetchReport {
    run_fetch_with(client, options, &EnsureCheckoutDeps::default())
}

/// [`run_fetch`] with injectable checkout deps.
pub fn run_fetch_with(
    client: &dyn HttpClient,
    options: &RunFetchOptions,
    deps: &EnsureCheckoutDeps,
) -> FetchReport {
    let mut report = FetchReport::default();
    let mut fetched = 0usize;
    let mut cached = 0usize;

    for spec in &options.specs {
        match ensure_checkout(
            client,
            &EnsureCheckoutOptions {
                spec: spec.clone(),
                project_dir: options.project_dir.clone(),
                no_fetch: false,
            },
            deps,
        ) {
            Ok(result) => {
                // Avoid `spec@ref` duplication when the user already pinned the
                // ref in the spec itself (e.g. `github:owner/repo@v1.2.3`).
                let suffix = format!("@{}", result.reference);
                let display = if spec.ends_with(&suffix) {
                    spec.clone()
                } else {
                    format!("{spec}{suffix}")
                };
                let path = result.checkout_dir.to_string_lossy();
                if result.from_cache {
                    cached += 1;
                    if !options.quiet {
                        report
                            .stdout
                            .push(format!("  ✓ {display} already cached ({path})"));
                    }
                } else {
                    fetched += 1;
                    if !options.quiet {
                        report
                            .stdout
                            .push(format!("  ✓ Fetched {display} ({path})"));
                    }
                }
            }
            Err(err) => {
                report.had_errors = true;
                report.stderr.push(format!("  ✗ {spec}: {err}"));
            }
        }
    }

    if !options.quiet {
        let mut parts: Vec<String> = Vec::new();
        if fetched > 0 {
            parts.push(format!("{fetched} fetched"));
        }
        if cached > 0 {
            parts.push(format!("{cached} already cached"));
        }
        if !parts.is_empty() {
            report.stdout.push(format!("\n{}", parts.join(", ")));
        }
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;
    use crate::store::github_store_path;

    fn deps_home(home: &std::path::Path) -> EnsureCheckoutDeps<'static> {
        EnsureCheckoutDeps {
            ask_home: Some(home.to_path_buf()),
            fetcher: None,
        }
    }

    #[test]
    fn reports_already_cached_without_duplicating_ref() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let dir = github_store_path(home.path(), "github.com", "owner", "repo", "v1.2.3").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let report = run_fetch_with(
            &MockClient::new(),
            &RunFetchOptions {
                specs: vec!["github:owner/repo@v1.2.3".into()],
                project_dir: proj.path().to_path_buf(),
                quiet: false,
            },
            &deps_home(home.path()),
        );
        assert!(!report.had_errors);
        // The spec already ends with @v1.2.3 — no `@v1.2.3@v1.2.3` duplication.
        assert!(report.stdout[0].contains("github:owner/repo@v1.2.3 already cached"));
        assert!(!report.stdout[0].contains("v1.2.3@v1.2.3"));
        assert!(report.stdout.last().unwrap().contains("1 already cached"));
    }

    #[test]
    fn per_spec_failure_sets_error_and_continues() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        // First spec resolves (cache hit); second is an unsupported ecosystem.
        let dir = github_store_path(home.path(), "github.com", "owner", "repo", "v1.0.0").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let report = run_fetch_with(
            &MockClient::new(),
            &RunFetchOptions {
                specs: vec![
                    "github:owner/repo@v1.0.0".into(),
                    "cargo:serde".into(), // no resolver for cargo
                ],
                project_dir: proj.path().to_path_buf(),
                quiet: false,
            },
            &deps_home(home.path()),
        );
        assert!(report.had_errors);
        assert_eq!(report.stderr.len(), 1);
        assert!(report.stderr[0].contains("cargo:serde"));
        // The good spec still succeeded.
        assert!(report.stdout.iter().any(|l| l.contains("already cached")));
    }

    #[test]
    fn quiet_suppresses_stdout_but_keeps_errors() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let report = run_fetch_with(
            &MockClient::new(),
            &RunFetchOptions {
                specs: vec!["cargo:serde".into()],
                project_dir: proj.path().to_path_buf(),
                quiet: true,
            },
            &deps_home(home.path()),
        );
        assert!(report.had_errors);
        assert!(report.stdout.is_empty());
        assert_eq!(report.stderr.len(), 1);
    }
}
