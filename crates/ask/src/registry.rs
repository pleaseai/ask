//! Registry spec parsing + ecosystem detection — Rust port of the pure parts of
//! `packages/cli/src/registry.ts`.
//!
//! The HTTP surface (`fetchRegistryEntry` / `resolveFromRegistry`, bounded by a
//! 10s timeout against `https://ask-registry.pages.dev`) and the `RegistrySource`
//! response type are deferred to a later phase — they depend on the registry
//! schema (`@pleaseai/ask-schema`) and an HTTP client, ported together once the
//! registry-entry schema lands. The parsing/detection helpers here are pure and
//! unblock the resolver + sources layers.

use std::path::Path;

/// The base URL for the ASK registry API. Kept here so the HTTP port reuses it.
pub const REGISTRY_BASE_URL: &str = "https://ask-registry.pages.dev";

/// Split an ecosystem prefix off a spec (port of `parseEcosystem`).
///
/// `npm:next@canary` → `(Some("npm"), "next@canary")`; `next@canary` →
/// `(None, "next@canary")`. A prefix is the text before the first `:`, but only
/// when that colon comes before any `/` — this rules out `owner/repo` shorthand
/// while still accepting scoped names like `npm:@mastra/client-js`.
pub fn parse_ecosystem(input: &str) -> (Option<&str>, &str) {
    let colon = input.find(':');
    let slash = input.find('/');
    if let Some(c) = colon {
        // `colonIdx > 0` in TS: a leading colon does not count as a prefix.
        if c > 0 && slash.is_none_or(|s| c < s) {
            return (Some(&input[..c]), &input[c + 1..]);
        }
    }
    (None, input)
}

/// A parsed `docs add` identifier (port of `ParsedDocSpec`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedDocSpec {
    Github {
        owner: String,
        repo: String,
        ref_: Option<String>,
    },
    Ecosystem {
        ecosystem: String,
        name: String,
        version: String,
    },
    Name {
        name: String,
        version: String,
    },
}

/// Error from [`parse_doc_spec`] — mirrors the TS thrown-error messages.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DocSpecError {
    #[error("docs spec is empty — expected `owner/repo`, `ecosystem:name`, or `name`")]
    Empty,
    #[error(
        "invalid docs spec '{0}': github shorthand must contain exactly one slash (owner/repo)"
    )]
    NotExactlyOneSlash(String),
    #[error("invalid docs spec '{0}': owner segment is empty")]
    EmptyOwner(String),
    #[error("invalid docs spec '{0}': repo segment is empty")]
    EmptyRepo(String),
}

/// Split `name[@version]`, defaulting the version to `latest`. `lastAt > 0`
/// keeps a leading `@` (bare scoped name) as part of the name.
fn split_name_version(spec: &str) -> (String, String) {
    match spec.rfind('@') {
        Some(idx) if idx > 0 => (spec[..idx].to_string(), spec[idx + 1..].to_string()),
        _ => (spec.to_string(), "latest".to_string()),
    }
}

/// Parse a `docs add` identifier into a [`ParsedDocSpec`] (port of
/// `parseDocSpec`). Disambiguation, checked in order:
///
///   1. Contains `/` and no `:` → github (`owner/repo[@ref]`, exactly one slash).
///   2. Contains `:` (non-empty prefix) → ecosystem (`prefix:name[@version]`).
///   3. Otherwise → bare name (`name[@version]`).
pub fn parse_doc_spec(input: &str) -> Result<ParsedDocSpec, DocSpecError> {
    if input.is_empty() {
        return Err(DocSpecError::Empty);
    }

    // 1. github shape: owner/repo[@ref]. The `:` exclusion keeps scoped
    //    ecosystem specs (`npm:@scope/pkg@1.0`) out of the github branch.
    if input.contains('/') && !input.contains(':') {
        let parts: Vec<&str> = input.split('/').collect();
        if parts.len() != 2 {
            return Err(DocSpecError::NotExactlyOneSlash(input.to_string()));
        }
        let owner = parts[0];
        let repo_and_ref = parts[1];
        if owner.is_empty() {
            return Err(DocSpecError::EmptyOwner(input.to_string()));
        }
        if repo_and_ref.is_empty() {
            return Err(DocSpecError::EmptyRepo(input.to_string()));
        }
        if let Some(at) = repo_and_ref.find('@') {
            let repo = &repo_and_ref[..at];
            let ref_ = &repo_and_ref[at + 1..];
            if repo.is_empty() {
                return Err(DocSpecError::EmptyRepo(input.to_string()));
            }
            return Ok(ParsedDocSpec::Github {
                owner: owner.to_string(),
                repo: repo.to_string(),
                // An empty ref (`owner/repo@`) drops back to no ref.
                ref_: (!ref_.is_empty()).then(|| ref_.to_string()),
            });
        }
        return Ok(ParsedDocSpec::Github {
            owner: owner.to_string(),
            repo: repo_and_ref.to_string(),
            ref_: None,
        });
    }

    // 2. ecosystem shape: prefix:name[@version].
    if let Some(colon) = input.find(':') {
        if colon > 0 {
            let ecosystem = &input[..colon];
            let (name, version) = split_name_version(&input[colon + 1..]);
            return Ok(ParsedDocSpec::Ecosystem {
                ecosystem: ecosystem.to_string(),
                name,
                version,
            });
        }
    }

    // 3. bare name: name[@version].
    let (name, version) = split_name_version(input);
    Ok(ParsedDocSpec::Name { name, version })
}

