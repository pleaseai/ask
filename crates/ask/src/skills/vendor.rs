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
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            // Symlinks are dereferenced by std::fs::copy, matching Node's default.
            std::fs::copy(&from, &to)?;
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
}
