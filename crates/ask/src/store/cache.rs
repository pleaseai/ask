//! Global store inspection + garbage collection for `ask cache`. Rust port of
//! `store/cache.ts`.
//!
//! `cache_ls` enumerates every entry under `<askHome>` (npm/web/llms-txt kind
//! dirs + the nested `github/<host>/<owner>/<repo>/<tag>/` layout, plus the
//! legacy `github/checkouts` layout tagged `legacy`). `cache_gc` removes entries
//! not referenced by any `.ask/resolved.json` under the scan roots, with an
//! optional age gate. `cache_clean_legacy` drops the pre-v2 github dirs.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::store::assert_contained;

/// One entry in the global store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheEntry {
    pub kind: CacheKind,
    pub key: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    /// True for the legacy `github/checkouts` layout — rendered with a
    /// `(legacy)` tag and a `(legacy) ` key prefix.
    pub legacy: bool,
}

/// Store entry kind. Serializes to the wire values `npm`/`github`/`web`/`llms-txt`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CacheKind {
    Npm,
    Github,
    Web,
    LlmsTxt,
}

impl CacheKind {
    /// The on-disk kind directory / wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            CacheKind::Npm => "npm",
            CacheKind::Github => "github",
            CacheKind::Web => "web",
            CacheKind::LlmsTxt => "llms-txt",
        }
    }

    /// Parse a `--kind` filter value.
    pub fn parse(s: &str) -> Option<CacheKind> {
        match s {
            "npm" => Some(CacheKind::Npm),
            "github" => Some(CacheKind::Github),
            "web" => Some(CacheKind::Web),
            "llms-txt" => Some(CacheKind::LlmsTxt),
            _ => None,
        }
    }
}

// ── JSON output models ─────────────────────────────────────────────

/// A cache entry as serialized in `--json` output (matches `CacheLsEntrySchema`).
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CacheLsEntry {
    pub kind: CacheKind,
    pub key: String,
    pub path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    /// Emitted only when true (absent otherwise), matching the TS shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy: Option<bool>,
}

impl CacheLsEntry {
    fn from_entry(e: &CacheEntry) -> Self {
        CacheLsEntry {
            kind: e.kind,
            key: e.key.clone(),
            path: e.path.to_string_lossy().into_owned(),
            size_bytes: e.size_bytes,
            legacy: if e.legacy { Some(true) } else { None },
        }
    }
}

/// `ask cache ls --json` model (matches `CacheLsModelSchema`).
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CacheLsModel {
    #[serde(rename = "askHome")]
    pub ask_home: String,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    pub entries: Vec<CacheLsEntry>,
}

/// `ask cache gc --json` model (matches `CacheGcModelSchema`).
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CacheGcModel {
    #[serde(rename = "askHome")]
    pub ask_home: String,
    #[serde(rename = "dryRun")]
    pub dry_run: bool,
    #[serde(rename = "freedBytes")]
    pub freed_bytes: u64,
    pub removed: Vec<CacheLsEntry>,
}

pub fn build_cache_ls_model(ask_home: &Path, filter: Option<CacheKind>) -> CacheLsModel {
    let entries = cache_ls(ask_home, filter);
    let total_bytes = entries.iter().map(|e| e.size_bytes).sum();
    CacheLsModel {
        ask_home: ask_home.to_string_lossy().into_owned(),
        total_bytes,
        entries: entries.iter().map(CacheLsEntry::from_entry).collect(),
    }
}

pub fn build_cache_gc_model(ask_home: &Path, options: &CacheGcOptions) -> CacheGcModel {
    let mut opts = options.clone();
    opts.silent = true;
    let result = cache_gc(ask_home, &opts);
    CacheGcModel {
        ask_home: ask_home.to_string_lossy().into_owned(),
        dry_run: options.dry_run,
        freed_bytes: result.freed_bytes,
        removed: result
            .removed
            .iter()
            .map(CacheLsEntry::from_entry)
            .collect(),
    }
}

