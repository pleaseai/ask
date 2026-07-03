//! Format-aware `pnpm-lock.yaml` parser — Rust port of `lockfiles/pnpm.ts`
//! (itself from opensrc's `core/version.rs`).
//!
//! An indent-aware stack machine covering pnpm v5–v9: importers,
//! dev/optionalDependencies, and nested peer-dep suffixes. While parsing it
//! builds a dependency graph from `snapshots:` (v9) or `packages:` (v6–v8); when
//! a direct lookup misses, a BFS from root-importer deps picks the
//! root-reachable version instead of a lexicographic first match.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::{
    clean_value, is_registry_version, read_file, split_pkg_spec, strip_peer_suffix, trim_quotes,
    LockfileHit, LockfileReader,
};

/// A dependency-graph node. Map keys are the full snapshot id
/// (`<name>@<version>[<peer-suffix>]`).
struct PnpmNode {
    name: String,
    /// Version with peer suffix stripped — what we'd return to the caller.
    version: String,
    /// Snapshot ids of this node's direct dependencies.
    deps: Vec<String>,
}

/// The snapshot dependency graph.
struct PnpmGraph {
    nodes: HashMap<String, PnpmNode>,
    /// Snapshot ids that are direct deps of any importer (or top-level
    /// `dependencies:` in v5/v6 non-workspace lockfiles). Insertion order is
    /// significant for the BFS.
    roots: Vec<String>,
}

/// Where a direct dependency entry was found.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Origin {
    Root,
    Importer,
}

/// A frame on the indent-aware parse stack. `base` is the indent of the line
/// that opened the frame; children sit at strictly greater indent.
#[derive(Clone)]
enum Frame {
    Importers {
        base: usize,
    },
    Importer {
        base: usize,
    },
    DepGroup {
        base: usize,
        origin: Origin,
    },
    /// Block-form dep entry awaiting a nested `version:` line.
    DepBlock {
        base: usize,
        origin: Origin,
        pkg_name: String,
    },
    Packages {
        base: usize,
    },
    Snapshots {
        base: usize,
    },
    /// Inside a `packages:`/`snapshots:` entry, collecting its subkeys.
    PkgEntry {
        base: usize,
        key: String,
    },
    /// Inside a pkg entry's `dependencies:`/`optionalDependencies:` block.
    PkgDeps {
        base: usize,
        owner: String,
    },
}

impl Frame {
    fn base(&self) -> usize {
        match self {
            Frame::Importers { base }
            | Frame::Importer { base }
            | Frame::DepGroup { base, .. }
            | Frame::DepBlock { base, .. }
            | Frame::Packages { base }
            | Frame::Snapshots { base }
            | Frame::PkgEntry { base, .. }
            | Frame::PkgDeps { base, .. } => *base,
        }
    }
}

/// Mutable state threaded through the per-frame line handlers.
struct ParseState {
    pkg: String,
    stack: Vec<Frame>,
    graph: PnpmGraph,
    importer_match: Option<String>,
    top_match: Option<String>,
    packages_fallback: Option<String>,
}

fn is_dep_group_key(key: &str) -> bool {
    matches!(
        key,
        "dependencies" | "devDependencies" | "optionalDependencies"
    )
}

/// Split a `packages:`/`snapshots:` entry key (leading `/` already stripped)
/// into name + version-with-peer + the node key used in the dep graph.
///
/// v6–v9 keys are `<name>@<version>[<peer-suffix>]` (node key = raw key). v5
/// keys are `<name>/<version>[_peerhash]` (slash separator): split at the LAST
/// slash so scoped names survive, strip `_peerhash`, and canonicalize the node
/// key to `<name>@<version>` (v5 edges reference deps as `<name>: <version>`).
fn split_packages_key(key: &str) -> Option<(String, String, String)> {
    if let Some((name, version_with_peer)) = split_pkg_spec(key) {
        return Some((
            name.to_string(),
            version_with_peer.to_string(),
            key.to_string(),
        ));
    }
    let i = key.rfind('/')?;
    if i == 0 || i == key.len() - 1 {
        return None;
    }
    let name = &key[..i];
    let underscore = key[i..].find('_').map(|x| x + i);
    let version = match underscore {
        Some(u) => &key[i + 1..u],
        None => &key[i + 1..],
    };
    if version.is_empty() {
        return None;
    }
    Some((
        name.to_string(),
        version.to_string(),
        format!("{name}@{version}"),
    ))
}

