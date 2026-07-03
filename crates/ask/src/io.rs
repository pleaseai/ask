//! `ask.json` / `.ask/resolved.json` file I/O + hashing — Rust port of
//! `packages/cli/src/io.ts`.
//!
//! `ask.json` is a root-level file (beside `package.json`); `.ask/` holds
//! materialized, gitignored output (docs + the resolved cache).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::ask_json::{AskJson, LibraryEntry};
use crate::resolved::{ResolvedEntry, ResolvedJson};
use crate::spec::{library_name_from_spec, parse_spec, split_explicit_version, ParsedSpec};

const ASK_DIR: &str = ".ask";
const ASK_JSON_FILE: &str = "ask.json";
const RESOLVED_FILE: &str = "resolved.json";

/// Serialize a value to JSON with **recursively sorted keys**, 2-space indent,
/// and a trailing newline. Two calls with semantically equivalent input always
/// produce the same byte string (port of `sortedJSON`).
///
/// Routing through `serde_json::Value` normalizes key order: serde_json's `Map`
/// is a `BTreeMap` by default (the `preserve_order` feature is off), so
/// `to_value` yields sorted maps at every level and arrays keep their order —
/// exactly the TS `sortKeys` contract.
pub fn sorted_json<T: Serialize>(value: &T) -> String {
    let normalized = serde_json::to_value(value).expect("serializable value");
    let mut out = serde_json::to_string_pretty(&normalized).expect("serializable value");
    out.push('\n');
    out
}

/// A file participating in a content hash. Exactly one of `bytes`/`content` is
/// used (bytes wins); an absent payload hashes as empty, matching the TS.
pub struct HashableFile {
    pub relpath: String,
    pub bytes: Option<Vec<u8>>,
    pub content: Option<String>,
}

impl HashableFile {
    fn payload(&self) -> &[u8] {
        if let Some(b) = &self.bytes {
            b
        } else if let Some(c) = &self.content {
            c.as_bytes()
        } else {
            &[]
        }
    }
}

/// Deterministic content hash over a list of files. Files are sorted by relative
/// path; each contributes `<relpath>\0<bytes>\0` to the stream. The NUL
/// separators prevent `path + content` ambiguity (`"ab"+"cd"` vs `"a"+"bcd"`).
/// Returns `sha256-<hex>` (port of `contentHash`).
pub fn content_hash(files: &[HashableFile]) -> String {
    let mut sorted: Vec<&HashableFile> = files.iter().collect();
    sorted.sort_by(|a, b| a.relpath.cmp(&b.relpath));
    let mut hash = Sha256::new();
    for f in sorted {
        hash.update(f.relpath.as_bytes());
        hash.update([0u8]);
        hash.update(f.payload());
        hash.update([0u8]);
    }
    format!("sha256-{:x}", hash.finalize())
}

pub fn get_ask_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(ASK_DIR)
}

/// `ask.json` sits at the project root, NOT inside `.ask/`.
pub fn get_ask_json_path(project_dir: &Path) -> PathBuf {
    project_dir.join(ASK_JSON_FILE)
}

pub fn get_resolved_json_path(project_dir: &Path) -> PathBuf {
    get_ask_dir(project_dir).join(RESOLVED_FILE)
}

/// Locate a library entry in `ask.json` by user-supplied identifier. Matches in
/// three steps (parity with `findEntry` / `ask remove`):
///
///   1. Exact spec string.
///   2. Library name via `library_name_from_spec(split_explicit_version(...))`
///      — so `next` matches both `npm:next` and `npm:next@14`.
///   3. Raw npm package name — `next` → `npm:next`, `@scope/pkg` → `npm:@scope/pkg`.
///
/// Returns `None` when nothing matches so callers can fall through to defaults.
pub fn find_entry<'a>(ask_json: &'a AskJson, target: &str) -> Option<&'a LibraryEntry> {
    for entry in &ask_json.libraries {
        let spec = entry.spec();
        if spec == target {
            return Some(entry);
        }
        let (body, _version) = split_explicit_version(spec);
        if library_name_from_spec(body) == target {
            return Some(entry);
        }
        if let ParsedSpec::Npm { pkg, .. } = parse_spec(body) {
            if pkg == target {
                return Some(entry);
            }
        }
    }
    None
}

/// Read and validate `ask.json`. Returns `Ok(None)` when the file does not
/// exist (so the install orchestrator can bootstrap an empty file). Errors on
/// invalid JSON or schema violations.
pub fn read_ask_json(project_dir: &Path) -> anyhow::Result<Option<AskJson>> {
    let file = get_ask_json_path(project_dir);
    if !file.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&file)?;
    let ask = AskJson::parse(&raw)
        .map_err(|e| anyhow::anyhow!("Failed to parse {}: {e}.", file.display()))?;
    Ok(Some(ask))
}

