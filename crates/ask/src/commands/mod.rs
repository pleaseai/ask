//! Lazy command implementations (`ask src` / `docs` / `fetch` / `add` / ...).
//!
//! These share the [`ensure_checkout`] resolver, which materializes a spec's
//! GitHub checkout in the global store on demand. Rust port of
//! `packages/cli/src/commands/`.

pub mod ensure_checkout;
