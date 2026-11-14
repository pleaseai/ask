//! Global ASK store — atomic writes, entry locking, content verification, the
//! store-version marker, and quarantine. Rust port of `store/index.ts`.
//!
//! The `github/db` and `github/checkouts` legacy layouts are intentionally NOT
//! reintroduced (see CLAUDE.md); only cache cleanup references them by name.

pub mod cache;
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
            // Restoring fails only when another publisher already put its own
            // (stamped) entry here; then the backup is just garbage.
            if std::fs::rename(&backup, target).is_err() {
                let _ = std::fs::remove_dir_all(&backup);
            }
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
        // `source_dir` is the containment root: a (non-unix) symlink whose target
        // dereferences outside it must not pull unrelated files into the entry.
        copy_tree_verbatim(source_dir, source_dir, &tmp_dir)?;
        atomic_swap(&tmp_dir, target_dir)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
    result
}

/// Like [`cp_dir_atomic`], but the copy is finished before it becomes visible:
/// `prepare` adds ask's own files to it and it is stamped, then swapped in. A
/// reader therefore never sees an unstamped entry and never quarantines a
/// publication in progress. The copy is a sibling of `target_dir`, so relative
/// symlinks resolve the same way and the stamp still matches after the swap.
pub fn publish_entry(
    source_dir: &Path,
    target_dir: &Path,
    prepare: impl FnOnce(&Path) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let tmp_dir = sibling(target_dir, ".tmp-");
    if let Some(parent) = tmp_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let result = (|| -> anyhow::Result<()> {
        copy_tree_verbatim(source_dir, source_dir, &tmp_dir)?;
        prepare(&tmp_dir)?;
        stamp_entry(&tmp_dir)?;
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
fn copy_tree_verbatim(root: &Path, src: &Path, dst: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_symlink() {
            let target = std::fs::read_link(&from)?;
            symlink_verbatim(root, &target, &from, &to)?;
        } else if file_type.is_dir() {
            copy_tree_verbatim(root, &from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn symlink_verbatim(
    _root: &Path,
    target: &Path,
    _src_link: &Path,
    link: &Path,
) -> std::io::Result<()> {
    // Unix records the link verbatim — it never dereferences the target, so an
    // escaping target is just a link, not a copy of external content.
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink_verbatim(
    root: &Path,
    target: &Path,
    src_link: &Path,
    link: &Path,
) -> std::io::Result<()> {
    // Windows requires privileges/target-type for symlinks; fall back to copying
    // the resolved file (best-effort; the store gotchas this guards are unix).
    // `target` may be RELATIVE to the source link's directory, so resolve it
    // against `src_link.parent()` before copying — copying the raw relative
    // target would resolve against the process CWD and read the wrong file / fail.
    let resolved = if target.is_absolute() {
        target.to_path_buf()
    } else {
        src_link
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(target)
    };
    // Containment: unlike unix (which only records the link), this branch COPIES
    // the target's bytes into the entry. A symlink whose target dereferences
    // outside the copy root (`../…`, an absolute path, or an escaping chain)
    // would exfiltrate unrelated local files into the cached entry — so canonicalize
    // both and skip the entry when the target escapes the root or cannot be resolved.
    match (
        std::fs::canonicalize(root),
        std::fs::canonicalize(&resolved),
    ) {
        (Ok(real_root), Ok(real_target)) if real_target.starts_with(&real_root) => {
            std::fs::copy(&real_target, link).map(|_| ())
        }
        _ => Ok(()), // escapes the root or unresolvable → skip, do not exfiltrate
    }
}

// ── Entry locking ──────────────────────────────────────────────────

const LOCK_TIMEOUT: Duration = Duration::from_secs(60);
const LOCK_INITIAL_DELAY: Duration = Duration::from_millis(100);
const LOCK_MAX_DELAY: Duration = Duration::from_millis(1600);

/// An acquired entry lock; removes its lock file on drop. The file carries an
/// owner token so a holder whose lock was taken over (see
/// [`acquire_entry_lock_to_replace`]) does not delete its successor's lock.
pub struct EntryLock {
    lock_path: PathBuf,
    token: String,
}

impl Drop for EntryLock {
    fn drop(&mut self) {
        if std::fs::read_to_string(&self.lock_path).is_ok_and(|t| t == self.token) {
            let _ = std::fs::remove_file(&self.lock_path);
        }
    }
}

/// Acquire a per-entry advisory lock (`<entry>.lock`, exclusive-create) with
/// exponential backoff. Returns `Ok(None)` when the target entry appears while
/// waiting (another process finished the write — treat as a hit). Errors on
/// timeout without deleting the live lock.
pub fn acquire_entry_lock(entry_dir: &Path) -> anyhow::Result<Option<EntryLock>> {
    acquire_lock(entry_dir, false, LOCK_TIMEOUT)
}

/// The `<entry>.lock` path guarding `entry_dir`.
pub fn entry_lock_path(entry_dir: &Path) -> PathBuf {
    let name = entry_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    entry_dir.with_file_name(format!("{name}.lock"))
}

/// Whether another process is writing `entry_dir` right now. A lock older than
/// the lock timeout was left behind by a killed process and does not count.
pub fn entry_lock_held(entry_dir: &Path) -> bool {
    std::fs::metadata(entry_lock_path(entry_dir)).is_ok_and(|m| !lock_abandoned(&m))
}

fn lock_abandoned(lock: &std::fs::Metadata) -> bool {
    lock.modified()
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age > LOCK_TIMEOUT)
}

/// Like [`acquire_entry_lock`], but for replacing an entry that already
/// exists: an existing target does not mean the holder is done, so wait for
/// the lock itself. A lock older than the lock timeout was left by a killed
/// process and is taken over. Returns `Ok(None)`, leaving the existing entry
/// in place, only on timeout.
pub fn acquire_entry_lock_to_replace(entry_dir: &Path) -> anyhow::Result<Option<EntryLock>> {
    acquire_lock(entry_dir, true, LOCK_TIMEOUT)
}

fn acquire_lock(
    entry_dir: &Path,
    replacing: bool,
    timeout: Duration,
) -> anyhow::Result<Option<EntryLock>> {
    let lock_path = entry_lock_path(entry_dir);
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let deadline = Instant::now() + timeout;
    let mut delay = LOCK_INITIAL_DELAY;

    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                use std::io::Write;
                let token = format!("{}-{}", std::process::id(), rand_hex8());
                file.write_all(token.as_bytes())?;
                return Ok(Some(EntryLock { lock_path, token }));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Held elsewhere. If the target now exists, another process
                // finished — treat as a store hit.
                if !replacing && entry_dir.exists() {
                    return Ok(None);
                }
                if replacing
                    && std::fs::metadata(&lock_path).is_ok_and(|m| lock_abandoned(&m))
                    && take_over_abandoned_lock(&lock_path)
                {
                    continue;
                }
                if Instant::now() >= deadline {
                    if replacing && entry_dir.exists() {
                        return Ok(None);
                    }
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

/// Move an abandoned lock out of the way. Renaming is atomic, so of several
/// processes taking over at once only one moves the file; the moved file is
/// checked again in case a fresh lock was created in between, and put back
/// if so. Returns false when nothing was taken over (permissions, a lock that
/// turned out to be live), so the caller falls back to the bounded wait.
/// Entries are published fully stamped (`publish_entry`), so even a slow live
/// writer that loses its lock this way cannot leave a corrupt entry behind.
fn take_over_abandoned_lock(lock_path: &Path) -> bool {
    let moved = sibling(lock_path, ".stale-");
    if std::fs::rename(lock_path, &moved).is_err() {
        return false;
    }
    if std::fs::metadata(&moved).is_ok_and(|m| lock_abandoned(&m)) {
        let _ = std::fs::remove_file(&moved);
        return true;
    }
    // A live lock was moved: put it back without overwriting a newer one.
    if std::fs::hard_link(&moved, lock_path).is_ok() {
        let _ = std::fs::remove_file(&moved);
    }
    false
}

// ── Content verification ───────────────────────────────────────────

/// Compute and record a content hash for a finalized entry (`.ask-hash`).
pub fn stamp_entry(entry_dir: &Path) -> anyhow::Result<String> {
    // Clear the reserved path first, so a `.ask-hash` directory in the fetched
    // tree is not hashed and then deleted.
    let hash_path = entry_dir.join(HASH_FILE);
    remove_store_path(&hash_path)?;
    let hash = hash_dir(entry_dir)?;
    std::fs::write(&hash_path, &hash)?;
    Ok(hash)
}

/// Write a file ask owns inside a store entry. Whatever the fetched tree put
/// at that path (a symlink in particular) is removed first, so the write can
/// never follow a link out of the store.
pub fn write_store_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    remove_store_path(path)?;
    std::fs::write(path, contents)
}

/// Remove whatever is at `path` without following a symlink.
fn remove_store_path(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Whether an entry's recorded `.ask-hash` matches its recomputed hash.
///
/// A publisher may swap the entry while it is being hashed. When the recorded
/// hash changed or the entry briefly vanished during the check, the check is
/// repeated, so a valid replacement is not reported (and quarantined) as
/// corrupt.
pub fn verify_entry(entry_dir: &Path) -> bool {
    let hash_path = entry_dir.join(HASH_FILE);
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(50));
        }
        let recorded = std::fs::read_to_string(&hash_path).ok();
        if let (Some(recorded), Ok(actual)) = (&recorded, hash_dir(entry_dir)) {
            if recorded.trim() == actual {
                return true;
            }
        }
        let swapped = !entry_dir.exists() || std::fs::read_to_string(&hash_path).ok() != recorded;
        if !swapped {
            return false;
        }
    }
    false
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
    fn replacing_waits_for_the_holder_even_when_the_entry_exists() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("e");
        std::fs::create_dir_all(&entry).unwrap();
        let lock_path = dir.path().join("e.lock");
        std::fs::File::create(&lock_path).unwrap();

        let releaser = {
            let lock_path = lock_path.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                std::fs::remove_file(lock_path).unwrap();
            })
        };
        let lock = acquire_lock(&entry, true, Duration::from_secs(10)).unwrap();
        releaser.join().unwrap();
        assert!(lock.is_some());
        assert!(lock_path.exists());
    }

    #[test]
    fn replacing_keeps_the_existing_entry_when_the_lock_never_frees() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("e");
        std::fs::create_dir_all(&entry).unwrap();
        std::fs::File::create(dir.path().join("e.lock")).unwrap();
        let lock = acquire_lock(&entry, true, Duration::from_millis(200)).unwrap();
        assert!(lock.is_none());
    }

    #[test]
    fn replacing_takes_over_an_abandoned_lock() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("e");
        std::fs::create_dir_all(&entry).unwrap();
        let lock = std::fs::File::create(dir.path().join("e.lock")).unwrap();
        lock.set_modified(SystemTime::now() - LOCK_TIMEOUT * 2)
            .unwrap();
        assert!(!entry_lock_held(&entry));
        let started = Instant::now();
        let taken = acquire_lock(&entry, true, Duration::from_secs(10)).unwrap();
        assert!(taken.is_some());
        assert!(entry_lock_held(&entry));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_lock_taken_over_is_not_deleted_by_its_previous_owner() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("e");
        let old_owner = acquire_entry_lock(&entry).unwrap().unwrap();
        // Another process takes the lock over and writes its own token.
        let lock_path = entry_lock_path(&entry);
        std::fs::remove_file(&lock_path).unwrap();
        std::fs::write(&lock_path, "successor").unwrap();
        drop(old_owner);
        assert_eq!(std::fs::read_to_string(&lock_path).unwrap(), "successor");
    }

    #[cfg(unix)]
    #[test]
    fn an_abandoned_lock_that_cannot_be_moved_times_out_instead_of_spinning() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("repo");
        let entry = parent.join("e");
        std::fs::create_dir_all(&entry).unwrap();
        let lock = std::fs::File::create(parent.join("e.lock")).unwrap();
        lock.set_modified(SystemTime::now() - LOCK_TIMEOUT * 2)
            .unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o555)).unwrap();
        if std::fs::File::create(parent.join("probe")).is_ok() {
            // Running as root: permissions do not block the takeover here.
            std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }
        let started = Instant::now();
        let result = acquire_lock(&entry, true, Duration::from_millis(300));
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.unwrap().is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn published_entry_is_stamped_before_it_replaces_the_old_one() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("e");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("old.txt"), "old").unwrap();
        stamp_entry(&target).unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("new.txt"), "new").unwrap();

        publish_entry(&src, &target, |staged| {
            // Still the old, valid entry while the new one is prepared.
            assert!(target.join("old.txt").exists());
            assert!(verify_entry(&target));
            std::fs::write(staged.join(".ask-meta.json"), "{}")?;
            Ok(())
        })
        .unwrap();

        assert!(target.join("new.txt").exists());
        assert!(target.join(".ask-meta.json").exists());
        assert!(!target.join("old.txt").exists());
        assert!(verify_entry(&target));
    }

    #[test]
    fn stamping_ignores_a_hash_directory_from_the_fetched_tree() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("e");
        std::fs::create_dir_all(entry.join(HASH_FILE)).unwrap();
        std::fs::write(entry.join(HASH_FILE).join("x"), "x").unwrap();
        std::fs::write(entry.join("a.txt"), "a").unwrap();
        stamp_entry(&entry).unwrap();
        assert!(verify_entry(&entry));
    }

    #[cfg(unix)]
    #[test]
    fn stamping_replaces_a_hash_symlink_instead_of_following_it() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, "keep").unwrap();
        let entry = dir.path().join("e");
        std::fs::create_dir_all(&entry).unwrap();
        std::os::unix::fs::symlink(&outside, entry.join(HASH_FILE)).unwrap();

        stamp_entry(&entry).unwrap();

        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
        let meta = std::fs::symlink_metadata(entry.join(HASH_FILE)).unwrap();
        assert!(meta.file_type().is_file());
        assert!(verify_entry(&entry));
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
