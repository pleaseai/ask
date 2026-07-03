//! Core library for the `ask` CLI (Rust port of `@pleaseai/ask`).
//!
//! Phase 0: this crate is a walking skeleton. The command surface is defined in
//! [`cli`], but the per-command logic is ported from the TypeScript
//! implementation (`packages/cli/src/`) module by module in later phases (see
//! the `rust-port-20260704` track). Until a command is ported it reports a
//! "not yet ported" notice via [`NotPorted`].

pub mod cli;
pub mod spec;

use std::fmt;

/// Sentinel error for a command whose logic has not been ported to Rust yet.
///
/// The binary maps this to a clear, non-zero-exit message pointing at the still
/// authoritative TypeScript build, rather than silently doing nothing.
#[derive(Debug)]
pub struct NotPorted {
    pub command: &'static str,
}

impl NotPorted {
    pub fn new(command: &'static str) -> Self {
        Self { command }
    }
}

impl fmt::Display for NotPorted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "`ask {}` is not ported to the Rust build yet.\n\
             The TypeScript build (`npx @pleaseai/ask {}`) remains the source of truth \
             during the migration — see .please/docs/tracks/active/rust-port-20260704/.",
            self.command, self.command
        )
    }
}

impl std::error::Error for NotPorted {}
