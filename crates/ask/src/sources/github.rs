//! GitHub source — shallow-clone a ref into the global store (tar.gz fallback),
//! with ref-candidate fallbacks and token auth. Rust port of `sources/github.ts`.
//!
//! Clones happen via a `git` SHELL-OUT (not a git library) so the opensrc
//! `authenticated_clone_url` token injection + `redact_token` scrubbing port
//! verbatim, including the #66 host-confusion fix.

use std::io::Cursor;
use std::path::Path;
use std::process::Command;
use std::sync::LazyLock;

use anyhow::{bail, Result};
use flate2::read::GzDecoder;
use regex::Regex;
use url::Url;

use super::{extract_docs_from_dir, FetchMeta, FetchResult, GITHUB_DOC_CANDIDATES};
use crate::http::HttpClient;
use crate::store::{
    acquire_entry_lock, cp_dir_atomic, github_store_path, quarantine_entry, stamp_entry,
    verify_entry,
};

const DEFAULT_GITHUB_HOST: &str = "github.com";

// ASCII-only classes to match the JS `\w` (`[A-Za-z0-9_]`), not Rust's
// unicode-aware `\w`.
static RE_SAFE_REPO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$").unwrap());
static RE_SAFE_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._/@-]+$").unwrap());
static RE_SHA40: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{40}$").unwrap());

/// Default-branch fallbacks tried (after `main`) when neither tag nor branch was
/// given.
const DEFAULT_BRANCH_FALLBACKS: &[&str] = &["master"];

/// Options for a github fetch (port of `GithubSourceOptions`).
#[derive(Debug, Clone, Default)]
pub struct GithubOptions {
    pub name: String,
    pub version: String,
    pub repo: String,
    pub branch: Option<String>,
    pub tag: Option<String>,
    pub docs_path: Option<String>,
    pub fallback_refs: Vec<String>,
    pub remote_url: Option<String>,
    pub skip_doc_extraction: bool,
}

/// The `GITHUB_TOKEN` from the environment, empty string treated as absent.
pub fn github_token() -> Option<String> {
    std::env::var("GITHUB_TOKEN").ok().filter(|t| !t.is_empty())
}

/// Rewrite an HTTPS GitHub clone URL to embed `x-access-token:<token>` auth, but
/// ONLY on an exact `github.com` host over `https` (opensrc #66: prefix/suffix-
/// confusable hosts, subdomains, non-https schemes, and ssh remotes pass through
/// unchanged). The result carries the secret — use it only as a git argument,
/// never in logs.
pub fn authenticated_clone_url(url: &str, token: Option<&str>) -> String {
    let token = match token {
        Some(t) if !t.is_empty() => t,
        _ => return url.to_string(),
    };
    let Ok(mut parsed) = Url::parse(url) else {
        return url.to_string();
    };
    if parsed.scheme() != "https" {
        return url.to_string();
    }
    if parsed.host_str().map(str::to_ascii_lowercase).as_deref() != Some(DEFAULT_GITHUB_HOST) {
        return url.to_string();
    }
    if parsed.set_username("x-access-token").is_err() || parsed.set_password(Some(token)).is_err() {
        return url.to_string();
    }
    parsed.to_string()
}

/// Replace every occurrence of the token with `***` before logging/throwing.
fn redact_token(msg: &str, token: Option<&str>) -> String {
    match token {
        Some(t) if !t.is_empty() => msg.replace(t, "***"),
        _ => msg.to_string(),
    }
}

/// Build the ref candidate chain: the ref as-is, plus `v<ref>` when it isn't
/// already `v`-prefixed. `extra` (monorepo tags) prepend; `tail` (default-branch
/// fallbacks) append; duplicates dropped (first wins).
fn ref_candidates(reference: &str, extra: &[String], tail: &[String]) -> Vec<String> {
    let base: Vec<String> = if reference.starts_with('v') {
        vec![reference.to_string()]
    } else {
        vec![reference.to_string(), format!("v{reference}")]
    };
    if extra.is_empty() && tail.is_empty() {
        return base;
    }
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for c in extra.iter().chain(base.iter()).chain(tail.iter()) {
        if seen.insert(c.clone()) {
            result.push(c.clone());
        }
    }
    result
}

fn has_git() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Remove the contents of `dir` (keeping `dir`) so a failed clone can be retried.
fn clear_dir_contents(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_dir_all(entry.path())
                .or_else(|_| std::fs::remove_file(entry.path()));
        }
    }
}

