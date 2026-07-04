//! Lazy-first `ask install` orchestrator. Rust port of `install.ts`.
//!
//! Reads `ask.json`, resolves each library's version (github specs carry it in
//! the spec; npm specs read the lockfile), and regenerates AGENTS.md + SKILL.md
//! with lazy `ask src`/`ask docs` references. No docs are downloaded here —
//! agents fetch on-demand through the lazy commands.

use std::path::Path;

use crate::agents::{generate_agents_md, LazyLibraryInfo};
use crate::ask_json::AskJson;
use crate::ignore_files::{manage_ignore_files, IgnoreMode};
use crate::io::{get_ask_json_path, read_ask_json, write_ask_json};
use crate::lockfiles::npm_ecosystem_read;
use crate::skill::generate_skill;
use crate::spec::{parse_spec, split_explicit_version, ParsedSpec};

/// Options for [`run_install`].
#[derive(Debug, Clone, Default)]
pub struct RunInstallOptions {
    /// Subset of libraries to install (by spec). `None` installs all.
    pub only_specs: Option<Vec<String>>,
}

/// Outcome counts from a run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InstallSummary {
    pub installed: usize,
    pub skipped: usize,
}

pub fn run_install(
    project_dir: &Path,
    options: &RunInstallOptions,
) -> anyhow::Result<InstallSummary> {
    let Some(ask_json) = read_ask_json(project_dir)? else {
        let empty = AskJson {
            libraries: Vec::new(),
        };
        write_ask_json(project_dir, &empty)?;
        eprintln!(
            "Created empty {}. Add libraries with `ask add npm:<package>` or \
             `ask add github:<owner>/<repo>@<ref>`.",
            get_ask_json_path(project_dir).display()
        );
        return Ok(InstallSummary::default());
    };

    let targets: Vec<String> = ask_json
        .libraries
        .iter()
        .map(|e| e.spec().to_string())
        .filter(|spec| match &options.only_specs {
            Some(only) => only.contains(spec),
            None => true,
        })
        .collect();

    let mut summary = InstallSummary::default();

    if targets.is_empty() {
        // Full install after the last library was removed still needs to strip
        // the AGENTS.md block and ignore markers.
        if options.only_specs.is_none() {
            generate_agents_md(project_dir, &[])?;
            manage_ignore_files(project_dir, IgnoreMode::Remove)?;
        }
        eprintln!("No libraries to install.");
        return Ok(summary);
    }

    eprintln!(
        "Resolving {} librar{}...",
        targets.len(),
        if targets.len() == 1 { "y" } else { "ies" }
    );

    let mut resolved: Vec<LazyLibraryInfo> = Vec::new();
    for spec in &targets {
        match resolve_one(project_dir, spec) {
            Some(info) => {
                generate_skill(project_dir, &info.name, &info.version)?;
                resolved.push(info);
                summary.installed += 1;
            }
            None => summary.skipped += 1,
        }
    }

    // AGENTS.md reflects ALL resolved libraries. For a scoped install, re-resolve
    // the full set; otherwise reuse this batch to avoid duplicate log output.
    let all_resolved = if options.only_specs.is_some() {
        resolve_all(project_dir)
    } else {
        resolved
    };
    generate_agents_md(project_dir, &all_resolved)?;
    manage_ignore_files(project_dir, IgnoreMode::Install)?;

    eprintln!(
        "Install complete: {} resolved, {} skipped.",
        summary.installed, summary.skipped
    );
    Ok(summary)
}

