//! `ask search <spec> <query>` — semantic code search over a version-pinned
//! checkout, delegating to the optional `csp` binary. Rust port of
//! `commands/search.ts`.
//!
//! Acquisition (ensure_checkout) feeds retrieval (csp). csp is optional: when it
//! is absent, ask prints the resolved checkout path plus a copy-pasteable recipe
//! and exits 0 — it never fails solely because csp is missing.

use std::path::PathBuf;

use crate::commands::ensure_checkout::{
    ensure_checkout, EnsureCheckoutDeps, EnsureCheckoutOptions,
};
use crate::http::HttpClient;

/// Options for [`run_search`].
#[derive(Debug, Clone)]
pub struct RunSearchOptions {
    pub spec: String,
    pub query: String,
    pub project_dir: PathBuf,
    pub no_fetch: bool,
    /// Maps to csp `--content` (repeatable: code | docs | config | all).
    pub content: Vec<String>,
    /// Maps to csp `--top-k`.
    pub top_k: Option<u64>,
}

/// Outcome of running csp — status is the normal exit code; signal is set when
/// the child was terminated by a signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CspRunResult {
    pub status: Option<i32>,
    pub signal: Option<i32>,
}

/// Map a csp result to a process exit code. A normal exit forwards `status`; a
/// signal-terminated child forwards the shell convention `128 + signum` so a
/// crashed csp is not reported as success; a truly-empty result falls back to 0.
pub fn csp_exit_code(result: &CspRunResult) -> i32 {
    if let Some(status) = result.status {
        return status;
    }
    if let Some(signal) = result.signal {
        return 128 + signal;
    }
    0
}

/// True when `token` is safe to print bare in a shell recipe.
fn is_shell_safe(token: &str) -> bool {
    !token.is_empty()
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.:/@%+=-".contains(c))
}

/// POSIX-shell-quote a recipe token so the printed csp command is copy-paste
/// safe. Display-only — the real csp call passes an argv array, never a shell.
fn shell_quote(token: &str) -> String {
    if is_shell_safe(token) {
        token.to_string()
    } else {
        format!("'{}'", token.replace('\'', r"'\''"))
    }
}

/// Build the csp argv: `search <query> <checkoutDir>` with the path as a
/// POSITIONAL after the query, one `--content <value>` per selection, and
/// `--top-k <n>` when set.
pub fn build_csp_args(
    query: &str,
    checkout_dir: &str,
    content: &[String],
    top_k: Option<u64>,
) -> Vec<String> {
    let mut args = vec![
        "search".to_string(),
        query.to_string(),
        checkout_dir.to_string(),
    ];
    for c in content {
        args.push("--content".to_string());
        args.push(c.clone());
    }
    if let Some(k) = top_k {
        args.push("--top-k".to_string());
        args.push(k.to_string());
    }
    args
}

/// What [`run_search`] produces: lines for stdout/stderr and the exit code the
/// CLI should terminate with. When csp runs, it streams through inherited stdio
/// so its output is NOT in `stdout` — only ask-level messages are.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SearchReport {
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
    pub exit_code: i32,
}

/// Test/production seams for [`run_search`].
pub struct SearchDeps<'a> {
    pub checkout: EnsureCheckoutDeps<'a>,
    /// Locate csp (default: [`resolve_csp_default`]).
    pub resolve_csp: &'a dyn Fn() -> Option<String>,
    /// Run csp (default: spawn with inherited stdio).
    pub run_csp: &'a dyn Fn(&str, &[String]) -> anyhow::Result<CspRunResult>,
}

/// Resolve the spec to a checkout and delegate the query to csp.
pub fn run_search(
    client: &dyn HttpClient,
    options: &RunSearchOptions,
    deps: &SearchDeps,
) -> SearchReport {
    let mut report = SearchReport::default();

    let result = match ensure_checkout(
        client,
        &EnsureCheckoutOptions {
            spec: options.spec.clone(),
            project_dir: options.project_dir.clone(),
            no_fetch: options.no_fetch,
        },
        &deps.checkout,
    ) {
        Ok(r) => r,
        Err(err) => {
            report.stderr.push(format!("{err}"));
            report.exit_code = 1;
            return report;
        }
    };

    let checkout_dir = result.checkout_dir.to_string_lossy().into_owned();
    let csp_args = build_csp_args(
        &options.query,
        &checkout_dir,
        &options.content,
        options.top_k,
    );

    let Some(csp) = (deps.resolve_csp)() else {
        // Graceful degradation: no csp → path + runnable recipe, exit 0.
        let mut recipe = String::from("csp");
        for a in &csp_args {
            recipe.push(' ');
            recipe.push_str(&shell_quote(a));
        }
        report.stderr.push(
            "ask: csp (code-search) not found on PATH or $CSP_BIN — printing checkout path + recipe."
                .to_string(),
        );
        report.stdout.push(checkout_dir);
        report.stdout.push(recipe);
        report.exit_code = 0;
        return report;
    };

    match (deps.run_csp)(&csp, &csp_args) {
        Ok(res) => report.exit_code = csp_exit_code(&res),
        Err(err) => {
            report
                .stderr
                .push(format!("ask: failed to run csp ({csp}): {err}"));
            report.exit_code = 1;
        }
    }
    report
}