// ── cache_ls ───────────────────────────────────────────────────────

/// List all entries in the store at `ask_home`, optionally filtered by kind.
pub fn cache_ls(ask_home: &Path, filter: Option<CacheKind>) -> Vec<CacheEntry> {
    let mut entries = Vec::new();
    let kinds: Vec<CacheKind> = match filter {
        Some(k) => vec![k],
        None => vec![
            CacheKind::Npm,
            CacheKind::Github,
            CacheKind::Web,
            CacheKind::LlmsTxt,
        ],
    };

    for kind in kinds {
        if kind == CacheKind::Github {
            collect_github(ask_home, &mut entries);
        } else {
            let kind_dir = ask_home.join(kind.as_str());
            if !kind_dir.exists() {
                continue;
            }
            for subdir in safe_readdir(&kind_dir) {
                let entry_path = kind_dir.join(&subdir);
                if !safe_is_directory(&entry_path) {
                    continue;
                }
                let size = dir_size(&entry_path);
                entries.push(CacheEntry {
                    kind,
                    key: subdir,
                    path: entry_path,
                    size_bytes: size,
                    legacy: false,
                });
            }
        }
    }

    entries
}

fn collect_github(ask_home: &Path, entries: &mut Vec<CacheEntry>) {
    // New nested layout: github/<host>/<owner>/<repo>/<tag>/
    let github_dir = ask_home.join("github");
    if github_dir.exists() {
        for host in safe_readdir(&github_dir) {
            // Skip legacy subdirs — handled separately below.
            if host == "db" || host == "checkouts" {
                continue;
            }
            let host_path = github_dir.join(&host);
            if !safe_is_directory(&host_path) {
                continue;
            }
            for owner in safe_readdir(&host_path) {
                let owner_path = host_path.join(&owner);
                if !safe_is_directory(&owner_path) {
                    continue;
                }
                for repo in safe_readdir(&owner_path) {
                    let repo_path = owner_path.join(&repo);
                    if !safe_is_directory(&repo_path) {
                        continue;
                    }
                    for tag in safe_readdir(&repo_path) {
                        let tag_path = repo_path.join(&tag);
                        if !safe_is_directory(&tag_path) {
                            continue;
                        }
                        let size = dir_size(&tag_path);
                        entries.push(CacheEntry {
                            kind: CacheKind::Github,
                            key: format!("{host}/{owner}/{repo}/{tag}"),
                            path: tag_path,
                            size_bytes: size,
                            legacy: false,
                        });
                    }
                }
            }
        }
    }

    // Legacy layout: github/checkouts/<owner>__<repo>/<ref>/
    let legacy_checkout_dir = ask_home.join("github").join("checkouts");
    if legacy_checkout_dir.exists() {
        for repo_dir in safe_readdir(&legacy_checkout_dir) {
            let repo_path = legacy_checkout_dir.join(&repo_dir);
            if !safe_is_directory(&repo_path) {
                continue;
            }
            for reference in safe_readdir(&repo_path) {
                let ref_path = repo_path.join(&reference);
                if !safe_is_directory(&ref_path) {
                    continue;
                }
                let size = dir_size(&ref_path);
                entries.push(CacheEntry {
                    kind: CacheKind::Github,
                    key: format!("(legacy) {repo_dir}/{reference}"),
                    path: ref_path,
                    size_bytes: size,
                    legacy: true,
                });
            }
        }
    }
}

// ── Legacy detection + cleanup ─────────────────────────────────────

/// Pre-store-v2 github paths under `<askHome>`.
pub fn legacy_layout_paths(ask_home: &Path) -> Vec<PathBuf> {
    vec![
        ask_home.join("github").join("db"),
        ask_home.join("github").join("checkouts"),
    ]
}

/// True iff any legacy github path exists under `<askHome>`.
pub fn detect_legacy_layout(ask_home: &Path) -> bool {
    legacy_layout_paths(ask_home).iter().any(|p| p.exists())
}