/// Resolve a single spec's version. `None` when unresolvable (missing lockfile
/// entry, unsupported ecosystem).
fn resolve_one(project_dir: &Path, spec: &str) -> Option<LazyLibraryInfo> {
    let (spec_body, explicit) = split_explicit_version(spec);
    match parse_spec(spec_body) {
        ParsedSpec::Github { name, .. } => {
            // github specs carry the version; strip a leading `v` so output uses
            // "^14" not "^v14".
            let version = explicit.unwrap_or("latest");
            let version = version.strip_prefix('v').unwrap_or(version).to_string();
            eprintln!("  {spec}: {name}@{version}");
            Some(LazyLibraryInfo {
                name,
                version,
                spec: spec.to_string(),
            })
        }
        ParsedSpec::Npm { pkg, name } => {
            let version = match explicit {
                Some(v) => v.to_string(),
                None => match npm_ecosystem_read(&pkg, project_dir) {
                    Some(hit) => hit.version,
                    None => {
                        eprintln!("  Warning: {spec}: not found in any lockfile — skipping");
                        return None;
                    }
                },
            };
            eprintln!("  {spec}: {name}@{version}");
            Some(LazyLibraryInfo {
                name,
                version,
                spec: spec.to_string(),
            })
        }
        ParsedSpec::Unknown { .. } => {
            eprintln!("  Warning: {spec}: unsupported ecosystem — skipping");
            None
        }
    }
}

/// Resolve every library in `ask.json` (for AGENTS.md regeneration).
fn resolve_all(project_dir: &Path) -> Vec<LazyLibraryInfo> {
    let Ok(Some(ask_json)) = read_ask_json(project_dir) else {
        return Vec::new();
    };
    ask_json
        .libraries
        .iter()
        .filter_map(|entry| resolve_one(project_dir, entry.spec()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_ask(project: &Path, json: &str) {
        std::fs::write(get_ask_json_path(project), json).unwrap();
    }

    #[test]
    fn creates_empty_ask_json_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let summary = run_install(dir.path(), &RunInstallOptions::default()).unwrap();
        assert_eq!(summary, InstallSummary::default());
        assert!(get_ask_json_path(dir.path()).exists());
    }

    #[test]
    fn resolves_github_spec_and_generates_outputs() {
        let dir = tempfile::tempdir().unwrap();
        // resolve_one reads the version from the spec string (spec-embedded
        // `@v15.0.3`), stripping the leading `v` for the output.
        write_ask(
            dir.path(),
            r#"{"libraries":["github:vercel/next.js@v15.0.3"]}"#,
        );
        let summary = run_install(dir.path(), &RunInstallOptions::default()).unwrap();
        assert_eq!(summary.installed, 1);
        // SKILL.md + AGENTS.md generated with the v-stripped version.
        let skill = std::fs::read_to_string(
            crate::skill::get_skill_dir(dir.path(), "next.js").join("SKILL.md"),
        )
        .unwrap();
        assert!(skill.contains("next.js v15.0.3"));
        let agents = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert!(agents.contains("## next.js v15.0.3"));
    }

    #[test]
    fn npm_spec_without_lockfile_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        write_ask(dir.path(), r#"{"libraries":["npm:acme"]}"#);
        let summary = run_install(dir.path(), &RunInstallOptions::default()).unwrap();
        assert_eq!(summary.installed, 0);
        assert_eq!(summary.skipped, 1);
    }

    #[test]
    fn npm_spec_resolves_from_package_json() {
        let dir = tempfile::tempdir().unwrap();
        write_ask(dir.path(), r#"{"libraries":["npm:acme"]}"#);
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"dependencies":{"acme":"3.4.5"}}"#,
        )
        .unwrap();
        let summary = run_install(dir.path(), &RunInstallOptions::default()).unwrap();
        assert_eq!(summary.installed, 1);
        let agents = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert!(agents.contains("## acme v3.4.5"));
    }

    #[test]
    fn empty_libraries_strips_agents_block() {
        let dir = tempfile::tempdir().unwrap();
        write_ask(dir.path(), r#"{"libraries":[]}"#);
        std::fs::write(
            dir.path().join("AGENTS.md"),
            "# Head\n\n<!-- BEGIN:ask-docs-auto-generated -->\nx\n<!-- END:ask-docs-auto-generated -->\n",
        )
        .unwrap();
        run_install(dir.path(), &RunInstallOptions::default()).unwrap();
        let agents = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert!(!agents.contains("BEGIN:ask-docs"));
    }
}
