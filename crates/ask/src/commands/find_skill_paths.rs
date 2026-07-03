//! Producer-side skill-directory discovery for `ask skills`. Rust port of
//! `commands/find-skill-paths.ts`.
//!
//! Mirrors [`find_doc_like_paths`](super::find_doc_paths::find_doc_like_paths)
//! with a `/skill/i` test instead of `/doc/i`, and two differences: the root is
//! ALWAYS included (index 0), and there is no `dist/docs` special case.

use std::path::{Path, PathBuf};

/// Skip set — mirrors `find_doc_like_paths`.
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

/// Case-insensitive `/skill/i` test on a directory basename.
fn is_skill_dir(name: &str) -> bool {
    name.to_ascii_lowercase().contains("skill")
}

/// Walk `root` and return the root plus every nested directory whose basename
/// matches `/skill/i`, up to depth 4. Returns an empty vec when `root` does not
/// exist (no error).
pub fn find_skill_like_paths(root: &Path) -> Vec<PathBuf> {
    if !root.exists() {
        return Vec::new();
    }
    let mut results: Vec<PathBuf> = vec![root.to_path_buf()];
    walk(root, 0, &mut results);
    results
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
        if is_skill_dir(&name) {
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
        assert!(find_skill_like_paths(&dir.path().join("nope")).is_empty());
    }

    #[test]
    fn root_always_first_then_skill_subdirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("skills/my-skill")).unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        let paths = find_skill_like_paths(dir.path());
        assert_eq!(paths[0], dir.path().to_path_buf());
        assert!(paths.iter().any(|p| p.ends_with("skills")));
        assert!(!paths.iter().any(|p| p.ends_with("src")));
    }

    #[test]
    fn skips_node_modules_and_dotdirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/skills")).unwrap();
        std::fs::create_dir_all(dir.path().join(".hidden-skill")).unwrap();
        let paths = find_skill_like_paths(dir.path());
        assert_eq!(paths, vec![dir.path().to_path_buf()]);
    }
}
