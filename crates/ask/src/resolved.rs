//! `.ask/resolved.json` schema — Rust port of `packages/schema/src/resolved.ts`.
//!
//! `resolved.json` is a pure cache that lets `ask install` short-circuit when
//! nothing has changed. `key` (the map key) is the library slug — the same
//! string used under `.ask/docs/<slug>@<ver>/` and as the skill dir name.
//!
//! This file is machine-generated (never hand-edited), so the datetime fields
//! use a light RFC3339 shape check rather than a full date parser; the content
//! hash, commit SHA, and structural refinements are validated faithfully.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// How the docs were materialized. `in-place` references
/// `node_modules/<pkg>/<docsPath>` directly; the others are global-store modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Materialization {
    Copy,
    Link,
    Ref,
    InPlace,
}

/// Distinguishes materialized docs from intent-skills entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntryFormat {
    Docs,
    IntentSkills,
}

/// One row in `.ask/resolved.json`. Optional fields are omitted from the
/// serialized JSON when absent (parity with the TS optional keys). Unknown
/// fields are rejected (zod `.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResolvedEntry {
    /// The exact spec from `ask.json` (so we can detect spec edits).
    pub spec: String,
    /// Resolved version (lockfile for PM-driven, `ref` for standalone).
    pub resolved_version: String,
    /// Hash of the materialized doc files (`sha256-<64 hex>`).
    pub content_hash: String,
    /// ISO timestamp of the most recent successful fetch.
    pub fetched_at: String,
    /// Number of files written under `.ask/docs/<slug>@<ver>/`.
    pub file_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<EntryFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub materialization: Option<Materialization>,
    /// Project-relative docs path when `materialization == in-place`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_place_path: Option<String>,
    /// Git commit SHA a `github` ref resolved to (40-char lowercase hex).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// Relative subpath inside `store_path` holding the docs tree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_subpath: Option<String>,
}

/// The `.ask/resolved.json` document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResolvedJson {
    pub schema_version: u32,
    pub generated_at: String,
    /// Slug → resolved entry. `BTreeMap` gives deterministic on-disk ordering
    /// (the cache is regenerable, so sorted order is fine).
    pub entries: BTreeMap<String, ResolvedEntry>,
}

/// Validation failure for a resolved-cache document.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ResolvedError {
    #[error("contentHash must be sha256-<64 hex chars>: {0:?}")]
    ContentHash(String),
    #[error("commit must be a 40-char lowercase hex SHA: {0:?}")]
    Commit(String),
    #[error("{field} must be an ISO-8601 datetime with offset: {value:?}")]
    DateTime { field: &'static str, value: String },
    #[error("inPlacePath is required when materialization is 'in-place' (entry {0:?})")]
    MissingInPlacePath(String),
    #[error("schemaVersion must be 1, got {0}")]
    SchemaVersion(u32),
}

impl ResolvedEntry {
    /// Enforce the field-shape refinements serde structural parsing cannot.
    pub fn validate(&self) -> Result<(), ResolvedError> {
        if !is_content_hash(&self.content_hash) {
            return Err(ResolvedError::ContentHash(self.content_hash.clone()));
        }
        if !is_iso_datetime_offset(&self.fetched_at) {
            return Err(ResolvedError::DateTime {
                field: "fetchedAt",
                value: self.fetched_at.clone(),
            });
        }
        if let Some(commit) = &self.commit {
            if !is_git_sha(commit) {
                return Err(ResolvedError::Commit(commit.clone()));
            }
        }
        if self.materialization == Some(Materialization::InPlace) && self.in_place_path.is_none() {
            return Err(ResolvedError::MissingInPlacePath(self.spec.clone()));
        }
        Ok(())
    }
}

impl ResolvedJson {
    /// Parse and validate a `resolved.json` document from a JSON string.
    pub fn parse(json: &str) -> anyhow::Result<Self> {
        let parsed: ResolvedJson = serde_json::from_str(json)?;
        parsed.validate()?;
        Ok(parsed)
    }

    /// Validate the literal schema version, timestamp, and every entry.
    pub fn validate(&self) -> Result<(), ResolvedError> {
        if self.schema_version != 1 {
            return Err(ResolvedError::SchemaVersion(self.schema_version));
        }
        if !is_iso_datetime_offset(&self.generated_at) {
            return Err(ResolvedError::DateTime {
                field: "generatedAt",
                value: self.generated_at.clone(),
            });
        }
        for entry in self.entries.values() {
            entry.validate()?;
        }
        Ok(())
    }
}

/// `^sha256-[0-9a-f]{64}$`.
fn is_content_hash(s: &str) -> bool {
    match s.strip_prefix("sha256-") {
        Some(hex) => {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }
        None => false,
    }
}

