//! llms-txt source — fetch a single `llms.txt`-style document and store it.
//! Rust port of `sources/llms-txt.ts`.

use std::path::Path;

use anyhow::{bail, Result};

use super::{to_entry_files, DocFile, FetchMeta, FetchResult};
use crate::http::HttpClient;
use crate::store::{acquire_entry_lock, llms_txt_store_path, stamp_entry, write_entry_atomic};

/// Options for an llms-txt fetch (port of `LlmsTxtSourceOptions`).
#[derive(Debug, Clone)]
pub struct LlmsTxtOptions {
    pub name: String,
    pub version: String,
    pub url: String,
}

/// Fetch the document, derive a filename from the URL path (appending `.md` when
/// it isn't already `.md`/`.txt`), and materialize it into the store.
pub fn fetch(
    client: &dyn HttpClient,
    opts: &LlmsTxtOptions,
    ask_home: &Path,
) -> Result<FetchResult> {
    let response = client.get(&opts.url)?;
    if !response.ok() {
        bail!("Failed to fetch {}: {}", opts.url, response.status);
    }
    let content = response.body;
    if content.trim().is_empty() {
        bail!("No content found at {}", opts.url);
    }

    let filename = url_last_segment(&opts.url);
    let file_path = if filename.ends_with(".md") || filename.ends_with(".txt") {
        filename
    } else {
        format!("{filename}.md")
    };
    let files = vec![DocFile {
        path: file_path,
        content,
    }];

    let store_dir = llms_txt_store_path(ask_home, &opts.url, &opts.version);
    if !store_dir.exists() {
        if let Some(lock) = acquire_entry_lock(&store_dir)? {
            write_entry_atomic(&store_dir, &to_entry_files(&files))?;
            stamp_entry(&store_dir)?;
            drop(lock);
        }
    }

    Ok(FetchResult {
        files,
        resolved_version: opts.version.clone(),
        store_path: Some(store_dir),
        store_subpath: None,
        from_store_cache: false,
        meta: FetchMeta::default(),
    })
}

/// The last path segment of `url`, or `llms.txt` (parity with TS
/// `urlObj.pathname.split('/').pop() || 'llms.txt'`). TS's `pop()` takes the
/// LAST segment even when it is empty (a trailing slash), so `.../docs/` falls
/// back to `llms.txt` — using `rfind(non-empty)` here would wrongly yield `docs`.
fn url_last_segment(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.path_segments()?.next_back().map(str::to_string))
        .filter(|seg| !seg.is_empty())
        .unwrap_or_else(|| "llms.txt".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock::MockClient;

    #[test]
    fn fetches_and_stores_llms_txt() {
        let dir = tempfile::tempdir().unwrap();
        let url = "https://example.com/llms.txt";
        let client = MockClient::new().with(url, 200, "# Docs\ncontent");
        let opts = LlmsTxtOptions {
            name: "x".into(),
            version: "1.0.0".into(),
            url: url.into(),
        };

        let result = fetch(&client, &opts, dir.path()).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, "llms.txt");
        assert!(result.files[0].content.contains("content"));
        let store = result.store_path.unwrap();
        assert!(store.join("llms.txt").exists());
    }

    #[test]
    fn appends_md_when_no_doc_extension() {
        let dir = tempfile::tempdir().unwrap();
        let url = "https://example.com/api/reference";
        let client = MockClient::new().with(url, 200, "body");
        let opts = LlmsTxtOptions {
            name: "x".into(),
            version: "1".into(),
            url: url.into(),
        };
        let result = fetch(&client, &opts, dir.path()).unwrap();
        assert_eq!(result.files[0].path, "reference.md");
    }

    #[test]
    fn errors_on_non_ok_and_empty() {
        let dir = tempfile::tempdir().unwrap();
        let url = "https://example.com/llms.txt";
        let miss = MockClient::new().with(url, 404, "");
        let opts = LlmsTxtOptions {
            name: "x".into(),
            version: "1".into(),
            url: url.into(),
        };
        assert!(fetch(&miss, &opts, dir.path()).is_err());

        let empty = MockClient::new().with(url, 200, "   \n  ");
        assert!(fetch(&empty, &opts, dir.path()).is_err());
    }

    #[test]
    fn root_path_falls_back_to_llms_txt() {
        assert_eq!(url_last_segment("https://x.io/"), "llms.txt");
        assert_eq!(url_last_segment("https://x.io/a/b/guide.md"), "guide.md");
        // A NON-root trailing slash also falls back (TS `pop()` yields "" here).
        // The previous `rfind(non-empty)` wrongly returned "docs".
        assert_eq!(url_last_segment("https://x.io/docs/"), "llms.txt");
        assert_eq!(url_last_segment("https://x.io/a/b/"), "llms.txt");
    }
}