/// Validate and write `ask.json`. Library entries are NOT reordered (users may
/// care about declaration order; `ask add` appends). Only object *keys* within
/// each entry are sorted, via `sorted_json`.
pub fn write_ask_json(project_dir: &Path, ask_json: &AskJson) -> anyhow::Result<()> {
    ask_json.validate()?;
    let file = get_ask_json_path(project_dir);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&file, sorted_json(ask_json))?;
    Ok(())
}

/// Read and validate `.ask/resolved.json`. Returns the default empty cache when
/// the file is missing OR fails to parse/validate — the cache is rebuilt from
/// scratch in that case. This is the contract that makes `resolved.json` safe to
/// delete by hand.
pub fn read_resolved_json(project_dir: &Path) -> ResolvedJson {
    let file = get_resolved_json_path(project_dir);
    let Ok(raw) = std::fs::read_to_string(&file) else {
        return empty_resolved();
    };
    ResolvedJson::parse(&raw).unwrap_or_else(|_| empty_resolved())
}

/// The default empty resolved cache.
pub fn empty_resolved() -> ResolvedJson {
    ResolvedJson {
        schema_version: 1,
        generated_at: "1970-01-01T00:00:00Z".to_string(),
        entries: BTreeMap::new(),
    }
}

/// Validate and write `.ask/resolved.json`.
pub fn write_resolved_json(project_dir: &Path, resolved: &ResolvedJson) -> anyhow::Result<()> {
    resolved.validate()?;
    let file = get_resolved_json_path(project_dir);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&file, sorted_json(resolved))?;
    Ok(())
}

/// Upsert a single entry into `.ask/resolved.json`. Skips the rewrite when
/// nothing changed (modulo `fetchedAt`) so file watchers stay quiet on no-op
/// runs (parity with `upsertResolvedEntry`).
pub fn upsert_resolved_entry(
    project_dir: &Path,
    key: &str,
    entry: ResolvedEntry,
) -> anyhow::Result<()> {
    let mut resolved = read_resolved_json(project_dir);
    let changed = match resolved.entries.get(key) {
        None => true,
        Some(previous) => !eq_ignoring_fetched_at(previous, &entry),
    };
    if !changed {
        return Ok(());
    }
    resolved.entries.insert(key.to_string(), entry);
    resolved.generated_at = now_iso();
    write_resolved_json(project_dir, &resolved)
}

/// Remove one or more entries from `.ask/resolved.json` by key. No-op if the
/// key set is empty (parity with `removeResolvedEntries`).
pub fn remove_resolved_entries(project_dir: &Path, keys: &[String]) -> anyhow::Result<()> {
    if keys.is_empty() {
        return Ok(());
    }
    let mut resolved = read_resolved_json(project_dir);
    for k in keys {
        resolved.entries.remove(k);
    }
    resolved.generated_at = now_iso();
    write_resolved_json(project_dir, &resolved)
}

/// Two entries are equal ignoring `fetched_at` (the TS `stripFetchedAt`
/// comparison, done structurally instead of via JSON).
fn eq_ignoring_fetched_at(a: &ResolvedEntry, b: &ResolvedEntry) -> bool {
    let mut a = a.clone();
    a.fetched_at = b.fetched_at.clone();
    &a == b
}

