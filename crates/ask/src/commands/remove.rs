//! `ask remove <name>` — remove a library from ask.json and delete its skill.
//! Rust port of the inline `removeCmd` in `index.ts`.
//!
//! Matching mirrors the TS `findIndex`: exact spec, then library slug, then npm
//! package name. After removal it rewrites ask.json, deletes the skill, re-runs
//! the lazy install to regenerate AGENTS.md, and re-syncs the ignore markers.

use std::path::Path;

use anyhow::Result;

use crate::ask_json::LibraryEntry;
use crate::ignore_files::{manage_ignore_files, IgnoreMode};
use crate::install::{run_install, RunInstallOptions};
use crate::io::{read_ask_json, write_ask_json};
use crate::skill::remove_skill;
use crate::spec::{library_name_from_spec, parse_spec, split_explicit_version, ParsedSpec};

/// Outcome of [`run_remove`]. The CLI maps each to a consola-equivalent line;
/// all three exit 0 (matching the TS `warn`/`success` behaviour).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoveOutcome {
    /// No ask.json present — nothing to remove.
    NoAskJson,
    /// No entry matched `target`.
    NoMatch(String),
    /// Removed the entry with this spec.
    Removed(String),
}

/// Remove the entry matching `target` from ask.json (if any) and tear down its
/// generated artifacts.
pub fn run_remove(project_dir: &Path, target: &str) -> Result<RemoveOutcome> {
    let Some(mut ask_json) = read_ask_json(project_dir)? else {
        return Ok(RemoveOutcome::NoAskJson);
    };

    let idx = ask_json
        .libraries
        .iter()
        .position(|entry| entry_matches(entry, target));
    let Some(idx) = idx else {
        return Ok(RemoveOutcome::NoMatch(target.to_string()));
    };

    let removed = ask_json.libraries[idx].spec().to_string();
    let (spec_body, _) = split_explicit_version(&removed);
    let lib_name = library_name_from_spec(spec_body);
    ask_json.libraries.remove(idx);
    write_ask_json(project_dir, &ask_json)?;

    remove_skill(project_dir, &lib_name)?;

    // Re-run install to regenerate AGENTS.md with the remaining libraries.
    run_install(project_dir, &RunInstallOptions::default())?;

    let mode = if ask_json.libraries.is_empty() {
        IgnoreMode::Remove
    } else {
        IgnoreMode::Install
    };
    manage_ignore_files(project_dir, mode)?;

    Ok(RemoveOutcome::Removed(removed))
}

/// Match rules, identical to the TS `removeCmd` findIndex: exact spec, then the
/// library slug of the spec body, then the npm package name.
fn entry_matches(entry: &LibraryEntry, target: &str) -> bool {
    let spec = entry.spec();
    if spec == target {
        return true;
    }
    let (body, _) = split_explicit_version(spec);
    if library_name_from_spec(body) == target {
        return true;
    }
    matches!(parse_spec(body), ParsedSpec::Npm { pkg, .. } if pkg == target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::get_ask_json_path;

    fn write_ask(dir: &Path, json: &str) {
        std::fs::write(get_ask_json_path(dir), json).unwrap();
    }

    #[test]
    fn no_ask_json_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            run_remove(dir.path(), "react").unwrap(),
            RemoveOutcome::NoAskJson
        );
    }

    #[test]
    fn no_match_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        write_ask(dir.path(), r#"{"libraries":["npm:react"]}"#);
        assert_eq!(
            run_remove(dir.path(), "vue").unwrap(),
            RemoveOutcome::NoMatch("vue".into())
        );
    }

    #[test]
    fn removes_by_npm_package_name() {
        let dir = tempfile::tempdir().unwrap();
        write_ask(dir.path(), r#"{"libraries":["npm:react","npm:vue"]}"#);
        let out = run_remove(dir.path(), "react").unwrap();
        assert_eq!(out, RemoveOutcome::Removed("npm:react".into()));
        // ask.json now holds only vue.
        let aj = read_ask_json(dir.path()).unwrap().unwrap();
        assert_eq!(aj.libraries.len(), 1);
        assert_eq!(aj.libraries[0].spec(), "npm:vue");
    }

    #[test]
    fn removes_by_exact_spec_and_deletes_skill() {
        let dir = tempfile::tempdir().unwrap();
        write_ask(
            dir.path(),
            r#"{"libraries":["github:vercel/next.js@v15.0.3"]}"#,
        );
        // Materialize the skill first so we can assert its teardown.
        run_install(dir.path(), &RunInstallOptions::default()).unwrap();
        let skill = crate::skill::get_skill_dir(dir.path(), "next.js").join("SKILL.md");
        assert!(skill.exists());

        let out = run_remove(dir.path(), "github:vercel/next.js@v15.0.3").unwrap();
        assert_eq!(
            out,
            RemoveOutcome::Removed("github:vercel/next.js@v15.0.3".into())
        );
        assert!(!skill.exists());
        // AGENTS.md block stripped (no libraries left).
        let agents = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap_or_default();
        assert!(!agents.contains("BEGIN:ask-docs"));
    }

    #[test]
    fn removes_by_library_slug() {
        let dir = tempfile::tempdir().unwrap();
        write_ask(
            dir.path(),
            r#"{"libraries":["github:vercel/next.js@v15.0.3"]}"#,
        );
        // The slug of `github:vercel/next.js` is `next.js`.
        let out = run_remove(dir.path(), "next.js").unwrap();
        assert_eq!(
            out,
            RemoveOutcome::Removed("github:vercel/next.js@v15.0.3".into())
        );
    }
}
