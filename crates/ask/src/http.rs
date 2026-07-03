//! A small injectable HTTP client abstraction shared by the registry lookup,
//! the ecosystem resolvers, and (later) the web/llms-txt sources.
//!
//! The TypeScript code calls the global `fetch`; porting that verbatim would
//! make every network path untestable without a live server. Instead callers
//! take a `&dyn HttpClient`, so production wires [`UreqClient`] (a 10s-timeout
//! ureq agent) while tests inject [`mock::MockClient`] with canned responses —
//! the same parity-by-unit-test approach used for the pure modules.

use std::time::Duration;

/// A completed HTTP response: the numeric status and the body as text. Non-2xx
/// responses are returned as `Ok` (not errors) so callers can branch on 404 vs
/// other statuses exactly like the TS `response.ok` / `response.status` checks.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

impl HttpResponse {
    /// `true` for a 2xx status (parity with `fetch`'s `response.ok`).
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// A GET-only HTTP client. `get` performs the request and reads the full body;
/// a transport failure (DNS, connect, timeout, read) is an `Err`, while any
/// HTTP status (including 4xx/5xx) is an `Ok(HttpResponse)`.
pub trait HttpClient {
    fn get(&self, url: &str) -> anyhow::Result<HttpResponse>;
}

/// The production client: a ureq agent with a 10s global timeout (parity with
/// the TS `AbortSignal.timeout(10_000)`) that surfaces HTTP status codes rather
/// than turning 4xx/5xx into transport errors.
pub struct UreqClient {
    agent: ureq::Agent,
}

impl UreqClient {
    pub fn new() -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .http_status_as_error(false)
            .build()
            .into();
        Self { agent }
    }
}

impl Default for UreqClient {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpClient for UreqClient {
    fn get(&self, url: &str) -> anyhow::Result<HttpResponse> {
        let mut response = self.agent.get(url).call()?;
        let status = response.status().as_u16();
        let body = response.body_mut().read_to_string()?;
        Ok(HttpResponse { status, body })
    }
}

/// Percent-encode a string the way JavaScript's `encodeURIComponent` does:
/// everything except the unreserved set `A-Za-z0-9-_.!~*'()` is UTF-8 encoded to
/// `%XX` (uppercase hex). Used for registry catch-all path segments (scoped npm
/// names contain `/` and `@`) and Maven Solr query params.
pub fn encode_uri_component(input: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        let unreserved = b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
    }
    out
}

/// In-memory HTTP client for tests. Maps exact URLs to canned responses; an
/// unmapped URL returns a transport error (simulating a network failure).
#[cfg(test)]
pub mod mock {
    use std::collections::HashMap;

    use super::{HttpClient, HttpResponse};

    #[derive(Default)]
    pub struct MockClient {
        responses: HashMap<String, HttpResponse>,
    }

    impl MockClient {
        pub fn new() -> Self {
            Self::default()
        }

        /// Register a canned response for an exact URL.
        pub fn with(mut self, url: &str, status: u16, body: &str) -> Self {
            self.responses.insert(
                url.to_string(),
                HttpResponse {
                    status,
                    body: body.to_string(),
                },
            );
            self
        }
    }

    impl HttpClient for MockClient {
        fn get(&self, url: &str) -> anyhow::Result<HttpResponse> {
            self.responses
                .get(url)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("MockClient: no response registered for {url}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_uri_component_matches_js() {
        assert_eq!(encode_uri_component("next"), "next");
        assert_eq!(
            encode_uri_component("@mastra/client-js"),
            "%40mastra%2Fclient-js"
        );
        assert_eq!(encode_uri_component("a b"), "a%20b");
        // Unreserved punctuation is left intact.
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
        // Multi-byte UTF-8 is percent-encoded per byte.
        assert_eq!(encode_uri_component("é"), "%C3%A9");
    }

    #[test]
    fn response_ok_only_for_2xx() {
        let mk = |status| HttpResponse {
            status,
            body: String::new(),
        };
        assert!(mk(200).ok());
        assert!(mk(299).ok());
        assert!(!mk(404).ok());
        assert!(!mk(500).ok());
        assert!(!mk(301).ok());
    }

    #[test]
    fn mock_client_returns_canned_and_errors_on_miss() {
        use super::mock::MockClient;
        let client = MockClient::new().with("https://x/y", 200, "{\"ok\":true}");
        let resp = client.get("https://x/y").unwrap();
        assert_eq!(resp.status, 200);
        assert!(resp.body.contains("ok"));
        assert!(client.get("https://x/other").is_err());
    }
}
