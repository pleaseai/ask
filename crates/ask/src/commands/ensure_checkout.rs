//! Shared checkout resolver for `ask src` / `ask docs` / `ask fetch` / `ask add`.
//! Rust port of `commands/ensure-checkout.ts`.
//!
//! Given a spec (optionally `@version`-suffixed), resolve owner/repo/ref, and
//! ensure the GitHub checkout exists in the global store — triggering the
//! `github::fetch` pipeline on a cache miss (unless `no_fetch`). Both `ask src`
//! and `ask docs` share this fetch path, version resolution, and cache layout;
//! they only differ in what they print afterwards.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};

use crate::http::HttpClient;
use crate::lockfiles::npm_ecosystem_read;
use crate::resolvers::get_resolver;
use crate::sources::github::{self, GithubOptions};
use crate::sources::FetchResult;
use crate::spec::{parse_spec, split_explicit_version, ParsedSpec};
use crate::store::{github_store_path, resolve_ask_home};

const DEFAULT_GITHUB_HOST: &str = "github.com";

/// Options for [`ensure_checkout`].
#[derive(Debug, Clone)]
pub struct EnsureCheckoutOptions {
    /// User-supplied spec, optionally with a trailing `@version` suffix.
    pub spec: String,
    /// Project root used for lockfile lookups.
    pub project_dir: PathBuf,
    /// When true, return cache hits only and error with [`NoCacheError`] on miss.
    pub no_fetch: bool,
}

/// Result of a successful [`ensure_checkout`].
#[derive(Debug, Clone)]
pub struct EnsureCheckoutResult {
    pub parsed: ParsedSpec,
    pub owner: String,
    pub repo: String,
    pub reference: String,
    pub resolved_version: String,
    /// Absolute path to `~/.ask/github/<host>/<owner>/<repo>/<ref>/`.
    pub checkout_dir: PathBuf,
    /// For npm-ecosystem specs, the package name (e.g. `react`, `@vercel/ai`).
    /// Used by `ask docs` to additionally walk `node_modules/<pkg>/`.
    pub npm_package_name: Option<String>,
    /// True when the checkout was already in the store (no network fetch).
    pub from_cache: bool,
}

/// Error returned when `no_fetch` is set and the checkout is not cached.
///
/// Carries enough context for callers to print a helpful message and, for
/// `ask add`'s offline-first path, to silently skip the cached-checkout group.
#[derive(Debug, thiserror::Error)]
#[error("no cached checkout for {spec} (expected at {checkout_dir})")]
pub struct NoCacheError {
    pub checkout_dir: PathBuf,
    pub spec: String,
}

/// The fetch step, injected so tests can exercise `ensure_checkout` offline.
///
/// Mirrors TS `deps.fetcher`. The production impl forwards to
/// [`github::fetch`]; a returned `None` models a test seam that materializes
/// the checkout dir without building a real [`FetchResult`].
pub trait CheckoutFetcher {
    fn fetch(
        &self,
        client: &dyn HttpClient,
        opts: &GithubOptions,
        ask_home: &Path,
    ) -> Result<Option<FetchResult>>;
}

/// Production fetcher: the real `github::fetch` clone/tarball pipeline.
pub struct GithubCheckoutFetcher;

impl CheckoutFetcher for GithubCheckoutFetcher {
    fn fetch(
        &self,
        client: &dyn HttpClient,
        opts: &GithubOptions,
        ask_home: &Path,
    ) -> Result<Option<FetchResult>> {
        github::fetch(client, opts, ask_home).map(Some)
    }
}

/// Test seams — production callers pass [`EnsureCheckoutDeps::default`].
#[derive(Default)]
pub struct EnsureCheckoutDeps<'a> {
    /// Override the resolved ASK home (default: [`resolve_ask_home`]).
    pub ask_home: Option<PathBuf>,
    /// Override the fetch step (default: [`GithubCheckoutFetcher`]).
    pub fetcher: Option<&'a dyn CheckoutFetcher>,
}

