//! Vendor producer-side skill directories into `.ask/skills/<specKey>/`. Rust
//! port of `skills/vendor.ts`.
//!
//! Refresh-safe: contents are staged under a sibling `.<specKey>.tmp` dir and
//! renamed into place, so a re-install replaces the entry atomically and a
//! mid-copy crash cannot leave a half-populated vendor directory.

use std::path::{Path, PathBuf};

pub const VENDOR_ROOT: &str = ".ask/skills";

/// Result of [`vendor_skills`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorResult {
    /// Absolute path to `.ask/skills/<specKey>/`.
    pub vendor_dir: PathBuf,
    /// Skill basenames that were copied in.
    pub skill_names: Vec<String>,
}

/// Recursively copy `src` into `dst`, creating `dst` and parents on demand.
/// Follows the Node `fs.cpSync(recursive)` default (regular file contents; no
/// verbatim-symlink preservation — producer skills are plain trees).
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    // Containment root: a dereferenced directory symlink must not escape the copy
    // source. Seed `visited` with the root so a self-loop (`ln -s . loop`) is a
    // cycle hit, not a fresh descent.
    let root = std::fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
    let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    visited.insert(root.clone());
    copy_dir_inner(&root, src, dst, &mut visited)
}

fn copy_dir_inner(
    root: &Path,
    src: &Path,
    dst: &Path,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        // Stat the TARGET (follow symlinks), not the link itself: entry.file_type()
        // reports the link's own type, so a symlink pointing at a directory would
        // take the copy branch and std::fs::copy would fail (it cannot read a
        // directory as file bytes). Node's fs.cpSync(recursive) dereferences here,
        // so a symlinked subdir must recurse. Fall back to the entry type when the
        // target is unreadable (e.g. a dangling symlink) so std::fs::copy surfaces
        // the original error as before.
        let is_dir = std::fs::metadata(&from)
            .map(|m| m.is_dir())
            .unwrap_or_else(|_| entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false));
        if is_dir {
            // Because directory symlinks are now followed, guard against symlink
            // cycles (`ln -s . loop` → infinite recursion → stack overflow) and
            // outbound escapes (a symlink to `/` would copy arbitrary external
            // data into the vendor dir). Resolve the real path: skip it when it
            // leaves the copy root, is already on the current descent (cycle), or
            // cannot be resolved. `visited` is stack-scoped (removed after the
            // subtree) so legitimate DAG repeats via distinct paths still copy.
            match std::fs::canonicalize(&from) {
                Ok(real) if real.starts_with(root) && visited.insert(real.clone()) => {
                    copy_dir_inner(root, &from, &to, visited)?;
                    visited.remove(&real);
                }
                _ => {}
            }
        } else {
            // std::fs::copy dereferences a file symlink, so a link pointing at an
            // outbound target (`→ /etc/passwd`) would copy external bytes into the
            // vendor dir — the same escape the directory branch guards. A regular
            // file is physically inside the tree, so only symlinks need the check.
            let is_symlink = entry.file_type().map(|ft| ft.is_symlink()).unwrap_or(false);
            if is_symlink {
                match std::fs::canonicalize(&from) {
                    Ok(real) if real.starts_with(root) => {
                        std::fs::copy(&from, &to)?;
                    }
                    _ => {} // escapes the root or unresolvable → skip
                }
            } else {
                std::fs::copy(&from, &to)?;
            }
        }
    }
    Ok(())
}

/// Copy each source skill directory into `.ask/skills/<specKey>/<basename>/`.
/// Non-directory / missing sources are skipped. On a basename collision the
/// later copy wins (caller dedups). Parity with `vendorSkills`.
pub fn vendor_skills(
    project_dir: &Path,
    spec_key: &str,
    sources: &[PathBuf],
) -> anyhow::Result<VendorResult> {
    let root = project_dir.join(VENDOR_ROOT);
    let vendor_dir = root.join(spec_key);
    std::fs::create_dir_all(&root)?;

    let staging = root.join(format!(".{spec_key}.tmp"));
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    std::fs::create_dir_all(&staging)?;

    let mut skill_names: Vec<String> = Vec::new();
    for source in sources {
        if !source.is_dir() {
            continue;
        }
        let Some(name) = source.file_name() else {
            continue;
        };
        let target = staging.join(name);
        copy_dir_recursive(source, &target)?;
        skill_names.push(name.to_string_lossy().into_owned());
    }

    if vendor_dir.exists() {
        std::fs::remove_dir_all(&vendor_dir)?;
    }
    std::fs::rename(&staging, &vendor_dir)?;

    Ok(VendorResult {
        vendor_dir,
        skill_names,
    })
}

