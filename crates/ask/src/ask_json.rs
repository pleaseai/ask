//! `ask.json` schema — Rust port of `packages/schema/src/ask-json.ts`.
//!
//! `ask.json` is the single declarative input in the lazy-first architecture: a
//! list of library entries. Each entry is either a bare **spec string** (the
//! canonical, diff-clean form) or an **object** carrying a non-empty `docsPaths`
//! override selected by the user at `ask add` time.
//!
//! Spec strings carry the ecosystem in the prefix (`npm:next`,
//! `npm:@scope/pkg`, `github:owner/repo@v1.2.3`).

use serde::{Deserialize, Serialize};

/// Object form of a library entry — used ONLY when the user selected a subset of
/// candidate documentation paths. `docs_paths` is required and non-empty; an
/// empty override is indistinguishable from the default, so the canonical
/// "no override" form is the bare string. Unknown fields are rejected (parity
/// with the zod `.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryEntryObject {
    pub spec: String,
    #[serde(rename = "docsPaths")]
    pub docs_paths: Vec<String>,
}

/// A library entry: a bare spec string, or an object with a `docsPaths`
/// override. Serialized untagged so the string form stays a plain JSON string on
/// disk (existing `ask.json` files render unchanged).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LibraryEntry {
    Spec(String),
    WithDocs(LibraryEntryObject),
}

/// Lazy-first `ask.json` — a list of library entries. Unknown top-level fields
/// are rejected (parity with `.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AskJson {
    pub libraries: Vec<LibraryEntry>,
}

/// Materialization mode for the eager `--fetch` path.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StoreMode {
    #[default]
    Copy,
    Link,
    Ref,
}

/// Validation failure for an `ask.json` document, mirroring the zod refinements
/// that plain serde structural parsing does not enforce.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AskJsonError {
    #[error("spec must start with an ecosystem prefix (e.g. \"npm:next\", \"github:owner/repo@v1.2.3\"): {0:?}")]
    InvalidSpec(String),
    #[error(
        "docsPaths override must be non-empty (use a bare spec string for no override): {0:?}"
    )]
    EmptyDocsPaths(String),
    #[error("docsPaths entries must be non-empty strings: {0:?}")]
    EmptyDocsPathItem(String),
}

impl AskJson {
    /// Parse and validate an `ask.json` document from a JSON string.
    ///
    /// Deserialization enforces structure + strictness (`deny_unknown_fields`);
    /// [`AskJson::validate`] then enforces the zod refinements (spec-string
    /// shape, non-empty `docsPaths`).
    pub fn parse(json: &str) -> anyhow::Result<Self> {
        let parsed: AskJson = serde_json::from_str(json)?;
        parsed.validate()?;
        Ok(parsed)
    }

    /// Run the content refinements the serde layer cannot express.
    pub fn validate(&self) -> Result<(), AskJsonError> {
        for entry in &self.libraries {
            let spec = entry.spec();
            if !is_valid_spec_string(spec) {
                return Err(AskJsonError::InvalidSpec(spec.to_string()));
            }
            if let LibraryEntry::WithDocs(obj) = entry {
                if obj.docs_paths.is_empty() {
                    return Err(AskJsonError::EmptyDocsPaths(spec.to_string()));
                }
                if obj.docs_paths.iter().any(|p| p.is_empty()) {
                    return Err(AskJsonError::EmptyDocsPathItem(spec.to_string()));
                }
            }
        }
        Ok(())
    }
}

impl LibraryEntry {
    /// Extract the spec string from either form (parity with `specFromEntry`).
    pub fn spec(&self) -> &str {
        match self {
            LibraryEntry::Spec(s) => s,
            LibraryEntry::WithDocs(o) => &o.spec,
        }
    }

    /// The docs-path override, or `None` for the bare-string form
    /// (parity with `docsPathsFromEntry`).
    pub fn docs_paths(&self) -> Option<&[String]> {
        match self {
            LibraryEntry::Spec(_) => None,
            LibraryEntry::WithDocs(o) => Some(&o.docs_paths),
        }
    }
}

/// Build a library entry from a spec and optional docs paths. Canonical-form
/// rule: an empty or absent `docs_paths` collapses to a bare string so
/// `ask.json` stays diff-clean (parity with `entryFromSpec`).
pub fn entry_from_spec(spec: impl Into<String>, docs_paths: &[String]) -> LibraryEntry {
    let spec = spec.into();
    if docs_paths.is_empty() {
        LibraryEntry::Spec(spec)
    } else {
        LibraryEntry::WithDocs(LibraryEntryObject {
            spec,
            docs_paths: docs_paths.to_vec(),
        })
    }
}

