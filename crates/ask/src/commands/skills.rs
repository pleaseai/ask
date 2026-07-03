//! `ask skills {list|install|remove}` — surface and vendor producer-side agent
//! skills. Rust port of `commands/skills/{list,install,remove}.ts`.
//!
//! `list` prints the fixed `<root>/skills/` directory for each available source.
//! `install` vendors skill bundles into `.ask/skills/<specKey>/`, symlinks them
//! into detected agents, and records the lock. `remove` reverses an install
//! using the lock as the source of truth. The non-interactive contract
//! (`--agent`, `--no-fetch`, `--ignore-missing`) is what gets byte-parity
//! tested; the agent-picker prompt is a seamed TTY leaf.

use std::path::{Path, PathBuf};

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::commands::ensure_checkout::{
    ensure_checkout, EnsureCheckoutDeps, EnsureCheckoutOptions, EnsureCheckoutResult, NoCacheError,
};
use crate::commands::find_skill_paths::find_skill_like_paths;
use crate::http::HttpClient;
use crate::ignore_files::{manage_ignore_files, IgnoreMode};
use crate::skills::agent_detect::{detect_agents, resolve_agent_names, AgentTarget};
use crate::skills::lock::{
    read_lock, remove_entry, upsert_entry, write_lock_atomic, LockEntry, LockSkill,
};
use crate::skills::spec_key::{encode_spec_key, SpecKeyInput};
use crate::skills::symlinks::{link_skill, unlink_if_owned, LinkSkillOptions};
use crate::skills::vendor::{remove_vendor_dir, vendor_skills, VENDOR_ROOT};

/// Common command output: collected lines plus the process exit code.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SkillsReport {
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
    pub exit_code: i32,
}

/// True when `<root>/skills/` exists and is a directory.
fn skills_dir_if_exists(root: &Path) -> Option<PathBuf> {
    let candidate = root.join("skills");
    if candidate.is_dir() {
        Some(candidate)
    } else {
        None
    }
}

/// Resolve a spec to a checkout, converting the two error modes into a stderr
/// line + exit 1 (parity with the shared `catch` in every skills command).
fn resolve_or_report(
    client: &dyn HttpClient,
    spec: &str,
    project_dir: &Path,
    no_fetch: bool,
    checkout: &EnsureCheckoutDeps,
    report: &mut SkillsReport,
) -> Option<EnsureCheckoutResult> {
    match ensure_checkout(
        client,
        &EnsureCheckoutOptions {
            spec: spec.to_string(),
            project_dir: project_dir.to_path_buf(),
            no_fetch,
        },
        checkout,
    ) {
        Ok(r) => Some(r),
        Err(err) => {
            // NoCacheError and any other resolver error both print the message
            // and exit 1 — the TS build distinguishes only for the type guard.
            let msg = match err.downcast_ref::<NoCacheError>() {
                Some(nc) => nc.to_string(),
                None => err.to_string(),
            };
            report.stderr.push(msg);
            report.exit_code = 1;
            None
        }
    }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/// Options for [`run_skills_list`].
#[derive(Debug, Clone)]
pub struct RunSkillsListOptions {
    pub spec: String,
    pub project_dir: PathBuf,
    pub no_fetch: bool,
}

/// `ask skills [list] <spec>` — print `<root>/skills/` for node_modules and the
/// cached checkout. Exits 1 when neither exists.
pub fn run_skills_list(
    client: &dyn HttpClient,
    options: &RunSkillsListOptions,
    checkout: &EnsureCheckoutDeps,
) -> SkillsReport {
    let mut report = SkillsReport::default();
    let Some(result) = resolve_or_report(
        client,
        &options.spec,
        &options.project_dir,
        options.no_fetch,
        checkout,
        &mut report,
    ) else {
        return report;
    };

    let mut found: Vec<PathBuf> = Vec::new();
    if let Some(pkg) = &result.npm_package_name {
        let nm_path = options.project_dir.join("node_modules").join(pkg);
        if let Some(s) = skills_dir_if_exists(&nm_path) {
            found.push(s);
        }
    }
    if let Some(s) = skills_dir_if_exists(&result.checkout_dir) {
        found.push(s);
    }

    if found.is_empty() {
        report.stderr.push(format!(
            "no skills/ directory found for {} — try 'ask src {}' for the checkout root",
            options.spec, options.spec
        ));
        report.exit_code = 1;
        return report;
    }

    for p in found {
        report.stdout.push(p.to_string_lossy().into_owned());
    }
    report
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

const SKILLS_PARENTS: &[&str] = &["skill", "skills"];

/// Options for [`run_skills_install`].
#[derive(Debug, Clone)]
pub struct RunSkillsInstallOptions {
    pub spec: String,
    pub project_dir: PathBuf,
    pub no_fetch: bool,
    pub force: bool,
    /// Explicit agent list (CSV from CLI). Overrides detection + prompt.
    pub agents: Option<Vec<String>>,
}

/// Agent-picker seam: given the detected candidates, return the chosen subset.
type PickAgentsFn<'a> = dyn Fn(&[AgentTarget]) -> Vec<AgentTarget> + 'a;

/// Seams for [`run_skills_install`].
#[derive(Default)]
pub struct SkillsInstallDeps<'a> {
    pub checkout: EnsureCheckoutDeps<'a>,
    /// Picks agents when >1 detected and no explicit `--agent`.
    pub pick_agents: Option<&'a PickAgentsFn<'a>>,
    /// Clock seam for `installedAt` (default: real RFC3339 UTC).
    pub now_iso: Option<&'a (dyn Fn() -> String + 'a)>,
}

