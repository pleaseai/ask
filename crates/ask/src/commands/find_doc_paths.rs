//! Documentation-directory discovery for `ask docs`. Rust port of
//! `commands/find-doc-paths.ts`.
//!
//! Walks a source tree and returns every subdirectory whose basename contains
//! "doc" (case-insensitive), up to depth 4, falling back to `[root]` when none
//! exist (README-only packages). The traversal order mirrors the TS walker
//! exactly (pre-order DFS in filesystem order, `dist/docs` probed first) so the
//! emitted path list is identical to the TypeScript build.

use std::path::{Path, PathBuf};

/// Directories that never hold useful docs — skipped wholesale.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "coverage",
];

/// Maximum walk depth. Root counts as depth 0.
const MAX_DEPTH: usize = 4;

/// Case-insensitive `/doc/i` test on a directory basename.
fn is_doc_dir(name: &str) -> bool {
    name.to_ascii_lowercase().contains("doc")
}

/// Walk `root` and return every subdirectory whose basename matches `/doc/i`,
/// up to depth 4. When none exist, returns `[root]` so small projects whose docs
/// live as a top-level `README.md` still produce a usable path. Returns an empty
/// vec when `root` does not exist (no error).
pub fn find_doc_like_paths(root: &Path) -> Vec<PathBuf> {
    if !root.exists() {
        return Vec::new();
    }
    let mut subdirs: Vec<PathBuf> = Vec::new();

    // `dist/docs` is a common publish-time convention (e.g. mastra ships docs
    // there). The walker skips `dist/` wholesale, so probe this path explicitly.
    let dist_docs = root.join("dist").join("docs");
    if dist_docs.is_dir() {
        subdirs.push(dist_docs);
    }

    walk(root, 0, &mut subdirs);

    if subdirs.is_empty() {
        vec![root.to_path_buf()]
    } else {
        subdirs
    }
}

fn walk(current_dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(current_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if SKIP_DIRS.contains(&name.as_ref()) || name.starts_with('.') {
            continue;
        }
        let full = current_dir.join(name.as_ref());
        if is_doc_dir(&name) {
            out.push(full.clone());
        }
        walk(&full, depth + 1, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_root_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(find_doc_like_paths(&dir.path().join("nope")).is_empty());
    }

    #[test]
    fn readme_only_falls_back_to_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("README.md"), "x").unwrap();
        let paths = find_doc_like_paths(dir.path());
        assert_eq!(paths, vec![dir.path().to_path_buf()]);
    }

    #[test]
    fn finds_doc_subdirs_and_dist_docs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        std::fs::create_dir_all(dir.path().join("dist/docs")).unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        let paths = find_doc_like_paths(dir.path());
        // dist/docs probed first, then the docs subdir from the walk.
        assert!(paths.iter().any(|p| p.ends_with("dist/docs")));
        assert!(paths
            .iter()
            .any(|p| p.ends_with("docs") && !p.ends_with("dist/docs")));
        assert!(!paths.iter().any(|p| p.ends_with("src")));
        // dist/docs comes before the walked docs dir.
        assert!(paths[0].ends_with("dist/docs"));
    }

    #[test]
    fn skips_node_modules_and_dotdirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/foo/docs")).unwrap();
        std::fs::create_dir_all(dir.path().join(".hidden/docs")).unwrap();
        std::fs::write(dir.path().join("README.md"), "x").unwrap();
        let paths = find_doc_like_paths(dir.path());
        // Nothing doc-like reachable → fall back to root.
        assert_eq!(paths, vec![dir.path().to_path_buf()]);
    }

    #[test]
    fn case_insensitive_doc_match() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Documentation")).unwrap();
        let paths = find_doc_like_paths(dir.path());
        assert!(paths.iter().any(|p| p.ends_with("Documentation")));
    }

    #[test]
    fn respects_max_depth() {
        let dir = tempfile::tempdir().unwrap();
        // depth 5 doc dir is beyond MAX_DEPTH (root=0 .. a/b/c/d=4, doc at depth 5).
        std::fs::create_dir_all(dir.path().join("a/b/c/d/docs")).unwrap();
        std::fs::write(dir.path().join("README.md"), "x").unwrap();
        let paths = find_doc_like_paths(dir.path());
        assert_eq!(paths, vec![dir.path().to_path_buf()]);
    }
}
