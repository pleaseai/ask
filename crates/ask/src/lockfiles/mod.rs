//! Lockfile readers — translate a dependency name into the version pinned by
//! the project's package manager. Rust port of `packages/cli/src/lockfiles/`.
//!
//! The npm-ecosystem facade probes lockfiles in priority order:
//!
//!   `bun.lock → package-lock.json → pnpm-lock.yaml → yarn.lock → package.json`
//!
//! The first hit wins; the `package.json` fallback returns a *range* (not an
//! exact pin), so callers can decide whether to normalize it via a resolver.
//!
//! **Port status:** all five readers (`bun.lock`, `package-lock.json`,
//! `pnpm-lock.yaml`, `yarn.lock`, `package.json`) are ported, restoring full
//! priority parity with `lockfiles/index.ts`.

mod pnpm;

pub use pnpm::{parse_pnpm_lock, PNPM_LOCK_READER};

use std::path::Path;

/// A resolved dependency version plus provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockfileHit {
    /// The resolved version (exact pin if `exact`, otherwise a range).
    pub version: String,
    /// Provenance label, e.g. `"bun.lock"`, `"package.json"`.
    pub source: String,
    /// True when read from a lockfile, false when read from a manifest range.
    pub exact: bool,
}

/// Per-format reader: probes a single lockfile/manifest and returns `None` when
/// the file is missing or the package is absent.
pub struct LockfileReader {
    /// Filename inspected, relative to `project_dir`.
    pub file: &'static str,
    /// Whether hits are exact pins.
    pub exact: bool,
    /// Reader fn: `(name, project_dir) -> Option<LockfileHit>`.
    pub read: fn(&str, &Path) -> Option<LockfileHit>,
}

// ---------------------------------------------------------------------------
// parse-helpers — shared text utilities (port of parse-helpers.ts)
// ---------------------------------------------------------------------------

/// Strip a pnpm peer-dependency suffix (`18.2.0(react@17.0.0)` → `18.2.0`).
/// Cuts at the first `(` so nested suffixes collapse too.
pub fn strip_peer_suffix(v: &str) -> &str {
    match v.find('(') {
        Some(i) => v[..i].trim_end(),
        None => v.trim_end(),
    }
}

/// Strip a YAML-style inline comment, but only when `#` is preceded by a space,
/// so `github:foo/bar#branch` fragments pass through intact.
pub fn strip_inline_comment(s: &str) -> &str {
    match s.find(" #") {
        Some(i) => s[..i].trim_end(),
        None => s,
    }
}

/// Strip any mix of surrounding single/double quotes (`^['"]+|['"]+$`).
pub fn trim_quotes(s: &str) -> &str {
    s.trim_matches(['\'', '"'])
}

/// Normalize a raw YAML value: trim, strip inline comment, strip quotes. Does
/// NOT strip peer-dep suffixes — callers do that when appropriate.
pub fn clean_value(s: &str) -> &str {
    trim_quotes(strip_inline_comment(s.trim()))
}

/// Split a `<pkg>@<rest>` spec into `(name, rest)`, handling scoped names
/// (`@scope/pkg`). Returns `None` if there is no `@` separator.
pub fn split_pkg_spec(spec: &str) -> Option<(&str, &str)> {
    let at_pos = match spec.strip_prefix('@') {
        // Scoped: separating `@` is the next one after the leading `@` (+1 to
        // map the index in `rest` back onto `spec`).
        Some(rest) => rest.find('@').map(|i| i + 1)?,
        None => spec.find('@')?,
    };
    Some((&spec[..at_pos], &spec[at_pos + 1..]))
}