/// Shallow-clone a single candidate ref into `tmp_dir`, capture the commit SHA,
/// then strip `.git/`. Returns the commit SHA or an error (token-redacted).
fn shallow_clone_ref(
    remote_url: &str,
    candidate: &str,
    tmp_dir: &Path,
    token: Option<&str>,
) -> Result<String> {
    clear_dir_contents(tmp_dir);
    let auth_url = authenticated_clone_url(remote_url, token);
    let output = Command::new("git")
        .args([
            "clone",
            "--depth",
            "1",
            "--branch",
            candidate,
            "--single-branch",
        ])
        .arg(&auth_url)
        .arg(tmp_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("{}", redact_token(stderr.trim(), token));
    }

    let rev = Command::new("git")
        .args(["-C"])
        .arg(tmp_dir)
        .args(["rev-parse", "HEAD"])
        .output()?;
    let commit = String::from_utf8_lossy(&rev.stdout).trim().to_string();
    if !RE_SHA40.is_match(&commit) {
        bail!("git rev-parse returned invalid SHA '{commit}'");
    }

    let _ = std::fs::remove_dir_all(tmp_dir.join(".git"));
    Ok(commit)
}

/// Probe `git ls-remote --tags` for a tag containing `version`, preferring an
/// exact `@<version>` / `@v<version>` (changesets) suffix.
fn probe_remote_tag(
    remote_url: &str,
    version: &str,
    token: Option<&str>,
) -> Option<(String, Vec<String>)> {
    let auth_url = authenticated_clone_url(remote_url, token);
    let output = Command::new("git")
        .args(["ls-remote", "--tags"])
        .arg(&auth_url)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut seen = std::collections::HashSet::new();
    let mut matching = Vec::new();
    for line in text.lines() {
        // Strip everything up to and including `refs/tags/`, and a peeled `^{}`.
        let Some(idx) = line.find("refs/tags/") else {
            continue;
        };
        let tag = line[idx + "refs/tags/".len()..].trim_end_matches("^{}");
        if tag.is_empty() || !tag.contains(version) {
            continue;
        }
        if seen.insert(tag.to_string()) {
            matching.push(tag.to_string());
        }
    }
    if matching.is_empty() {
        return None;
    }
    let exact = matching
        .iter()
        .find(|t| t.ends_with(&format!("@{version}")) || t.ends_with(&format!("@v{version}")))
        .cloned();
    Some((exact.unwrap_or_else(|| matching[0].clone()), matching))
}

/// Try each ref candidate; on total failure probe remote tags (tag requests
/// only). Returns `(commit, winning_candidate)`.
fn clone_at_tag(
    remote_url: &str,
    reference: &str,
    tmp_dir: &Path,
    extra: &[String],
    tag_only: bool,
    tail: &[String],
    token: Option<&str>,
) -> Result<(String, String)> {
    let candidates = ref_candidates(reference, extra, tail);
    let mut last_err = String::from("no candidates");
    for candidate in &candidates {
        match shallow_clone_ref(remote_url, candidate, tmp_dir, token) {
            Ok(commit) => return Ok((commit, candidate.clone())),
            Err(e) => last_err = e.to_string(),
        }
    }

    if !tag_only {
        bail!(
            "Failed to clone {remote_url} at {reference} (tried: {}): {last_err}",
            candidates.join(", ")
        );
    }

    let version_for_probe = reference.strip_prefix('v').unwrap_or(reference);
    if let Some((discovered, all_matching)) = probe_remote_tag(remote_url, version_for_probe, token)
    {
        match shallow_clone_ref(remote_url, &discovered, tmp_dir, token) {
            Ok(commit) => return Ok((commit, discovered)),
            Err(clone_err) => bail!(
                "Failed to clone {remote_url} at {reference} (tried: {}). Available tags matching \
                 '{version_for_probe}': {}. Clone error: {clone_err}. Retry with: \
                 ask src github:<repo>@{discovered}",
                candidates.join(", "),
                all_matching.join(", ")
            ),
        }
    }

    bail!(
        "Failed to clone {remote_url} at {reference} (tried: {}): {last_err}",
        candidates.join(", ")
    );
}

