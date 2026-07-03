//! Standalone agent-skills subsystem for `ask skills` — vendoring producer-side
//! skill directories into `.ask/skills/` and symlinking them into detected
//! coding-agent directories. Separate from the docs-skill generation in
//! `skill.rs`. Rust port of `packages/cli/src/skills/`.

pub mod agent_detect;
pub mod lock;
pub mod spec_key;
pub mod symlinks;
pub mod vendor;