/// Pop frames whose scope ended at this indent; return the frame the line
/// belongs to (`None` = document/root level). Returns a clone so callers can
/// mutate the stack/graph without a borrow conflict.
fn current_frame(stack: &mut Vec<Frame>, indent: usize) -> Option<Frame> {
    while let Some(top) = stack.last() {
        if indent <= top.base() {
            stack.pop();
        } else {
            break;
        }
    }
    stack.last().cloned()
}

/// Record a direct dependency entry: seed the graph roots and capture the
/// version when the entry names the package we're looking for.
fn capture_direct(state: &mut ParseState, dep_name: &str, raw_value: &str, origin: Origin) {
    let cleaned = clean_value(raw_value);
    let stripped = strip_peer_suffix(cleaned);
    // Root key uses the raw (peer-including) value so it matches `snapshots:`.
    state.graph.roots.push(format!("{dep_name}@{cleaned}"));

    // Filter at capture so workspace/link/file versions in one importer don't
    // block a real version in a later importer.
    if dep_name != state.pkg || !is_registry_version(stripped) {
        return;
    }
    if origin == Origin::Importer && state.importer_match.is_none() {
        state.importer_match = Some(stripped.to_string());
    } else if origin == Origin::Root && state.top_match.is_none() {
        state.top_match = Some(stripped.to_string());
    }
}

fn handle_root_line(state: &mut ParseState, indent: usize, content: &str) {
    if indent != 0 || !content.ends_with(':') {
        return;
    }
    let key = content[..content.len() - 1].trim();
    if key == "importers" {
        state.stack.push(Frame::Importers { base: indent });
    } else if is_dep_group_key(key) {
        state.stack.push(Frame::DepGroup {
            base: indent,
            origin: Origin::Root,
        });
    } else if key == "packages" {
        state.stack.push(Frame::Packages { base: indent });
    } else if key == "snapshots" {
        state.stack.push(Frame::Snapshots { base: indent });
    }
}

fn handle_importers_line(state: &mut ParseState, indent: usize, content: &str) {
    if content.ends_with(':') {
        state.stack.push(Frame::Importer { base: indent });
    }
}

fn handle_importer_line(state: &mut ParseState, indent: usize, content: &str) {
    if content.ends_with(':') && is_dep_group_key(content[..content.len() - 1].trim()) {
        state.stack.push(Frame::DepGroup {
            base: indent,
            origin: Origin::Importer,
        });
    }
}

fn handle_dep_group_line(state: &mut ParseState, origin: Origin, indent: usize, content: &str) {
    let Some(sep) = content.find(':') else { return };
    let dep_name = trim_quotes(content[..sep].trim()).to_string();
    let raw_value = content[sep + 1..].trim();
    if raw_value.is_empty() {
        state.stack.push(Frame::DepBlock {
            base: indent,
            origin,
            pkg_name: dep_name,
        });
    } else {
        capture_direct(state, &dep_name, raw_value, origin);
    }
}

fn handle_dep_block_line(state: &mut ParseState, origin: Origin, pkg_name: &str, content: &str) {
    let Some(rest) = content.strip_prefix("version:") else {
        return;
    };
    capture_direct(state, pkg_name, rest, origin);
    state.stack.pop();
}

fn handle_packages_line(state: &mut ParseState, indent: usize, content: &str) {
    let Some(sep) = content.find(':') else { return };
    let raw_key = trim_quotes(content[..sep].trim());
    let key = raw_key.strip_prefix('/').unwrap_or(raw_key);
    let value_part = &content[sep + 1..];

    let Some((name, version_with_peer, node_key)) = split_packages_key(key) else {
        return;
    };
    let version = strip_peer_suffix(&version_with_peer).to_string();

    state
        .graph
        .nodes
        .entry(node_key.clone())
        .or_insert_with(|| PnpmNode {
            name: name.clone(),
            version: version.clone(),
            deps: Vec::new(),
        });

    if name == state.pkg && state.packages_fallback.is_none() && is_registry_version(&version) {
        state.packages_fallback = Some(version);
    }

    if value_part.trim().is_empty() {
        state.stack.push(Frame::PkgEntry {
            base: indent,
            key: node_key,
        });
    }
    // Else: inline value like `{}` — no children to parse.
}

