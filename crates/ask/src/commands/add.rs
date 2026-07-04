//! `ask add <spec>` — add a library to `ask.json` and materialize its docs via
//! `run_install`. Rust port of `commands/add.ts` + the bare-`ask add`
//! interactive flow in `interactive.ts`.
//!
//! The real contract is the persisted `ask.json`, NOT the prompt UI. The
//! non-interactive path (`--docs-paths`, `--clear-docs-paths`, cold-cache bare
//! `add`) is what gets byte-parity tested against the TS oracle; the TTY
//! multiselect / text prompts are seamed out so unit tests never need a
//! terminal, and the production defaults use `dialoguer`.

use std::collections::HashSet;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use crate::ask_json::{entry_from_spec, AskJson};
use crate::commands::ensure_checkout::EnsureCheckoutDeps;
use crate::discovery::candidates::{
    gather_docs_candidates, CandidateGatheringError, CandidateGroup,
};
use crate::http::HttpClient;
use crate::install::{run_install, RunInstallOptions};
use crate::io::{read_ask_json, write_ask_json};
use crate::registry::api::fetch_registry_entry;
use crate::registry::detect_ecosystem;
use crate::spec::{parse_spec, ParsedSpec};

/// A single choice presented by a multiselect prompt. `value` is what the
/// selection resolves to (an absolute path, or a dependency name); `label` and
/// `hint` are display-only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptOption {
    pub label: String,
    pub value: String,
    pub hint: String,
}

/// Normalize a POSIX path the way Node's `path.posix.normalize` does: collapse
/// `.`/`//`, resolve `..` (leaving leading `..` for relative escapes), and
/// return `.` for an empty result. Used by [`sanitize_docs_path`].
fn posix_normalize(input: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for seg in input.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if matches!(stack.last(), Some(&top) if top != "..") {
                    stack.pop();
                } else {
                    stack.push("..");
                }
            }
            other => stack.push(other),
        }
    }
    if stack.is_empty() {
        ".".to_string()
    } else {
        stack.join("/")
    }
}

/// Validate and canonicalize a user-supplied docs path. Returns the
/// POSIX-normalized relative path on success, or `None` when the input is
/// unsafe / empty. Rejects empty/whitespace, absolute paths, and `..` escapes.
/// Parity with `sanitizeDocsPath`.
pub fn sanitize_docs_path(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    // `Path::is_absolute` matches `path.isAbsolute` on POSIX (leading `/`).
    if Path::new(trimmed).is_absolute() {
        return None;
    }
    let normalized = posix_normalize(&trimmed.replace('\\', "/"));
    if normalized.is_empty() {
        return None;
    }
    if normalized == ".." || normalized.starts_with("../") {
        return None;
    }
    Some(normalized)
}

const AMBIGUOUS_SPEC_HINT: &str = "Ambiguous spec '{}'. Use:\n\
     \u{20} • npm:<name>           (e.g. npm:next, npm:@mastra/client-js)\n\
     \u{20} • github:<owner>/<repo>@<ref>  (e.g. github:vercel/next.js@v14.2.3)";

/// True when `input` is an `owner/repo` pair (exactly one slash, both sides
/// non-empty). Equivalent to the `^[^/]+/[^/]+$` regex without a regex.
fn is_owner_repo(input: &str) -> bool {
    let parts: Vec<&str> = input.split('/').collect();
    parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty()
}

/// `ask add <spec>` spec normalization: a bare `owner/repo` becomes
/// `github:owner/repo`; anything else without a `:` is ambiguous and errors.
/// Parity with `add.ts`'s `normalizeAddSpec`.
pub fn normalize_add_spec(input: &str) -> anyhow::Result<String> {
    if !input.contains(':') {
        if is_owner_repo(input) {
            return Ok(format!("github:{input}"));
        }
        return Err(anyhow::anyhow!(AMBIGUOUS_SPEC_HINT.replacen("{}", input, 1)));
    }
    Ok(input.to_string())
}

