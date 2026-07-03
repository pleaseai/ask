//! Global ASK store — atomic writes, entry locking, content verification, the
//! store-version marker, and quarantine. Rust port of `store/index.ts`.
//!
//! The `github/db` and `github/checkouts` legacy layouts are intentionally NOT
//! reintroduced (see CLAUDE.md); only cache cleanup references them by name.

mod paths;

pub use paths::{
    assert_contained, assert_safe_segment, github_store_path, lexical_clean, llms_txt_store_path,
    normalize_url, npm_store_path, resolve_ask_home, web_store_path,
};

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use sha2::{Digest, Sha256};

const HASH_FILE: &str = ".ask-hash";
const STORE_VERSION_FILE: &str = "STORE_VERSION";
const CURRENT_STORE_VERSION: &str = "2";

/// A file to write into a store entry: a relative path and its text content.
pub struct EntryFile {
    pub path: String,
    pub content: String,
}

/// A short random-ish hex suffix for temp/backup directory names. Uniqueness is
/// only needed to avoid same-process collisions (the entry lock serializes real
/// writers), so SystemTime nanos XOR a process-lifetime counter suffices.
fn rand_hex8() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let n = nanos
        ^ (COUNTER
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_mul(0x9E37_79B9_7F4A_7C15));
    format!("{:08x}", (n as u32))
}

/// Atomically swap `tmp_dir` into `target`: rename any existing target to a
/// backup first (keeping the path continuously observable), move tmp into place,
/// then remove the backup. Restores the original on a failed move.
fn atomic_swap(tmp_dir: &Path, target: &Path) -> std::io::Result<()> {
    if target.exists() {
        let backup = sibling(target, ".bak-");
        std::fs::rename(target, &backup)?;
        if let Err(e) = std::fs::rename(tmp_dir, target) {
            let _ = std::fs::rename(&backup, target);
            return Err(e);
        }
        let _ = std::fs::remove_dir_all(&backup);
    } else {
        std::fs::rename(tmp_dir, target)?;
    }
    Ok(())
}

fn sibling(target: &Path, infix: &str) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    target.with_file_name(format!("{name}{infix}{}", rand_hex8()))
}

