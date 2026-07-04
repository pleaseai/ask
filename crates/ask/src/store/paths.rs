//! Store path resolution + containment guards — Rust port of the path helpers in
//! `packages/cli/src/store/index.ts`.

use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// Resolve the global ASK home directory. Precedence: `ASK_HOME` (tilde-expanded,
/// absolutized) → `~/.ask`.
pub fn resolve_ask_home() -> PathBuf {
    if let Some(env_val) = std::env::var_os("ASK_HOME").filter(|v| !v.is_empty()) {
        let raw = env_val.to_string_lossy();
        let expanded: PathBuf = if let Some(rest) = raw.strip_prefix("~/") {
            home_dir().join(rest)
        } else {
            PathBuf::from(raw.as_ref())
        };
        return absolutize(&expanded);
    }
    home_dir().join(".ask")
}

/// Best-effort home directory (`$HOME` on unix, `%USERPROFILE%` on Windows).
pub(crate) fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Lexically clean a path (resolve `.`/`..` without touching the filesystem),
/// then make it absolute against the current dir if it is relative. Mirrors the
/// normalization `path.resolve` performs before containment checks.
fn absolutize(p: &Path) -> PathBuf {
    let base = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(p)
    };
    lexical_clean(&base)
}

/// Go-style lexical `Clean`: collapse `.` and `..` segments without resolving
/// symlinks or hitting the filesystem.
pub fn lexical_clean(p: &Path) -> PathBuf {
    let mut out: Vec<Component> = Vec::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {}
                _ => out.push(comp),
            },
            other => out.push(other),
        }
    }
    out.iter().map(|c| c.as_os_str()).collect()
}

/// Assert `candidate` resolves inside `parent`; returns the cleaned candidate.
/// Prevents path traversal via `..` or absolute paths in user-controlled inputs.
pub fn assert_contained(parent: &Path, candidate: &Path) -> anyhow::Result<PathBuf> {
    let rp = absolutize(parent);
    let rc = absolutize(candidate);
    if rc == rp || rc.starts_with(&rp) {
        Ok(rc)
    } else {
        anyhow::bail!(
            "Unsafe path: {} is outside {}",
            candidate.display(),
            parent.display()
        );
    }
}

/// Reject a path segment containing `..`, `/`, `\`, or empty — segment-level
/// traversal that [`assert_contained`] alone cannot catch.
pub fn assert_safe_segment(name: &str, value: &str) -> anyhow::Result<()> {
    if value.is_empty() || value.contains("..") || value.contains('/') || value.contains('\\') {
        anyhow::bail!("Unsafe path: {name} '{value}' contains path traversal characters");
    }
    Ok(())
}

pub fn npm_store_path(ask_home: &Path, pkg: &str, version: &str) -> anyhow::Result<PathBuf> {
    let candidate = ask_home.join("npm").join(format!("{pkg}@{version}"));
    assert_contained(ask_home, &candidate)
}

/// The PM-style nested layout for a github entry:
/// `<askHome>/github/<host>/<owner>/<repo>/<tag>/`.
pub fn github_store_path(
    ask_home: &Path,
    host: &str,
    owner: &str,
    repo: &str,
    tag: &str,
) -> anyhow::Result<PathBuf> {
    assert_safe_segment("host", host)?;
    assert_safe_segment("owner", owner)?;
    assert_safe_segment("repo", repo)?;
    assert_safe_segment("tag", tag)?;
    let github_root = ask_home.join("github");
    let candidate = github_root.join(host).join(owner).join(repo).join(tag);
    assert_contained(&github_root, &candidate)
}

pub fn web_store_path(ask_home: &Path, url: &str) -> PathBuf {
    ask_home.join("web").join(hash_url(url))
}

pub fn llms_txt_store_path(ask_home: &Path, url: &str, version: &str) -> PathBuf {
    ask_home
        .join("llms-txt")
        .join(format!("{}@{version}", hash_url(url)))
}