/// `ask skills install <spec>` — resolve, vendor, pick agents, symlink, update
/// the lock, and patch ignore files.
pub fn run_skills_install(
    client: &dyn HttpClient,
    options: &RunSkillsInstallOptions,
    deps: &SkillsInstallDeps,
) -> anyhow::Result<SkillsReport> {
    let mut report = SkillsReport::default();

    let Some(result) = resolve_or_report(
        client,
        &options.spec,
        &options.project_dir,
        options.no_fetch,
        &deps.checkout,
        &mut report,
    ) else {
        return Ok(report);
    };

    let sources = collect_skill_dirs(&options.project_dir, &result);
    if sources.is_empty() {
        report
            .stderr
            .push(format!("no skills/ directories found for {}", options.spec));
        report.exit_code = 1;
        return Ok(report);
    }

    // Agent selection: explicit flag > detect + prompt > detect-1 auto > error.
    let agents: Vec<AgentTarget> = match &options.agents {
        Some(names) if !names.is_empty() => {
            match resolve_agent_names(&options.project_dir, names) {
                Ok(a) => a,
                Err(err) => {
                    report.stderr.push(err.to_string());
                    report.exit_code = 1;
                    return Ok(report);
                }
            }
        }
        _ => {
            let detected = detect_agents(&options.project_dir);
            if detected.is_empty() {
                report.stderr.push(
                    "no supported coding agent detected in this project (.claude/, .cursor/, .opencode/, .codex/). Pass --agent <name> to force."
                        .to_string(),
                );
                report.exit_code = 1;
                return Ok(report);
            }
            let picked = if detected.len() == 1 {
                detected
            } else {
                let default_pick = default_pick_agents;
                let pick: &dyn Fn(&[AgentTarget]) -> Vec<AgentTarget> =
                    deps.pick_agents.unwrap_or(&default_pick);
                pick(&detected)
            };
            if picked.is_empty() {
                report.stderr.push("no agents selected".to_string());
                report.exit_code = 1;
                return Ok(report);
            }
            picked
        }
    };

    // Encode the spec-key from the resolver result.
    let ecosystem = if result.npm_package_name.is_some() {
        "npm"
    } else {
        "github"
    };
    let name = result
        .npm_package_name
        .clone()
        .unwrap_or_else(|| format!("{}/{}", result.owner, result.repo));
    let spec_key = encode_spec_key(&SpecKeyInput {
        ecosystem: ecosystem.to_string(),
        name,
        version: result.resolved_version.clone(),
    })?;

    // Vendor + symlink.
    let vendor = vendor_skills(&options.project_dir, &spec_key, &sources)?;
    let agent_names: Vec<String> = agents.iter().map(|a| a.name.clone()).collect();
    for skill in &vendor.skill_names {
        let target_path = vendor.vendor_dir.join(skill);
        for agent in &agents {
            let link_path = agent.skills_dir.join(skill);
            if let Err(err) = link_skill(&LinkSkillOptions {
                link_path: &link_path,
                target_path: &target_path,
                force: options.force,
            }) {
                report.stderr.push(err.to_string());
                report.exit_code = 1;
                return Ok(report);
            }
        }
    }

    // Persist the lock.
    let now = deps.now_iso.map(|f| f()).unwrap_or_else(default_now_iso);
    let lock = read_lock(&options.project_dir)?;
    let updated = upsert_entry(
        &lock,
        LockEntry {
            spec: options.spec.clone(),
            spec_key: spec_key.clone(),
            skills: vendor
                .skill_names
                .iter()
                .map(|n| LockSkill {
                    name: n.clone(),
                    agents: agent_names.clone(),
                })
                .collect(),
            installed_at: now,
        },
    );
    write_lock_atomic(&options.project_dir, &updated)?;

    // Make sure .ask/skills/ and skills-lock.json are marked vendored.
    manage_ignore_files(&options.project_dir, IgnoreMode::Install)?;

    report.stdout.push(format!(
        "installed {} skill(s) for {} into {}",
        vendor.skill_names.len(),
        options.spec,
        agent_names.join(", ")
    ));
    Ok(report)
}

