//! Lazy command implementations (`ask src` / `docs` / `fetch` / `add` / ...).
//!
//! These share the [`ensure_checkout`] resolver, which materializes a spec's
//! GitHub checkout in the global store on demand. Rust port of
//! `packages/cli/src/commands/`.

pub mod add;
pub mod docs;
pub mod ensure_checkout;
pub mod fetch;
pub mod find_doc_paths;
pub mod find_skill_paths;
pub mod remove;
pub mod resolve_csp;
pub mod search;
pub mod skills;
pub mod src;