/// Atomically write a directory of files to `target_dir` (temp dir + rename).
/// Each file path is containment-checked so a malicious archive entry
/// (`../../etc/passwd`) cannot escape.
pub fn write_entry_atomic(target_dir: &Path, files: &[EntryFile]) -> anyhow::Result<()> {
    let tmp_dir = sibling(target_dir, ".tmp-");
    std::fs::create_dir_all(&tmp_dir)?;
    let result = (|| -> anyhow::Result<()> {
        for file in files {
            let file_path = tmp_dir.join(&file.path);
            assert_contained(&tmp_dir, &file_path)?;
            if let Some(parent) = file_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&file_path, &file.content)?;
        }
        atomic_swap(&tmp_dir, target_dir)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
    result
}

/// Atomically copy a directory tree to `target_dir`, preserving symlinks
/// **verbatim** (not resolving them against the source). Without this, relative
/// symlinks would bake in absolute paths pointing at the soon-deleted clone tmp
/// dir, breaking every later `verify_entry` with ENOENT (the gitbutler CLAUDE.md
/// symlink gotcha).
pub fn cp_dir_atomic(source_dir: &Path, target_dir: &Path) -> anyhow::Result<()> {
    let tmp_dir = sibling(target_dir, ".tmp-");
    if let Some(parent) = tmp_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let result = (|| -> anyhow::Result<()> {
        copy_tree_verbatim(source_dir, &tmp_dir)?;
        atomic_swap(&tmp_dir, target_dir)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
    result
}

/// Recursively copy `src` into `dst`, copying symlinks as symlinks (verbatim
/// target) rather than following them.
fn copy_tree_verbatim(src: &Path, dst: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_symlink() {
            let target = std::fs::read_link(&from)?;
            symlink_verbatim(&target, &to)?;
        } else if file_type.is_dir() {
            copy_tree_verbatim(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn symlink_verbatim(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink_verbatim(target: &Path, link: &Path) -> std::io::Result<()> {
    // Windows requires privileges/target-type for symlinks; fall back to copying
    // the resolved file (best-effort; the store gotchas this guards are unix).
    std::fs::copy(target, link).map(|_| ())
}

// ── Entry locking ──────────────────────────────────────────────────

const LOCK_TIMEOUT: Duration = Duration::from_secs(60);
const LOCK_INITIAL_DELAY: Duration = Duration::from_millis(100);
const LOCK_MAX_DELAY: Duration = Duration::from_millis(1600);

/// An acquired entry lock; removes its lock file on drop.
pub struct EntryLock {
    lock_path: PathBuf,
}

impl Drop for EntryLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.lock_path);
    }
}

/// Acquire a per-entry advisory lock (`<entry>.lock`, exclusive-create) with
/// exponential backoff. Returns `Ok(None)` when the target entry appears while
/// waiting (another process finished the write — treat as a hit). Errors on
/// timeout without deleting the live lock.
pub fn acquire_entry_lock(entry_dir: &Path) -> anyhow::Result<Option<EntryLock>> {
    let lock_path = {
        let name = entry_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        entry_dir.with_file_name(format!("{name}.lock"))
    };
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let deadline = Instant::now() + LOCK_TIMEOUT;
    let mut delay = LOCK_INITIAL_DELAY;

    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(_) => return Ok(Some(EntryLock { lock_path })),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Held elsewhere. If the target now exists, another process
                // finished — treat as a store hit.
                if entry_dir.exists() {
                    return Ok(None);
                }
                if Instant::now() >= deadline {
                    anyhow::bail!(
                        "Timed out waiting for lock: {}. Another ask install may be in progress. \
                         If no other process is running, remove it manually.",
                        lock_path.display()
                    );
                }
                std::thread::sleep(delay);
                delay = (delay * 2).min(LOCK_MAX_DELAY);
            }
            Err(e) => return Err(e.into()),
        }
    }
}

// ── Content verification ───────────────────────────────────────────

/// Compute and record a content hash for a finalized entry (`.ask-hash`).
pub fn stamp_entry(entry_dir: &Path) -> anyhow::Result<String> {
    let hash = hash_dir(entry_dir)?;
    std::fs::write(entry_dir.join(HASH_FILE), &hash)?;
    Ok(hash)
}

/// Whether an entry's recorded `.ask-hash` matches its recomputed hash.
pub fn verify_entry(entry_dir: &Path) -> bool {
    let hash_path = entry_dir.join(HASH_FILE);
    let Ok(recorded) = std::fs::read_to_string(&hash_path) else {
        return false;
    };
    match hash_dir(entry_dir) {
        Ok(actual) => recorded.trim() == actual,
        Err(_) => false,
    }
}

/// sha256 over the sorted relative file list, `<relpath>\0<bytes>\0` per file,
/// skipping the `.ask-hash` file itself.
fn hash_dir(dir: &Path) -> anyhow::Result<String> {
    let mut files = collect_files(dir, "")?;
    files.sort();
    let mut hasher = Sha256::new();
    for rel in &files {
        if Path::new(rel).file_name().and_then(|n| n.to_str()) == Some(HASH_FILE) {
            continue;
        }
        hasher.update(rel.as_bytes());
        hasher.update([0u8]);
        hasher.update(std::fs::read(dir.join(rel))?);
        hasher.update([0u8]);
    }
    Ok(format!("sha256-{:x}", hasher.finalize()))
}

/// Relative file paths under `dir` (recursive, forward-slash separated).
fn collect_files(dir: &Path, prefix: &str) -> anyhow::Result<Vec<String>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if entry.file_type()?.is_dir() {
            out.extend(collect_files(&entry.path(), &rel)?);
        } else {
            out.push(rel);
        }
    }
    Ok(out)
}

// ── Store version ──────────────────────────────────────────────────

/// Write `<askHome>/STORE_VERSION` if absent or stale (best-effort).
pub fn write_store_version(ask_home: &Path) {
    let file = ask_home.join(STORE_VERSION_FILE);
    let _ = std::fs::create_dir_all(ask_home);
    let existing = std::fs::read_to_string(&file)
        .ok()
        .map(|s| s.trim().to_string());
    if existing.as_deref() != Some(CURRENT_STORE_VERSION) {
        let _ = std::fs::write(&file, format!("{CURRENT_STORE_VERSION}\n"));
    }
}

