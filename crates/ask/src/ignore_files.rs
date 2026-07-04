//! Vendored-docs ignore-file management. Rust port of `ignore-files.ts`.
//!
//! `.ask/docs/` holds third-party docs — lint/format/review tools should skip it
//! while agents still read it. Strategy: (A) write self-contained nested configs
//! inside `.ask/docs/` for tools with hierarchical config, (C) patch root files
//! for tools without nested config (Prettier, SonarQube, legacy markdownlint).

use std::path::Path;

use crate::io::read_ask_json;
use crate::markers::{inject, remove as remove_marker, wrap, MarkerSyntax};
use crate::storage::get_docs_dir;

/// install (create/patch) vs remove (delete/strip).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IgnoreMode {
    Install,
    Remove,
}

struct NestedConfig {
    name: &'static str,
    content: &'static str,
}

/// Nested config files written inside `.ask/docs/` (byte-exact templates).
const NESTED_CONFIGS: &[NestedConfig] = &[
    NestedConfig {
        name: ".gitattributes",
        content: "# Managed by ASK — marks vendored docs for GitHub Linguist.\n\
                  * linguist-vendored=true\n\
                  * linguist-generated=true\n",
    },
    NestedConfig {
        name: "eslint.config.mjs",
        content: "// Managed by ASK — vendored docs, excluded from ESLint.\n\
                  export default [\n\
                  \x20 { ignores: ['**/*'] },\n\
                  ]\n",
    },
    NestedConfig {
        name: "biome.json",
        content: "{\n  \"$schema\": \"https://biomejs.dev/schemas/2.0.0/schema.json\",\n  \"files\": {\n    \"ignore\": [\n      \"**/*\"\n    ]\n  }\n}\n",
    },
    NestedConfig {
        name: ".markdownlint-cli2.jsonc",
        content: "{\n  \"ignores\": [\n    \"**/*\"\n  ]\n}\n",
    },
];

struct RootPatch {
    file: &'static str,
    payload: &'static str,
    warn: Option<&'static str>,
}

/// Root files patched only when they already exist (never created from scratch).
const ROOT_PATCHES: &[RootPatch] = &[
    RootPatch {
        file: ".prettierignore",
        payload:
            "# Vendored by ASK\n.ask/docs/\n.ask/skills/\n.ask/resolved.json\n.ask/skills-lock.json",
        warn: None,
    },
    RootPatch {
        file: "sonar-project.properties",
        payload: "# Vendored by ASK\nsonar.exclusions=.ask/docs/**,.ask/skills/**",
        warn: None,
    },
    RootPatch {
        file: ".markdownlintignore",
        payload: "# Vendored by ASK\n.ask/docs/\n.ask/skills/",
        warn: Some(
            "Legacy .markdownlintignore detected. Consider migrating to markdownlint-cli2, which \
             supports nested config inside .ask/docs/ automatically.",
        ),
    },
    RootPatch {
        file: ".gitignore",
        payload:
            "# Vendored by ASK\n.ask/docs/\n.ask/skills/\n.ask/resolved.json\n.ask/skills-lock.json",
        warn: None,
    },
];

/// Whether the user has opted into ASK via any entry point.
fn has_ask_opt_in(project_dir: &Path) -> bool {
    if matches!(read_ask_json(project_dir), Ok(Some(_))) {
        return true;
    }
    let ask = project_dir.join(".ask");
    ask.join("skills-lock.json").exists() || ask.join("skills").exists()
}

fn rel(project_dir: &Path, target: &Path) -> String {
    target
        .strip_prefix(project_dir)
        .unwrap_or(target)
        .to_string_lossy()
        .into_owned()
}

/// Category A: write nested config files inside `.ask/docs/` (only when content
/// differs). Returns project-relative paths written.
pub fn write_nested_configs(project_dir: &Path) -> anyhow::Result<Vec<String>> {
    let docs_dir = get_docs_dir(project_dir);
    std::fs::create_dir_all(&docs_dir)?;
    let mut written = Vec::new();
    for cfg in NESTED_CONFIGS {
        let target = docs_dir.join(cfg.name);
        let existing = std::fs::read_to_string(&target).ok();
        if existing.as_deref() != Some(cfg.content) {
            std::fs::write(&target, cfg.content)?;
            written.push(rel(project_dir, &target));
        }
    }
    Ok(written)
}

/// Remove the nested config files (leaving downloaded docs untouched).
pub fn remove_nested_configs(project_dir: &Path) -> anyhow::Result<Vec<String>> {
    let docs_dir = get_docs_dir(project_dir);
    if !docs_dir.exists() {
        return Ok(Vec::new());
    }
    let mut removed = Vec::new();
    for cfg in NESTED_CONFIGS {
        let target = docs_dir.join(cfg.name);
        if target.exists() {
            std::fs::remove_file(&target)?;
            removed.push(rel(project_dir, &target));
        }
    }
    Ok(removed)
}

