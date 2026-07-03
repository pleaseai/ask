//! Project-local docs materialization + the `ask list` view. Rust port of
//! `packages/cli/src/storage.ts`.
//!
//! `save_docs` writes (or links/refs) the fetched docs under
//! `.ask/docs/<name>@<version>/`; `list_docs` joins `ask.json` (intent) with
//! `.ask/resolved.json` (last materialization) for `ask list`.

use std::path::{Path, PathBuf};

pub use crate::ask_json::StoreMode;
use crate::io::{get_ask_dir, read_ask_json, read_resolved_json};
use crate::resolved::{EntryFormat, Materialization};
use crate::sources::DocFile;
use crate::spec::library_name_from_spec;

/// Options for [`save_docs`].
#[derive(Debug, Clone, Default)]
pub struct SaveDocsOptions {
    pub store_mode: StoreMode,
    pub store_path: Option<PathBuf>,
    /// Relative docs subpath inside `store_path` (github `docsPath`). Link/ref
    /// modes join this so the symlink/ref target is the docs dir, not the repo
    /// root.
    pub store_subpath: Option<String>,
}

pub fn get_docs_dir(project_dir: &Path) -> PathBuf {
    get_ask_dir(project_dir).join("docs")
}

pub fn get_library_docs_dir(project_dir: &Path, name: &str, version: &str) -> PathBuf {
    get_docs_dir(project_dir).join(format!("{name}@{version}"))
}

fn effective_store_path(store_path: &Path, store_subpath: Option<&str>) -> PathBuf {
    match store_subpath.filter(|s| !s.is_empty()) {
        Some(sub) => store_path.join(sub),
        None => store_path.to_path_buf(),
    }
}

/// Materialize docs into the project. Returns the path AGENTS.md should point at.
pub fn save_docs(
    project_dir: &Path,
    name: &str,
    version: &str,
    files: &[DocFile],
    options: &SaveDocsOptions,
) -> anyhow::Result<PathBuf> {
    let docs_dir = get_library_docs_dir(project_dir, name, version);

    // ref mode: no project-local materialization.
    if options.store_mode == StoreMode::Ref {
        return Ok(match &options.store_path {
            Some(sp) => effective_store_path(sp, options.store_subpath.as_deref()),
            None => docs_dir,
        });
    }

    // link mode: symlink project-local → store (docs subdir).
    if options.store_mode == StoreMode::Link {
        if let Some(sp) = &options.store_path {
            let link_target = effective_store_path(sp, options.store_subpath.as_deref());
            if docs_dir.exists() {
                std::fs::remove_dir_all(&docs_dir)?;
            }
            if let Some(parent) = docs_dir.parent() {
                std::fs::create_dir_all(parent)?;
            }
            match symlink_dir(&link_target, &docs_dir) {
                Ok(()) => return Ok(docs_dir),
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    // Clean up partial state, then fall through to copy.
                    let _ = std::fs::remove_dir_all(&docs_dir);
                    eprintln!(
                        "  Symlink creation failed ({}), falling back to copy mode",
                        e.kind()
                    );
                }
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&docs_dir);
                    anyhow::bail!("Failed to create symlink at {}: {e}", docs_dir.display());
                }
            }
        }
    }

    // copy mode (default).
    if docs_dir.exists() {
        std::fs::remove_dir_all(&docs_dir)?;
    }
    std::fs::create_dir_all(&docs_dir)?;
    for file in files {
        let file_path = docs_dir.join(&file.path);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&file_path, &file.content)?;
    }
    let index = files
        .iter()
        .map(|f| format!("- [{}](./{})", f.path, f.path))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(
        docs_dir.join("INDEX.md"),
        format!("# {name}@{version} Documentation\n\n{index}\n"),
    )?;

    Ok(docs_dir)
}

#[cfg(unix)]
fn symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

/// Remove project-local docs for `name` (all versions when `version` is `None`).
pub fn remove_docs(project_dir: &Path, name: &str, version: Option<&str>) -> anyhow::Result<()> {
    if let Some(version) = version {
        let docs_dir = get_library_docs_dir(project_dir, name, version);
        if docs_dir.exists() {
            std::fs::remove_dir_all(&docs_dir)?;
        }
        return Ok(());
    }
    let base = get_docs_dir(project_dir);
    if !base.exists() {
        return Ok(());
    }
    let prefix = format!("{name}@");
    for entry in std::fs::read_dir(&base)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            std::fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

/// Source classification for a list entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListSource {
    PmDriven,
    Github,
    Unresolved,
}