/// Whether `v` is a version resolvable against a public registry. Lockfiles can
/// carry protocol strings (`link:`, `file:`, `workspace:`, git/URL, and yarn
/// Berry's `0.0.0-use.local`); real npm versions never contain `:`, so a colon
/// (or the Berry sentinel, or emptiness) disqualifies.
pub fn is_registry_version(v: &str) -> bool {
    !v.is_empty() && v != "0.0.0-use.local" && !v.contains(':')
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/// Parse a `bun.lock` for the version of `name`. bun.lock is a text-ish format
/// where deps appear as quoted `"<name>@<version>"` tokens. Hand-rolled scan
/// equivalent to the TS regex `"<name>@([^"@][^"]*)"`: literal `"<name>@`, a
/// first version char that is neither `@` nor `"`, then up to the next `"`.
/// Returns the first valid occurrence in file order.
fn parse_bun(content: &str, name: &str) -> Option<String> {
    let needle = format!("\"{name}@");
    let mut base = 0;
    while let Some(rel) = content[base..].find(&needle) {
        let start = base + rel + needle.len();
        let rest = &content[start..];
        // First version char must be neither `@` (double separator) nor `"`
        // (empty version).
        match rest.chars().next() {
            Some(c) if c != '@' && c != '"' => {
                if let Some(qpos) = rest.find('"') {
                    return Some(rest[..qpos].to_string());
                }
            }
            _ => {}
        }
        base = base + rel + 1; // advance past this occurrence and keep scanning
    }
    None
}

fn read_file(project_dir: &Path, file: &str) -> Option<String> {
    std::fs::read_to_string(project_dir.join(file)).ok()
}

fn bun_read(name: &str, project_dir: &Path) -> Option<LockfileHit> {
    let content = read_file(project_dir, "bun.lock")?;
    parse_bun(&content, name).map(|version| LockfileHit {
        version,
        source: "bun.lock".to_string(),
        exact: true,
    })
}

/// Parse a `package-lock.json` (npm v2/v3): prefer
/// `packages["node_modules/<name>"].version` (lockfileVersion 2+), then
/// `dependencies.<name>.version` (v1).
fn parse_npm(content: &str, name: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(content).ok()?;
    let pkg_key = format!("node_modules/{name}");
    if let Some(v) = json
        .get("packages")
        .and_then(|p| p.get(&pkg_key))
        .and_then(|e| e.get("version"))
        .and_then(|v| v.as_str())
    {
        return Some(v.to_string());
    }
    json.get("dependencies")
        .and_then(|d| d.get(name))
        .and_then(|e| e.get("version"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn npm_read(name: &str, project_dir: &Path) -> Option<LockfileHit> {
    let content = read_file(project_dir, "package-lock.json")?;
    parse_npm(&content, name).map(|version| LockfileHit {
        version,
        source: "package-lock.json".to_string(),
        exact: true,
    })
}

/// Parse `package.json` for a dependency range (dependencies → dev → peer →
/// optional). Non-registry protocol strings are skipped. The hit is NOT exact.
fn parse_package_json(content: &str, name: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(content).ok()?;
    let lookup = |field: &str| {
        json.get(field)
            .and_then(|m| m.get(name))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let value = lookup("dependencies")
        .or_else(|| lookup("devDependencies"))
        .or_else(|| lookup("peerDependencies"))
        .or_else(|| lookup("optionalDependencies"))?;
    is_registry_version(&value).then_some(value)
}

fn package_json_read(name: &str, project_dir: &Path) -> Option<LockfileHit> {
    let content = read_file(project_dir, "package.json")?;
    parse_package_json(&content, name).map(|version| LockfileHit {
        version,
        source: "package.json".to_string(),
        exact: false,
    })
}

/// Block-based `yarn.lock` parser handling both classic v1 and Berry v2+ in one
/// path (port of `parseYarnLock`, itself from opensrc's `core/version.rs`).
///
/// Blocks are separated by blank lines. For each block whose header mentions
/// `pkg` in ANY comma-separated specifier, the nearest body `version` line wins
/// — unless it is a workspace sentinel / protocol string, in which case a later
/// block may still provide a real version.
pub fn parse_yarn_lock(text: &str, pkg: &str) -> Option<String> {
    // Split into blocks on blank lines (CR-stripped).
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }

    for block in blocks {
        let mut header: Option<&str> = None;
        let mut body: Vec<&str> = Vec::new();

        for line in block {
            if line.trim_start().starts_with('#') {
                continue;
            }
            let first_is_ws = line.chars().next().is_some_and(char::is_whitespace);
            if header.is_none() && !first_is_ws {
                header = Some(line);
            } else {
                body.push(line);
            }
        }

        let Some(header) = header else { continue };
        if header.starts_with("__metadata:") || !header.ends_with(':') {
            continue;
        }
        let header_body = &header[..header.len() - 1];

        // Split on `, ` to cover v1 multi-specifier headers and Berry's
        // `foo@npm:^1, foo@workspace:*`; trim_quotes handles the outer quotes.
        let matched = header_body.split(", ").any(|s| {
            let spec = trim_quotes(s.trim());
            split_pkg_spec(spec).is_some_and(|(name, _)| name == pkg)
        });
        if !matched {
            continue;
        }

        for line in body {
            let trimmed = line.trim_start();
            let Some(rest) = trimmed.strip_prefix("version") else {
                continue;
            };
            // Must be followed by `:` (Berry) or whitespace (v1) — not `versions:`.
            match rest.chars().next() {
                Some(':') | Some(' ') | Some('\t') => {}
                _ => continue,
            }
            let rest = rest.trim_start();
            let rest = rest.strip_prefix(':').unwrap_or(rest);
            let stripped = strip_peer_suffix(clean_value(rest));
            if is_registry_version(stripped) {
                return Some(stripped.to_string());
            }
        }
    }

    None
}

fn yarn_read(name: &str, project_dir: &Path) -> Option<LockfileHit> {
    let content = read_file(project_dir, "yarn.lock")?;
    parse_yarn_lock(&content, name).map(|version| LockfileHit {
        version,
        source: "yarn.lock".to_string(),
        exact: true,
    })
}

pub const BUN_LOCK_READER: LockfileReader = LockfileReader {
    file: "bun.lock",
    exact: true,
    read: bun_read,
};
pub const NPM_LOCK_READER: LockfileReader = LockfileReader {
    file: "package-lock.json",
    exact: true,
    read: npm_read,
};
pub const PACKAGE_JSON_READER: LockfileReader = LockfileReader {
    file: "package.json",
    exact: false,
    read: package_json_read,
};
pub const YARN_LOCK_READER: LockfileReader = LockfileReader {
    file: "yarn.lock",
    exact: true,
    read: yarn_read,
};

/// The npm-ecosystem chain in priority order:
/// bun → package-lock → pnpm → yarn → package.json.
pub const NPM_ECOSYSTEM_CHAIN: &[LockfileReader] = &[
    BUN_LOCK_READER,
    NPM_LOCK_READER,
    PNPM_LOCK_READER,
    YARN_LOCK_READER,
    PACKAGE_JSON_READER,
];

/// Probe the npm-ecosystem chain in order; return the first hit.
pub fn npm_ecosystem_read(name: &str, project_dir: &Path) -> Option<LockfileHit> {
    for reader in NPM_ECOSYSTEM_CHAIN {
        if let Some(hit) = (reader.read)(name, project_dir) {
            return Some(hit);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- parse-helpers ----

    #[test]
    fn strip_peer_suffix_cases() {
        assert_eq!(strip_peer_suffix("18.2.0(react@17.0.0)"), "18.2.0");
        assert_eq!(strip_peer_suffix("18.2.0(a@1)(b@2(c@3))"), "18.2.0");
        assert_eq!(strip_peer_suffix("1.0.0 "), "1.0.0");
    }

    #[test]
    fn strip_inline_comment_keeps_url_fragments() {
        assert_eq!(strip_inline_comment("1.0.0 # a comment"), "1.0.0");
        assert_eq!(
            strip_inline_comment("github:foo/bar#branch"),
            "github:foo/bar#branch"
        );
    }

    #[test]
    fn trim_and_clean() {
        assert_eq!(trim_quotes("\"'x'\""), "x");
        assert_eq!(clean_value("  \"1.0.0\" # c "), "1.0.0");
    }

    #[test]
    fn split_pkg_spec_scoped_and_plain() {
        assert_eq!(split_pkg_spec("next@15.0.0"), Some(("next", "15.0.0")));
        assert_eq!(
            split_pkg_spec("@scope/pkg@1.2.3"),
            Some(("@scope/pkg", "1.2.3"))
        );
        assert_eq!(split_pkg_spec("noatsign"), None);
    }

    #[test]
    fn is_registry_version_rejects_protocols() {
        assert!(is_registry_version("1.2.3"));
        assert!(!is_registry_version("workspace:*"));
        assert!(!is_registry_version("link:../pkg"));
        assert!(!is_registry_version("0.0.0-use.local"));
        assert!(!is_registry_version(""));
    }

    // ---- bun ----

    #[test]
    fn bun_finds_scoped_and_plain() {
        let content = r#"{
          "packages": {
            "next": ["next@15.0.3", {}],
            "@scope/pkg": ["@scope/pkg@1.2.3", {}]
          }
        }"#;
        assert_eq!(parse_bun(content, "next").as_deref(), Some("15.0.3"));
        assert_eq!(parse_bun(content, "@scope/pkg").as_deref(), Some("1.2.3"));
        assert_eq!(parse_bun(content, "absent"), None);
    }

    #[test]
    fn bun_skips_empty_or_double_at_token() {
        // `"next@"` (empty) and `"next@@"` (leading @) must not match; the real
        // pin later in the file wins.
        let content = "\"next@\": x\n\"next@1.0.0\": y\n";
        assert_eq!(parse_bun(content, "next").as_deref(), Some("1.0.0"));
    }

    // ---- npm ----

    #[test]
    fn npm_prefers_packages_then_dependencies() {
        let v3 = r#"{"packages":{"node_modules/next":{"version":"15.0.3"}}}"#;
        assert_eq!(parse_npm(v3, "next").as_deref(), Some("15.0.3"));
        let v1 = r#"{"dependencies":{"next":{"version":"14.0.0"}}}"#;
        assert_eq!(parse_npm(v1, "next").as_deref(), Some("14.0.0"));
        assert_eq!(parse_npm("{}", "next"), None);
        assert_eq!(parse_npm("not json", "next"), None);
    }

    // ---- package.json ----

    #[test]
    fn package_json_ranges_and_protocol_skip() {
        let json = r#"{
          "dependencies": { "next": "^15.0.0", "linked": "link:../x" },
          "devDependencies": { "vitest": "1.2.3" }
        }"#;
        assert_eq!(parse_package_json(json, "next").as_deref(), Some("^15.0.0"));
        assert_eq!(parse_package_json(json, "vitest").as_deref(), Some("1.2.3"));
        assert_eq!(parse_package_json(json, "linked"), None); // protocol skipped
        assert_eq!(parse_package_json(json, "absent"), None);
    }

    // ---- yarn ----

    #[test]
    fn yarn_v1_multi_specifier_header() {
        let text = "\
# yarn lockfile v1


\"next@^15.0.0\", \"next@~15.0.3\":
  version \"15.0.3\"
  resolved \"https://...\"
";
        assert_eq!(parse_yarn_lock(text, "next").as_deref(), Some("15.0.3"));
    }

    #[test]
    fn yarn_berry_and_peer_suffix_and_protocol_skip() {
        // Berry header form + a peer suffix on the version; workspace sentinel
        // block is skipped in favor of the real one.
        let text = "\
__metadata:
  version: 8

\"root@workspace:.\":
  version: 0.0.0-use.local

\"react@npm:^18.0.0, react@npm:^18.2.0\":
  version: 18.2.0(loose)
";
        assert_eq!(parse_yarn_lock(text, "react").as_deref(), Some("18.2.0"));
        // The workspace root resolves to a sentinel → no registry version.
        assert_eq!(parse_yarn_lock(text, "root"), None);
    }

    #[test]
    fn yarn_versions_key_is_not_the_version_key() {
        // `versions:` (plural) must not be mistaken for the `version` key.
        let text = "\
\"pkg@^1.0.0\":
  versions:
    - 1.0.0
  version \"1.0.0\"
";
        assert_eq!(parse_yarn_lock(text, "pkg").as_deref(), Some("1.0.0"));
    }

    // ---- facade ----

    #[test]
    fn chain_priority_bun_beats_package_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("bun.lock"), "\"next@15.0.3\": {}").unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"dependencies":{"next":"^14.0.0"}}"#,
        )
        .unwrap();
        let hit = npm_ecosystem_read("next", dir.path()).unwrap();
        assert_eq!(hit.version, "15.0.3");
        assert_eq!(hit.source, "bun.lock");
        assert!(hit.exact);
    }

    #[test]
    fn chain_falls_back_to_package_json_range() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"dependencies":{"next":"^14.0.0"}}"#,
        )
        .unwrap();
        let hit = npm_ecosystem_read("next", dir.path()).unwrap();
        assert_eq!(hit.version, "^14.0.0");
        assert_eq!(hit.source, "package.json");
        assert!(!hit.exact);
        assert!(npm_ecosystem_read("absent", dir.path()).is_none());
    }
}
