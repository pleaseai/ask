//! Binary entrypoint for `ask`. Thin wrapper: parse argv, dispatch, print any
//! error to stderr and exit non-zero (clap already handles `--help`/`--version`
//! and usage errors with its own exit codes).

use std::process::ExitCode;

use ask::cli::{self, Cli};
use clap::Parser;

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli::run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("ask: {err}");
            ExitCode::from(2)
        }
    }
}
