//! Detect which coding agents a project targets, by the presence of their
//! marker directory. Rust port of `skills/agent-detect.ts`.

use std::path::{Path, PathBuf};

/// A resolved agent install target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTarget {
    /// Stable identifier used in the lock file, e.g. `claude`.
    pub name: String,
    /// Human label shown in prompts, e.g. `Claude Code`.
    pub label: String,
    /// Marker directory whose presence enables this agent (absolute).
    pub marker_dir: PathBuf,
    /// Absolute path where `skills/<skill-name>` symlinks are created.
    pub skills_dir: PathBuf,
}

/// Static agent registry: (name, label, marker dir, skills-dir relative path).
const AGENTS: &[(&str, &str, &str, &str)] = &[
    ("claude", "Claude Code", ".claude", ".claude/skills"),
    ("cursor", "Cursor", ".cursor", ".cursor/skills"),
    ("opencode", "OpenCode", ".opencode", ".opencode/skills"),
    ("codex", "Codex", ".codex", ".codex/skills"),
];

fn target_for(
    project_dir: &Path,
    name: &str,
    label: &str,
    marker: &str,
    skills_rel: &str,
) -> AgentTarget {
    AgentTarget {
        name: name.to_string(),
        label: label.to_string(),
        marker_dir: project_dir.join(marker),
        skills_dir: project_dir.join(skills_rel),
    }
}

/// Every supported agent whose marker directory is present under `project_dir`.
/// `AGENTS.md` alone is NOT an agent (it is a cross-agent convention file).
pub fn detect_agents(project_dir: &Path) -> Vec<AgentTarget> {
    AGENTS
        .iter()
        .filter(|(_, _, marker, _)| project_dir.join(marker).exists())
        .map(|(name, label, marker, skills_rel)| {
            target_for(project_dir, name, label, marker, skills_rel)
        })
        .collect()
}

/// Resolve a user-supplied `--agent` list into targets WITHOUT requiring the
/// marker dir to exist. Unknown names error (loud failure over silently
/// installing into an unintended location). Parity with `resolveAgentNames`.
pub fn resolve_agent_names(
    project_dir: &Path,
    names: &[String],
) -> anyhow::Result<Vec<AgentTarget>> {
    names
        .iter()
        .map(|name| {
            AGENTS
                .iter()
                .find(|(n, _, _, _)| *n == name)
                .map(|(n, label, marker, skills_rel)| {
                    target_for(project_dir, n, label, marker, skills_rel)
                })
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "unknown agent '{name}'. Supported: {}",
                        supported_agents().join(", ")
                    )
                })
        })
        .collect()
}

/// The supported agent identifiers, in registry order.
pub fn supported_agents() -> Vec<&'static str> {
    AGENTS.iter().map(|(n, _, _, _)| *n).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_only_present_markers() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".claude")).unwrap();
        std::fs::create_dir_all(dir.path().join(".cursor")).unwrap();
        let found = detect_agents(dir.path());
        let names: Vec<&str> = found.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["claude", "cursor"]);
        assert_eq!(found[0].skills_dir, dir.path().join(".claude/skills"));
    }

    #[test]
    fn resolve_names_does_not_require_marker() {
        let dir = tempfile::tempdir().unwrap();
        let got = resolve_agent_names(dir.path(), &["codex".to_string()]).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "codex");
        assert_eq!(got[0].skills_dir, dir.path().join(".codex/skills"));
    }

    #[test]
    fn resolve_unknown_name_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_agent_names(dir.path(), &["bogus".to_string()]).is_err());
    }

    #[test]
    fn supported_agents_order() {
        assert_eq!(
            supported_agents(),
            vec!["claude", "cursor", "opencode", "codex"]
        );
    }
}