/// `^[0-9a-f]{40}$`.
fn is_git_sha(s: &str) -> bool {
    s.len() == 40
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Light RFC3339 shape check: `YYYY-MM-DDThh:mm:ss[.fff]` followed by `Z` or a
/// `±hh:mm` offset. Faithful to zod's `.datetime({ offset: true })` intent
/// (an offset is required) without pulling a date-parsing dependency; tightened
/// later if a module needs true calendar validation.
fn is_iso_datetime_offset(s: &str) -> bool {
    let Some((date, rest)) = s.split_once('T') else {
        return false;
    };
    // Date: YYYY-MM-DD
    let d: Vec<&str> = date.split('-').collect();
    if d.len() != 3 || d[0].len() != 4 || d[1].len() != 2 || d[2].len() != 2 {
        return false;
    }
    if !d.iter().all(|p| p.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    // Time + offset.
    let (time, offset) = if let Some(stripped) = rest.strip_suffix('Z') {
        (stripped, true)
    } else if let Some(idx) = rest.rfind(['+', '-']) {
        // Offset must be ±hh:mm.
        let off = &rest[idx + 1..];
        let ok = off.len() == 5
            && off.as_bytes()[2] == b':'
            && off[..2]
                .bytes()
                .chain(off[3..].bytes())
                .all(|b| b.is_ascii_digit());
        (&rest[..idx], ok)
    } else {
        (rest, false)
    };
    if !offset {
        return false;
    }
    // Time: hh:mm:ss with optional .fraction.
    let core = time.split('.').next().unwrap_or(time);
    let t: Vec<&str> = core.split(':').collect();
    t.len() == 3
        && t[0].len() == 2
        && t[1].len() == 2
        && t[2].len() == 2
        && t.iter().all(|p| p.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "sha256-0000000000000000000000000000000000000000000000000000000000000000";
    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    fn base_entry_json(extra: &str) -> String {
        format!(
            r#"{{"spec":"npm:next","resolvedVersion":"15.0.0","contentHash":"{HASH}","fetchedAt":"2026-07-04T00:00:00Z","fileCount":3{extra}}}"#
        )
    }

    fn doc(entry_json: &str) -> String {
        format!(
            r#"{{"schemaVersion":1,"generatedAt":"2026-07-04T00:00:00Z","entries":{{"next":{entry_json}}}}}"#
        )
    }

    #[test]
    fn parses_minimal_entry() {
        let ask = ResolvedJson::parse(&doc(&base_entry_json(""))).unwrap();
        let e = &ask.entries["next"];
        assert_eq!(e.spec, "npm:next");
        assert_eq!(e.file_count, 3);
        assert_eq!(e.commit, None);
    }

    #[test]
    fn optional_fields_omitted_when_none() {
        let e = ResolvedJson::parse(&doc(&base_entry_json("")))
            .unwrap()
            .entries
            .remove("next")
            .unwrap();
        let json = serde_json::to_string(&e).unwrap();
        assert!(!json.contains("commit"));
        assert!(!json.contains("storePath"));
        assert!(!json.contains("format"));
    }

    #[test]
    fn kebab_case_enums_roundtrip() {
        let json = base_entry_json(
            r#","materialization":"in-place","inPlacePath":"node_modules/next/dist/docs","format":"intent-skills""#,
        );
        let e: ResolvedEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(e.materialization, Some(Materialization::InPlace));
        assert_eq!(e.format, Some(EntryFormat::IntentSkills));
        // Re-serialize keeps the kebab-case wire form.
        let out = serde_json::to_string(&e).unwrap();
        assert!(out.contains(r#""materialization":"in-place""#));
        assert!(out.contains(r#""format":"intent-skills""#));
    }

    #[test]
    fn in_place_requires_in_place_path() {
        let json = base_entry_json(r#","materialization":"in-place""#);
        let err = ResolvedJson::parse(&doc(&json)).unwrap_err();
        assert!(err.to_string().contains("inPlacePath is required"));
    }

    #[test]
    fn rejects_bad_content_hash() {
        let json = base_entry_json("").replace(HASH, "sha256-xyz");
        assert!(ResolvedJson::parse(&doc(&json)).is_err());
    }

    #[test]
    fn rejects_bad_commit_sha() {
        let json = base_entry_json(r#","commit":"NOTASHA""#);
        assert!(ResolvedJson::parse(&doc(&json)).is_err());
    }

    #[test]
    fn accepts_valid_commit_sha() {
        let json = base_entry_json(&format!(r#","commit":"{SHA}""#));
        let ask = ResolvedJson::parse(&doc(&json)).unwrap();
        assert_eq!(ask.entries["next"].commit.as_deref(), Some(SHA));
    }

    #[test]
    fn rejects_wrong_schema_version() {
        let doc = doc(&base_entry_json("")).replace("\"schemaVersion\":1", "\"schemaVersion\":2");
        assert!(ResolvedJson::parse(&doc).is_err());
    }

    #[test]
    fn rejects_unknown_entry_field() {
        let json = base_entry_json(r#","bogus":1"#);
        assert!(ResolvedJson::parse(&doc(&json)).is_err());
    }

    #[test]
    fn datetime_offset_shapes() {
        assert!(is_iso_datetime_offset("2026-07-04T00:00:00Z"));
        assert!(is_iso_datetime_offset("2026-07-04T12:30:59.123+09:00"));
        assert!(is_iso_datetime_offset("2026-07-04T12:30:59-05:00"));
        assert!(!is_iso_datetime_offset("2026-07-04T00:00:00")); // no offset
        assert!(!is_iso_datetime_offset("2026-07-04 00:00:00Z")); // no T
        assert!(!is_iso_datetime_offset("not-a-date"));
    }
}