/// Gather the individual skill directories: for each `skill`/`skills` parent the
/// walker surfaced, every direct subdirectory (deduped). Parity with
/// `collectSkillDirs`.
fn collect_skill_dirs(project_dir: &Path, result: &EnsureCheckoutResult) -> Vec<PathBuf> {
    let mut parents: Vec<PathBuf> = Vec::new();
    if let Some(pkg) = &result.npm_package_name {
        let nm_path = project_dir.join("node_modules").join(pkg);
        if nm_path.exists() {
            parents.extend(find_skill_like_paths(&nm_path));
        }
    }
    parents.extend(find_skill_like_paths(&result.checkout_dir));

    let mut skill_dirs: Vec<PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for parent in &parents {
        // Tight match: only exact `skill`/`skills` (case-insensitive) qualify as
        // the producer-side "skills parent".
        let basename = parent
            .file_name()
            .map(|s| s.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if !SKILLS_PARENTS.contains(&basename.as_str()) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(parent) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            let child = parent.join(entry.file_name());
            if seen.insert(child.clone()) {
                skill_dirs.push(child);
            }
        }
    }
    skill_dirs
}

fn default_now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

/// Production agent picker — `dialoguer::MultiSelect` over agent labels. Empty
/// selection (or a non-TTY error) yields no agents, matching "nothing picked".
fn default_pick_agents(candidates: &[AgentTarget]) -> Vec<AgentTarget> {
    use dialoguer::MultiSelect;
    let labels: Vec<&str> = candidates.iter().map(|c| c.label.as_str()).collect();
    match MultiSelect::new()
        .with_prompt("Install into which agents?")
        .items(&labels)
        .interact()
    {
        Ok(idxs) => idxs
            .into_iter()
            .filter_map(|i| candidates.get(i).cloned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/// Options for [`run_skills_remove`].
#[derive(Debug, Clone)]
pub struct RunSkillsRemoveOptions {
    /// Full user spec OR the spec-key directly.
    pub spec: String,
    pub project_dir: PathBuf,
    pub ignore_missing: bool,
}

/// `ask skills remove <spec>` — reverse a prior install using the lock as the
/// source of truth. Never touches real dirs or foreign symlinks.
pub fn run_skills_remove(options: &RunSkillsRemoveOptions) -> anyhow::Result<SkillsReport> {
    let mut report = SkillsReport::default();

    let lock = read_lock(&options.project_dir)?;
    let entry = lock
        .entries
        .values()
        .find(|e| e.spec_key == options.spec || e.spec == options.spec)
        .cloned();

    let Some(entry) = entry else {
        if options.ignore_missing {
            report.stdout.push(format!(
                "no lock entry for {} — nothing to do",
                options.spec
            ));
            return Ok(report);
        }
        report.stderr.push(format!(
            "no lock entry for {}. Pass --ignore-missing to silence.",
            options.spec
        ));
        report.exit_code = 1;
        return Ok(report);
    };

    let vendor_dir = options.project_dir.join(VENDOR_ROOT).join(&entry.spec_key);
    let mut unlinked = 0usize;
    for skill in &entry.skills {
        let agents = match resolve_agent_names(&options.project_dir, &skill.agents) {
            Ok(a) => a,
            Err(err) => {
                report.stderr.push(err.to_string());
                report.exit_code = 1;
                return Ok(report);
            }
        };
        for agent in &agents {
            let link_path = agent.skills_dir.join(&skill.name);
            let target_path = vendor_dir.join(&skill.name);
            if unlink_if_owned(&link_path, &target_path) {
                unlinked += 1;
            }
        }
    }

    remove_vendor_dir(&options.project_dir, &entry.spec_key)?;
    write_lock_atomic(&options.project_dir, &remove_entry(&lock, &entry.spec_key))?;

    report.stdout.push(format!(
        "removed {} symlink(s) and vendored copy for {}",
        unlinked, options.spec
    ));
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;
    use crate::store::github_store_path;

    /// Pre-warm a checkout with a `skills/<name>/SKILL.md` bundle.
    fn warmed_with_skill(skill: &str) -> (tempfile::TempDir, tempfile::TempDir, PathBuf) {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let dir = github_store_path(home.path(), "github.com", "o", "r", "v1.0.0").unwrap();
        let bundle = dir.join("skills").join(skill);
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("SKILL.md"), "# skill").unwrap();
        (home, proj, dir)
    }

    fn checkout_deps(home: &Path) -> EnsureCheckoutDeps<'static> {
        EnsureCheckoutDeps {
            ask_home: Some(home.to_path_buf()),
            fetcher: None,
        }
    }

    #[test]
    fn list_prints_skills_dir() {
        let (home, proj, dir) = warmed_with_skill("s");
        let report = run_skills_list(
            &MockClient::new(),
            &RunSkillsListOptions {
                spec: "github:o/r@v1.0.0".into(),
                project_dir: proj.path().to_path_buf(),
                no_fetch: false,
            },
            &checkout_deps(home.path()),
        );
        assert_eq!(report.exit_code, 0);
        assert_eq!(
            report.stdout,
            vec![dir.join("skills").to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn list_no_skills_dir_exits_one() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let dir = github_store_path(home.path(), "github.com", "o", "r", "v1.0.0").unwrap();
        std::fs::create_dir_all(&dir).unwrap(); // no skills/ subdir
        let report = run_skills_list(
            &MockClient::new(),
            &RunSkillsListOptions {
                spec: "github:o/r@v1.0.0".into(),
                project_dir: proj.path().to_path_buf(),
                no_fetch: false,
            },
            &checkout_deps(home.path()),
        );
        assert_eq!(report.exit_code, 1);
        assert!(report.stderr[0].contains("no skills/ directory"));
    }

    #[test]
    fn install_vendors_symlinks_and_locks() {
        let (home, proj, _dir) = warmed_with_skill("my-skill");
        std::fs::create_dir_all(proj.path().join(".claude")).unwrap();
        let fixed_now = || "2026-07-04T00:00:00.000Z".to_string();
        let deps = SkillsInstallDeps {
            checkout: checkout_deps(home.path()),
            pick_agents: None,
            now_iso: Some(&fixed_now),
        };
        let report = run_skills_install(
            &MockClient::new(),
            &RunSkillsInstallOptions {
                spec: "github:o/r@v1.0.0".into(),
                project_dir: proj.path().to_path_buf(),
                no_fetch: false,
                force: false,
                agents: Some(vec!["claude".into()]),
            },
            &deps,
        )
        .unwrap();
        assert_eq!(report.exit_code, 0);
        // Vendored copy exists.
        let vendored = proj
            .path()
            .join(".ask/skills/github__o__r__v1.0.0/my-skill/SKILL.md");
        assert!(vendored.exists());
        // Symlink into the agent dir, relative-encoded.
        let link = proj.path().join(".claude/skills/my-skill");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        // Lock records the entry.
        let lock = read_lock(proj.path()).unwrap();
        assert!(lock.entries.contains_key("github__o__r__v1.0.0"));
    }

    #[test]
    fn install_no_agent_detected_exits_one() {
        let (home, proj, _dir) = warmed_with_skill("s");
        let deps = SkillsInstallDeps {
            checkout: checkout_deps(home.path()),
            ..Default::default()
        };
        let report = run_skills_install(
            &MockClient::new(),
            &RunSkillsInstallOptions {
                spec: "github:o/r@v1.0.0".into(),
                project_dir: proj.path().to_path_buf(),
                no_fetch: false,
                force: false,
                agents: None,
            },
            &deps,
        )
        .unwrap();
        assert_eq!(report.exit_code, 1);
        assert!(report.stderr[0].contains("no supported coding agent"));
    }

    #[test]
    fn install_no_skills_exits_one() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let dir = github_store_path(home.path(), "github.com", "o", "r", "v1.0.0").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(proj.path().join(".claude")).unwrap();
        let deps = SkillsInstallDeps {
            checkout: checkout_deps(home.path()),
            ..Default::default()
        };
        let report = run_skills_install(
            &MockClient::new(),
            &RunSkillsInstallOptions {
                spec: "github:o/r@v1.0.0".into(),
                project_dir: proj.path().to_path_buf(),
                no_fetch: false,
                force: false,
                agents: Some(vec!["claude".into()]),
            },
            &deps,
        )
        .unwrap();
        assert_eq!(report.exit_code, 1);
        assert!(report.stderr[0].contains("no skills/ directories"));
    }

    #[test]
    fn install_then_remove_roundtrip() {
        let (home, proj, _dir) = warmed_with_skill("my-skill");
        std::fs::create_dir_all(proj.path().join(".claude")).unwrap();
        let fixed_now = || "2026-07-04T00:00:00.000Z".to_string();
        run_skills_install(
            &MockClient::new(),
            &RunSkillsInstallOptions {
                spec: "github:o/r@v1.0.0".into(),
                project_dir: proj.path().to_path_buf(),
                no_fetch: false,
                force: false,
                agents: Some(vec!["claude".into()]),
            },
            &SkillsInstallDeps {
                checkout: checkout_deps(home.path()),
                pick_agents: None,
                now_iso: Some(&fixed_now),
            },
        )
        .unwrap();

        let report = run_skills_remove(&RunSkillsRemoveOptions {
            spec: "github:o/r@v1.0.0".into(),
            project_dir: proj.path().to_path_buf(),
            ignore_missing: false,
        })
        .unwrap();
        assert_eq!(report.exit_code, 0);
        assert_eq!(
            report.stdout[0],
            "removed 1 symlink(s) and vendored copy for github:o/r@v1.0.0"
        );
        // Symlink and vendor gone; lock entry cleared.
        assert!(std::fs::symlink_metadata(proj.path().join(".claude/skills/my-skill")).is_err());
        assert!(!proj
            .path()
            .join(".ask/skills/github__o__r__v1.0.0")
            .exists());
        assert!(read_lock(proj.path()).unwrap().entries.is_empty());
    }

    #[test]
    fn remove_missing_without_flag_exits_one() {
        let proj = tempfile::tempdir().unwrap();
        let report = run_skills_remove(&RunSkillsRemoveOptions {
            spec: "npm:nope".into(),
            project_dir: proj.path().to_path_buf(),
            ignore_missing: false,
        })
        .unwrap();
        assert_eq!(report.exit_code, 1);
        assert!(report.stderr[0].contains("no lock entry"));
    }

    #[test]
    fn remove_missing_with_flag_is_ok() {
        let proj = tempfile::tempdir().unwrap();
        let report = run_skills_remove(&RunSkillsRemoveOptions {
            spec: "npm:nope".into(),
            project_dir: proj.path().to_path_buf(),
            ignore_missing: true,
        })
        .unwrap();
        assert_eq!(report.exit_code, 0);
        assert!(report.stdout[0].contains("nothing to do"));
    }
}
