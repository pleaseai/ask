//! `AGENTS.md` generation — maintains the `<!-- BEGIN:ask-docs-auto-generated -->`
//! block and a `@AGENTS.md` reference in `CLAUDE.md`. Rust port of `agents.ts`.

use std::path::Path;

const BEGIN_MARKER: &str = "<!-- BEGIN:ask-docs-auto-generated -->";
const END_MARKER: &str = "<!-- END:ask-docs-auto-generated -->";

/// A library to render into the AGENTS.md docs block.
#[derive(Debug, Clone)]
pub struct LazyLibraryInfo {
    pub name: String,
    pub version: String,
    pub spec: String,
}

/// Regenerate the ask-docs block in `AGENTS.md`. With no libraries, strips a
/// previously generated block (removing the file if it becomes empty). Returns
/// the AGENTS.md path (empty string when the file was left absent/untouched).
pub fn generate_agents_md(project_dir: &Path, libraries: &[LazyLibraryInfo]) -> String {
    let agents_path = project_dir.join("AGENTS.md");

    if libraries.is_empty() {
        strip_block(project_dir, &agents_path);
        return String::new();
    }

    let sections: Vec<String> = libraries
        .iter()
        .map(|lib| {
            let major = lib.version.split('.').next().unwrap_or(&lib.version);
            let name = &lib.name;
            let version = &lib.version;
            format!(
                "## {name} v{version}\n\n\
                 > **WARNING:** This version may differ from your training data.\n\
                 > Use `ask docs {name}` to read the documentation before writing any {name}-related code.\n\
                 > Heed deprecation notices and breaking changes.\n\n\
                 - **Version**: `{version}` — use `\"^{major}\"` in package.json (NOT older major versions)\n\
                 - **Docs**: `ask docs {name}` — prints documentation paths (lazy fetch on first use)\n\
                 - **Source**: `ask src {name}` — prints the cached source tree path"
            )
        })
        .collect();

    let generated_block = format!(
        "{BEGIN_MARKER}\n\
         # Documentation References\n\n\
         The libraries in this project may have APIs and patterns that differ from your training data.\n\
         **Always read the relevant documentation before writing code.**\n\n\
         ## Accessing Library Documentation\n\n\
         Use the lazy commands `ask src <package>` and `ask docs <package>` to access\n\
         documentation on-demand. They print absolute paths to the cached source tree\n\
         (and any `*doc*` directories), with automatic fetch on cache miss:\n\n\
         ```bash\n\
         rg \"pattern\" $(ask src <package>)\n\
         cat \"$(ask src <package>)/README.md\"\n\
         fd \"\\.md$\" \"$(ask docs <package> | head -n 1)\"\n\
         ```\n\n\
         {}\n\
         {END_MARKER}",
        sections.join("\n\n")
    );

    if let Ok(existing) = std::fs::read_to_string(&agents_path) {
        match (existing.find(BEGIN_MARKER), existing.find(END_MARKER)) {
            (Some(begin), Some(end)) => {
                let updated = format!(
                    "{}{generated_block}{}",
                    &existing[..begin],
                    &existing[end + END_MARKER.len()..]
                );
                let _ = std::fs::write(&agents_path, updated);
            }
            _ => {
                let _ = std::fs::write(
                    &agents_path,
                    format!("{}\n\n{generated_block}\n", existing.trim_end()),
                );
            }
        }
    } else {
        let _ = std::fs::write(&agents_path, format!("{generated_block}\n"));
    }

    update_claude_md(project_dir);
    agents_path.to_string_lossy().into_owned()
}

