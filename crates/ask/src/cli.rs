//! Command-line surface for `ask`, mirroring `packages/cli/src/index.ts`.
//!
//! The parser is the real, stable contract (`ask --help` lists every command);
//! command *bodies* are filled in per migration phase. Un-ported commands return
//! [`NotPorted`](crate::NotPorted) so the surface is honest about what works.

use std::env::current_dir;

use clap::{Args, Parser, Subcommand};

use crate::NotPorted;

/// Agent Skills Kit — download version-specific library docs for AI coding agents.
#[derive(Debug, Parser)]
#[command(
    name = "ask",
    version,
    about = "Agent Skills Kit - Download version-specific library docs for AI coding agents",
    propagate_version = true
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Resolve versions and generate AGENTS.md + SKILL.md for all libraries in ask.json.
    Install,

    /// Add a library to ask.json and materialize its docs/skill.
    Add(AddArgs),

    /// Remove a library entry from ask.json and delete its skill file.
    Remove(RemoveArgs),

    /// List declared libraries with their resolved versions.
    List(ListArgs),

    /// Print resolved source-checkout paths for one or more specs.
    Src(SrcArgs),

    /// Print candidate documentation paths for a spec.
    Docs(DocsArgs),

    /// Warm the checkout cache for one or more specs.
    Fetch(FetchArgs),

    /// Semantic code search over a pinned checkout (delegates to csp).
    Search(SearchArgs),

    /// Manage standalone agent skills.
    Skills(SkillsArgs),

    /// Manage the global ASK documentation store.
    Cache(CacheArgs),
}

#[derive(Debug, Args)]
pub struct AddArgs {
    /// Library name or full spec (e.g. next, @mastra/client-js, npm:react).
    pub spec: String,
    /// Comma-separated docs-path override (non-interactive).
    #[arg(long = "docs-paths")]
    pub docs_paths: Option<String>,
    /// Downgrade an object entry back to a bare-string entry.
    #[arg(long = "clear-docs-paths")]
    pub clear_docs_paths: bool,
    /// Explicit source override (registry auto-detect is bypassed).
    #[arg(short = 's', long = "source")]
    pub source: Option<String>,
    /// Allow a mutable ref (main/master/latest/...) in ask.json.
    #[arg(long = "allow-mutable-ref")]
    pub allow_mutable_ref: bool,
}

#[derive(Debug, Args)]
pub struct RemoveArgs {
    /// Library name (e.g. next, @mastra/client-js) or full spec.
    pub name: String,
}

#[derive(Debug, Args)]
pub struct ListArgs {
    /// Emit the list as JSON matching ListModelSchema.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct SrcArgs {
    /// One or more specs (e.g. npm:next, github:owner/repo@v1).
    #[arg(required = true)]
    pub specs: Vec<String>,
    /// Emit resolved paths as JSON.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct DocsArgs {
    /// A single spec (e.g. npm:next, github:owner/repo).
    pub spec: String,
}

#[derive(Debug, Args)]
pub struct FetchArgs {
    /// One or more specs to warm into the checkout cache.
    #[arg(required = true)]
    pub specs: Vec<String>,
    /// Suppress per-spec progress output.
    #[arg(short = 'q', long)]
    pub quiet: bool,
}

#[derive(Debug, Args)]
pub struct SearchArgs {
    /// The spec whose pinned checkout to search.
    pub spec: String,
    /// The search query.
    pub query: String,
}

#[derive(Debug, Args)]
pub struct SkillsArgs {
    #[command(subcommand)]
    pub command: SkillsCommand,
}

#[derive(Debug, Subcommand)]
pub enum SkillsCommand {
    /// Install standalone skills.
    Install,
    /// Remove standalone skills.
    Remove,
    /// List installed standalone skills.
    List,
}

#[derive(Debug, Args)]
pub struct CacheArgs {
    #[command(subcommand)]
    pub command: CacheCommand,
}