/// Remove `.ask/skills/<specKey>/` if present. Parity with `removeVendorDir`.
pub fn remove_vendor_dir(project_dir: &Path, spec_key: &str) -> anyhow::Result<()> {
    let vendor_dir = project_dir.join(VENDOR_ROOT).join(spec_key);
    if vendor_dir.exists() {
        std::fs::remove_dir_all(&vendor_dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_skill(root: &Path, name: &str) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), format!("# {name}")).unwrap();
        dir
    }

    #[test]
    fn vendors_sources_and_reports_names() {
        let proj = tempfile::tempdir().unwrap();
        let srcroot = tempfile::tempdir().unwrap();
        let a = make_skill(srcroot.path(), "a");
        let b = make_skill(srcroot.path(), "b");
        let res = vendor_skills(proj.path(), "npm__x__1", &[a, b]).unwrap();
        assert_eq!(res.skill_names, vec!["a", "b"]);
        assert!(res.vendor_dir.ends_with(".ask/skills/npm__x__1"));
        assert!(res.vendor_dir.join("a/SKILL.md").exists());
        assert!(res.vendor_dir.join("b/SKILL.md").exists());
    }

    #[test]
    fn reinstall_replaces_stale_contents() {
        let proj = tempfile::tempdir().unwrap();
        let srcroot = tempfile::tempdir().unwrap();
        let a = make_skill(srcroot.path(), "a");
        vendor_skills(proj.path(), "k", std::slice::from_ref(&a)).unwrap();
        // Second install with a different source — old "a" must be gone.
        let c = make_skill(srcroot.path(), "c");
        let res = vendor_skills(proj.path(), "k", &[c]).unwrap();
        assert_eq!(res.skill_names, vec!["c"]);
        assert!(!res.vendor_dir.join("a").exists());
        assert!(res.vendor_dir.join("c/SKILL.md").exists());
    }

    #[test]
    fn skips_missing_and_non_dir_sources() {
        let proj = tempfile::tempdir().unwrap();
        let srcroot = tempfile::tempdir().unwrap();
        let a = make_skill(srcroot.path(), "a");
        let missing = srcroot.path().join("nope");
        let res = vendor_skills(proj.path(), "k", &[a, missing]).unwrap();
        assert_eq!(res.skill_names, vec!["a"]);
    }

    #[test]
    fn remove_vendor_dir_is_idempotent() {
        let proj = tempfile::tempdir().unwrap();
        let srcroot = tempfile::tempdir().unwrap();
        let a = make_skill(srcroot.path(), "a");
        vendor_skills(proj.path(), "k", &[a]).unwrap();
        remove_vendor_dir(proj.path(), "k").unwrap();
        assert!(!proj.path().join(".ask/skills/k").exists());
        // Second removal is a no-op.
        remove_vendor_dir(proj.path(), "k").unwrap();
    }

    // A symlink pointing at a directory must be dereferenced and copied as a
    // tree (Node fs.cpSync behaviour), not hit std::fs::copy (which errors on a
    // directory). entry.file_type() reports the link's type, so the fix stats
    // the target.
    #[cfg(unix)]
    #[test]
    fn copies_through_a_directory_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let real = src.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("a.md"), "A").unwrap();
        std::os::unix::fs::symlink("real", src.join("link")).unwrap();
        let dst = dir.path().join("dst");
        copy_dir_recursive(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("real/a.md")).unwrap(), "A");
        // The symlinked directory's contents are copied through.
        assert_eq!(std::fs::read_to_string(dst.join("link/a.md")).unwrap(), "A");
    }

    // Following directory symlinks must not hang on a cycle or copy external data
    // through an outbound symlink.
    #[cfg(unix)]
    #[test]
    fn symlink_cycle_and_escape_are_guarded() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.md"), "A").unwrap();
        // Self-loop — would infinite-recurse without the cycle guard.
        std::os::unix::fs::symlink(".", src.join("loop")).unwrap();
        // Outbound escape to a sibling outside the copy root (directory symlink).
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "SECRET").unwrap();
        std::os::unix::fs::symlink(&outside, src.join("escape")).unwrap();
        // Outbound FILE symlink — std::fs::copy would dereference it.
        std::fs::write(outside.join("secret.txt"), "FILESECRET").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), src.join("leak.md")).unwrap();

        let dst = dir.path().join("dst");
        // Must terminate (no stack overflow)…
        copy_dir_recursive(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("a.md")).unwrap(), "A");
        // …and neither the escaping directory nor file symlink's target is pulled in.
        assert!(!dst.join("escape/secret.md").exists());
        assert!(!dst.join("leak.md").exists());
    }
}
