//! Convention-based discovery helpers. On this branch only `candidates` is
//! wired into a command (`ask add`'s offline-first docs-path probe); the local
//! adapter chain (local-ask / local-intent / local-conventions) that `install`
//! consults upstream is not yet materialized here.

pub mod candidates;