fn handle_pkg_entry_line(state: &mut ParseState, key: &str, indent: usize, content: &str) {
    if !content.ends_with(':') {
        return;
    }
    let sub_key = content[..content.len() - 1].trim();
    if sub_key == "dependencies" || sub_key == "optionalDependencies" {
        state.stack.push(Frame::PkgDeps {
            base: indent,
            owner: key.to_string(),
        });
    }
    // Ignore resolution/engines/peerDependencies/etc.
}

fn handle_pkg_deps_line(state: &mut ParseState, owner: &str, content: &str) {
    let Some(sep) = content.find(':') else { return };
    let dep_name = trim_quotes(content[..sep].trim()).to_string();
    let dep_value = clean_value(&content[sep + 1..]);
    if !dep_value.is_empty() {
        if let Some(node) = state.graph.nodes.get_mut(owner) {
            node.deps.push(format!("{dep_name}@{dep_value}"));
        }
    }
}

fn dispatch_line(state: &mut ParseState, indent: usize, content: &str) {
    let Some(top) = current_frame(&mut state.stack, indent) else {
        handle_root_line(state, indent, content);
        return;
    };
    match top {
        Frame::Importers { .. } => handle_importers_line(state, indent, content),
        Frame::Importer { .. } => handle_importer_line(state, indent, content),
        Frame::DepGroup { origin, .. } => handle_dep_group_line(state, origin, indent, content),
        Frame::DepBlock {
            origin, pkg_name, ..
        } => handle_dep_block_line(state, origin, &pkg_name, content),
        Frame::Packages { .. } | Frame::Snapshots { .. } => {
            handle_packages_line(state, indent, content)
        }
        Frame::PkgEntry { key, .. } => handle_pkg_entry_line(state, &key, indent, content),
        Frame::PkgDeps { owner, .. } => handle_pkg_deps_line(state, &owner, content),
    }
}

/// Parse a `pnpm-lock.yaml` and return the installed version of `pkg`.
///
/// Priority: (1) direct match in an importer dep group, (2) direct match in
/// top-level dep groups (v5/v6), (3) transitive BFS through the snapshot graph,
/// (4) first matching `packages:`/`snapshots:` key.
pub fn parse_pnpm_lock(text: &str, pkg: &str) -> Option<String> {
    let mut state = ParseState {
        pkg: pkg.to_string(),
        stack: Vec::new(),
        graph: PnpmGraph {
            nodes: HashMap::new(),
            roots: Vec::new(),
        },
        importer_match: None,
        top_match: None,
        packages_fallback: None,
    };

    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed_start = line.trim_start();
        if trimmed_start.is_empty() || trimmed_start.starts_with('#') {
            continue;
        }
        let indent = line.len() - trimmed_start.len();
        dispatch_line(&mut state, indent, trimmed_start);
    }

    state
        .importer_match
        .or(state.top_match)
        .or_else(|| resolve_transitive(&state.graph, pkg))
        .or(state.packages_fallback)
}

/// BFS from `graph.roots` through the snapshot dep graph, returning the version
/// of the first reached node whose name matches `pkg`. BFS (not DFS) picks the
/// version at the shallowest transitive depth — closest to what's hoisted.
fn resolve_transitive(graph: &PnpmGraph, pkg: &str) -> Option<String> {
    if graph.nodes.is_empty() || graph.roots.is_empty() {
        return None;
    }
    let mut visited: HashSet<&str> = HashSet::new();
    // Index-pointer BFS: the queue only grows, iterated in insertion order.
    let mut queue: Vec<&str> = graph.roots.iter().map(String::as_str).collect();
    let mut i = 0;
    while i < queue.len() {
        let key = queue[i];
        i += 1;
        if !visited.insert(key) {
            continue;
        }
        let Some(node) = graph.nodes.get(key) else {
            continue;
        };
        if node.name == pkg && is_registry_version(&node.version) {
            return Some(node.version.clone());
        }
        for dep in &node.deps {
            if !visited.contains(dep.as_str()) {
                queue.push(dep.as_str());
            }
        }
    }
    None
}