/// Detect the project ecosystem from marker files, defaulting to `npm` (port of
/// `detectEcosystem`). Checks are ordered; the first existing file wins.
pub fn detect_ecosystem(project_dir: &Path) -> &'static str {
    const CHECKS: &[(&str, &str)] = &[
        ("package.json", "npm"),
        ("pubspec.yaml", "pub"),
        ("pyproject.toml", "pypi"),
        ("requirements.txt", "pypi"),
        ("go.mod", "go"),
        ("Cargo.toml", "crates"),
        ("mix.exs", "hex"),
        ("pom.xml", "maven"),
        ("build.gradle", "maven"),
        ("build.gradle.kts", "maven"),
    ];
    for (file, ecosystem) in CHECKS {
        if project_dir.join(file).exists() {
            return ecosystem;
        }
    }
    "npm"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ecosystem_cases() {
        assert_eq!(
            parse_ecosystem("npm:next@canary"),
            (Some("npm"), "next@canary")
        );
        assert_eq!(parse_ecosystem("next@canary"), (None, "next@canary"));
        // Scoped npm name: colon before slash → still an ecosystem prefix.
        assert_eq!(
            parse_ecosystem("npm:@mastra/client-js"),
            (Some("npm"), "@mastra/client-js")
        );
        // owner/repo shorthand: slash before colon (or no colon) → no prefix.
        assert_eq!(parse_ecosystem("owner/repo"), (None, "owner/repo"));
        // Leading colon does not count as a prefix.
        assert_eq!(parse_ecosystem(":x"), (None, ":x"));
    }

    #[test]
    fn parse_doc_spec_github_shapes() {
        assert_eq!(
            parse_doc_spec("vercel/next.js").unwrap(),
            ParsedDocSpec::Github {
                owner: "vercel".into(),
                repo: "next.js".into(),
                ref_: None
            }
        );
        assert_eq!(
            parse_doc_spec("vercel/next.js@v14").unwrap(),
            ParsedDocSpec::Github {
                owner: "vercel".into(),
                repo: "next.js".into(),
                ref_: Some("v14".into()),
            }
        );
        // Trailing `@` drops back to no ref.
        assert_eq!(
            parse_doc_spec("vercel/next.js@").unwrap(),
            ParsedDocSpec::Github {
                owner: "vercel".into(),
                repo: "next.js".into(),
                ref_: None
            }
        );
    }

    #[test]
    fn parse_doc_spec_github_errors() {
        assert_eq!(parse_doc_spec("").unwrap_err(), DocSpecError::Empty);
        assert_eq!(
            parse_doc_spec("a/b/c").unwrap_err(),
            DocSpecError::NotExactlyOneSlash("a/b/c".into())
        );
        assert_eq!(
            parse_doc_spec("/repo").unwrap_err(),
            DocSpecError::EmptyOwner("/repo".into())
        );
        assert_eq!(
            parse_doc_spec("owner/").unwrap_err(),
            DocSpecError::EmptyRepo("owner/".into())
        );
    }

    #[test]
    fn parse_doc_spec_ecosystem_and_name() {
        assert_eq!(
            parse_doc_spec("npm:next@canary").unwrap(),
            ParsedDocSpec::Ecosystem {
                ecosystem: "npm".into(),
                name: "next".into(),
                version: "canary".into(),
            }
        );
        assert_eq!(
            parse_doc_spec("next").unwrap(),
            ParsedDocSpec::Name {
                name: "next".into(),
                version: "latest".into()
            }
        );
        assert_eq!(
            parse_doc_spec("next@14").unwrap(),
            ParsedDocSpec::Name {
                name: "next".into(),
                version: "14".into()
            }
        );
        // Scoped ecosystem spec with a slash stays in the ecosystem branch (has `:`).
        assert_eq!(
            parse_doc_spec("npm:@scope/pkg@1.0").unwrap(),
            ParsedDocSpec::Ecosystem {
                ecosystem: "npm".into(),
                name: "@scope/pkg".into(),
                version: "1.0".into(),
            }
        );
    }

    #[test]
    fn detect_ecosystem_from_marker_files() {
        let dir = tempfile::tempdir().unwrap();
        // Empty dir → npm default.
        assert_eq!(detect_ecosystem(dir.path()), "npm");
        // Cargo.toml → crates (but package.json would win if present first).
        std::fs::write(dir.path().join("Cargo.toml"), "").unwrap();
        assert_eq!(detect_ecosystem(dir.path()), "crates");
        // package.json takes priority (checked first).
        std::fs::write(dir.path().join("package.json"), "{}").unwrap();
        assert_eq!(detect_ecosystem(dir.path()), "npm");
    }
}
