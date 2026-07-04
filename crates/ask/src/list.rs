//! `ask list` model + renderer. Rust port of `list/{model,aggregate,render}.ts`
//! and `display/table.ts`.
//!
//! The intent-skills tree (per-skill task/load rows) is omitted until
//! agents-intent lands — intent entries currently carry no skills, so the tree
//! section renders empty exactly as in the TS renderer.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::resolved::EntryFormat;
use crate::storage::{list_docs, ListDocsEntry, ListSource};

const EMPTY_MESSAGE: &str = "No libraries declared in ask.json. Use `ask add npm:<pkg>` or `ask add github:<owner>/<repo> --ref <tag>` to get started.";

/// Where a docs entry's files live (JSON: kebab-case).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ListEntrySource {
    PmDriven,
    Github,
    Unresolved,
}

impl From<ListSource> for ListEntrySource {
    fn from(s: ListSource) -> Self {
        match s {
            ListSource::PmDriven => ListEntrySource::PmDriven,
            ListSource::Github => ListEntrySource::Github,
            ListSource::Unresolved => ListEntrySource::Unresolved,
        }
    }
}

/// One row in the list table / JSON array.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ListEntry {
    pub name: String,
    pub version: String,
    pub format: EntryFormat,
    pub source: ListEntrySource,
    pub location: String,
    #[serde(rename = "itemCount")]
    pub item_count: u64,
}

/// A name collision (same name, differing versions).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ListConflict {
    pub name: String,
    pub versions: Vec<String>,
}

/// Full `ask list` model (matches `ListModelSchema`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ListModel {
    pub entries: Vec<ListEntry>,
    pub conflicts: Vec<ListConflict>,
    pub warnings: Vec<String>,
}

/// Read the lock-backed view and shape it into a [`ListModel`].
pub fn build_list_model(project_dir: &Path) -> ListModel {
    let raw = list_docs(project_dir);
    let conflicts = detect_conflicts(&raw);
    let entries = raw
        .into_iter()
        .map(|e| ListEntry {
            name: e.name,
            version: e.version,
            format: e.format,
            source: e.source.into(),
            location: e.location,
            item_count: e.file_count,
        })
        .collect();
    ListModel {
        entries,
        conflicts,
        warnings: Vec::new(),
    }
}

/// Two or more entries sharing a name but differing versions.
fn detect_conflicts(entries: &[ListDocsEntry]) -> Vec<ListConflict> {
    let mut by_name: BTreeMap<String, std::collections::BTreeSet<String>> = BTreeMap::new();
    for e in entries {
        by_name
            .entry(e.name.clone())
            .or_default()
            .insert(e.version.clone());
    }
    by_name
        .into_iter()
        .filter(|(_, versions)| versions.len() >= 2)
        .map(|(name, versions)| ListConflict {
            name,
            versions: versions.into_iter().collect(),
        })
        .collect()
}

/// Render the model as user-facing text (empty message when no entries).
pub fn format_list(model: &ListModel) -> String {
    if model.entries.is_empty() {
        return EMPTY_MESSAGE.to_string();
    }
    let mut sections = vec![format_header(model), format_entry_table(&model.entries)];
    if !model.conflicts.is_empty() {
        sections.push(format_conflicts(model));
    }
    if !model.warnings.is_empty() {
        let mut lines = vec!["Warnings:".to_string()];
        lines.extend(model.warnings.iter().map(|w| format!("  {w}")));
        sections.push(lines.join("\n"));
    }
    sections.join("\n\n")
}

fn format_header(model: &ListModel) -> String {
    let docs = model
        .entries
        .iter()
        .filter(|e| e.format == EntryFormat::Docs)
        .count();
    let intent = model
        .entries
        .iter()
        .filter(|e| e.format == EntryFormat::IntentSkills)
        .count();
    let mut parts = vec![format!(
        "{} {}",
        model.entries.len(),
        if model.entries.len() == 1 {
            "entry"
        } else {
            "entries"
        }
    )];
    if docs > 0 {
        parts.push(format!("{docs} docs"));
    }
    if intent > 0 {
        parts.push(format!("{intent} intent-skills"));
    }
    format!("Downloaded documentation: {}", parts.join(", "))
}

fn format_entry_table(entries: &[ListEntry]) -> String {
    let headers = ["Name", "Version", "Format", "Source", "Items", "Location"];
    let rows: Vec<Vec<String>> = entries
        .iter()
        .map(|e| {
            vec![
                e.name.clone(),
                e.version.clone(),
                format_enum(&e.format),
                source_str(e.source).to_string(),
                e.item_count.to_string(),
                e.location.clone(),
            ]
        })
        .collect();
    format_table(&headers, &rows)
}