/// Strip a previously generated block for the empty-libraries case.
fn strip_block(project_dir: &Path, agents_path: &Path) {
    let Ok(existing) = std::fs::read_to_string(agents_path) else {
        return;
    };
    match (existing.find(BEGIN_MARKER), existing.find(END_MARKER)) {
        (Some(begin), Some(end)) => {
            let head = existing[..begin].trim_end_matches('\n');
            let tail = existing[end + END_MARKER.len()..].trim_start_matches('\n');
            let stripped = if head.is_empty() {
                tail.to_string()
            } else if tail.is_empty() {
                format!("{head}\n")
            } else {
                format!("{head}\n\n{tail}")
            };
            if stripped.is_empty() {
                let _ = std::fs::remove_file(agents_path);
            } else {
                let _ = std::fs::write(agents_path, stripped);
            }
        }
        (Some(_), None) | (None, Some(_)) => {
            // Unmatched marker — likely hand-edited/truncated. Leave it for the
            // user to repair rather than emitting further corruption.
            let rel = agents_path.strip_prefix(project_dir).unwrap_or(agents_path);
            eprintln!(
                "  Warning: {} has an unmatched ask-docs marker — leaving file untouched. Inspect \
                 manually to restore the BEGIN/END pair.",
                rel.display()
            );
        }
        (None, None) => {}
    }
}

/// Ensure `CLAUDE.md` references `@AGENTS.md`.
fn update_claude_md(project_dir: &Path) {
    let claude_path = project_dir.join("CLAUDE.md");
    let claude_ref = "@AGENTS.md";
    match std::fs::read_to_string(&claude_path) {
        Ok(content) if content.contains(claude_ref) => {}
        Ok(content) => {
            let _ = std::fs::write(
                &claude_path,
                format!("{}\n{claude_ref}\n", content.trim_end()),
            );
        }
        Err(_) => {
            let _ = std::fs::write(&claude_path, format!("{claude_ref}\n"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib(name: &str, version: &str) -> LazyLibraryInfo {
        LazyLibraryInfo {
            name: name.into(),
            version: version.into(),
            spec: format!("npm:{name}"),
        }
    }

    #[test]
    fn generates_block_and_claude_ref() {
        let dir = tempfile::tempdir().unwrap();
        let path = generate_agents_md(dir.path(), &[lib("next", "15.0.3")]);
        assert!(!path.is_empty());
        let content = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert!(content.starts_with(BEGIN_MARKER));
        assert!(content.contains("## next v15.0.3"));
        assert!(content.contains(r#"use `"^15"`"#));
        assert!(content.trim_end().ends_with(END_MARKER));
        // CLAUDE.md gets the reference.
        assert_eq!(
            std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap(),
            "@AGENTS.md\n"
        );
    }

    #[test]
    fn replaces_existing_block_preserving_surrounding_text() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("AGENTS.md"),
            format!("# My Project\n\nIntro.\n\n{BEGIN_MARKER}\nold\n{END_MARKER}\n\n## Footer\n"),
        )
        .unwrap();
        generate_agents_md(dir.path(), &[lib("vue", "3.4.0")]);
        let content = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert!(content.starts_with("# My Project"));
        assert!(content.contains("## Footer"));
        assert!(content.contains("## vue v3.4.0"));
        assert!(!content.contains("\nold\n"));
    }

    #[test]
    fn appends_block_when_no_markers_present() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "# Existing\n").unwrap();
        generate_agents_md(dir.path(), &[lib("next", "1.0.0")]);
        let content = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert!(content.starts_with("# Existing"));
        assert!(content.contains(BEGIN_MARKER));
    }

    #[test]
    fn empty_libraries_strips_block() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("AGENTS.md"),
            format!("# Head\n\n{BEGIN_MARKER}\nx\n{END_MARKER}\n\n## Tail\n"),
        )
        .unwrap();
        let result = generate_agents_md(dir.path(), &[]);
        assert_eq!(result, "");
        let content = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert_eq!(content, "# Head\n\n## Tail\n");
        assert!(!content.contains(BEGIN_MARKER));
    }

    #[test]
    fn empty_libraries_removes_file_when_block_was_all() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("AGENTS.md"),
            format!("{BEGIN_MARKER}\nx\n{END_MARKER}"),
        )
        .unwrap();
        generate_agents_md(dir.path(), &[]);
        assert!(!dir.path().join("AGENTS.md").exists());
    }

    #[test]
    fn does_not_duplicate_claude_ref() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "# Rules\n@AGENTS.md\n").unwrap();
        generate_agents_md(dir.path(), &[lib("next", "1.0.0")]);
        let content = std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap();
        assert_eq!(content.matches("@AGENTS.md").count(), 1);
    }
}
