//! Source adapters — fetch docs from github / npm / llms-txt (web is deferred)
//! and materialize them into the global store. Rust port of
//! `packages/cli/src/sources/`.
//!
//! Shared here: the [`DocFile`]/[`FetchResult`] value types and the doc-file
//! collection helpers reused by the npm and github adapters.

pub mod github;
pub mod llms_txt;
pub mod npm;

use std::path::{Path, PathBuf};

use crate::store::EntryFile;

/// A documentation file: a store-relative path (forward-slash separated) and its
/// text content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocFile {
    pub path: String,
    pub content: String,
}

impl DocFile {
    fn to_entry(&self) -> EntryFile {
        EntryFile {
            path: self.path.clone(),
            content: self.content.clone(),
        }
    }
}

/// Convert docs to store entry files.
pub fn to_entry_files(files: &[DocFile]) -> Vec<EntryFile> {
    files.iter().map(DocFile::to_entry).collect()
}

/// Source-specific metadata propagated to the resolved cache / lockfile.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FetchMeta {
    /// GitHub commit sha (40 hex chars).
    pub commit: Option<String>,
    /// GitHub ref used (tag or branch name).
    pub ref_: Option<String>,
    /// npm Subresource Integrity hash from `dist.integrity`.
    pub integrity: Option<String>,
    /// npm tarball URL (omitted for local `node_modules` reads).
    pub tarball: Option<String>,
    /// Absolute path to the local `node_modules/<pkg>` dir when read locally.
    pub install_path: Option<PathBuf>,
    /// web / llms-txt source URL(s).
    pub urls: Option<Vec<String>>,
}

/// The result of a source fetch (port of `FetchResult`).
#[derive(Debug, Clone)]
pub struct FetchResult {
    pub files: Vec<DocFile>,
    pub resolved_version: String,
    /// Absolute path to the finalized store entry.
    pub store_path: Option<PathBuf>,
    /// Relative docs subpath inside `store_path` (github `docsPath`; empty
    /// elsewhere).
    pub store_subpath: Option<String>,
    /// True when served from an existing verified store entry without a fetch.
    pub from_store_cache: bool,
    pub meta: FetchMeta,
}

/// Doc-file extensions collected from a docs directory.
const DOC_EXTS: &[&str] = &["md", "mdx", "txt", "rst"];

/// npm tarball docs-path auto-detect candidates (includes `dist/docs`).
pub const NPM_DOC_CANDIDATES: &[&str] = &[
    "docs",
    "doc",
    "dist/docs",
    "documentation",
    "guide",
    "guides",
];
/// github checkout docs-path auto-detect candidates.
pub const GITHUB_DOC_CANDIDATES: &[&str] = &["docs", "doc", "documentation", "guide", "guides"];

/// Whether `name` has a documentation extension (case-insensitive).
pub fn is_doc_file(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((_, ext)) => DOC_EXTS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// Recursively collect doc files under `current`, returning paths relative to
/// `base` (forward-slash separated), sorted for determinism.
pub fn collect_doc_files(base: &Path, current: &Path) -> std::io::Result<Vec<DocFile>> {
    let mut files = Vec::new();
    collect_into(base, current, &mut files)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn collect_into(base: &Path, current: &Path, out: &mut Vec<DocFile>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect_into(base, &path, out)?;
        } else if is_doc_file(&entry.file_name().to_string_lossy()) {
            let rel = path.strip_prefix(base).unwrap_or(&path);
            let rel_str = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            let content = std::fs::read_to_string(&path)?;
            out.push(DocFile {
                path: rel_str,
                content,
            });
        }
    }
    Ok(())
}

/// First candidate that exists as a directory under `dir`, or `None`.
pub fn detect_docs_path(dir: &Path, candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find(|c| dir.join(c).is_dir())
        .map(|c| c.to_string())
}

/// Resolve the docs directory (`docs_path` or auto-detected) inside `extracted`,
/// guard against traversal via realpath containment, and collect its doc files
/// (or a single file). Port of `extractDocsFromDir` / npm's equivalent.
pub fn extract_docs_from_dir(
    extracted: &Path,
    repo: &str,
    ref_: &str,
    docs_path: Option<&str>,
    candidates: &[&str],
) -> anyhow::Result<Vec<DocFile>> {
    let target = match docs_path.map(str::to_string).or_else(|| detect_docs_path(extracted, candidates)) {
        Some(t) => t,
        None => anyhow::bail!(
            "No docs directory found in {repo}@{ref_}. Specify --path to point to the docs directory."
        ),
    };

    let docs_dir = extracted.join(&target);
    // Realpath containment: a symlink inside the checkout pointing outside must
    // not let us read arbitrary files.
    let resolved_base = std::fs::canonicalize(extracted)?;
    let resolved_docs = if docs_dir.exists() {
        std::fs::canonicalize(&docs_dir)?
    } else {
        docs_dir.clone()
    };
    if !resolved_docs.starts_with(&resolved_base) {
        anyhow::bail!("Unsafe docsPath '{target}': must be a relative path within the repository");
    }
    if !docs_dir.exists() {
        anyhow::bail!("Path \"{target}\" not found in {repo}@{ref_}");
    }

    if docs_dir.is_file() {
        let content = std::fs::read_to_string(&docs_dir)?;
        let name = docs_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        return Ok(vec![DocFile {
            path: name,
            content,
        }]);
    }
    Ok(collect_doc_files(&docs_dir, &docs_dir)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_doc_file_matches_known_extensions() {
        for ok in ["a.md", "b.MDX", "c.txt", "d.rst"] {
            assert!(is_doc_file(ok), "{ok}");
        }
        for no in ["a.png", "b.js", "noext", "c.mdxx"] {
            assert!(!is_doc_file(no), "{no}");
        }
    }

    #[test]
    fn collect_and_extract_from_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("docs/sub")).unwrap();
        std::fs::write(root.join("docs/a.md"), "A").unwrap();
        std::fs::write(root.join("docs/sub/b.mdx"), "B").unwrap();
        std::fs::write(root.join("docs/ignore.png"), "x").unwrap();

        let files =
            extract_docs_from_dir(root, "o/r", "v1", Some("docs"), GITHUB_DOC_CANDIDATES).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["a.md", "sub/b.mdx"]);
    }

    #[test]
    fn extract_auto_detects_docs_dir() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("doc")).unwrap();
        std::fs::write(dir.path().join("doc/x.md"), "X").unwrap();
        let files =
            extract_docs_from_dir(dir.path(), "o/r", "v1", None, GITHUB_DOC_CANDIDATES).unwrap();
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn extract_single_file_docs_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("README.md"), "hi").unwrap();
        let files = extract_docs_from_dir(
            dir.path(),
            "o/r",
            "v1",
            Some("README.md"),
            GITHUB_DOC_CANDIDATES,
        )
        .unwrap();
        assert_eq!(
            files,
            vec![DocFile {
                path: "README.md".into(),
                content: "hi".into()
            }]
        );
    }

    #[test]
    fn extract_missing_docs_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            extract_docs_from_dir(dir.path(), "o/r", "v1", None, GITHUB_DOC_CANDIDATES).is_err()
        );
        assert!(extract_docs_from_dir(
            dir.path(),
            "o/r",
            "v1",
            Some("nope"),
            GITHUB_DOC_CANDIDATES
        )
        .is_err());
    }
}
