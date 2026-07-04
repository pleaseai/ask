//! Locate the optional `csp` (code-search) binary for `ask search`. Rust port
//! of `commands/resolve-csp.ts`.
//!
//! ask spawns csp as a separate process (the contract is a path, not an
//! in-process API) and csp is OPTIONAL — ask must never fail solely because csp
//! is absent. Resolution order: `CSP_BIN` env override → `csp` on `PATH` → None.

use std::path::{Path, PathBuf};

/// Windows extensions that need a shell interpreter — `ask search` spawns csp
/// without a shell, so these are never resolvable.
const SHELL_ONLY_EXTS: &[&str] = &[".cmd", ".bat", ".ps1"];

/// Environment inputs for [`resolve_csp`], injectable for tests.
pub struct CspEnv<'a> {
    pub csp_bin: Option<String>,
    pub path: Option<String>,
    pub pathext: Option<String>,
    pub is_win: bool,
    /// Returns true when `p` exists and is executable.
    pub is_executable: &'a dyn Fn(&Path) -> bool,
}

/// Locate csp. `CSP_BIN` wins with no existence probe (let the spawn fail loudly
/// if bogus); otherwise scan `PATH`, honouring `PATHEXT` on Windows and the
/// executable bit on POSIX.
pub fn resolve_csp(env: &CspEnv) -> Option<String> {
    // 1. Explicit override wins, no probe.
    if let Some(override_) = env
        .csp_bin
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return Some(override_.to_string());
    }

    // 2. PATH scan.
    let path_var = env.path.as_deref().unwrap_or("");
    if path_var.is_empty() {
        return None;
    }

    // csp is spawned WITHOUT a shell, so probe only shell-free executables and
    // drop `.cmd`/`.bat`/`.ps1` even if the user's PATHEXT lists them.
    let exts: Vec<String> = if env.is_win {
        env.pathext
            .as_deref()
            .unwrap_or(".EXE;.COM")
            .split(';')
            .filter(|e| !e.is_empty())
            .filter(|e| !SHELL_ONLY_EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .map(|e| e.to_string())
            .collect()
    } else {
        vec![String::new()]
    };

    let sep = if env.is_win { ';' } else { ':' };
    for dir in path_var.split(sep) {
        if dir.is_empty() {
            continue;
        }
        for ext in &exts {
            let candidate = PathBuf::from(dir).join(format!("csp{}", ext.to_ascii_lowercase()));
            if (env.is_executable)(&candidate) {
                return Some(candidate.to_string_lossy().into_owned());
            }
            if env.is_win {
                let upper = PathBuf::from(dir).join(format!("csp{}", ext.to_ascii_uppercase()));
                if (env.is_executable)(&upper) {
                    return Some(upper.to_string_lossy().into_owned());
                }
            }
        }
    }

    None
}

/// Real executability probe: exists, is a file, and (on unix) has an exec bit.
pub fn default_is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Production [`CspEnv`] built from the real process environment.
pub fn resolve_csp_default() -> Option<String> {
    let env = CspEnv {
        csp_bin: std::env::var("CSP_BIN").ok(),
        path: std::env::var("PATH")
            .ok()
            .or_else(|| std::env::var("Path").ok()),
        pathext: std::env::var("PATHEXT").ok(),
        is_win: cfg!(windows),
        is_executable: &default_is_executable,
    };
    resolve_csp(&env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csp_bin_override_wins_without_probe() {
        let never = |_: &Path| false;
        let env = CspEnv {
            csp_bin: Some("  /custom/csp  ".into()),
            path: Some("/usr/bin".into()),
            pathext: None,
            is_win: false,
            is_executable: &never,
        };
        assert_eq!(resolve_csp(&env).as_deref(), Some("/custom/csp"));
    }

    #[test]
    fn empty_override_falls_through_to_path() {
        let match_bin = |p: &Path| p == Path::new("/opt/bin/csp");
        let env = CspEnv {
            csp_bin: Some("   ".into()),
            path: Some("/usr/bin:/opt/bin".into()),
            pathext: None,
            is_win: false,
            is_executable: &match_bin,
        };
        assert_eq!(resolve_csp(&env).as_deref(), Some("/opt/bin/csp"));
    }

    #[test]
    fn absent_from_path_returns_none() {
        let never = |_: &Path| false;
        let env = CspEnv {
            csp_bin: None,
            path: Some("/usr/bin:/opt/bin".into()),
            pathext: None,
            is_win: false,
            is_executable: &never,
        };
        assert_eq!(resolve_csp(&env), None);
    }

    #[test]
    fn empty_path_returns_none() {
        let never = |_: &Path| false;
        let env = CspEnv {
            csp_bin: None,
            path: None,
            pathext: None,
            is_win: false,
            is_executable: &never,
        };
        assert_eq!(resolve_csp(&env), None);
    }

    #[test]
    fn windows_drops_shell_only_extensions() {
        // Only csp.cmd exists — a shell shim ask can't spawn — so resolution fails.
        let match_cmd = |p: &Path| p.to_string_lossy().to_lowercase().ends_with("csp.cmd");
        let env = CspEnv {
            csp_bin: None,
            path: Some("C:\\bin".into()),
            pathext: Some(".CMD;.EXE".into()),
            is_win: true,
            is_executable: &match_cmd,
        };
        assert_eq!(resolve_csp(&env), None);
    }
}
