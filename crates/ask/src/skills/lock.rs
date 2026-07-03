//! The `ask skills` install lock (`.ask/skills-lock.json`) — the source of
//! truth for `skills remove`. Rust port of `skills/lock.ts`.
//!
//! Entries are keyed by spec-key. Unlike the TS build (insertion order), the
//! Rust store keys entries in a `BTreeMap` for deterministic on-disk ordering,
//! matching `resolved.json`'s convention. The differential harness normalizes
//! the volatile `installedAt` timestamp before diffing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const LOCK_FILENAME: &str = ".ask/skills-lock.json";

/// One installed skill: its name and the agents it was symlinked into.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockSkill {
    /// Skill name — the basename of the source skill directory.
    pub name: String,
    /// Agents whose `<agent>/skills/<name>` symlinks were installed.
    pub agents: Vec<String>,
}

/// One lock entry per installed spec. Field order matches the TS object literal
/// so `serde_json::to_string_pretty` reproduces `JSON.stringify` byte-for-byte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockEntry {
    /// Original user-facing spec, e.g. `npm:next@14.2.3`.
    pub spec: String,
    /// Filesystem-safe encoding (see `encode_spec_key`).
    pub spec_key: String,
    /// Skills installed for this entry.
    pub skills: Vec<LockSkill>,
    /// ISO timestamp of the last install.
    pub installed_at: String,
}

/// The whole lock file: a fixed `version: 1` plus the spec-key → entry map.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockFile {
    pub version: u8,
    pub entries: BTreeMap<String, LockEntry>,
}

impl Default for LockFile {
    fn default() -> Self {
        LockFile {
            version: 1,
            entries: BTreeMap::new(),
        }
    }
}

pub fn lock_path(project_dir: &Path) -> PathBuf {
    project_dir.join(LOCK_FILENAME)
}

/// Read the lock, returning an empty `version: 1` lock when the file is absent.
/// Errors on a schema mismatch (non-object, or `version != 1`). Parity with
/// `readLock`.
pub fn read_lock(project_dir: &Path) -> anyhow::Result<LockFile> {
    let p = lock_path(project_dir);
    if !p.exists() {
        return Ok(LockFile::default());
    }
    let raw = std::fs::read_to_string(&p)?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    let ok = value.get("version").and_then(|v| v.as_u64()) == Some(1)
        && value.get("entries").map(|e| e.is_object()).unwrap_or(false);
    if !ok {
        anyhow::bail!("{LOCK_FILENAME}: schema mismatch");
    }
    Ok(serde_json::from_value(value)?)
}

/// Return a new lock with `entry` inserted/overwritten under its spec-key.
pub fn upsert_entry(lock: &LockFile, entry: LockEntry) -> LockFile {
    let mut entries = lock.entries.clone();
    entries.insert(entry.spec_key.clone(), entry);
    LockFile {
        version: 1,
        entries,
    }
}

/// Return a new lock with `spec_key` removed (or the lock unchanged if absent).
pub fn remove_entry(lock: &LockFile, spec_key: &str) -> LockFile {
    let mut entries = lock.entries.clone();
    entries.remove(spec_key);
    LockFile {
        version: 1,
        entries,
    }
}

/// Serialize (`JSON.stringify(lock, null, 2)\n`) to a `.tmp` neighbour then
/// rename into place. The `.ask/` parent is created on demand. Parity with
/// `writeLockAtomic`.
pub fn write_lock_atomic(project_dir: &Path, lock: &LockFile) -> anyhow::Result<()> {
    let target = lock_path(project_dir);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension("json.tmp");
    let body = format!("{}\n", serde_json::to_string_pretty(lock)?);
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(spec: &str, spec_key: &str) -> LockEntry {
        LockEntry {
            spec: spec.to_string(),
            spec_key: spec_key.to_string(),
            skills: vec![LockSkill {
                name: "s".to_string(),
                agents: vec!["claude".to_string()],
            }],
            installed_at: "2026-07-04T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn missing_lock_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let lock = read_lock(dir.path()).unwrap();
        assert_eq!(lock.version, 1);
        assert!(lock.entries.is_empty());
    }

    #[test]
    fn write_read_roundtrip_and_camelcase_keys() {
        let dir = tempfile::tempdir().unwrap();
        let lock = upsert_entry(
            &LockFile::default(),
            entry("npm:react@18", "npm__react__18"),
        );
        write_lock_atomic(dir.path(), &lock).unwrap();
        let body = std::fs::read_to_string(dir.path().join(LOCK_FILENAME)).unwrap();
        assert!(body.contains("\"specKey\""));
        assert!(body.contains("\"installedAt\""));
        assert!(body.ends_with("}\n"));
        let back = read_lock(dir.path()).unwrap();
        assert_eq!(back, lock);
    }

    #[test]
    fn field_order_matches_ts_literal() {
        let lock = upsert_entry(
            &LockFile::default(),
            entry("npm:react@18", "npm__react__18"),
        );
        let body = serde_json::to_string_pretty(&lock).unwrap();
        let spec = body.find("\"spec\"").unwrap();
        let spec_key = body.find("\"specKey\"").unwrap();
        let skills = body.find("\"skills\"").unwrap();
        let installed = body.find("\"installedAt\"").unwrap();
        assert!(spec < spec_key && spec_key < skills && skills < installed);
    }

    #[test]
    fn upsert_and_remove() {
        let lock = upsert_entry(&LockFile::default(), entry("a", "ka"));
        let lock = upsert_entry(&lock, entry("b", "kb"));
        assert_eq!(lock.entries.len(), 2);
        let lock = remove_entry(&lock, "ka");
        assert_eq!(lock.entries.len(), 1);
        assert!(lock.entries.contains_key("kb"));
        // Removing an absent key is a no-op.
        let same = remove_entry(&lock, "nope");
        assert_eq!(same.entries.len(), 1);
    }

    #[test]
    fn schema_mismatch_errors() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".ask")).unwrap();
        std::fs::write(
            dir.path().join(LOCK_FILENAME),
            r#"{"version":2,"entries":{}}"#,
        )
        .unwrap();
        assert!(read_lock(dir.path()).is_err());
    }
}