/// Interactive-mode spec normalization: assumes npm for bare names, treats
/// `@scope/pkg` as npm (not github), never errors. Parity with
/// `interactive.ts`'s `normalizeAddSpec`.
pub fn normalize_add_spec_interactive(input: &str) -> String {
    if !input.contains(':') {
        if input.starts_with('@') {
            return format!("npm:{input}");
        }
        if is_owner_repo(input) {
            return format!("github:{input}");
        }
        return format!("npm:{input}");
    }
    input.to_string()
}

/// Options for [`run_add`].
#[derive(Debug, Clone)]
pub struct RunAddOptions {
    pub project_dir: PathBuf,
    pub spec: String,
    /// Raw CSV from `--docs-paths`. When `Some`, skips the interactive prompt.
    pub docs_paths_arg: Option<String>,
    /// `--clear-docs-paths` — drop any existing `docsPaths` override.
    pub clear_docs_paths: bool,
}

/// What [`run_add`] produced: user-facing messages, collected so the CLI can
/// print them (routing is not parity-critical — the harness checks `ask.json`).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct AddReport {
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

type GatherFn<'a> =
    dyn Fn(&str, &Path) -> Result<Vec<CandidateGroup>, CandidateGatheringError> + 'a;
type PromptFn<'a> = dyn Fn(&str, &[PromptOption]) -> Vec<String> + 'a;
type InstallerFn<'a> = dyn Fn(&Path, &[String]) -> anyhow::Result<()> + 'a;

/// Test/production seams for [`run_add`]. All `None` → real defaults.
#[derive(Default)]
pub struct RunAddDeps<'a> {
    pub gather: Option<&'a GatherFn<'a>>,
    pub prompt: Option<&'a PromptFn<'a>>,
    pub is_tty: Option<&'a (dyn Fn() -> bool + 'a)>,
    pub installer: Option<&'a InstallerFn<'a>>,
}

/// `ask add <spec>` implementation. Persists the entry (bare string or object
/// with a `docsPaths` override per the three policies below) then runs the
/// lazy-first installer for the single spec.
pub fn run_add(
    client: &dyn HttpClient,
    options: &RunAddOptions,
    deps: &RunAddDeps,
) -> anyhow::Result<AddReport> {
    let default_gather = |spec: &str, dir: &Path| {
        gather_docs_candidates(client, spec, dir, &EnsureCheckoutDeps::default())
    };
    let gather: &GatherFn = deps.gather.unwrap_or(&default_gather);

    let default_prompt: &PromptFn = &default_multiselect;
    let prompt: &PromptFn = deps.prompt.unwrap_or(default_prompt);

    let default_is_tty = || std::io::stdout().is_terminal();
    let is_tty: &dyn Fn() -> bool = deps.is_tty.unwrap_or(&default_is_tty);

    let default_installer = |dir: &Path, specs: &[String]| -> anyhow::Result<()> {
        run_install(
            dir,
            &RunInstallOptions {
                only_specs: Some(specs.to_vec()),
            },
        )?;
        Ok(())
    };
    let installer: &InstallerFn = deps.installer.unwrap_or(&default_installer);

    let spec = normalize_add_spec(&options.spec)?;

    if let ParsedSpec::Unknown { .. } = parse_spec(&spec) {
        anyhow::bail!("Invalid spec: {spec}");
    }

    let mut ask_json = read_ask_json(&options.project_dir)?.unwrap_or(AskJson {
        libraries: Vec::new(),
    });
    let existing_idx = ask_json.libraries.iter().position(|e| e.spec() == spec);

    let mut report = AddReport::default();
    let selected = resolve_selected_paths(&spec, options, gather, prompt, is_tty, &mut report);

    let entry = entry_from_spec(spec.clone(), selected.as_deref().unwrap_or(&[]));
    if let Some(idx) = existing_idx {
        ask_json.libraries[idx] = entry;
        report.stdout.push(format!("Updated {spec} in ask.json"));
    } else {
        ask_json.libraries.push(entry);
        report.stdout.push(format!("Added {spec} to ask.json"));
    }
    write_ask_json(&options.project_dir, &ask_json)?;

    installer(&options.project_dir, &[spec])?;
    Ok(report)
}

/// Strip `root` from `abs`, yielding the relative POSIX-ish tail (empty when
/// equal). Candidates are always descendants of their group root.
fn relative(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| abs.to_string_lossy().into_owned())
}