/// Category C: inject the ASK marker block into existing root files.
pub fn patch_root_ignores(project_dir: &Path) -> anyhow::Result<Vec<String>> {
    let mut updated = Vec::new();
    for patch in ROOT_PATCHES {
        let target = project_dir.join(patch.file);
        if !target.exists() {
            continue;
        }
        let existing = std::fs::read_to_string(&target)?;
        let block = wrap(patch.payload, MarkerSyntax::Hash);
        let next = inject(&existing, &block, MarkerSyntax::Hash);
        if next != existing {
            std::fs::write(&target, &next)?;
            updated.push(patch.file.to_string());
        }
        if let Some(warn) = patch.warn {
            eprintln!("  Warning: {warn}");
        }
    }
    Ok(updated)
}

/// Strip the ASK marker block from patched root files (files never deleted).
pub fn unpatch_root_ignores(project_dir: &Path) -> anyhow::Result<Vec<String>> {
    let mut updated = Vec::new();
    for patch in ROOT_PATCHES {
        let target = project_dir.join(patch.file);
        if !target.exists() {
            continue;
        }
        let existing = std::fs::read_to_string(&target)?;
        let next = remove_marker(&existing, MarkerSyntax::Hash);
        if next != existing {
            std::fs::write(&target, &next)?;
            updated.push(patch.file.to_string());
        }
    }
    Ok(updated)
}

/// Top-level orchestrator. No-op when the user hasn't opted into ASK.
pub fn manage_ignore_files(project_dir: &Path, mode: IgnoreMode) -> anyhow::Result<()> {
    if !has_ask_opt_in(project_dir) {
        return Ok(());
    }
    match mode {
        IgnoreMode::Install => {
            let nested = write_nested_configs(project_dir)?;
            let root = patch_root_ignores(project_dir)?;
            if !nested.is_empty() {
                eprintln!("  Nested configs written: {}", nested.join(", "));
            }
            if !root.is_empty() {
                eprintln!("  Root ignore files patched: {}", root.join(", "));
            }
        }
        IgnoreMode::Remove => {
            let nested = remove_nested_configs(project_dir)?;
            let root = unpatch_root_ignores(project_dir)?;
            if !nested.is_empty() {
                eprintln!("  Nested configs removed: {}", nested.join(", "));
            }
            if !root.is_empty() {
                eprintln!("  Root ignore marker blocks removed: {}", root.join(", "));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opt_in(project: &Path) {
        std::fs::write(crate::io::get_ask_json_path(project), r#"{"libraries":[]}"#).unwrap();
    }

    #[test]
    fn no_op_without_opt_in() {
        let dir = tempfile::tempdir().unwrap();
        // A .gitignore exists but no ask.json → untouched.
        std::fs::write(dir.path().join(".gitignore"), "node_modules\n").unwrap();
        manage_ignore_files(dir.path(), IgnoreMode::Install).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "node_modules\n"
        );
    }

    #[test]
    fn install_writes_nested_and_patches_existing_root() {
        let dir = tempfile::tempdir().unwrap();
        opt_in(dir.path());
        std::fs::write(dir.path().join(".gitignore"), "node_modules\n").unwrap();
        // .prettierignore does NOT exist → must not be created.
        manage_ignore_files(dir.path(), IgnoreMode::Install).unwrap();

        let docs = get_docs_dir(dir.path());
        assert!(docs.join(".gitattributes").exists());
        assert!(docs.join("biome.json").exists());
        // biome.json byte-exact.
        assert_eq!(
            std::fs::read_to_string(docs.join("biome.json")).unwrap(),
            "{\n  \"$schema\": \"https://biomejs.dev/schemas/2.0.0/schema.json\",\n  \"files\": {\n    \"ignore\": [\n      \"**/*\"\n    ]\n  }\n}\n"
        );
        // .gitignore patched with a marker block; .prettierignore untouched.
        let gi = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(gi.contains("# ask:start"));
        assert!(gi.contains(".ask/docs/"));
        assert!(!dir.path().join(".prettierignore").exists());
    }

    #[test]
    fn remove_strips_nested_and_root() {
        let dir = tempfile::tempdir().unwrap();
        opt_in(dir.path());
        std::fs::write(dir.path().join(".gitignore"), "node_modules\n").unwrap();
        manage_ignore_files(dir.path(), IgnoreMode::Install).unwrap();
        manage_ignore_files(dir.path(), IgnoreMode::Remove).unwrap();

        assert!(!get_docs_dir(dir.path()).join("biome.json").exists());
        let gi = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(!gi.contains("# ask:start"));
        assert!(gi.contains("node_modules"));
    }

    #[test]
    fn nested_write_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        opt_in(dir.path());
        assert!(!write_nested_configs(dir.path()).unwrap().is_empty());
        // Second run: content unchanged → nothing reported.
        assert!(write_nested_configs(dir.path()).unwrap().is_empty());
    }
}