#[derive(Debug, Subcommand)]
pub enum CacheCommand {
    /// List entries in the global ASK store.
    Ls(CacheLsArgs),
    /// Remove unreferenced entries from the global ASK store.
    Gc(CacheGcArgs),
    /// Remove legacy store-layout directories (pre-v2).
    Clean(CacheCleanArgs),
}

#[derive(Debug, Args)]
pub struct CacheLsArgs {
    /// Filter by kind: npm, github, web, llms-txt.
    #[arg(long)]
    pub kind: Option<String>,
    /// Emit entries as JSON matching CacheLsModelSchema.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct CacheGcArgs {
    /// Show what would be removed without deleting.
    #[arg(long = "dry-run")]
    pub dry_run: bool,
    /// Only remove entries older than this duration (e.g. 30d, 12h, 90m, 60s).
    #[arg(long = "older-than")]
    pub older_than: Option<String>,
    /// Emit results as JSON matching CacheGcModelSchema.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct CacheCleanArgs {
    /// Remove github/db and github/checkouts left by the pre-v2 store layout.
    #[arg(long)]
    pub legacy: bool,
}

/// Dispatch a parsed [`Cli`] to its command. Ported commands run their real
/// logic; the rest still return [`NotPorted`] until their migration phase.
pub fn run(cli: Cli) -> anyhow::Result<()> {
    match cli.command {
        Command::Install => {
            crate::install::run_install(&current_dir()?, &Default::default())?;
            Ok(())
        }
        Command::List(args) => run_list(args),
        Command::Add(_) => Err(NotPorted::new("add").into()),
        Command::Remove(_) => Err(NotPorted::new("remove").into()),
        Command::Src(_) => Err(NotPorted::new("src").into()),
        Command::Docs(_) => Err(NotPorted::new("docs").into()),
        Command::Fetch(_) => Err(NotPorted::new("fetch").into()),
        Command::Search(_) => Err(NotPorted::new("search").into()),
        Command::Skills(_) => Err(NotPorted::new("skills").into()),
        Command::Cache(_) => Err(NotPorted::new("cache").into()),
    }
}

/// `ask list` — render the docs model as text (default) or JSON (`--json`).
fn run_list(args: ListArgs) -> anyhow::Result<()> {
    let model = crate::list::build_list_model(&current_dir()?);
    if args.json {
        println!("{}", serde_json::to_string_pretty(&model)?);
    } else {
        println!("{}", crate::list::format_list(&model));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn cli_definition_is_valid() {
        // Fails to compile/at runtime if the derive produces an inconsistent
        // command tree (duplicate flags, bad arg config, etc.).
        Cli::command().debug_assert();
    }

    #[test]
    fn version_is_the_crate_version() {
        // The `#[command(version)]` uses CARGO_PKG_VERSION, kept in lockstep with
        // the workspace version anchor that release-please bumps.
        assert_eq!(
            Cli::command().get_version(),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn all_top_level_subcommands_are_present() {
        let cmd = Cli::command();
        let names: Vec<_> = cmd.get_subcommands().map(|c| c.get_name()).collect();
        for expected in [
            "install", "add", "remove", "list", "src", "docs", "fetch", "search", "skills", "cache",
        ] {
            assert!(names.contains(&expected), "missing subcommand: {expected}");
        }
    }

    #[test]
    fn parses_representative_invocations() {
        // A cross-section of the surface parses without error.
        Cli::try_parse_from(["ask", "install"]).unwrap();
        Cli::try_parse_from(["ask", "add", "next", "--docs-paths", "docs,readme"]).unwrap();
        Cli::try_parse_from(["ask", "list", "--json"]).unwrap();
        Cli::try_parse_from(["ask", "fetch", "npm:next", "github:a/b", "-q"]).unwrap();
        Cli::try_parse_from(["ask", "cache", "gc", "--dry-run", "--older-than", "30d"]).unwrap();
        Cli::try_parse_from(["ask", "skills", "list"]).unwrap();
    }
}