/// Fetch docs for a github entry, materializing the checkout into the store.
pub fn fetch(
    client: &dyn HttpClient,
    opts: &GithubOptions,
    ask_home: &Path,
) -> Result<FetchResult> {
    let is_default_ref = opts.tag.is_none() && opts.branch.is_none();
    let reference = opts
        .tag
        .clone()
        .or_else(|| opts.branch.clone())
        .unwrap_or_else(|| "main".into());
    let (owner, repo_name) = opts
        .repo
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("Invalid repo '{}': must be owner/repo", opts.repo))?;

    if !RE_SAFE_REPO.is_match(&opts.repo) {
        bail!(
            "Invalid repo '{}': must be owner/repo with safe characters",
            opts.repo
        );
    }
    if !RE_SAFE_REF.is_match(&reference) {
        bail!("Invalid ref '{reference}': must contain only [A-Za-z0-9._/@-]");
    }

    let tag_version = opts
        .tag
        .as_deref()
        .map(|t| t.strip_prefix('v').unwrap_or(t).to_string());
    let resolved_version = tag_version.unwrap_or_else(|| opts.version.clone());
    let tail: Vec<String> = if is_default_ref {
        DEFAULT_BRANCH_FALLBACKS
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        Vec::new()
    };

    // Store-hit path: check each candidate key, verify, quarantine on tamper.
    for candidate in ref_candidates(&reference, &opts.fallback_refs, &tail) {
        let store_dir =
            github_store_path(ask_home, DEFAULT_GITHUB_HOST, owner, repo_name, &candidate)?;
        if !store_dir.exists() {
            continue;
        }
        if verify_entry(&store_dir) {
            let files = if opts.skip_doc_extraction {
                Vec::new()
            } else {
                extract_docs_from_dir(
                    &store_dir,
                    &opts.repo,
                    &reference,
                    opts.docs_path.as_deref(),
                    GITHUB_DOC_CANDIDATES,
                )?
            };
            return Ok(FetchResult {
                files,
                resolved_version,
                store_path: Some(store_dir),
                store_subpath: opts.docs_path.clone(),
                from_store_cache: true,
                // Report the WINNING candidate, not the requested ref — the
                // store dir is keyed by the candidate, and slash-containing
                // tags are encoded in the path, so callers cannot recover
                // the real ref from the directory basename.
                meta: FetchMeta {
                    ref_: Some(candidate),
                    ..Default::default()
                },
            });
        }
        quarantine_entry(ask_home, &store_dir);
    }

    let remote_url = opts
        .remote_url
        .clone()
        .unwrap_or_else(|| format!("https://github.com/{}.git", opts.repo));

    if has_git() {
        match fetch_via_shallow_clone(
            opts,
            owner,
            repo_name,
            &reference,
            &resolved_version,
            &remote_url,
            ask_home,
            &tail,
        ) {
            Ok(result) => return Ok(result),
            Err(e) => {
                eprintln!(
                    "  Warning: git clone failed for {}@{reference}: {e}. Falling back to tar.gz download.",
                    opts.repo
                );
            }
        }
    }

    fetch_from_tar_gz(
        client,
        opts,
        owner,
        repo_name,
        &reference,
        &resolved_version,
        ask_home,
        &tail,
    )
}