fn basename(root: &Path) -> String {
    root.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Resolve which docs paths (if any) to persist. Returns `None` for the
/// canonical bare-string form; `Some(paths)` for an object override.
fn resolve_selected_paths(
    spec: &str,
    options: &RunAddOptions,
    gather: &GatherFn,
    prompt: &PromptFn,
    is_tty: &dyn Fn() -> bool,
    report: &mut AddReport,
) -> Option<Vec<String>> {
    // 1. `--clear-docs-paths` → force canonical string form (downgrade).
    if options.clear_docs_paths {
        return None;
    }

    // 2. `--docs-paths a,b,c` → store the supplied CSV, no prompt.
    if let Some(csv) = &options.docs_paths_arg {
        let mut parsed = Vec::new();
        for raw in csv.split(',') {
            match sanitize_docs_path(raw) {
                Some(safe) => parsed.push(safe),
                None => {
                    let trimmed = raw.trim();
                    if !trimmed.is_empty() {
                        report.stderr.push(format!(
                            "Ignoring unsafe docs-path entry {trimmed:?} (must be a relative path that stays inside its root)."
                        ));
                    }
                }
            }
        }
        return if parsed.is_empty() {
            None
        } else {
            Some(parsed)
        };
    }

    // 3. Probe candidates offline; prompt only on a TTY with a real choice.
    let groups = match gather(spec, &options.project_dir) {
        Ok(g) => g,
        Err(err) => {
            report.stderr.push(format!(
                "Could not probe docs candidates for {spec}: {}. Recording the spec without a docs-path override.",
                err.cause
            ));
            return None;
        }
    };

    let all_candidates: Vec<(&CandidateGroup, &PathBuf)> = groups
        .iter()
        .flat_map(|g| g.paths.iter().map(move |p| (g, p)))
        .collect();
    let all_are_root_only = groups
        .iter()
        .all(|g| g.paths.len() == 1 && g.paths[0] == g.root);

    if !is_tty() || all_candidates.len() <= 1 || all_are_root_only {
        return None;
    }

    let prompt_options: Vec<PromptOption> = all_candidates
        .iter()
        .map(|(g, abs)| {
            let rel = relative(&g.root, abs);
            PromptOption {
                label: if rel.is_empty() { ".".to_string() } else { rel },
                value: abs.to_string_lossy().into_owned(),
                hint: basename(&g.root),
            }
        })
        .collect();

    let picked = prompt(
        &format!("Select docs paths to keep for {spec} (space to toggle, enter to confirm):"),
        &prompt_options,
    );
    if picked.is_empty() {
        return None;
    }

    let mut selected = Vec::new();
    for abs in &picked {
        if let Some((g, abs_path)) = all_candidates
            .iter()
            .find(|(_, p)| p.to_string_lossy() == *abs)
        {
            // Root selection resolves to `.` so the min(1) override schema
            // still accepts it and the read side re-resolves to the root.
            let rel = relative(&g.root, abs_path);
            let rel = if rel.is_empty() { ".".to_string() } else { rel };
            if let Some(safe) = sanitize_docs_path(&rel) {
                selected.push(safe);
            }
        }
    }
    if selected.is_empty() {
        None
    } else {
        Some(selected)
    }
}

// ---------------------------------------------------------------------------
// Interactive flow (bare `ask add`) — TTY-only, not byte-parity tested.
// ---------------------------------------------------------------------------

/// Dependency names (from `package.json` deps + devDeps) not already declared
/// in `ask.json`, sorted. Parity with `readProjectDeps`.
pub fn read_project_deps(
    package_json: &serde_json::Value,
    existing_specs: &[String],
) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for key in ["dependencies", "devDependencies"] {
        if let Some(obj) = package_json.get(key).and_then(|v| v.as_object()) {
            for k in obj.keys() {
                if seen.insert(k.clone()) {
                    names.push(k.clone());
                }
            }
        }
    }
    if names.is_empty() {
        return Vec::new();
    }
    let registered: HashSet<String> = existing_specs
        .iter()
        .filter_map(|s| match parse_spec(s) {
            ParsedSpec::Npm { pkg, .. } => Some(pkg),
            _ => None,
        })
        .collect();
    let mut out: Vec<String> = names
        .into_iter()
        .filter(|n| !registered.contains(n))
        .collect();
    out.sort();
    out
}