fn pnpm_read(name: &str, project_dir: &Path) -> Option<LockfileHit> {
    let content = read_file(project_dir, "pnpm-lock.yaml")?;
    parse_pnpm_lock(&content, name).map(|version| LockfileHit {
        version,
        source: "pnpm-lock.yaml".to_string(),
        exact: true,
    })
}

pub const PNPM_LOCK_READER: LockfileReader = LockfileReader {
    file: "pnpm-lock.yaml",
    exact: true,
    read: pnpm_read,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v9_importer_direct_match() {
        let text = "\
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      next:
        specifier: ^15.0.0
        version: 15.0.3
";
        assert_eq!(parse_pnpm_lock(text, "next").as_deref(), Some("15.0.3"));
    }

    #[test]
    fn peer_suffix_does_not_leak_inner_package() {
        // `react-dom@18.2.0(react@18.2.0)`: looking up `react` must NOT return
        // the version embedded in react-dom's peer suffix.
        let text = "\
importers:
  .:
    dependencies:
      react:
        specifier: ^18.0.0
        version: 18.2.0
      react-dom:
        specifier: ^18.0.0
        version: 18.2.0(react@18.2.0)
";
        assert_eq!(parse_pnpm_lock(text, "react").as_deref(), Some("18.2.0"));
        assert_eq!(
            parse_pnpm_lock(text, "react-dom").as_deref(),
            Some("18.2.0")
        );
    }

    #[test]
    fn importer_beats_workspace_protocol() {
        // A workspace/link importer entry must not block a real version.
        let text = "\
importers:
  .:
    dependencies:
      pkg:
        specifier: workspace:*
        version: link:../pkg
  packages/app:
    dependencies:
      pkg:
        specifier: ^1.0.0
        version: 1.2.3
";
        assert_eq!(parse_pnpm_lock(text, "pkg").as_deref(), Some("1.2.3"));
    }

    #[test]
    fn transitive_bfs_from_snapshots() {
        // `left-pad` is not a direct dep; it is reachable transitively via the
        // snapshot graph and resolved by BFS.
        let text = "\
importers:
  .:
    dependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0

snapshots:
  a@1.0.0:
    dependencies:
      left-pad: 1.3.0
  left-pad@1.3.0: {}
";
        assert_eq!(parse_pnpm_lock(text, "left-pad").as_deref(), Some("1.3.0"));
    }

    #[test]
    fn v5_slash_keys_and_packages_fallback() {
        // v5-style `/name/version[_peerhash]` keys, resolved via the packages
        // fallback. The slash-split branch is only reached for keys with NO `@`
        // (a `@` anywhere makes split_pkg_spec win and take the
        // `<name>@<version>` interpretation — identical to the TS).
        let text = "\
packages:
  /foo/1.0.0:
    resolution: {integrity: sha512-xxx}
  /@scope/pkg/2.3.4:
    resolution: {integrity: sha512-yyy}
  /bar/3.0.0_abc123hash:
    resolution: {integrity: sha512-zzz}
";
        assert_eq!(parse_pnpm_lock(text, "foo").as_deref(), Some("1.0.0"));
        // Scoped v5 key (no peer hash) → split at the last slash.
        assert_eq!(
            parse_pnpm_lock(text, "@scope/pkg").as_deref(),
            Some("2.3.4")
        );
        // v5 peer hash (no `@`) is stripped at the `_`.
        assert_eq!(parse_pnpm_lock(text, "bar").as_deref(), Some("3.0.0"));
    }

    #[test]
    fn missing_package_is_none() {
        let text = "\
importers:
  .:
    dependencies:
      next:
        specifier: ^15.0.0
        version: 15.0.3
";
        assert_eq!(parse_pnpm_lock(text, "absent"), None);
    }
}