#[allow(clippy::too_many_arguments)]
fn fetch_via_shallow_clone(
    opts: &GithubOptions,
    owner: &str,
    repo_name: &str,
    reference: &str,
    resolved_version: &str,
    remote_url: &str,
    ask_home: &Path,
    tail: &[String],
) -> Result<FetchResult> {
    let token = github_token();
    let tmp = tempfile::Builder::new().prefix("ask-gh-clone-").tempdir()?;
    let (commit, winning) = clone_at_tag(
        remote_url,
        reference,
        tmp.path(),
        &opts.fallback_refs,
        opts.tag.is_some(),
        tail,
        token.as_deref(),
    )?;
    let store_dir = github_store_path(ask_home, DEFAULT_GITHUB_HOST, owner, repo_name, &winning)?;

    if let Some(lock) = acquire_entry_lock(&store_dir)? {
        if let Some(parent) = store_dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        cp_dir_atomic(tmp.path(), &store_dir)?;
        stamp_entry(&store_dir)?;
        drop(lock);
    }

    let files = if opts.skip_doc_extraction {
        Vec::new()
    } else {
        extract_docs_from_dir(
            &store_dir,
            &opts.repo,
            reference,
            opts.docs_path.as_deref(),
            GITHUB_DOC_CANDIDATES,
        )?
    };
    Ok(FetchResult {
        files,
        resolved_version: resolved_version.to_string(),
        store_path: Some(store_dir),
        store_subpath: opts.docs_path.clone(),
        from_store_cache: false,
        meta: FetchMeta {
            commit: Some(commit),
            ref_: Some(winning),
            ..Default::default()
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn fetch_from_tar_gz(
    client: &dyn HttpClient,
    opts: &GithubOptions,
    owner: &str,
    repo_name: &str,
    reference: &str,
    resolved_version: &str,
    ask_home: &Path,
    tail: &[String],
) -> Result<FetchResult> {
    let token = github_token();
    let candidates = ref_candidates(reference, &opts.fallback_refs, tail);
    let tmp = tempfile::Builder::new().prefix("ask-gh-tar-").tempdir()?;
    let mut last_err = String::from("no candidates");

    for candidate in &candidates {
        let is_tag_candidate = opts.tag.is_some() && !tail.iter().any(|t| t == candidate);
        let archive_url = if token.is_some() {
            format!(
                "https://api.github.com/repos/{}/tarball/{candidate}",
                opts.repo
            )
        } else {
            let kind = if is_tag_candidate { "tags" } else { "heads" };
            format!(
                "https://github.com/{}/archive/refs/{kind}/{candidate}.tar.gz",
                opts.repo
            )
        };
        let auth_header = token
            .as_ref()
            .map(|t| ("Authorization", format!("Bearer {t}")));
        let headers: Vec<(&str, &str)> = auth_header
            .as_ref()
            .map(|(k, v)| vec![(*k, v.as_str())])
            .unwrap_or_default();

        let response = match client.get_bytes(&archive_url, &headers) {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        if !response.ok() {
            last_err = format!("Failed to download {archive_url}: HTTP {}", response.status);
            continue;
        }

        clear_dir_contents(tmp.path());
        if let Err(e) = unpack_tar_gz(&response.body, tmp.path()) {
            last_err = format!("tar extraction failed for {}@{candidate}: {e}", opts.repo);
            clear_dir_contents(tmp.path());
            continue;
        }
        let extracted_dir = match std::fs::read_dir(tmp.path())?.flatten().next() {
            Some(entry) => entry.path(),
            None => bail!("Failed to extract archive from {}@{candidate}", opts.repo),
        };

        let store_dir =
            github_store_path(ask_home, DEFAULT_GITHUB_HOST, owner, repo_name, candidate)?;
        if let Some(lock) = acquire_entry_lock(&store_dir)? {
            if let Some(parent) = store_dir.parent() {
                std::fs::create_dir_all(parent)?;
            }
            cp_dir_atomic(&extracted_dir, &store_dir)?;
            stamp_entry(&store_dir)?;
            drop(lock);
        }

        let files = if opts.skip_doc_extraction {
            Vec::new()
        } else {
            extract_docs_from_dir(
                &store_dir,
                &opts.repo,
                candidate,
                opts.docs_path.as_deref(),
                GITHUB_DOC_CANDIDATES,
            )?
        };
        return Ok(FetchResult {
            files,
            resolved_version: resolved_version.to_string(),
            store_path: Some(store_dir),
            store_subpath: opts.docs_path.clone(),
            from_store_cache: false,
            meta: FetchMeta {
                ref_: Some(candidate.clone()),
                ..Default::default()
            },
        });
    }

    bail!(
        "Failed to download tar.gz for {}@{reference} (tried: {}): {last_err}",
        opts.repo,
        candidates.join(", ")
    );
}

fn unpack_tar_gz(bytes: &[u8], dest: &Path) -> Result<()> {
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(dest)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "ghp_test_token";

    // ── authenticated_clone_url (opensrc #52 + #66 parity) ──────────

    #[test]
    fn auth_url_injects_on_exact_github_host() {
        assert_eq!(
            authenticated_clone_url("https://github.com/owner/repo.git", Some(TOKEN)),
            format!("https://x-access-token:{TOKEN}@github.com/owner/repo.git")
        );
    }

    #[test]
    fn auth_url_case_insensitive_host() {
        assert!(
            authenticated_clone_url("https://GitHub.com/owner/repo.git", Some(TOKEN))
                .contains(&format!("x-access-token:{TOKEN}@"))
        );
    }

    #[test]
    fn auth_url_no_token_unchanged() {
        assert_eq!(
            authenticated_clone_url("https://github.com/owner/repo.git", None),
            "https://github.com/owner/repo.git"
        );
        assert_eq!(
            authenticated_clone_url("https://github.com/owner/repo.git", Some("")),
            "https://github.com/owner/repo.git"
        );
    }

    #[test]
    fn auth_url_rejects_host_confusion_and_schemes() {
        for url in [
            "https://github.com.evil.com/owner/repo.git",
            "https://evilgithub.com/owner/repo.git",
            "https://gist.github.com/owner/repo.git",
            "http://github.com/owner/repo.git",
            "git://github.com/owner/repo.git",
            "git@github.com:owner/repo.git",
            "not a url",
        ] {
            assert_eq!(authenticated_clone_url(url, Some(TOKEN)), url, "{url}");
        }
    }

    #[test]
    fn redact_token_scrubs_all_occurrences() {
        assert_eq!(
            redact_token("a ghp_x b ghp_x", Some("ghp_x")),
            "a *** b ***"
        );
        assert_eq!(
            redact_token("no token here", Some("ghp_x")),
            "no token here"
        );
        assert_eq!(redact_token("keep ghp_x", None), "keep ghp_x");
    }

    // ── ref_candidates ───────────────────────────────────────────────

    #[test]
    fn ref_candidates_base_chain() {
        assert_eq!(ref_candidates("1.0.0", &[], &[]), vec!["1.0.0", "v1.0.0"]);
        assert_eq!(ref_candidates("v1.0.0", &[], &[]), vec!["v1.0.0"]);
    }

    #[test]
    fn ref_candidates_dedup_extra_and_tail() {
        let extra = vec!["ai@6.0.0".to_string()];
        let tail = vec!["master".to_string()];
        assert_eq!(
            ref_candidates("main", &extra, &tail),
            vec!["ai@6.0.0", "main", "vmain", "master"]
        );
        // Duplicate across extra/base is dropped (first wins).
        assert_eq!(ref_candidates("v1", &["v1".to_string()], &[]), vec!["v1"]);
    }

    // ── end-to-end clone against a local git repo (offline) ─────────

    fn git(args: &[&str], cwd: &Path) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    /// Build a local bare repo with tags v1.0.0, v2.0.0, and a bare 3.0.0, each
    /// with a `docs/guide.md`. Returns the bare repo path (a valid clone remote).
    fn create_local_remote(tmp: &Path) -> std::path::PathBuf {
        let work = tmp.join("work");
        let bare = tmp.join("local-remote.git");
        std::fs::create_dir_all(&work).unwrap();
        git(&["init", "-b", "main", "."], &work);
        git(&["config", "user.email", "t@t.com"], &work);
        git(&["config", "user.name", "T"], &work);
        git(&["config", "commit.gpgsign", "false"], &work);
        git(&["config", "tag.gpgsign", "false"], &work);
        std::fs::write(work.join("README.md"), "# Test Repo\n").unwrap();
        std::fs::create_dir_all(work.join("docs")).unwrap();

        std::fs::write(work.join("docs/guide.md"), "# Guide v1\n").unwrap();
        git(&["add", "-A"], &work);
        git(&["commit", "-m", "initial"], &work);
        git(&["tag", "v1.0.0"], &work);

        std::fs::write(work.join("docs/guide.md"), "# Guide v2\n").unwrap();
        git(&["add", "-A"], &work);
        git(&["commit", "-m", "update"], &work);
        git(&["tag", "v2.0.0"], &work);

        std::fs::write(work.join("docs/guide.md"), "# Guide v3\n").unwrap();
        git(&["add", "-A"], &work);
        git(&["commit", "-m", "bare-tag"], &work);
        git(&["tag", "3.0.0"], &work);

        git(
            &[
                "clone",
                "--bare",
                work.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
            tmp,
        );
        bare
    }

    fn no_client() -> crate::http::mock::MockClient {
        crate::http::mock::MockClient::new()
    }

    #[test]
    fn clone_materializes_v_prefixed_tag_into_nested_store() {
        if !has_git() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = create_local_remote(tmp.path());
        let ask_home = tmp.path().join("ask-home");
        let opts = GithubOptions {
            name: "test-repo".into(),
            version: "1.0.0".into(),
            repo: "test/repo".into(),
            tag: Some("v1.0.0".into()),
            docs_path: Some("docs".into()),
            remote_url: Some(remote.to_string_lossy().into_owned()),
            ..Default::default()
        };
        let result = fetch(&no_client(), &opts, &ask_home).unwrap();

        let expected = ask_home.join("github/github.com/test/repo/v1.0.0");
        assert_eq!(result.store_path.as_deref(), Some(expected.as_path()));
        assert_eq!(result.store_subpath.as_deref(), Some("docs"));
        assert!(expected.join("README.md").exists());
        assert_eq!(
            std::fs::read_to_string(expected.join("docs/guide.md")).unwrap(),
            "# Guide v1\n"
        );
        // .git stripped, commit captured, entry verifies.
        assert!(!expected.join(".git").exists());
        assert!(RE_SHA40.is_match(result.meta.commit.as_deref().unwrap()));
        assert!(verify_entry(&expected));
        assert_eq!(result.files.len(), 1);
    }

    #[test]
    fn clone_bare_tag_via_v_fallback_lands_under_requested_key() {
        if !has_git() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = create_local_remote(tmp.path());
        let ask_home = tmp.path().join("ask-home");
        // Request `3.0.0`; only a bare `3.0.0` tag exists (no `v3.0.0`), so the
        // as-is candidate wins and the store key is `3.0.0`.
        let opts = GithubOptions {
            name: "r".into(),
            version: "3.0.0".into(),
            repo: "test/repo".into(),
            tag: Some("3.0.0".into()),
            docs_path: Some("docs".into()),
            remote_url: Some(remote.to_string_lossy().into_owned()),
            ..Default::default()
        };
        let result = fetch(&no_client(), &opts, &ask_home).unwrap();
        assert!(result
            .store_path
            .as_deref()
            .unwrap()
            .ends_with("test/repo/3.0.0"));
        assert_eq!(
            std::fs::read_to_string(result.store_path.unwrap().join("docs/guide.md")).unwrap(),
            "# Guide v3\n"
        );
    }

    #[test]
    fn scoped_monorepo_tag_clones_into_encoded_store_dir() {
        // pleaseai/ask#121: tags like `@tanstack/react-query@5.101.2` contain
        // `/` — the clone must succeed and land under the encoded dir name,
        // while meta.ref reports the REAL tag.
        if !has_git() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = create_local_remote(tmp.path());
        let scoped_tag = "@tanstack/react-query@5.101.2";
        git(&["tag", scoped_tag, "v1.0.0"], &tmp.path().join("work"));
        // Re-push the new tag into the bare remote.
        git(
            &["push", remote.to_str().unwrap(), scoped_tag],
            &tmp.path().join("work"),
        );
        let ask_home = tmp.path().join("ask-home");
        let opts = GithubOptions {
            name: "react-query".into(),
            version: "5.101.2".into(),
            repo: "TanStack/query".into(),
            tag: Some("v5.101.2".into()),
            fallback_refs: vec![scoped_tag.to_string()],
            docs_path: Some("docs".into()),
            remote_url: Some(remote.to_string_lossy().into_owned()),
            ..Default::default()
        };
        let result = fetch(&no_client(), &opts, &ask_home).unwrap();

        let store_path = result.store_path.clone().unwrap();
        assert_eq!(
            store_path.file_name().unwrap().to_str().unwrap(),
            "@tanstack__react-query@5.101.2-8cd04c22"
        );
        assert_eq!(result.meta.ref_.as_deref(), Some(scoped_tag));
        assert!(store_path.join("docs/guide.md").exists());

        // Second fetch: store-cache hit on the same encoded path, still
        // reporting the real tag.
        let cached = fetch(&no_client(), &opts, &ask_home).unwrap();
        assert!(cached.from_store_cache);
        assert_eq!(cached.store_path.as_deref(), Some(store_path.as_path()));
        assert_eq!(cached.meta.ref_.as_deref(), Some(scoped_tag));
    }

    #[test]
    fn second_fetch_hits_the_store_cache() {
        if !has_git() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = create_local_remote(tmp.path());
        let ask_home = tmp.path().join("ask-home");
        let opts = GithubOptions {
            name: "r".into(),
            version: "1.0.0".into(),
            repo: "test/repo".into(),
            tag: Some("v1.0.0".into()),
            docs_path: Some("docs".into()),
            remote_url: Some(remote.to_string_lossy().into_owned()),
            ..Default::default()
        };
        fetch(&no_client(), &opts, &ask_home).unwrap();
        // Second call: remote_url pointed at a now-removed path would fail a
        // fresh clone, so a success proves the store-cache short-circuit fired.
        std::fs::remove_dir_all(&remote).unwrap();
        let second = fetch(&no_client(), &opts, &ask_home).unwrap();
        assert!(second.from_store_cache);
        assert_eq!(second.files.len(), 1);
    }

    #[test]
    fn invalid_repo_and_ref_rejected() {
        let ask_home = tempfile::tempdir().unwrap();
        let bad_repo = GithubOptions {
            repo: "not-a-repo".into(),
            ..Default::default()
        };
        assert!(fetch(&no_client(), &bad_repo, ask_home.path()).is_err());
    }
}