/// Current UTC time as an RFC3339 string (`new Date().toISOString()` analog).
fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("Rfc3339 formatting of now_utc is infallible")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask_json::entry_from_spec;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn sorted_json_sorts_keys_recursively_with_trailing_newline() {
        let value = serde_json::json!({ "b": 1, "a": { "d": 2, "c": 3 } });
        let out = sorted_json(&value);
        assert_eq!(
            out,
            "{\n  \"a\": {\n    \"c\": 3,\n    \"d\": 2\n  },\n  \"b\": 1\n}\n"
        );
    }

    #[test]
    fn content_hash_is_order_independent_and_nul_separated() {
        let f = |p: &str, c: &str| HashableFile {
            relpath: p.into(),
            bytes: None,
            content: Some(c.into()),
        };
        let a = content_hash(&[f("a.md", "x"), f("b.md", "y")]);
        let b = content_hash(&[f("b.md", "y"), f("a.md", "x")]);
        assert_eq!(a, b, "sorting by relpath makes order irrelevant");
        assert!(a.starts_with("sha256-"));
        assert_eq!(a.len(), "sha256-".len() + 64);
        // NUL separation: ("ab","cd") must differ from ("a","bcd").
        assert_ne!(
            content_hash(&[f("ab", "cd")]),
            content_hash(&[f("a", "bcd")])
        );
    }

    #[test]
    fn content_hash_matches_known_vector() {
        // sha256 of "a.md\0hello\0" — pin the exact stream format.
        let h = content_hash(&[HashableFile {
            relpath: "a.md".into(),
            bytes: None,
            content: Some("hello".into()),
        }]);
        let mut hasher = Sha256::new();
        hasher.update(b"a.md\0hello\0");
        assert_eq!(h, format!("sha256-{:x}", hasher.finalize()));
    }

    #[test]
    fn read_missing_ask_json_is_none() {
        let dir = tmp();
        assert!(read_ask_json(dir.path()).unwrap().is_none());
    }

    #[test]
    fn write_then_read_ask_json_roundtrips() {
        let dir = tmp();
        let ask = AskJson {
            libraries: vec![
                LibraryEntry::Spec("npm:next".into()),
                entry_from_spec("npm:zod", &["docs/API.md".to_string()]),
            ],
        };
        write_ask_json(dir.path(), &ask).unwrap();
        // ask.json is at the root, not under .ask/.
        assert!(dir.path().join("ask.json").exists());
        let back = read_ask_json(dir.path()).unwrap().unwrap();
        assert_eq!(back, ask);
    }

    #[test]
    fn find_entry_three_ways() {
        let ask = AskJson {
            libraries: vec![
                LibraryEntry::Spec("npm:next".into()),
                LibraryEntry::Spec("npm:@mastra/client-js".into()),
                LibraryEntry::Spec("github:vercel/next.js@v14.2.3".into()),
            ],
        };
        // 1. exact spec
        assert_eq!(find_entry(&ask, "npm:next").unwrap().spec(), "npm:next");
        // 2. library name (with version stripped)
        assert_eq!(
            find_entry(&ask, "next.js").unwrap().spec(),
            "github:vercel/next.js@v14.2.3"
        );
        // 3. raw npm package name (scoped)
        assert_eq!(
            find_entry(&ask, "@mastra/client-js").unwrap().spec(),
            "npm:@mastra/client-js"
        );
        assert!(find_entry(&ask, "nonexistent").is_none());
    }

    #[test]
    fn read_missing_resolved_is_empty_default() {
        let dir = tmp();
        let r = read_resolved_json(dir.path());
        assert_eq!(r.schema_version, 1);
        assert!(r.entries.is_empty());
    }

    #[test]
    fn corrupt_resolved_json_falls_back_to_empty() {
        let dir = tmp();
        let file = get_resolved_json_path(dir.path());
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "{ not valid json").unwrap();
        assert!(read_resolved_json(dir.path()).entries.is_empty());
    }

    fn sample_entry(spec: &str) -> ResolvedEntry {
        ResolvedEntry {
            spec: spec.into(),
            resolved_version: "1.0.0".into(),
            content_hash: format!("sha256-{}", "0".repeat(64)),
            fetched_at: "2026-07-04T00:00:00Z".into(),
            file_count: 1,
            format: None,
            store_path: None,
            materialization: None,
            in_place_path: None,
            commit: None,
            store_subpath: None,
        }
    }

    #[test]
    fn upsert_then_remove_resolved_entry() {
        let dir = tmp();
        upsert_resolved_entry(dir.path(), "next", sample_entry("npm:next")).unwrap();
        let r = read_resolved_json(dir.path());
        assert!(r.entries.contains_key("next"));
        // generatedAt was stamped to a real time (not the 1970 default).
        assert_ne!(r.generated_at, "1970-01-01T00:00:00Z");

        remove_resolved_entries(dir.path(), &["next".to_string()]).unwrap();
        assert!(!read_resolved_json(dir.path()).entries.contains_key("next"));
    }

    #[test]
    fn upsert_skips_rewrite_when_only_fetched_at_differs() {
        let dir = tmp();
        upsert_resolved_entry(dir.path(), "next", sample_entry("npm:next")).unwrap();
        let first = read_resolved_json(dir.path()).generated_at.clone();

        // Same entry but a different fetched_at → treated as unchanged, no rewrite.
        let mut again = sample_entry("npm:next");
        again.fetched_at = "2099-01-01T00:00:00Z".into();
        upsert_resolved_entry(dir.path(), "next", again).unwrap();
        assert_eq!(read_resolved_json(dir.path()).generated_at, first);

        // A material change (version) → rewrite.
        let mut changed = sample_entry("npm:next");
        changed.resolved_version = "2.0.0".into();
        upsert_resolved_entry(dir.path(), "next", changed).unwrap();
        assert_eq!(
            read_resolved_json(dir.path()).entries["next"].resolved_version,
            "2.0.0"
        );
    }
}