/// Equivalent of the zod `SpecString` regex `^[a-z][a-z0-9+-]*:.+$`: a lowercase
/// ecosystem prefix, then `:`, then at least one payload char.
fn is_valid_spec_string(spec: &str) -> bool {
    let Some((prefix, payload)) = spec.split_once(':') else {
        return false;
    };
    if payload.is_empty() {
        return false;
    }
    // The zod regex `^...:.+$` has no `s`/`m` flags: `.` never matches a JS line
    // terminator and `$` is strict end-of-string, so a payload containing any JS
    // line terminator (LF, CR, U+2028, U+2029) is rejected. Mirror that so Rust
    // does not accept multiline specs the TS schema rejects. (The prefix charset
    // already excludes these.)
    if payload.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return false;
    }
    let mut chars = prefix.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mixed_string_and_object_entries() {
        let json = r#"{
            "libraries": [
                "npm:next",
                { "spec": "npm:zod", "docsPaths": ["docs/API.md"] },
                "github:vercel/ai@v5.0.0"
            ]
        }"#;
        let ask = AskJson::parse(json).unwrap();
        assert_eq!(ask.libraries.len(), 3);
        assert_eq!(ask.libraries[0], LibraryEntry::Spec("npm:next".into()));
        assert_eq!(ask.libraries[1].spec(), "npm:zod");
        assert_eq!(
            ask.libraries[1].docs_paths(),
            Some(&["docs/API.md".to_string()][..])
        );
        assert_eq!(ask.libraries[2].docs_paths(), None);
    }

    #[test]
    fn string_entry_roundtrips_as_plain_string() {
        // The canonical no-override form must serialize back to a bare string,
        // not an object — otherwise every ask.json would churn on write.
        let entry = LibraryEntry::Spec("npm:next".into());
        assert_eq!(serde_json::to_string(&entry).unwrap(), "\"npm:next\"");
    }

    #[test]
    fn object_entry_uses_camelcase_docs_paths() {
        let entry = entry_from_spec("npm:zod", &["docs/API.md".to_string()]);
        assert_eq!(
            serde_json::to_string(&entry).unwrap(),
            r#"{"spec":"npm:zod","docsPaths":["docs/API.md"]}"#
        );
    }

    #[test]
    fn entry_from_spec_collapses_empty_docs_paths_to_string() {
        assert_eq!(
            entry_from_spec("npm:next", &[]),
            LibraryEntry::Spec("npm:next".into())
        );
        assert!(matches!(
            entry_from_spec("npm:next", &["d".to_string()]),
            LibraryEntry::WithDocs(_)
        ));
    }

    #[test]
    fn rejects_spec_without_ecosystem_prefix() {
        let err = AskJson::parse(r#"{"libraries":["next"]}"#).unwrap_err();
        assert!(err.to_string().contains("ecosystem prefix"));
    }

    #[test]
    fn rejects_spec_with_embedded_line_terminator() {
        // The `\n` here is a JSON escape → the parsed spec string contains a real
        // newline. TS's `.+$` regex rejects it; Rust must too.
        let err = AskJson::parse(r#"{"libraries":["npm:next\nmalicious"]}"#).unwrap_err();
        assert!(err.to_string().contains("ecosystem prefix"));
    }

    #[test]
    fn rejects_object_with_empty_docs_paths() {
        // Structurally valid but violates the non-empty refinement.
        let err =
            AskJson::parse(r#"{"libraries":[{"spec":"npm:zod","docsPaths":[]}]}"#).unwrap_err();
        assert!(err.to_string().contains("non-empty"));
    }

    #[test]
    fn rejects_unknown_top_level_field() {
        assert!(AskJson::parse(r#"{"libraries":[],"extra":1}"#).is_err());
    }

    #[test]
    fn rejects_unknown_object_entry_field() {
        assert!(AskJson::parse(
            r#"{"libraries":[{"spec":"npm:zod","docsPaths":["d"],"ref":"v1"}]}"#
        )
        .is_err());
    }

    #[test]
    fn spec_string_shape_matches_regex() {
        assert!(is_valid_spec_string("npm:next"));
        assert!(is_valid_spec_string("github:owner/repo@v1.2.3"));
        assert!(is_valid_spec_string("llms-txt:x"));
        assert!(!is_valid_spec_string("Next:x")); // uppercase prefix start
        assert!(!is_valid_spec_string("npm:")); // empty payload
        assert!(!is_valid_spec_string("noprefix"));
        assert!(!is_valid_spec_string(":x")); // empty prefix
    }

    #[test]
    fn store_mode_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&StoreMode::Ref).unwrap(), "\"ref\"");
        assert_eq!(
            serde_json::from_str::<StoreMode>("\"link\"").unwrap(),
            StoreMode::Link
        );
    }
}