fn hash_url(url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalize_url(url).as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Normalize a URL for hashing: strip trailing slashes, lowercase the
/// scheme + host (the path stays case-sensitive per RFC 3986). Non-parseable
/// strings are lowercased wholesale.
pub fn normalize_url(url: &str) -> String {
    let stripped = url.trim_end_matches('/');
    // Minimal scheme://host split — enough to lowercase scheme+authority
    // without a URL-parsing dependency.
    if let Some(scheme_end) = stripped.find("://") {
        let scheme = &stripped[..scheme_end];
        let rest = &stripped[scheme_end + 3..];
        // The authority ends at the FIRST of `/`, `?`, or `#`. Splitting only on
        // `/` lets a URL with a query/fragment but no path (`host?Query`) fold the
        // query/fragment into the authority and lowercase it — collapsing distinct
        // URLs to the same store key. TS normalizeUrl lowercases only host+scheme
        // and preserves path/query/fragment case; mirror that here.
        let split_at = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..split_at];
        let suffix = &rest[split_at..];
        format!(
            "{}://{}{}",
            scheme.to_lowercase(),
            authority.to_lowercase(),
            suffix
        )
    } else {
        stripped.to_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_home_env_and_default() {
        // Absolute ASK_HOME is used verbatim (cleaned).
        temp_env("ASK_HOME", Some("/tmp/custom/ask"), || {
            assert_eq!(resolve_ask_home(), PathBuf::from("/tmp/custom/ask"));
        });
        temp_env("ASK_HOME", None, || {
            assert!(resolve_ask_home().ends_with(".ask"));
        });
    }

    #[test]
    fn npm_and_github_paths() {
        let home = Path::new("/store");
        assert_eq!(
            npm_store_path(home, "next", "15.0.3").unwrap(),
            PathBuf::from("/store/npm/next@15.0.3")
        );
        assert_eq!(
            github_store_path(home, "github.com", "vercel", "next.js", "v15.0.3").unwrap(),
            PathBuf::from("/store/github/github.com/vercel/next.js/v15.0.3")
        );
    }

    #[test]
    fn github_path_rejects_traversal_segments() {
        let home = Path::new("/store");
        assert!(github_store_path(home, "github.com", "..", "repo", "v1").is_err());
        assert!(github_store_path(home, "github.com", "o", "re/po", "v1").is_err());
        assert!(github_store_path(home, "github.com", "o", "repo", "").is_err());
    }

    #[test]
    fn assert_contained_blocks_escape() {
        let parent = Path::new("/store/github");
        assert!(assert_contained(parent, Path::new("/store/github/a/b")).is_ok());
        assert!(assert_contained(parent, Path::new("/store/github/../../etc")).is_err());
        assert!(assert_contained(parent, Path::new("/etc/passwd")).is_err());
    }

    #[test]
    fn normalize_url_lowercases_scheme_host_only() {
        assert_eq!(
            normalize_url("HTTPS://Example.COM/Docs/"),
            "https://example.com/Docs"
        );
        assert_eq!(normalize_url("https://X.io///"), "https://x.io");
        // Path case is preserved.
        assert_eq!(
            normalize_url("https://x.io/CaseSensitive"),
            "https://x.io/CaseSensitive"
        );
    }

    #[test]
    fn llms_txt_and_web_paths_hash_normalized_url() {
        let home = Path::new("/store");
        // Trailing slash + host case fold to the same hash.
        let a = llms_txt_store_path(home, "https://X.io/llms.txt", "1");
        let b = llms_txt_store_path(home, "https://x.io/llms.txt/", "1");
        assert_eq!(a, b);
        assert!(web_store_path(home, "https://x.io").starts_with("/store/web/"));
    }

    fn temp_env(key: &str, value: Option<&str>, f: impl FnOnce()) {
        let prev = std::env::var_os(key);
        match value {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        f();
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }
}