/// Production csp runner: spawn with inherited stdio and capture status/signal.
pub fn spawn_csp(bin: &str, args: &[String]) -> anyhow::Result<CspRunResult> {
    use std::process::Command;
    let status = Command::new(bin).args(args).status()?;
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal = None;
    Ok(CspRunResult {
        status: status.code(),
        signal,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;
    use crate::store::github_store_path;

    #[test]
    fn csp_exit_code_forwards_status_signal_or_zero() {
        assert_eq!(
            csp_exit_code(&CspRunResult {
                status: Some(3),
                signal: None
            }),
            3
        );
        assert_eq!(
            csp_exit_code(&CspRunResult {
                status: None,
                signal: Some(9)
            }),
            137
        );
        assert_eq!(
            csp_exit_code(&CspRunResult {
                status: None,
                signal: None
            }),
            0
        );
    }

    #[test]
    fn shell_quote_bare_and_quoted() {
        assert_eq!(shell_quote("react"), "react");
        assert_eq!(shell_quote("a/b:c@1.0"), "a/b:c@1.0");
        assert_eq!(shell_quote("hello world"), "'hello world'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn build_csp_args_shape() {
        let args = build_csp_args("q", "/co", &["docs".into(), "code".into()], Some(5));
        assert_eq!(
            args,
            vec![
                "search",
                "q",
                "/co",
                "--content",
                "docs",
                "--content",
                "code",
                "--top-k",
                "5"
            ]
        );
    }

    fn warmed() -> (tempfile::TempDir, tempfile::TempDir, PathBuf) {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let dir = github_store_path(home.path(), "github.com", "o", "r", "v1.0.0").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        (home, proj, dir)
    }

    fn opts(project_dir: &std::path::Path) -> RunSearchOptions {
        RunSearchOptions {
            spec: "github:o/r@v1.0.0".into(),
            query: "hooks".into(),
            project_dir: project_dir.to_path_buf(),
            no_fetch: false,
            content: vec![],
            top_k: None,
        }
    }

    #[test]
    fn no_csp_prints_path_and_recipe_exit_zero() {
        let (home, proj, dir) = warmed();
        let no_csp = || None;
        let never_run = |_: &str, _: &[String]| -> anyhow::Result<CspRunResult> {
            panic!("csp must not run when absent")
        };
        let deps = SearchDeps {
            checkout: EnsureCheckoutDeps {
                ask_home: Some(home.path().to_path_buf()),
                fetcher: None,
            },
            resolve_csp: &no_csp,
            run_csp: &never_run,
        };
        let report = run_search(&MockClient::new(), &opts(proj.path()), &deps);
        assert_eq!(report.exit_code, 0);
        assert_eq!(report.stdout[0], dir.to_string_lossy());
        assert!(report.stdout[1].starts_with("csp search hooks "));
        assert!(report.stderr[0].contains("not found"));
    }

    #[test]
    fn csp_present_forwards_exit_code() {
        let (home, proj, _dir) = warmed();
        let have_csp = || Some("/bin/csp".to_string());
        let run = |_: &str, _: &[String]| -> anyhow::Result<CspRunResult> {
            Ok(CspRunResult {
                status: Some(2),
                signal: None,
            })
        };
        let deps = SearchDeps {
            checkout: EnsureCheckoutDeps {
                ask_home: Some(home.path().to_path_buf()),
                fetcher: None,
            },
            resolve_csp: &have_csp,
            run_csp: &run,
        };
        let report = run_search(&MockClient::new(), &opts(proj.path()), &deps);
        assert_eq!(report.exit_code, 2);
        assert!(report.stdout.is_empty());
    }

    #[test]
    fn csp_spawn_failure_exit_one() {
        let (home, proj, _dir) = warmed();
        let have_csp = || Some("/bin/csp".to_string());
        let run =
            |_: &str, _: &[String]| -> anyhow::Result<CspRunResult> { anyhow::bail!("ENOEXEC") };
        let deps = SearchDeps {
            checkout: EnsureCheckoutDeps {
                ask_home: Some(home.path().to_path_buf()),
                fetcher: None,
            },
            resolve_csp: &have_csp,
            run_csp: &run,
        };
        let report = run_search(&MockClient::new(), &opts(proj.path()), &deps);
        assert_eq!(report.exit_code, 1);
        assert!(report.stderr[0].contains("failed to run csp"));
    }

    #[test]
    fn no_cache_error_exit_one() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let no_csp = || None;
        let never_run =
            |_: &str, _: &[String]| -> anyhow::Result<CspRunResult> { panic!("unreachable") };
        let deps = SearchDeps {
            checkout: EnsureCheckoutDeps {
                ask_home: Some(home.path().to_path_buf()),
                fetcher: None,
            },
            resolve_csp: &no_csp,
            run_csp: &never_run,
        };
        let mut o = opts(proj.path());
        o.no_fetch = true; // miss + no_fetch → NoCacheError
        let report = run_search(&MockClient::new(), &o, &deps);
        assert_eq!(report.exit_code, 1);
        assert!(report.stderr[0].contains("no cached checkout"));
    }
}