/// Remove all legacy github store paths under `<askHome>`. Idempotent.
pub fn cache_clean_legacy(ask_home: &Path) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    for p in legacy_layout_paths(ask_home) {
        if p.exists() {
            let _ = std::fs::remove_dir_all(&p);
            removed.push(p);
        }
    }
    removed
}

// ── parse_duration ─────────────────────────────────────────────────

/// Parse `30d`/`12h`/`90m`/`60s` into milliseconds. `None` on invalid input.
pub fn parse_duration(input: &str) -> Option<u64> {
    let s = input.trim();
    let idx = s.find(|c: char| !c.is_ascii_digit())?;
    if idx == 0 {
        return None; // no leading digits
    }
    let (num, rest) = s.split_at(idx);
    let unit = rest.trim();
    let n: u64 = num.parse().ok()?;
    match unit {
        "s" => Some(n * 1000),
        "m" => Some(n * 60 * 1000),
        "h" => Some(n * 60 * 60 * 1000),
        "d" => Some(n * 24 * 60 * 60 * 1000),
        _ => None,
    }
}

// ── cache_gc ───────────────────────────────────────────────────────

/// Options for [`cache_gc`].
#[derive(Debug, Clone, Default)]
pub struct CacheGcOptions {
    pub dry_run: bool,
    /// Roots to scan for `.ask/resolved.json`. `None` → `[$HOME]`.
    pub scan_roots: Option<Vec<PathBuf>>,
    /// Age gate in milliseconds; entries newer than `now - older_than` are kept.
    pub older_than: Option<u64>,
    /// Suppress per-entry progress (set by the `--json` path).
    pub silent: bool,
}

/// Result of a [`cache_gc`] run.
#[derive(Debug, Default)]
pub struct CacheGcResult {
    pub removed: Vec<CacheEntry>,
    pub kept: Vec<CacheEntry>,
    pub freed_bytes: u64,
}

/// Remove store entries not referenced by any `.ask/resolved.json` under the
/// scan roots. With `older_than`, unreferenced entries newer than the cutoff are
/// still kept.
pub fn cache_gc(ask_home: &Path, options: &CacheGcOptions) -> CacheGcResult {
    let scan_roots = options.scan_roots.clone().unwrap_or_else(|| {
        std::env::var("HOME")
            .ok()
            .filter(|h| !h.is_empty())
            .map(|h| vec![PathBuf::from(h)])
            .unwrap_or_default()
    });

    let referenced = collect_referenced_store_paths(&scan_roots, ask_home);
    let all_entries = cache_ls(ask_home, None);

    let mut result = CacheGcResult::default();
    let cutoff_ms = options.older_than.map(|ot| now_ms().saturating_sub(ot));

    for entry in all_entries {
        if referenced.contains(&entry.path) {
            result.kept.push(entry);
            continue;
        }
        if let Some(cutoff) = cutoff_ms {
            match entry_mtime_ms(&entry.path) {
                Some(mtime) if mtime > cutoff => {
                    result.kept.push(entry);
                    continue;
                }
                None => {
                    // Stat failure → keep to avoid accidental removal.
                    result.kept.push(entry);
                    continue;
                }
                _ => {}
            }
        }
        if !options.dry_run && std::fs::remove_dir_all(&entry.path).is_err() {
            result.kept.push(entry);
            continue;
        }
        result.freed_bytes += entry.size_bytes;
        result.removed.push(entry);
    }

    result
}

fn collect_referenced_store_paths(scan_roots: &[PathBuf], ask_home: &Path) -> BTreeSet<PathBuf> {
    let mut referenced = BTreeSet::new();
    for root in scan_roots {
        if root.as_os_str().is_empty() || !root.exists() {
            continue;
        }
        find_resolved_json_files(root, &mut referenced, ask_home, 0, 8);
    }
    referenced
}