/// Read `<askHome>/STORE_VERSION`, or `None` for a fresh/pre-v2 store.
pub fn read_store_version(ask_home: &Path) -> Option<String> {
    std::fs::read_to_string(ask_home.join(STORE_VERSION_FILE))
        .ok()
        .map(|s| s.trim().to_string())
}

// ── Quarantine ─────────────────────────────────────────────────────

/// Move a corrupt entry (one failing `verify_entry`) to
/// `<askHome>/.quarantine/<ts>-<rand>/` for inspection; a rename failure falls
/// back to a best-effort remove.
pub fn quarantine_entry(ask_home: &Path, store_dir: &Path) {
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let quarantine_dir = ask_home
        .join(".quarantine")
        .join(format!("{ts}-{}", rand_hex8()));
    if let Some(parent) = quarantine_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::rename(store_dir, &quarantine_dir).is_err() {
        let _ = std::fs::remove_dir_all(store_dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ef(path: &str, content: &str) -> EntryFile {
        EntryFile {
            path: path.into(),
            content: content.into(),
        }
    }

    #[test]
    fn write_then_verify_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("entry");
        write_entry_atomic(&target, &[ef("INDEX.md", "hi"), ef("sub/a.md", "x")]).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("INDEX.md")).unwrap(),
            "hi"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("sub/a.md")).unwrap(),
            "x"
        );

        stamp_entry(&target).unwrap();
        assert!(verify_entry(&target));
        // Tamper → verification fails.
        std::fs::write(target.join("INDEX.md"), "changed").unwrap();
        assert!(!verify_entry(&target));
    }

    #[test]
    fn write_entry_rejects_escaping_path() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("entry");
        assert!(write_entry_atomic(&target, &[ef("../escape.md", "x")]).is_err());
    }

    #[test]
    fn write_entry_overwrites_existing_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("entry");
        write_entry_atomic(&target, &[ef("a.md", "1")]).unwrap();
        write_entry_atomic(&target, &[ef("b.md", "2")]).unwrap();
        // The second write replaced the first entirely.
        assert!(!target.join("a.md").exists());
        assert_eq!(std::fs::read_to_string(target.join("b.md")).unwrap(), "2");
    }

    #[cfg(unix)]
    #[test]
    fn cp_dir_preserves_symlinks_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("AGENTS.md"), "agents").unwrap();
        std::os::unix::fs::symlink("AGENTS.md", src.join("CLAUDE.md")).unwrap();

        let target = dir.path().join("dst");
        cp_dir_atomic(&src, &target).unwrap();
        let link = target.join("CLAUDE.md");
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        // The relative target is preserved verbatim (not absolutized).
        assert_eq!(std::fs::read_link(&link).unwrap(), Path::new("AGENTS.md"));
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "agents");
    }

    #[test]
    fn lock_acquire_release_and_hit() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("e");
        let lock = acquire_entry_lock(&entry).unwrap().unwrap();
        assert!(dir.path().join("e.lock").exists());
        drop(lock);
        assert!(!dir.path().join("e.lock").exists());

        // Lock held + target exists → treated as a hit (None).
        std::fs::create_dir_all(&entry).unwrap();
        let _held = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.path().join("e.lock"))
            .unwrap();
        assert!(acquire_entry_lock(&entry).unwrap().is_none());
    }

    #[test]
    fn store_version_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_store_version(dir.path()), None);
        write_store_version(dir.path());
        assert_eq!(read_store_version(dir.path()).as_deref(), Some("2"));
    }

    #[test]
    fn quarantine_moves_entry_out() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("npm").join("bad@1.0.0");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("x"), "y").unwrap();
        quarantine_entry(dir.path(), &store);
        assert!(!store.exists());
        assert!(dir
            .path()
            .join(".quarantine")
            .read_dir()
            .unwrap()
            .next()
            .is_some());
    }
}
