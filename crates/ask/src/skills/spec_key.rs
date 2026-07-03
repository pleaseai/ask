//! Filesystem-safe encoding of a resolved library spec, used as the top-level
//! directory name under `.ask/skills/<spec-key>/`. Rust port of
//! `skills/spec-key.ts`.
//!
//! Only `/` and `:` — the structural separators that collide with path syntax
//! — are rewritten to `__`. `@` is kept as-is so scoped npm packages stay
//! human-readable.
//!
//! ```text
//! { npm, next, 14.2.3 }        → npm__next__14.2.3
//! { npm, @vercel/ai, 5.0.0 }   → npm__@vercel__ai__5.0.0
//! { github, vercel/ai, v5.0.0} → github__vercel__ai__v5.0.0
//! ```

/// A decoded spec-key: ecosystem prefix, package name (or `owner/repo`), and
/// resolved version / git ref.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecKeyInput {
    pub ecosystem: String,
    pub name: String,
    pub version: String,
}

/// Rewrite the two structural separators (`/` and `:`) to `__`. Errors on an
/// empty part (parity with `encodePart`'s throw).
fn encode_part(value: &str) -> anyhow::Result<String> {
    if value.is_empty() {
        anyhow::bail!("spec-key part must be non-empty");
    }
    Ok(value.replace(['/', ':'], "__"))
}

/// Encode a [`SpecKeyInput`] into `ecosystem__name__version` with separators
/// rewritten. Parity with `encodeSpecKey`.
pub fn encode_spec_key(input: &SpecKeyInput) -> anyhow::Result<String> {
    Ok([
        encode_part(&input.ecosystem)?,
        encode_part(&input.name)?,
        encode_part(&input.version)?,
    ]
    .join("__"))
}

/// Reverse of [`encode_spec_key`]. Splits on `__`; the canonical layout is
/// `[ecosystem, …name parts, version]` (≥3 segments). Name parts re-join with
/// `/`. Parity with `decodeSpecKey`.
pub fn decode_spec_key(key: &str) -> anyhow::Result<SpecKeyInput> {
    let segments: Vec<&str> = key.split("__").collect();
    if segments.len() < 3 {
        anyhow::bail!("malformed spec-key (needs at least 3 segments): {key}");
    }
    let ecosystem = segments[0];
    let version = *segments.last().unwrap();
    let name = segments[1..segments.len() - 1].join("/");
    if ecosystem.is_empty() || name.is_empty() || version.is_empty() {
        anyhow::bail!("malformed spec-key (empty segment): {key}");
    }
    Ok(SpecKeyInput {
        ecosystem: ecosystem.to_string(),
        name,
        version: version.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(e: &str, n: &str, v: &str) -> SpecKeyInput {
        SpecKeyInput {
            ecosystem: e.to_string(),
            name: n.to_string(),
            version: v.to_string(),
        }
    }

    #[test]
    fn encode_examples() {
        assert_eq!(
            encode_spec_key(&k("npm", "next", "14.2.3")).unwrap(),
            "npm__next__14.2.3"
        );
        assert_eq!(
            encode_spec_key(&k("npm", "@vercel/ai", "5.0.0")).unwrap(),
            "npm__@vercel__ai__5.0.0"
        );
        assert_eq!(
            encode_spec_key(&k("github", "vercel/ai", "v5.0.0")).unwrap(),
            "github__vercel__ai__v5.0.0"
        );
    }

    #[test]
    fn encode_rejects_empty_part() {
        assert!(encode_spec_key(&k("", "n", "v")).is_err());
    }

    #[test]
    fn decode_roundtrips_scoped_and_github() {
        assert_eq!(
            decode_spec_key("npm__next__14.2.3").unwrap(),
            k("npm", "next", "14.2.3")
        );
        // Scoped npm: name parts re-join with `/`.
        assert_eq!(
            decode_spec_key("github__vercel__ai__v5.0.0").unwrap(),
            k("github", "vercel/ai", "v5.0.0")
        );
    }

    #[test]
    fn decode_rejects_short_key() {
        assert!(decode_spec_key("npm__next").is_err());
    }
}