/// Which of `deps` have a registry entry. Parity with `checkRegistryBatch`
/// (sequential here — result set, not concurrency, is the contract).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RegistryCheckResult {
    pub registered: Vec<String>,
    pub unregistered: Vec<String>,
}

pub fn check_registry_batch(
    client: &dyn HttpClient,
    ecosystem: &str,
    deps: &[String],
) -> RegistryCheckResult {
    let mut result = RegistryCheckResult::default();
    for name in deps {
        if fetch_registry_entry(client, ecosystem, name).is_some() {
            result.registered.push(name.clone());
        } else {
            result.unregistered.push(name.clone());
        }
    }
    result
}

/// Report for the interactive flow, including an exit code (TTY-required guard
/// exits 1, mirroring `process.exit(1)`).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct InteractiveReport {
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
    pub exit_code: i32,
}

type TextFn<'a> = dyn Fn(&str, &str) -> String + 'a;

/// Seams for [`run_interactive_add`].
#[derive(Default)]
pub struct RunInteractiveDeps<'a> {
    pub is_tty: Option<&'a (dyn Fn() -> bool + 'a)>,
    pub multiselect: Option<&'a PromptFn<'a>>,
    pub text: Option<&'a TextFn<'a>>,
    pub installer: Option<&'a InstallerFn<'a>>,
}

/// Interactive add — scans `package.json` deps, checks them against the ASK
/// registry, and lets the user multiselect + free-type specs to add.
pub fn run_interactive_add(
    client: &dyn HttpClient,
    project_dir: &Path,
    deps: &RunInteractiveDeps,
) -> anyhow::Result<InteractiveReport> {
    let default_is_tty = || std::io::stdout().is_terminal();
    let is_tty: &dyn Fn() -> bool = deps.is_tty.unwrap_or(&default_is_tty);
    let default_multi: &PromptFn = &default_multiselect;
    let multiselect: &PromptFn = deps.multiselect.unwrap_or(default_multi);
    let default_text_fn: &TextFn = &default_text;
    let text: &TextFn = deps.text.unwrap_or(default_text_fn);
    let default_installer = |dir: &Path, specs: &[String]| -> anyhow::Result<()> {
        run_install(
            dir,
            &RunInstallOptions {
                only_specs: Some(specs.to_vec()),
            },
        )?;
        Ok(())
    };
    let installer: &InstallerFn = deps.installer.unwrap_or(&default_installer);

    let mut report = InteractiveReport::default();

    if !is_tty() {
        report.stderr.push(
            "Interactive mode requires a TTY. Use `ask add <spec>` to add a library non-interactively."
                .to_string(),
        );
        report.exit_code = 1;
        return Ok(report);
    }

    let ecosystem = detect_ecosystem(project_dir);
    report
        .stdout
        .push(format!("Detected ecosystem: {ecosystem}"));

    let pkg_path = project_dir.join("package.json");
    if !pkg_path.exists() {
        report
            .stderr
            .push("No package.json found. Cannot scan dependencies.".to_string());
        report
            .stdout
            .push("Use `ask add <spec>` to add a library directly.".to_string());
        return Ok(report);
    }

    let package_json: serde_json::Value = match std::fs::read_to_string(&pkg_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => v,
        None => {
            report
                .stderr
                .push("Failed to parse package.json. Check for syntax errors.".to_string());
            return Ok(report);
        }
    };

    let mut ask_json = read_ask_json(project_dir)?.unwrap_or(AskJson {
        libraries: Vec::new(),
    });
    let existing_specs: Vec<String> = ask_json
        .libraries
        .iter()
        .map(|e| e.spec().to_string())
        .collect();
    let dep_names = read_project_deps(&package_json, &existing_specs);

    if dep_names.is_empty() {
        report
            .stdout
            .push("All project dependencies are already registered in ask.json.".to_string());
        return Ok(report);
    }

    report.stdout.push(format!(
        "Checking {} dependencies against ASK registry...",
        dep_names.len()
    ));
    let RegistryCheckResult {
        registered,
        unregistered,
    } = check_registry_batch(client, ecosystem, &dep_names);

    let mut choices: Vec<PromptOption> = Vec::new();
    for name in &registered {
        choices.push(PromptOption {
            label: name.clone(),
            value: name.clone(),
            hint: "registry".to_string(),
        });
    }
    for name in &unregistered {
        choices.push(PromptOption {
            label: name.clone(),
            value: name.clone(),
            hint: "not in registry".to_string(),
        });
    }

    if choices.is_empty() {
        report
            .stdout
            .push("No new dependencies to add.".to_string());
        return Ok(report);
    }

    report.stdout.push(format!(
        "Found {} registered, {} unregistered in ASK registry.",
        registered.len(),
        unregistered.len()
    ));

    let selected = multiselect(
        "Select libraries to add (space to toggle, enter to confirm):",
        &choices,
    );

    let placeholder = "npm:lodash, github:owner/repo@v1";
    let specs: Vec<String> = if selected.is_empty() {
        let manual = text(
            "Enter a spec manually (or press enter to skip):",
            placeholder,
        );
        if manual.trim().is_empty() {
            report.stdout.push("No libraries selected.".to_string());
            return Ok(report);
        }
        manual
            .split(',')
            .map(|s| normalize_add_spec_interactive(s.trim()))
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        // Selected names always come from package.json → npm ecosystem.
        let mut specs: Vec<String> = selected.iter().map(|n| format!("npm:{n}")).collect();
        let manual = text(
            "Any additional specs to add manually? (press enter to skip):",
            placeholder,
        );
        if !manual.trim().is_empty() {
            specs.extend(
                manual
                    .split(',')
                    .map(|s| normalize_add_spec_interactive(s.trim()))
                    .filter(|s| !s.is_empty()),
            );
        }
        specs
    };

    add_specs(project_dir, &mut ask_json, &specs, installer, &mut report)?;
    Ok(report)
}

