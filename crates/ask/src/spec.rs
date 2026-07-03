//! Spec parsing for `ask.json` library entries — Rust port of
//! `packages/cli/src/spec.ts`.
//!
//! The spec string is the user-facing identifier; the library *name* is the slug
//! used for `.ask/docs/<name>@<ver>/` and `.claude/skills/<name>-docs/`. Slug
//! derivation:
//!
//!   - `npm:next`              → `next`
//!   - `npm:@mastra/client-js` → `mastra-client-js` (scoped flatten)
//!   - `github:vercel/next.js` → `next.js`

/// A parsed `ask.json` spec string. Discriminated the same way as the TS
/// `ParsedSpec` union.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedSpec {
    Npm {
        pkg: String,
        name: String,
    },
    Github {
        owner: String,
        repo: String,
        name: String,
    },
    Unknown {
        ecosystem: String,
        payload: String,
        name: String,
    },
}

impl ParsedSpec {
    /// The library slug, regardless of variant.
    pub fn name(&self) -> &str {
        match self {
            ParsedSpec::Npm { name, .. }
            | ParsedSpec::Github { name, .. }
            | ParsedSpec::Unknown { name, .. } => name,
        }
    }
}

/// Parse a spec string into its ecosystem-tagged form.
///
/// Mirrors `parseSpec` in `spec.ts`: the ecosystem is everything before the
/// first `:`; a spec with no `:` is `unknown` with an empty ecosystem.
pub fn parse_spec(spec: &str) -> ParsedSpec {
    let Some(colon_idx) = spec.find(':') else {
        return ParsedSpec::Unknown {
            ecosystem: String::new(),
            payload: spec.to_string(),
            name: spec.to_string(),
        };
    };
    let ecosystem = &spec[..colon_idx];
    let payload = &spec[colon_idx + 1..];

    if ecosystem == "npm" {
        return ParsedSpec::Npm {
            pkg: payload.to_string(),
            name: slugify_npm_name(payload),
        };
    }

    if ecosystem == "github" {
        // The github repo is everything after the FIRST slash (repo names never
        // contain a slash, but owners don't either — split on the first).
        match payload.split_once('/') {
            Some((owner, repo)) => {
                return ParsedSpec::Github {
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    name: repo.to_string(),
                };
            }
            None => {
                return ParsedSpec::Unknown {
                    ecosystem: ecosystem.to_string(),
                    payload: payload.to_string(),
                    name: payload.to_string(),
                };
            }
        }
    }

    ParsedSpec::Unknown {
        ecosystem: ecosystem.to_string(),
        payload: payload.to_string(),
        name: payload.to_string(),
    }
}

/// The library slug for a spec (`parse_spec(spec).name()`).
pub fn library_name_from_spec(spec: &str) -> String {
    parse_spec(spec).name().to_string()
}

/// `@mastra/client-js` → `mastra-client-js`. Scoped npm names are not valid as
/// `.ask/docs/<dir>` or Claude Code skill dir names, so we flatten them the same
/// way the registry server does. Non-scoped names pass through unchanged.
pub fn slugify_npm_name(pkg_name: &str) -> String {
    if is_scoped_pkg(pkg_name) {
        // Drop the leading `@`, then turn the single `/` into `-`.
        pkg_name[1..].replacen('/', "-", 1)
    } else {
        pkg_name.to_string()
    }
}

/// Equivalent of the TS `SCOPED_PKG_RE = /^@[^/]+\/[^/]+$/`: a leading `@`, a
/// non-empty scope with no slash, a single `/`, and a non-empty name with no
/// slash.
fn is_scoped_pkg(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('@') else {
        return false;
    };
    match rest.split_once('/') {
        // `split_once` splits on the first `/`, so `scope` is slash-free by
        // construction; the name must also be non-empty and slash-free.
        Some((scope, name)) => !scope.is_empty() && !name.is_empty() && !name.contains('/'),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_unscoped() {
        assert_eq!(
            parse_spec("npm:next"),
            ParsedSpec::Npm {
                pkg: "next".into(),
                name: "next".into()
            }
        );
    }

    #[test]
    fn npm_scoped_is_flattened() {
        assert_eq!(
            parse_spec("npm:@mastra/client-js"),
            ParsedSpec::Npm {
                pkg: "@mastra/client-js".into(),
                name: "mastra-client-js".into(),
            }
        );
    }

    #[test]
    fn github_repo_keeps_dots() {
        assert_eq!(
            parse_spec("github:vercel/next.js"),
            ParsedSpec::Github {
                owner: "vercel".into(),
                repo: "next.js".into(),
                name: "next.js".into(),
            }
        );
    }

    #[test]
    fn github_without_slash_is_unknown() {
        assert_eq!(
            parse_spec("github:justarepo"),
            ParsedSpec::Unknown {
                ecosystem: "github".into(),
                payload: "justarepo".into(),
                name: "justarepo".into(),
            }
        );
    }

    #[test]
    fn no_colon_is_unknown_empty_ecosystem() {
        assert_eq!(
            parse_spec("next"),
            ParsedSpec::Unknown {
                ecosystem: String::new(),
                payload: "next".into(),
                name: "next".into(),
            }
        );
    }

    #[test]
    fn unknown_ecosystem_passthrough() {
        assert_eq!(
            parse_spec("pypi:fastapi"),
            ParsedSpec::Unknown {
                ecosystem: "pypi".into(),
                payload: "fastapi".into(),
                name: "fastapi".into(),
            }
        );
    }

    #[test]
    fn github_owner_repo_with_subpath_splits_on_first_slash() {
        // Only the first slash separates owner/repo; the rest stays in repo.
        assert_eq!(
            parse_spec("github:owner/repo/extra"),
            ParsedSpec::Github {
                owner: "owner".into(),
                repo: "repo/extra".into(),
                name: "repo/extra".into(),
            }
        );
    }

    #[test]
    fn library_name_helper_matches_variant_name() {
        assert_eq!(
            library_name_from_spec("npm:@mastra/client-js"),
            "mastra-client-js"
        );
        assert_eq!(library_name_from_spec("github:vercel/next.js"), "next.js");
        assert_eq!(library_name_from_spec("react"), "react");
    }

    #[test]
    fn slugify_edge_cases() {
        assert_eq!(slugify_npm_name("next"), "next");
        assert_eq!(slugify_npm_name("@scope/pkg"), "scope-pkg");
        // Not a valid scoped name (no `/`) — passes through unchanged.
        assert_eq!(slugify_npm_name("@notscoped"), "@notscoped");
        // Deep path is not the scoped shape (`^@[^/]+/[^/]+$`) — unchanged.
        assert_eq!(slugify_npm_name("@a/b/c"), "@a/b/c");
    }
}