fn find_resolved_json_files(
    dir: &Path,
    referenced: &mut BTreeSet<PathBuf>,
    ask_home: &Path,
    depth: usize,
    max_depth: usize,
) {
    if depth > max_depth {
        return;
    }

    let resolved_path = dir.join(".ask").join("resolved.json");
    if resolved_path.exists() {
        if let Ok(text) = std::fs::read_to_string(&resolved_path) {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(entries) = data.get("entries").and_then(|e| e.as_object()) {
                    for entry in entries.values() {
                        if let Some(sp) = entry.get("storePath").and_then(|v| v.as_str()) {
                            // Only trust storePath values inside ask_home — a
                            // stale/malicious resolved.json cannot pin entries
                            // outside the store.
                            let candidate = PathBuf::from(sp);
                            if let Ok(abs) = assert_contained(ask_home, &candidate) {
                                referenced.insert(abs);
                            }
                        }
                    }
                }
            }
        }
    }

    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        // is_dir() is false for symlinks, so symlinked dirs are excluded —
        // preventing cycle traps and scope escape.
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        find_resolved_json_files(
            &dir.join(name.as_ref()),
            referenced,
            ask_home,
            depth + 1,
            max_depth,
        );
    }
}

// ── format_bytes ───────────────────────────────────────────────────

/// Human-readable byte count. Matches the TS `toFixed(1)` rendering.
pub fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let b = bytes as f64;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if b < MB {
        format!("{:.1} KB", b / KB)
    } else if b < GB {
        format!("{:.1} MB", b / MB)
    } else {
        format!("{:.1} GB", b / GB)
    }
}