/// One `ask list` row, joined from `ask.json` + `.ask/resolved.json`. Entries
/// declared but never installed surface as `version: "unresolved"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListDocsEntry {
    pub name: String,
    pub version: String,
    pub format: EntryFormat,
    pub source: ListSource,
    pub spec: String,
    pub location: String,
    pub file_count: u64,
}

pub fn list_docs(project_dir: &Path) -> Vec<ListDocsEntry> {
    let Ok(Some(ask_json)) = read_ask_json(project_dir) else {
        return Vec::new();
    };
    let resolved = read_resolved_json(project_dir);

    let mut out = Vec::new();
    for entry in &ask_json.libraries {
        let spec = entry.spec().to_string();
        let name = library_name_from_spec(&spec);
        let source_kind = if spec.starts_with("github:") {
            ListSource::Github
        } else {
            ListSource::PmDriven
        };

        let Some(cached) = resolved.entries.get(&name) else {
            out.push(ListDocsEntry {
                name,
                version: "unresolved".into(),
                format: EntryFormat::Docs,
                source: ListSource::Unresolved,
                spec,
                location: "(not installed — run `ask install`)".into(),
                file_count: 0,
            });
            continue;
        };

        // intent-skills format: docs live in node_modules; the skill listing is
        // sourced from the AGENTS.md intent block (agents-intent, deferred).
        if cached.format == Some(EntryFormat::IntentSkills) {
            out.push(ListDocsEntry {
                name,
                version: cached.resolved_version.clone(),
                format: EntryFormat::IntentSkills,
                source: source_kind,
                spec: spec.clone(),
                location: format!("node_modules/{}", pkg_from_spec(&spec)),
                file_count: 0,
            });
            continue;
        }

        if cached.materialization == Some(Materialization::InPlace) {
            if let Some(in_place) = &cached.in_place_path {
                out.push(ListDocsEntry {
                    name,
                    version: cached.resolved_version.clone(),
                    format: EntryFormat::Docs,
                    source: source_kind,
                    spec,
                    location: in_place.clone(),
                    file_count: cached.file_count,
                });
                continue;
            }
        }

        let docs_dir = get_library_docs_dir(project_dir, &name, &cached.resolved_version);
        let file_count = if docs_dir.exists() {
            count_files(&docs_dir)
        } else {
            cached.file_count
        };
        let location = pathdiff_relative(project_dir, &docs_dir)
            .unwrap_or_else(|| docs_dir.to_string_lossy().into_owned());
        out.push(ListDocsEntry {
            name,
            version: cached.resolved_version.clone(),
            format: EntryFormat::Docs,
            source: source_kind,
            spec,
            location,
            file_count,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn pkg_from_spec(spec: &str) -> &str {
    match spec.find(':') {
        Some(i) => &spec[i + 1..],
        None => spec,
    }
}

/// Path of `target` relative to `base` (forward-slash), or `None` when `target`
/// is not under `base`.
fn pathdiff_relative(base: &Path, target: &Path) -> Option<String> {
    let rel = target.strip_prefix(base).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    Some(
        rel.components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

fn count_files(dir: &Path) -> u64 {
    let mut count = 0;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        match entry.file_type() {
            Ok(t) if t.is_dir() => count += count_files(&entry.path()),
            Ok(_) => count += 1,
            Err(_) => {}
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    fn df(path: &str, content: &str) -> DocFile {
        DocFile {
            path: path.into(),
            content: content.into(),
        }
    }

    #[test]
    fn save_copy_writes_files_and_index() {
        let dir = tempfile::tempdir().unwrap();
        let out = save_docs(
            dir.path(),
            "acme",
            "1.0.0",
            &[df("a.md", "A"), df("sub/b.md", "B")],
            &SaveDocsOptions::default(),
        )
        .unwrap();
        assert!(out.ends_with(".ask/docs/acme@1.0.0"));
        assert_eq!(std::fs::read_to_string(out.join("a.md")).unwrap(), "A");
        assert_eq!(std::fs::read_to_string(out.join("sub/b.md")).unwrap(), "B");
        let index = std::fs::read_to_string(out.join("INDEX.md")).unwrap();
        assert!(index.contains("# acme@1.0.0 Documentation"));
        assert!(index.contains("- [a.md](./a.md)"));
    }

    #[test]
    fn save_copy_replaces_existing() {
        let dir = tempfile::tempdir().unwrap();
        save_docs(
            dir.path(),
            "acme",
            "1.0.0",
            &[df("old.md", "x")],
            &SaveDocsOptions::default(),
        )
        .unwrap();
        let out = save_docs(
            dir.path(),
            "acme",
            "1.0.0",
            &[df("new.md", "y")],
            &SaveDocsOptions::default(),
        )
        .unwrap();
        assert!(!out.join("old.md").exists());
        assert!(out.join("new.md").exists());
    }

    #[test]
    fn ref_mode_returns_effective_store_path() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("store/github.com/o/r/v1");
        let out = save_docs(
            dir.path(),
            "acme",
            "1.0.0",
            &[],
            &SaveDocsOptions {
                store_mode: StoreMode::Ref,
                store_path: Some(store.clone()),
                store_subpath: Some("docs".into()),
            },
        )
        .unwrap();
        assert_eq!(out, store.join("docs"));
        // Nothing was materialized locally.
        assert!(!get_library_docs_dir(dir.path(), "acme", "1.0.0").exists());
    }

    #[cfg(unix)]
    #[test]
    fn link_mode_creates_symlink_to_subpath() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("store");
        std::fs::create_dir_all(store.join("docs")).unwrap();
        std::fs::write(store.join("docs/guide.md"), "G").unwrap();
        let out = save_docs(
            dir.path(),
            "acme",
            "1.0.0",
            &[],
            &SaveDocsOptions {
                store_mode: StoreMode::Link,
                store_path: Some(store.clone()),
                store_subpath: Some("docs".into()),
            },
        )
        .unwrap();
        assert!(out.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(out.join("guide.md")).unwrap(), "G");
    }

    #[test]
    fn remove_docs_by_version_and_all() {
        let dir = tempfile::tempdir().unwrap();
        save_docs(
            dir.path(),
            "acme",
            "1.0.0",
            &[df("a.md", "A")],
            &SaveDocsOptions::default(),
        )
        .unwrap();
        save_docs(
            dir.path(),
            "acme",
            "2.0.0",
            &[df("a.md", "A")],
            &SaveDocsOptions::default(),
        )
        .unwrap();
        remove_docs(dir.path(), "acme", Some("1.0.0")).unwrap();
        assert!(!get_library_docs_dir(dir.path(), "acme", "1.0.0").exists());
        assert!(get_library_docs_dir(dir.path(), "acme", "2.0.0").exists());
        remove_docs(dir.path(), "acme", None).unwrap();
        assert!(!get_library_docs_dir(dir.path(), "acme", "2.0.0").exists());
    }

    #[test]
    fn list_docs_empty_without_ask_json() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_docs(dir.path()).is_empty());
    }

    #[test]
    fn list_docs_marks_unresolved_and_resolved() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(get_ask_dir(dir.path())).unwrap();
        std::fs::write(
            crate::io::get_ask_json_path(dir.path()),
            r#"{"libraries":["npm:acme","github:o/other"]}"#,
        )
        .unwrap();
        // Only acme is resolved.
        std::fs::write(
            crate::io::get_resolved_json_path(dir.path()),
            r#"{"schemaVersion":1,"generatedAt":"2026-01-01T00:00:00Z","entries":{
              "acme":{"spec":"npm:acme","resolvedVersion":"1.2.3",
                "contentHash":"sha256-0000000000000000000000000000000000000000000000000000000000000000",
                "fetchedAt":"2026-01-01T00:00:00Z","fileCount":3}}}"#,
        )
        .unwrap();

        let entries = list_docs(dir.path());
        assert_eq!(entries.len(), 2);
        // Sorted by name: "acme" before "other".
        assert_eq!(entries[0].name, "acme");
        assert_eq!(entries[0].version, "1.2.3");
        assert_eq!(entries[0].source, ListSource::PmDriven);
        assert_eq!(entries[1].name, "other");
        assert_eq!(entries[1].version, "unresolved");
        assert_eq!(entries[1].source, ListSource::Unresolved);
    }
}
