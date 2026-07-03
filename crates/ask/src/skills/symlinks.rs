//! Create and remove the relative symlinks that point an agent's
//! `skills/<name>` at a vendored skill directory. Rust port of
//! `skills/symlinks.ts`.

use std::path::{Component, Path, PathBuf};

/// Options for [`link_skill`].
pub struct LinkSkillOptions<'a> {
    pub link_path: &'a Path,
    pub target_path: &'a Path,
    pub force: bool,
}

/// Raised when a link path is occupied by a conflicting entry and `force` is
/// unset. Parity with `SymlinkConflictError`.
#[derive(Debug, thiserror::Error)]
#[error("{link_path}: {reason}. Re-run with --force to overwrite.")]
pub struct SymlinkConflictError {
    pub link_path: String,
    pub reason: String,
}

/// Lexical `path.relative(from, to)` over already-absolute, clean paths: shared
/// prefix, then `..` per remaining `from` segment plus the `to` tail. No
/// symlink resolution — matches Node's behaviour on normalized absolute inputs.
pub fn relative_path(from: &Path, to: &Path) -> PathBuf {
    let from_comps: Vec<Component> = from.components().collect();
    let to_comps: Vec<Component> = to.components().collect();
    let mut i = 0;
    while i < from_comps.len() && i < to_comps.len() && from_comps[i] == to_comps[i] {
        i += 1;
    }
    let mut result = PathBuf::new();
    for _ in i..from_comps.len() {
        result.push("..");
    }
    for c in &to_comps[i..] {
        result.push(c.as_os_str());
    }
    result
}

fn create_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link)
    }
}

/// Remove a symlink previously created by [`create_symlink`]. On Windows the
/// links are directory symlinks (`symlink_dir`), and a directory symlink must
/// be removed with `remove_dir` — `remove_file` only removes file symlinks and
/// would fail, leaving the link behind. On unix `remove_file` removes any
/// symlink. Keeping removal symmetric with creation makes relink/unlink work
/// cross-platform.
fn remove_symlink(link: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        std::fs::remove_dir(link)
    }
    #[cfg(not(windows))]
    {
        std::fs::remove_file(link)
    }
}

/// Create a relative symlink at `link_path` → `target_path`, creating the
/// parent dir on demand. A pre-existing identical symlink is a no-op; a
/// differing symlink or a real file/dir errors unless `force`. Parity with
/// `linkSkill`.
pub fn link_skill(opts: &LinkSkillOptions) -> anyhow::Result<()> {
    if let Some(parent) = opts.link_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let rel_target = relative_path(
        opts.link_path.parent().unwrap_or_else(|| Path::new("")),
        opts.target_path,
    );

    if let Ok(meta) = std::fs::symlink_metadata(opts.link_path) {
        if meta.file_type().is_symlink() {
            let current = std::fs::read_link(opts.link_path)?;
            if current == rel_target {
                return Ok(()); // identical — no-op
            }
            if !opts.force {
                return Err(SymlinkConflictError {
                    link_path: opts.link_path.to_string_lossy().into_owned(),
                    reason: format!(
                        "symlink points to '{}', expected '{}'",
                        current.to_string_lossy(),
                        rel_target.to_string_lossy()
                    ),
                }
                .into());
            }
            remove_symlink(opts.link_path)?;
        } else {
            if !opts.force {
                return Err(SymlinkConflictError {
                    link_path: opts.link_path.to_string_lossy().into_owned(),
                    reason: "a non-symlink entry already exists".to_string(),
                }
                .into());
            }
            if meta.file_type().is_dir() {
                std::fs::remove_dir_all(opts.link_path)?;
            } else {
                std::fs::remove_file(opts.link_path)?;
            }
        }
    }

    create_symlink(&rel_target, opts.link_path)?;
    Ok(())
}

/// Remove `link_path` iff it is a symlink whose target matches `expected_target`
/// (relative-encoded). Protects user-authored skills of the same name. Returns
/// true when a link was removed. Parity with `unlinkIfOwned`.
pub fn unlink_if_owned(link_path: &Path, expected_target: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(link_path) else {
        return false;
    };
    if !meta.file_type().is_symlink() {
        return false;
    }
    let rel_expected = relative_path(
        link_path.parent().unwrap_or_else(|| Path::new("")),
        expected_target,
    );
    let Ok(current) = std::fs::read_link(link_path) else {
        return false;
    };
    if current != rel_expected {
        return false;
    }
    remove_symlink(link_path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_path_cross_tree() {
        let from = Path::new("/p/.claude/skills");
        let to = Path::new("/p/.ask/skills/key/my-skill");
        assert_eq!(
            relative_path(from, to),
            PathBuf::from("../../.ask/skills/key/my-skill")
        );
    }

    #[test]
    fn link_creates_relative_symlink_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".ask/skills/key/s");
        std::fs::create_dir_all(&target).unwrap();
        let link = dir.path().join(".claude/skills/s");
        let opts = LinkSkillOptions {
            link_path: &link,
            target_path: &target,
            force: false,
        };
        link_skill(&opts).unwrap();
        let read = std::fs::read_link(&link).unwrap();
        assert_eq!(read, relative_path(link.parent().unwrap(), &target));
        // Second call with identical target is a no-op (no error).
        link_skill(&opts).unwrap();
    }

    #[test]
    fn link_conflict_without_force_errors() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join(".claude/skills/s");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::fs::write(&link, "real file").unwrap();
        let target = dir.path().join(".ask/skills/key/s");
        std::fs::create_dir_all(&target).unwrap();
        let opts = LinkSkillOptions {
            link_path: &link,
            target_path: &target,
            force: false,
        };
        assert!(link_skill(&opts).is_err());
        // With force it succeeds.
        let forced = LinkSkillOptions {
            link_path: &link,
            target_path: &target,
            force: true,
        };
        link_skill(&forced).unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn unlink_only_owned_links() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".ask/skills/key/s");
        std::fs::create_dir_all(&target).unwrap();
        let link = dir.path().join(".claude/skills/s");
        link_skill(&LinkSkillOptions {
            link_path: &link,
            target_path: &target,
            force: false,
        })
        .unwrap();
        // Wrong expected target → not removed.
        assert!(!unlink_if_owned(
            &link,
            &dir.path().join(".ask/skills/other/s")
        ));
        assert!(std::fs::symlink_metadata(&link).is_ok());
        // Correct target → removed.
        assert!(unlink_if_owned(&link, &target));
        assert!(std::fs::symlink_metadata(&link).is_err());
    }
}
