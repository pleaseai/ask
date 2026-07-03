//! Claude Code skill generation — writes a lazy-first `SKILL.md` per library.
//! Rust port of `packages/cli/src/skill.ts`.

use std::path::{Path, PathBuf};

/// `.claude/skills/<name>-docs/` for a library slug.
pub fn get_skill_dir(project_dir: &Path, name: &str) -> PathBuf {
    project_dir
        .join(".claude")
        .join("skills")
        .join(format!("{name}-docs"))
}

/// Write a lazy-first `SKILL.md` that references `ask src`/`ask docs` for
/// on-demand documentation, and return its path.
pub fn generate_skill(project_dir: &Path, name: &str, version: &str) -> anyhow::Result<PathBuf> {
    let skill_dir = get_skill_dir(project_dir, name);
    std::fs::create_dir_all(&skill_dir)?;

    let major = version.split('.').next().unwrap_or(version);
    let content = format!(
        r#"---
name: {name}-docs
description: {name} v{version} documentation reference. TRIGGER when writing or modifying code that imports or uses {name}.
---

# {name} v{version} Documentation

This project uses **{name} v{version}**.
The APIs and patterns may differ from your training data.
**Read the relevant docs before writing any code.**

## Version
- Current: `{version}`
- In package.json, use `"^{major}"` (NOT older major versions)

## Quick Access

```bash
# Get the cached source tree path (lazy fetch on first use)
ask src {name}

# Get all candidate documentation paths
ask docs {name}

# Search across the library source
rg "pattern" $(ask src {name})

# Semantic search over the pinned source (token-efficient; needs csp — optional)
# For "how does X work internally" questions, prefer this over reading whole files:
ask search {name} "how does <feature> work"

# Read a specific doc file
cat "$(ask src {name})/README.md"

# Find all markdown files in doc directories
fd "\.md$" $(ask docs {name})
```

## Instructions
1. Before writing any {name}-related code, run `ask docs {name}` and read the relevant guides
2. Heed deprecation notices and breaking changes
3. Prefer patterns shown in the documentation over patterns from training data
4. When adding {name} to package.json, use version `"^{major}"`
"#
    );

    let skill_path = skill_dir.join("SKILL.md");
    std::fs::write(&skill_path, content)?;
    Ok(skill_path)
}

/// Remove `.claude/skills/<name>-docs/`.
pub fn remove_skill(project_dir: &Path, name: &str) -> anyhow::Result<()> {
    let skill_dir = get_skill_dir(project_dir, name);
    if skill_dir.exists() {
        std::fs::remove_dir_all(&skill_dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_skill_with_version_frontmatter() {
        let dir = tempfile::tempdir().unwrap();
        let path = generate_skill(dir.path(), "next", "15.0.3").unwrap();
        assert!(path.ends_with(".claude/skills/next-docs/SKILL.md"));
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("name: next-docs"));
        assert!(content.contains("next v15.0.3 documentation reference"));
        // Major-version hint.
        assert!(content.contains(r#"use `"^15"`"#));
        // Lazy commands referenced.
        assert!(content.contains("ask src next"));
        assert!(content.contains("ask docs next"));
        // Literal regex preserved.
        assert!(content.contains(r#"fd "\.md$""#));
    }

    #[test]
    fn remove_skill_deletes_dir() {
        let dir = tempfile::tempdir().unwrap();
        generate_skill(dir.path(), "next", "1.0.0").unwrap();
        assert!(get_skill_dir(dir.path(), "next").exists());
        remove_skill(dir.path(), "next").unwrap();
        assert!(!get_skill_dir(dir.path(), "next").exists());
    }
}