fn add_specs(
    project_dir: &Path,
    ask_json: &mut AskJson,
    specs: &[String],
    installer: &InstallerFn,
    report: &mut InteractiveReport,
) -> anyhow::Result<()> {
    let mut added: Vec<String> = Vec::new();
    for spec in specs {
        if let ParsedSpec::Unknown { .. } = parse_spec(spec) {
            report.stderr.push(format!("Skipping invalid spec: {spec}"));
            continue;
        }
        if ask_json.libraries.iter().any(|e| e.spec() == spec) {
            report.stdout.push(format!("{spec} already in ask.json"));
            continue;
        }
        ask_json.libraries.push(entry_from_spec(spec.clone(), &[]));
        added.push(spec.clone());
    }

    if added.is_empty() {
        report.stdout.push("No new libraries to add.".to_string());
        return Ok(());
    }

    write_ask_json(project_dir, ask_json)?;
    let plural = if added.len() == 1 { "y" } else { "ies" };
    report.stdout.push(format!(
        "Added {} librar{plural} to ask.json: {}",
        added.len(),
        added.join(", ")
    ));

    installer(project_dir, &added)?;
    Ok(())
}

/// Production multiselect: `dialoguer::MultiSelect`. On any I/O error (no TTY,
/// interrupted) returns an empty selection, matching the "nothing picked" path.
fn default_multiselect(msg: &str, opts: &[PromptOption]) -> Vec<String> {
    use dialoguer::MultiSelect;
    let items: Vec<String> = opts
        .iter()
        .map(|o| {
            if o.hint.is_empty() {
                o.label.clone()
            } else {
                format!("{}  ({})", o.label, o.hint)
            }
        })
        .collect();
    match MultiSelect::new().with_prompt(msg).items(&items).interact() {
        Ok(idxs) => idxs
            .into_iter()
            .filter_map(|i| opts.get(i).map(|o| o.value.clone()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Production text input: `dialoguer::Input`, empty allowed (enter to skip).
fn default_text(msg: &str, _placeholder: &str) -> String {
    use dialoguer::Input;
    Input::<String>::new()
        .with_prompt(msg)
        .allow_empty(true)
        .interact_text()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;

    #[test]
    fn posix_normalize_matches_node() {
        assert_eq!(posix_normalize("docs/./api"), "docs/api");
        assert_eq!(posix_normalize("docs//api"), "docs/api");
        assert_eq!(posix_normalize("a/b/.."), "a");
        assert_eq!(posix_normalize("a/../.."), "..");
        assert_eq!(posix_normalize("."), ".");
        assert_eq!(posix_normalize("./docs"), "docs");
    }

    #[test]
    fn sanitize_rejects_unsafe_accepts_relative() {
        assert_eq!(sanitize_docs_path("docs"), Some("docs".to_string()));
        assert_eq!(
            sanitize_docs_path("  docs/api "),
            Some("docs/api".to_string())
        );
        assert_eq!(
            sanitize_docs_path("docs\\api"),
            Some("docs/api".to_string())
        );
        assert_eq!(sanitize_docs_path("."), Some(".".to_string()));
        assert_eq!(sanitize_docs_path(""), None);
        assert_eq!(sanitize_docs_path("   "), None);
        assert_eq!(sanitize_docs_path("/abs"), None);
        assert_eq!(sanitize_docs_path(".."), None);
        assert_eq!(sanitize_docs_path("../escape"), None);
        assert_eq!(sanitize_docs_path("a/../../b"), None);
    }

    #[test]
    fn normalize_add_spec_owner_repo_and_ambiguous() {
        assert_eq!(
            normalize_add_spec("vercel/next.js").unwrap(),
            "github:vercel/next.js"
        );
        assert_eq!(normalize_add_spec("npm:next").unwrap(), "npm:next");
        assert!(normalize_add_spec("lodash").is_err());
    }

    #[test]
    fn normalize_interactive_assumes_npm() {
        assert_eq!(normalize_add_spec_interactive("lodash"), "npm:lodash");
        assert_eq!(
            normalize_add_spec_interactive("@mastra/client-js"),
            "npm:@mastra/client-js"
        );
        assert_eq!(
            normalize_add_spec_interactive("vercel/next.js"),
            "github:vercel/next.js"
        );
        assert_eq!(
            normalize_add_spec_interactive("github:o/r@v1"),
            "github:o/r@v1"
        );
    }

    #[test]
    fn read_project_deps_dedups_sorts_excludes_registered() {
        let pkg = serde_json::json!({
            "dependencies": { "react": "18", "zod": "3" },
            "devDependencies": { "vite": "5", "react": "18" }
        });
        let existing = vec!["npm:react".to_string()];
        assert_eq!(read_project_deps(&pkg, &existing), vec!["vite", "zod"]);
    }

    #[test]
    fn read_project_deps_empty() {
        let pkg = serde_json::json!({});
        assert!(read_project_deps(&pkg, &[]).is_empty());
    }

    fn write_ask_json_raw(dir: &Path, body: &str) {
        std::fs::write(dir.join("ask.json"), body).unwrap();
    }

    #[test]
    fn run_add_clear_docs_paths_writes_bare_string() {
        let proj = tempfile::tempdir().unwrap();
        write_ask_json_raw(
            proj.path(),
            r#"{"libraries":[{"spec":"npm:react","docsPaths":["docs"]}]}"#,
        );
        let no_install = |_: &Path, _: &[String]| -> anyhow::Result<()> { Ok(()) };
        let deps = RunAddDeps {
            installer: Some(&no_install),
            ..Default::default()
        };
        let opts = RunAddOptions {
            project_dir: proj.path().to_path_buf(),
            spec: "npm:react".into(),
            docs_paths_arg: None,
            clear_docs_paths: true,
        };
        run_add(&MockClient::new(), &opts, &deps).unwrap();
        let written = std::fs::read_to_string(proj.path().join("ask.json")).unwrap();
        assert!(written.contains("\"npm:react\""));
        assert!(!written.contains("docsPaths"));
    }

    #[test]
    fn run_add_docs_paths_csv_persists_object_and_warns_unsafe() {
        let proj = tempfile::tempdir().unwrap();
        let no_install = |_: &Path, _: &[String]| -> anyhow::Result<()> { Ok(()) };
        let deps = RunAddDeps {
            installer: Some(&no_install),
            ..Default::default()
        };
        let opts = RunAddOptions {
            project_dir: proj.path().to_path_buf(),
            spec: "npm:react".into(),
            docs_paths_arg: Some("docs, ../evil ,api".into()),
            clear_docs_paths: false,
        };
        let report = run_add(&MockClient::new(), &opts, &deps).unwrap();
        let written = std::fs::read_to_string(proj.path().join("ask.json")).unwrap();
        assert!(written.contains("docsPaths"));
        assert!(written.contains("\"docs\""));
        assert!(written.contains("\"api\""));
        assert!(!written.contains("evil"));
        assert!(report.stderr.iter().any(|m| m.contains("unsafe docs-path")));
    }

    #[test]
    fn run_add_bare_owner_repo_normalizes_to_github() {
        let proj = tempfile::tempdir().unwrap();
        let captured = std::cell::RefCell::new(Vec::new());
        let capture = |_: &Path, specs: &[String]| -> anyhow::Result<()> {
            captured.borrow_mut().extend_from_slice(specs);
            Ok(())
        };
        let deps = RunAddDeps {
            installer: Some(&capture),
            ..Default::default()
        };
        let opts = RunAddOptions {
            project_dir: proj.path().to_path_buf(),
            spec: "vercel/next.js".into(),
            docs_paths_arg: None,
            clear_docs_paths: false,
        };
        run_add(&MockClient::new(), &opts, &deps).unwrap();
        assert_eq!(captured.borrow().as_slice(), ["github:vercel/next.js"]);
        let written = std::fs::read_to_string(proj.path().join("ask.json")).unwrap();
        assert!(written.contains("github:vercel/next.js"));
    }

    #[test]
    fn interactive_requires_tty() {
        let proj = tempfile::tempdir().unwrap();
        let no_tty = || false;
        let deps = RunInteractiveDeps {
            is_tty: Some(&no_tty),
            ..Default::default()
        };
        let report = run_interactive_add(&MockClient::new(), proj.path(), &deps).unwrap();
        assert_eq!(report.exit_code, 1);
        assert!(report.stderr[0].contains("requires a TTY"));
    }

    #[test]
    fn interactive_no_package_json() {
        let proj = tempfile::tempdir().unwrap();
        let tty = || true;
        let deps = RunInteractiveDeps {
            is_tty: Some(&tty),
            ..Default::default()
        };
        let report = run_interactive_add(&MockClient::new(), proj.path(), &deps).unwrap();
        assert_eq!(report.exit_code, 0);
        assert!(report.stderr.iter().any(|m| m.contains("No package.json")));
    }

    #[test]
    fn interactive_selects_and_installs_npm_specs() {
        let proj = tempfile::tempdir().unwrap();
        std::fs::write(
            proj.path().join("package.json"),
            r#"{"dependencies":{"lodash":"4"}}"#,
        )
        .unwrap();
        let tty = || true;
        // MockClient returns nothing → registry lookups miss → all unregistered.
        let pick = |_: &str, opts: &[PromptOption]| -> Vec<String> {
            opts.iter().map(|o| o.value.clone()).collect()
        };
        let no_text = |_: &str, _: &str| -> String { String::new() };
        let captured = std::cell::RefCell::new(Vec::new());
        let capture = |_: &Path, specs: &[String]| -> anyhow::Result<()> {
            captured.borrow_mut().extend_from_slice(specs);
            Ok(())
        };
        let deps = RunInteractiveDeps {
            is_tty: Some(&tty),
            multiselect: Some(&pick),
            text: Some(&no_text),
            installer: Some(&capture),
        };
        let report = run_interactive_add(&MockClient::new(), proj.path(), &deps).unwrap();
        assert_eq!(report.exit_code, 0);
        assert_eq!(captured.borrow().as_slice(), ["npm:lodash"]);
        let written = std::fs::read_to_string(proj.path().join("ask.json")).unwrap();
        assert!(written.contains("npm:lodash"));
    }
}