// ── Helpers ────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn entry_mtime_ms(p: &Path) -> Option<u64> {
    let meta = std::fs::metadata(p).ok()?;
    let mtime = meta.modified().ok()?;
    mtime
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn safe_is_directory(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

fn safe_readdir(dir: &Path) -> Vec<String> {
    match std::fs::read_dir(dir) {
        Ok(read) => read
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn dir_size(dir: &Path) -> u64 {
    let mut size = 0;
    let Ok(read) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in read.flatten() {
        let full = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => size += dir_size(&full),
            Ok(_) => {
                if let Ok(meta) = std::fs::metadata(&full) {
                    size += meta.len();
                }
            }
            Err(_) => {}
        }
    }
    size
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_duration_units() {
        assert_eq!(parse_duration("60s"), Some(60_000));
        assert_eq!(parse_duration("90m"), Some(90 * 60_000));
        assert_eq!(parse_duration("12h"), Some(12 * 3_600_000));
        assert_eq!(parse_duration("30d"), Some(30 * 86_400_000));
        assert_eq!(parse_duration(" 5 d "), Some(5 * 86_400_000));
        assert_eq!(parse_duration("d"), None);
        assert_eq!(parse_duration("10w"), None);
        assert_eq!(parse_duration("abc"), None);
    }

    #[test]
    fn format_bytes_thresholds() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(format_bytes(1024 * 1024 * 1024), "1.0 GB");
    }

    fn touch(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn cache_ls_walks_all_kinds_and_legacy() {
        let home = tempfile::tempdir().unwrap();
        let ah = home.path();
        touch(&ah.join("npm/react@18.3.1/INDEX.md"), "x");
        touch(
            &ah.join("github/github.com/facebook/react/v18.2.0/README.md"),
            "hello",
        );
        touch(&ah.join("web/abcd1234/page.md"), "web");
        touch(&ah.join("llms-txt/efgh5678/llms.md"), "llms");
        // Legacy layout.
        touch(&ah.join("github/checkouts/owner__repo/v1.0.0/f.md"), "leg");

        let entries = cache_ls(ah, None);
        let keys: Vec<&str> = entries.iter().map(|e| e.key.as_str()).collect();
        assert!(keys.contains(&"react@18.3.1"));
        assert!(keys.contains(&"github.com/facebook/react/v18.2.0"));
        assert!(keys.contains(&"abcd1234"));
        assert!(keys.contains(&"efgh5678"));
        assert!(keys
            .iter()
            .any(|k| k.starts_with("(legacy) owner__repo/v1.0.0")));
        // Legacy entry flagged.
        assert!(entries.iter().find(|e| e.legacy).is_some());
        // Filter by kind.
        let only_web = cache_ls(ah, Some(CacheKind::Web));
        assert_eq!(only_web.len(), 1);
        assert_eq!(only_web[0].kind, CacheKind::Web);
    }

    #[test]
    fn detect_and_clean_legacy() {
        let home = tempfile::tempdir().unwrap();
        let ah = home.path();
        assert!(!detect_legacy_layout(ah));
        touch(&ah.join("github/db/some-clone/HEAD"), "x");
        touch(&ah.join("github/checkouts/o__r/v1/f.md"), "y");
        assert!(detect_legacy_layout(ah));
        let removed = cache_clean_legacy(ah);
        assert_eq!(removed.len(), 2);
        assert!(!detect_legacy_layout(ah));
        // Idempotent.
        assert!(cache_clean_legacy(ah).is_empty());
    }

    #[test]
    fn gc_removes_unreferenced_keeps_referenced() {
        let home = tempfile::tempdir().unwrap();
        let ah = home.path();
        let used = ah.join("github/github.com/o/used/v1.0.0");
        let unused = ah.join("github/github.com/o/unused/v1.0.0");
        touch(&used.join("f.md"), "used");
        touch(&unused.join("f.md"), "unused");

        // A project whose resolved.json references the `used` entry.
        let proj = tempfile::tempdir().unwrap();
        let resolved = serde_json::json!({
            "entries": { "used": { "storePath": used.to_string_lossy() } }
        });
        touch(
            &proj.path().join(".ask/resolved.json"),
            &resolved.to_string(),
        );

        let opts = CacheGcOptions {
            dry_run: false,
            scan_roots: Some(vec![proj.path().to_path_buf()]),
            older_than: None,
            silent: true,
        };
        let result = cache_gc(ah, &opts);
        assert_eq!(result.removed.len(), 1);
        assert!(result.removed[0].key.contains("unused"));
        assert!(!unused.exists());
        assert!(used.exists());
    }

    #[test]
    fn gc_dry_run_does_not_delete() {
        let home = tempfile::tempdir().unwrap();
        let ah = home.path();
        let unused = ah.join("web/abcd");
        touch(&unused.join("f.md"), "x");
        let proj = tempfile::tempdir().unwrap();
        let opts = CacheGcOptions {
            dry_run: true,
            scan_roots: Some(vec![proj.path().to_path_buf()]),
            older_than: None,
            silent: true,
        };
        let result = cache_gc(ah, &opts);
        assert_eq!(result.removed.len(), 1);
        assert!(unused.exists()); // not actually deleted
    }

    #[test]
    fn gc_age_gate_keeps_fresh_entries() {
        let home = tempfile::tempdir().unwrap();
        let ah = home.path();
        let fresh = ah.join("web/fresh");
        touch(&fresh.join("f.md"), "x");
        let proj = tempfile::tempdir().unwrap();
        // older_than very large → cutoff far in the past → fresh entry kept.
        let opts = CacheGcOptions {
            dry_run: false,
            scan_roots: Some(vec![proj.path().to_path_buf()]),
            older_than: Some(365 * 86_400_000),
            silent: true,
        };
        let result = cache_gc(ah, &opts);
        assert!(result.removed.is_empty());
        assert!(fresh.exists());
    }

    #[test]
    fn ls_json_model_omits_legacy_when_false() {
        let home = tempfile::tempdir().unwrap();
        let ah = home.path();
        touch(&ah.join("web/abcd/f.md"), "hello");
        let model = build_cache_ls_model(ah, None);
        let json = serde_json::to_string(&model).unwrap();
        assert!(json.contains(r#""kind":"web""#));
        assert!(json.contains(r#""sizeBytes""#));
        assert!(!json.contains("legacy"));
    }
}