fn format_conflicts(model: &ListModel) -> String {
    let mut lines = vec!["Conflicts:".to_string()];
    for c in &model.conflicts {
        lines.push(format!("  {}: {}", c.name, c.versions.join(", ")));
    }
    lines.join("\n")
}

fn format_enum(f: &EntryFormat) -> String {
    match f {
        EntryFormat::Docs => "docs".into(),
        EntryFormat::IntentSkills => "intent-skills".into(),
    }
}

fn source_str(s: ListEntrySource) -> &'static str {
    match s {
        ListEntrySource::PmDriven => "pm-driven",
        ListEntrySource::Github => "github",
        ListEntrySource::Unresolved => "unresolved",
    }
}

/// Column width = max(header, longest cell) + 2; a U+2500 line under the header.
fn format_table(headers: &[&str], rows: &[Vec<String>]) -> String {
    if headers.is_empty() {
        return String::new();
    }
    let widths: Vec<usize> = headers
        .iter()
        .enumerate()
        .map(|(i, h)| {
            let max_cell = rows
                .iter()
                .map(|r| r.get(i).map(|c| char_len(c)).unwrap_or(0))
                .max()
                .unwrap_or(0);
            char_len(h).max(max_cell) + 2
        })
        .collect();

    let mut lines = Vec::new();
    lines.push(
        headers
            .iter()
            .enumerate()
            .map(|(i, h)| pad_column(h, widths[i]))
            .collect::<String>(),
    );
    lines.push(widths.iter().map(|w| "─".repeat(*w)).collect::<String>());
    for row in rows {
        lines.push(
            row.iter()
                .enumerate()
                .map(|(i, c)| pad_column(c, widths[i]))
                .collect::<String>(),
        );
    }
    lines.join("\n")
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

fn pad_column(text: &str, width: usize) -> String {
    let len = char_len(text);
    if len >= width {
        format!("{text}  ")
    } else {
        format!("{text}{}", " ".repeat(width - len))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(project: &Path, ask: &str, resolved: Option<&str>) {
        std::fs::create_dir_all(crate::io::get_ask_dir(project)).unwrap();
        std::fs::write(crate::io::get_ask_json_path(project), ask).unwrap();
        if let Some(r) = resolved {
            std::fs::write(crate::io::get_resolved_json_path(project), r).unwrap();
        }
    }

    #[test]
    fn empty_model_renders_message() {
        let dir = tempfile::tempdir().unwrap();
        let model = build_list_model(dir.path());
        assert!(model.entries.is_empty());
        assert_eq!(format_list(&model), EMPTY_MESSAGE);
    }

    #[test]
    fn table_and_header_render() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            r#"{"libraries":["npm:acme","github:o/other"]}"#,
            Some(
                r#"{"schemaVersion":1,"generatedAt":"2026-01-01T00:00:00Z","entries":{
                  "acme":{"spec":"npm:acme","resolvedVersion":"1.2.3",
                    "contentHash":"sha256-0000000000000000000000000000000000000000000000000000000000000000",
                    "fetchedAt":"2026-01-01T00:00:00Z","fileCount":3}}}"#,
            ),
        );
        let model = build_list_model(dir.path());
        let text = format_list(&model);
        // Both rows carry format `docs` (an unresolved entry still reports docs).
        assert!(text.starts_with("Downloaded documentation: 2 entries, 2 docs"));
        assert!(text.contains("Name"));
        assert!(text.contains("acme"));
        assert!(text.contains("unresolved"));
        // Separator line uses U+2500.
        assert!(text.contains('─'));
    }

    #[test]
    fn json_serialization_uses_schema_field_names() {
        let model = ListModel {
            entries: vec![ListEntry {
                name: "acme".into(),
                version: "1.0.0".into(),
                format: EntryFormat::Docs,
                source: ListEntrySource::PmDriven,
                location: ".ask/docs/acme@1.0.0".into(),
                item_count: 5,
            }],
            conflicts: vec![],
            warnings: vec![],
        };
        let json = serde_json::to_string(&model).unwrap();
        assert!(json.contains(r#""itemCount":5"#));
        assert!(json.contains(r#""format":"docs""#));
        assert!(json.contains(r#""source":"pm-driven""#));
    }

    #[test]
    fn detects_version_conflicts() {
        let raw = vec![
            ListDocsEntry {
                name: "acme".into(),
                version: "1.0.0".into(),
                format: EntryFormat::Docs,
                source: ListSource::PmDriven,
                spec: "npm:acme".into(),
                location: "x".into(),
                file_count: 1,
            },
            ListDocsEntry {
                name: "acme".into(),
                version: "2.0.0".into(),
                format: EntryFormat::Docs,
                source: ListSource::Github,
                spec: "github:o/acme".into(),
                location: "y".into(),
                file_count: 1,
            },
        ];
        let conflicts = detect_conflicts(&raw);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].versions, vec!["1.0.0", "2.0.0"]);
    }
}
