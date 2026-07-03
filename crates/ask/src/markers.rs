//! Marker-block helpers — Rust port of `packages/cli/src/markers.ts`.
//!
//! Injects ASK-owned content into user files without touching the surrounding
//! user content. Two comment syntaxes:
//!   - [`MarkerSyntax::Html`] for Markdown (`<!-- ask:start --> … <!-- ask:end -->`)
//!   - [`MarkerSyntax::Hash`] for ignore/properties files (`# ask:start … # ask:end`)
//!
//! Marker delimiters are ASCII, so `str::find` byte offsets always land on char
//! boundaries even when the wrapped user content is multi-byte UTF-8.

/// Which comment syntax delimits the marker block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkerSyntax {
    Html,
    Hash,
}

impl MarkerSyntax {
    fn begin(self) -> &'static str {
        match self {
            MarkerSyntax::Html => "<!-- ask:start -->",
            MarkerSyntax::Hash => "# ask:start",
        }
    }

    fn end(self) -> &'static str {
        match self {
            MarkerSyntax::Html => "<!-- ask:end -->",
            MarkerSyntax::Hash => "# ask:end",
        }
    }
}

/// Wrap a payload with begin/end markers. No trailing newline (parity with
/// `wrap`).
pub fn wrap(payload: &str, syntax: MarkerSyntax) -> String {
    format!("{}\n{}\n{}", syntax.begin(), payload, syntax.end())
}

/// Locate a well-formed marker block: both delimiters present and `end` after
/// `begin`. Returns the byte offsets `(begin_idx, end_idx)`.
fn locate(content: &str, syntax: MarkerSyntax) -> Option<(usize, usize)> {
    let begin_idx = content.find(syntax.begin())?;
    let end_idx = content.find(syntax.end())?;
    if end_idx > begin_idx {
        Some((begin_idx, end_idx))
    } else {
        None
    }
}

/// Inject or refresh a marker block. If a matching block exists it is replaced
/// in place; otherwise the block is appended with a blank-line separator.
/// Deterministic and idempotent (parity with `inject`).
pub fn inject(content: &str, block: &str, syntax: MarkerSyntax) -> String {
    let end = syntax.end();
    if let Some((begin_idx, end_idx)) = locate(content, syntax) {
        // Replace existing block in place.
        let mut out = String::with_capacity(content.len());
        out.push_str(&content[..begin_idx]);
        out.push_str(block);
        out.push_str(&content[end_idx + end.len()..]);
        return out;
    }

    if content.is_empty() {
        return format!("{block}\n");
    }
    format!("{}\n\n{}\n", content.trim_end(), block)
}

/// Strip the marker block if present, normalizing the blank lines around the
/// removed region. Returns the content unchanged if no block is found (parity
/// with `remove`).
pub fn remove(content: &str, syntax: MarkerSyntax) -> String {
    let end = syntax.end();
    let Some((begin_idx, end_idx)) = locate(content, syntax) else {
        return content.to_string();
    };
    let before = content[..begin_idx].trim_end();
    let after = content[end_idx + end.len()..].trim_start();

    if before.is_empty() && after.is_empty() {
        return String::new();
    }
    if before.is_empty() {
        return if after.ends_with('\n') {
            after.to_string()
        } else {
            format!("{after}\n")
        };
    }
    if after.is_empty() {
        return format!("{before}\n");
    }
    let tail = if after.ends_with('\n') {
        after.to_string()
    } else {
        format!("{after}\n")
    };
    format!("{before}\n\n{tail}")
}

/// Whether a well-formed marker block of the given syntax exists.
pub fn has(content: &str, syntax: MarkerSyntax) -> bool {
    locate(content, syntax).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use MarkerSyntax::{Hash, Html};

    #[test]
    fn wrap_has_no_trailing_newline() {
        assert_eq!(
            wrap("body", Html),
            "<!-- ask:start -->\nbody\n<!-- ask:end -->"
        );
        assert_eq!(wrap("body", Hash), "# ask:start\nbody\n# ask:end");
    }

    #[test]
    fn inject_into_empty_appends_single_trailing_newline() {
        let block = wrap("x", Html);
        assert_eq!(inject("", &block, Html), format!("{block}\n"));
    }

    #[test]
    fn inject_appends_with_blank_line_separator() {
        let block = wrap("x", Html);
        let out = inject("# Title\n", &block, Html);
        assert_eq!(out, format!("# Title\n\n{block}\n"));
    }

    #[test]
    fn inject_is_idempotent_and_replaces_in_place() {
        let first = inject("# Title\n", &wrap("v1", Html), Html);
        let second = inject(&first, &wrap("v2", Html), Html);
        // The v1 block is replaced by v2, not duplicated.
        assert_eq!(second.matches("ask:start").count(), 1);
        assert!(second.contains("v2"));
        assert!(!second.contains("v1"));
        // Re-injecting the same block yields identical output (idempotent).
        assert_eq!(inject(&second, &wrap("v2", Html), Html), second);
    }

    #[test]
    fn has_detects_well_formed_block_only() {
        let with = inject("doc", &wrap("x", Hash), Hash);
        assert!(has(&with, Hash));
        assert!(!has("no markers here", Hash));
        // end-before-begin is not a well-formed block.
        assert!(!has("# ask:end\n# ask:start", Hash));
    }

    #[test]
    fn remove_block_only_leaves_empty_string() {
        let only = wrap("x", Html);
        assert_eq!(remove(&only, Html), "");
    }

    #[test]
    fn remove_preserves_surrounding_content() {
        let content = inject("# Title\n", &wrap("x", Html), Html);
        assert_eq!(remove(&content, Html), "# Title\n");
    }

    #[test]
    fn remove_between_two_user_sections_normalizes_blank_lines() {
        let block = wrap("x", Hash);
        let content = format!("before\n\n{block}\n\nafter\n");
        assert_eq!(remove(&content, Hash), "before\n\nafter\n");
    }

    #[test]
    fn remove_absent_block_is_noop() {
        assert_eq!(remove("untouched\n", Html), "untouched\n");
    }

    #[test]
    fn inject_remove_roundtrip_returns_original_trimmed() {
        let original = "# Title\n";
        let injected = inject(original, &wrap("x", Html), Html);
        assert_eq!(remove(&injected, Html), "# Title\n");
    }
}
