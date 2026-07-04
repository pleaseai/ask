//! Binary entrypoint for `ask`. Thin wrapper: parse argv, dispatch, print any
//! error to stderr and exit non-zero (clap already handles `--help`/`--version`
//! and usage errors with its own exit codes — those stay clap's 2).

use std::process::ExitCode;

use ask::cli::{self, Cli};
use clap::Parser;

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli::run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        // A runtime command failure (install/remove/list bubble here) exits 1,
        // matching the TS CLI's citty runMain, which exits 1 on a thrown command
        // error. clap's own usage/parse errors still exit 2 (handled in
        // Cli::parse above, before cli::run), which is the correct split.
        Err(err) => {
            eprintln!("ask: {err}");
            ExitCode::from(1)
        }
    }
}