/// Ensure the GitHub checkout for `spec` exists in the store and return its
/// absolute path. On cache miss, triggers `github::fetch` (bare clone preferred,
/// tar.gz fallback) unless `no_fetch` is set.
pub fn ensure_checkout(
    client: &dyn HttpClient,
    options: &EnsureCheckoutOptions,
    deps: &EnsureCheckoutDeps,
) -> Result<EnsureCheckoutResult> {
    let ask_home = deps.ask_home.clone().unwrap_or_else(resolve_ask_home);
    let default_fetcher = GithubCheckoutFetcher;
    let fetcher: &dyn CheckoutFetcher = deps.fetcher.unwrap_or(&default_fetcher);

    // 1. Split @version from the spec, then 2. parse the body.
    let (spec_body, explicit_version) = split_explicit_version(&options.spec);
    let parsed = parse_spec(spec_body);

    // 3. Determine owner, repo, ref, resolved_version (and npm_package_name).
    let owner: String;
    let repo: String;
    let reference: String;
    let resolved_version: String;
    let mut npm_package_name: Option<String> = None;
    let mut fallback_refs: Vec<String> = Vec::new();
    let mut is_from_branch = false;
    // A bare `github:owner/repo` with no explicit @ref defaults to 'main' for the
    // cache key, but must leave BOTH tag and branch unset so `github::fetch`
    // applies its default-branch fallback chain (main → vmain → master). Passing
    // `branch: 'main'` would lock repos whose default is `master` out.
    let mut is_implicit_default_ref = false;

    match &parsed {
        ParsedSpec::Github {
            owner: o, repo: r, ..
        } => {
            owner = o.clone();
            repo = r.clone();
            reference = explicit_version.unwrap_or("main").to_string();
            resolved_version = reference.clone();
            is_from_branch = explicit_version.is_none(); // 'main' is a branch
            is_implicit_default_ref = explicit_version.is_none();
        }
        _ => {
            // npm-prefixed, bare-name, or another ecosystem prefix → resolver.
            let ecosystem = match &parsed {
                ParsedSpec::Npm { .. } => "npm",
                ParsedSpec::Unknown { ecosystem, .. } if ecosystem.is_empty() => "npm", // bare name
                ParsedSpec::Unknown { ecosystem, .. } => ecosystem.as_str(),
                ParsedSpec::Github { .. } => unreachable!(),
            };
            let pkg_name = match &parsed {
                ParsedSpec::Npm { pkg, .. } => pkg.clone(),
                ParsedSpec::Unknown { payload, .. } => payload.clone(),
                ParsedSpec::Github { .. } => unreachable!(),
            };
            if ecosystem == "npm" {
                npm_package_name = Some(pkg_name.clone());
            }

            let Some(resolver) = get_resolver(ecosystem) else {
                bail!(
                    "unsupported ecosystem '{ecosystem}' for spec '{}'. \
                     Supported ecosystems: npm, pypi, pub, maven",
                    options.spec
                );
            };

            // Version priority: explicit @version > lockfile (npm only) > 'latest'.
            let query_version = match explicit_version {
                Some(v) => v.to_string(),
                None => {
                    let from_lock = if ecosystem == "npm" {
                        npm_ecosystem_read(&pkg_name, &options.project_dir).map(|h| h.version)
                    } else {
                        None
                    };
                    from_lock.unwrap_or_else(|| "latest".to_string())
                }
            };

            let result = resolver(client, &pkg_name, &query_version)?;
            let Some((o, r)) = result.repo.split_once('/') else {
                bail!(
                    "resolver returned malformed repo '{}' for spec '{}'",
                    result.repo,
                    options.spec
                );
            };
            owner = o.to_string();
            repo = r.to_string();
            reference = result.ref_;
            resolved_version = result.resolved_version;
            fallback_refs = result.fallback_refs;
        }
    }

    // 4. Compute the cache directory (PM-unified layout, shared with
    //    `github::fetch`). If these two ever diverge, output silently vanishes.
    let checkout_dir =
        github_store_path(&ask_home, DEFAULT_GITHUB_HOST, &owner, &repo, &reference)?;

    // 5. Cache hit short-circuit.
    if checkout_dir.exists() {
        return Ok(EnsureCheckoutResult {
            parsed,
            owner,
            repo,
            reference,
            resolved_version,
            checkout_dir,
            npm_package_name,
            from_cache: true,
        });
    }

    // 6. Cache miss + no_fetch → error.
    if options.no_fetch {
        return Err(NoCacheError {
            checkout_dir,
            spec: options.spec.clone(),
        }
        .into());
    }

    // 7. Trigger the fetch. For implicit default refs, pass NEITHER tag nor
    //    branch so `github::fetch` can activate its default-branch fallback.
    //    `skip_doc_extraction: true` — callers walk the tree themselves and
    //    must not fail on repos without a conventional `docs/` folder.
    let (branch, tag) = if is_implicit_default_ref {
        (None, None)
    } else if is_from_branch {
        (Some(reference.clone()), None)
    } else {
        (None, Some(reference.clone()))
    };
    let opts = GithubOptions {
        name: parsed.name().to_string(),
        version: resolved_version.clone(),
        repo: format!("{owner}/{repo}"),
        branch,
        tag,
        docs_path: None,
        fallback_refs,
        remote_url: None,
        skip_doc_extraction: true,
    };
    let fetch_result = fetcher.fetch(client, &opts, &ask_home)?;

    // 8. Prefer the fetcher's on-disk path: a winning fallbackRef or a
    //    `v<ref>`-rescued ref lands under a DIFFERENT dir than the requested
    //    ref. Returning the primary-ref path would reproduce the empty-output
    //    bug on the ref-candidate axis.
    let resolved_checkout_dir = fetch_result
        .as_ref()
        .and_then(|r| r.store_path.clone())
        .unwrap_or_else(|| checkout_dir.clone());

    // Keep `ref` consistent with the actual checkout dir. Prefer the
    // fetcher's `meta.ref` (the real winning ref) over the checkout's
    // basename — slash-containing tags like `@tanstack/react-query@5.101.2`
    // are encoded (`/` → `__`) in the directory name, so the basename is
    // only a fallback for fetchers that do not report `meta.ref`.
    let actual_ref = if resolved_checkout_dir == checkout_dir {
        reference
    } else {
        fetch_result
            .as_ref()
            .and_then(|r| r.meta.ref_.clone())
            .or_else(|| {
                resolved_checkout_dir
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
            })
            .unwrap_or(reference)
    };

    Ok(EnsureCheckoutResult {
        parsed,
        owner,
        repo,
        reference: actual_ref,
        resolved_version,
        checkout_dir: resolved_checkout_dir,
        npm_package_name,
        from_cache: fetch_result
            .as_ref()
            .map(|r| r.from_store_cache)
            .unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;

    /// A `MockClient` with no routes — resolvers never hit it in cache-hit /
    /// direct-github tests, so any call is a bug the panic surfaces.
    fn no_http() -> MockClient {
        MockClient::new()
    }

    fn opts(spec: &str, project_dir: &Path, no_fetch: bool) -> EnsureCheckoutOptions {
        EnsureCheckoutOptions {
            spec: spec.to_string(),
            project_dir: project_dir.to_path_buf(),
            no_fetch,
        }
    }

    /// Fetcher that materializes the checkout dir (models a successful clone)
    /// and reports it back via `store_path` — no network, no git.
    struct MkdirFetcher {
        from_store_cache: bool,
    }
    impl CheckoutFetcher for MkdirFetcher {
        fn fetch(
            &self,
            _client: &dyn HttpClient,
            o: &GithubOptions,
            ask_home: &Path,
        ) -> Result<Option<FetchResult>> {
            let (owner, repo) = o.repo.split_once('/').unwrap();
            let reference = o
                .tag
                .clone()
                .or_else(|| o.branch.clone())
                .unwrap_or_else(|| "main".into());
            let dir = github_store_path(ask_home, DEFAULT_GITHUB_HOST, owner, repo, &reference)?;
            std::fs::create_dir_all(&dir)?;
            Ok(Some(FetchResult {
                files: Vec::new(),
                resolved_version: o.version.clone(),
                store_path: Some(dir),
                store_subpath: None,
                from_store_cache: self.from_store_cache,
                meta: Default::default(),
            }))
        }
    }

    #[test]
    fn github_direct_spec_cache_hit() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        // Pre-populate the store for facebook/react @ v18.2.0.
        let dir = github_store_path(
            home.path(),
            DEFAULT_GITHUB_HOST,
            "facebook",
            "react",
            "v18.2.0",
        )
        .unwrap();
        std::fs::create_dir_all(&dir).unwrap();

        let deps = EnsureCheckoutDeps {
            ask_home: Some(home.path().to_path_buf()),
            fetcher: None,
        };
        let res = ensure_checkout(
            &no_http(),
            &opts("github:facebook/react@v18.2.0", proj.path(), false),
            &deps,
        )
        .unwrap();
        assert_eq!(res.owner, "facebook");
        assert_eq!(res.repo, "react");
        assert_eq!(res.reference, "v18.2.0");
        assert_eq!(res.checkout_dir, dir);
        assert!(res.from_cache);
        assert!(res.npm_package_name.is_none());
    }

    #[test]
    fn github_bare_spec_defaults_to_main() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let dir =
            github_store_path(home.path(), DEFAULT_GITHUB_HOST, "owner", "repo", "main").unwrap();
        std::fs::create_dir_all(&dir).unwrap();

        let deps = EnsureCheckoutDeps {
            ask_home: Some(home.path().to_path_buf()),
            fetcher: None,
        };
        let res = ensure_checkout(
            &no_http(),
            &opts("github:owner/repo", proj.path(), false),
            &deps,
        )
        .unwrap();
        assert_eq!(res.reference, "main");
        assert_eq!(res.resolved_version, "main");
        assert!(res.from_cache);
    }

    #[test]
    fn no_fetch_miss_raises_no_cache_error() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let deps = EnsureCheckoutDeps {
            ask_home: Some(home.path().to_path_buf()),
            fetcher: None,
        };
        let err = ensure_checkout(
            &no_http(),
            &opts("github:owner/repo@v1.2.3", proj.path(), true),
            &deps,
        )
        .unwrap_err();
        let nce = err.downcast_ref::<NoCacheError>().expect("NoCacheError");
        assert_eq!(nce.spec, "github:owner/repo@v1.2.3");
        assert!(nce
            .checkout_dir
            .ends_with("github/github.com/owner/repo/v1.2.3"));
    }

    #[test]
    fn npm_spec_resolves_via_registry_then_cache_hit() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        // npm resolver expects registry.npmjs.org/<name>; react 18.3.1 → v18.3.1.
        let client = MockClient::new().with(
            "https://registry.npmjs.org/react",
            200,
            r#"{"dist-tags":{},"versions":{"18.3.1":{}},"repository":{"url":"https://github.com/facebook/react.git"}}"#,
        );
        // Pre-populate the resolved checkout so no fetch happens.
        let dir = github_store_path(
            home.path(),
            DEFAULT_GITHUB_HOST,
            "facebook",
            "react",
            "v18.3.1",
        )
        .unwrap();
        std::fs::create_dir_all(&dir).unwrap();

        let deps = EnsureCheckoutDeps {
            ask_home: Some(home.path().to_path_buf()),
            fetcher: None,
        };
        let res = ensure_checkout(
            &client,
            &opts("npm:react@18.3.1", proj.path(), false),
            &deps,
        )
        .unwrap();
        assert_eq!(res.owner, "facebook");
        assert_eq!(res.repo, "react");
        assert_eq!(res.reference, "v18.3.1");
        assert_eq!(res.resolved_version, "18.3.1");
        assert_eq!(res.npm_package_name.as_deref(), Some("react"));
        assert!(res.from_cache);
    }

    #[test]
    fn cache_miss_triggers_fetch_and_reports_store_path() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let fetcher = MkdirFetcher {
            from_store_cache: false,
        };
        let deps = EnsureCheckoutDeps {
            ask_home: Some(home.path().to_path_buf()),
            fetcher: Some(&fetcher),
        };
        let res = ensure_checkout(
            &no_http(),
            &opts("github:owner/repo@v9.9.9", proj.path(), false),
            &deps,
        )
        .unwrap();
        assert_eq!(res.reference, "v9.9.9");
        assert!(res.checkout_dir.exists());
        assert!(res
            .checkout_dir
            .ends_with("github/github.com/owner/repo/v9.9.9"));
        assert!(!res.from_cache);
    }

    #[test]
    fn npm_bare_name_treated_as_npm_ecosystem() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let client = MockClient::new().with(
            "https://registry.npmjs.org/react",
            200,
            r#"{"dist-tags":{},"versions":{"18.3.1":{}},"repository":{"url":"https://github.com/facebook/react.git"}}"#,
        );
        let dir = github_store_path(
            home.path(),
            DEFAULT_GITHUB_HOST,
            "facebook",
            "react",
            "v18.3.1",
        )
        .unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let deps = EnsureCheckoutDeps {
            ask_home: Some(home.path().to_path_buf()),
            fetcher: None,
        };
        // Bare `react` (no ecosystem prefix) → npm resolver.
        let res =
            ensure_checkout(&client, &opts("react@18.3.1", proj.path(), false), &deps).unwrap();
        assert_eq!(res.npm_package_name.as_deref(), Some("react"));
        assert_eq!(res.reference, "v18.3.1");
    }
}
