//! The Preview's browsing history on this computer (Orca's browser history and address suggestions,
//! `browser-pane/history/**`, `address-bar/BrowserAddressBarSuggestionList.tsx`, MIT): the web addresses a Preview
//! page committed, with their titles, for the address bar's suggestions and the start page's recent sites.
//!
//! Kept outside the Preview's browser (panels-sidebar › Side panel: its partitions hold nothing past their window), in
//! `<userData>/preview-history.json` (0600, `{"entries": [{url, title, at, visits}]}`, newest first, at most
//! `MAX_ENTRIES`). Only http(s) addresses without a user name or password are kept; no cookies, no page content.
//! A damaged file reads as no history and is replaced on the next visit. Saved through `write_kept`: on a full disk the
//! list stays in memory and is saved when there is room.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::disk::saves::{waiting_content, write_kept};
use crate::server::{Call, Fault, Registry, Reply};

const FILE: &str = "preview-history.json";
/// The most addresses kept (Orca keeps about as many); the oldest visit goes first.
pub const MAX_ENTRIES: usize = 500;
const MAX_URL: usize = 2048;
const MAX_TITLE: usize = 300;
/// Suggestions a list answers when the caller names no limit.
const DEFAULT_LIMIT: usize = 8;

/// One read-change-write at a time, so two visits never drop each other.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Entry {
    pub url: String,
    pub title: String,
    /// The last visit, epoch milliseconds.
    pub at: f64,
    pub visits: u32,
}

#[derive(Default, Deserialize, Serialize)]
struct Store {
    entries: Vec<Entry>,
}

pub fn register(registry: &mut Registry) {
    registry.add("previewHistory.add", |call| Box::pin(add(call)));
    registry.add("previewHistory.list", |call| Box::pin(list(call)));
    registry.add("previewHistory.remove", |call| Box::pin(remove(call)));
    registry.add("previewHistory.clear", |call| Box::pin(clear(call)));
}

/// A web address the history may keep: http(s), no user name or password, not too long.
fn keepable(url: &str) -> bool {
    if url.len() > MAX_URL {
        return false;
    }
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"));
    rest.is_some_and(|rest| {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        !authority.is_empty() && !authority.contains('@')
    })
}

fn load(file: &Path) -> Store {
    let bytes = waiting_content(file).or_else(|| std::fs::read(file).ok());
    bytes
        .and_then(|bytes| serde_json::from_slice::<Store>(&bytes).ok())
        .map(|mut store| {
            store.entries.retain(|entry| keepable(&entry.url));
            store.entries.truncate(MAX_ENTRIES);
            store
        })
        .unwrap_or_default()
}

fn save(file: &Path, store: &Store) -> Result<(), Fault> {
    let bytes = serde_json::to_vec(store)
        .map_err(|_| Fault::new("internal", "Could not encode the Preview's history"))?;
    write_kept(file, &bytes, Some(0o600), 0o700).map(|_| ())
}

/// The title cut to `MAX_TITLE` characters, never inside one.
fn title(text: &str) -> String {
    text.trim().chars().take(MAX_TITLE).collect()
}

/// `url` visited at `at`: it moves to the front with the newest title (an empty one keeps the last), one more visit.
fn visited(store: &mut Store, url: &str, page_title: &str, at: f64) {
    let earlier = store
        .entries
        .iter()
        .position(|entry| entry.url == url)
        .map(|index| store.entries.remove(index));
    let page_title = title(page_title);
    let entry = match earlier {
        Some(entry) => Entry {
            title: if page_title.is_empty() {
                entry.title
            } else {
                page_title
            },
            at,
            visits: entry.visits.saturating_add(1),
            url: entry.url,
        },
        None => Entry {
            url: url.to_owned(),
            title: page_title,
            at,
            visits: 1,
        },
    };
    store.entries.insert(0, entry);
    store.entries.truncate(MAX_ENTRIES);
}

/// What `query` suggests (case ignored, in the address or the title): an address whose host starts with it first, then
/// the most visited, then the newest. No query: the newest.
fn suggestions(store: &Store, query: &str, limit: usize) -> Vec<Entry> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return store.entries.iter().take(limit).cloned().collect();
    }
    let bare = |url: &str| {
        let url = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))
            .unwrap_or(url);
        url.strip_prefix("www.").unwrap_or(url).to_lowercase()
    };
    let mut found: Vec<(bool, &Entry)> = store
        .entries
        .iter()
        .filter(|entry| {
            entry.url.to_lowercase().contains(&query) || entry.title.to_lowercase().contains(&query)
        })
        .map(|entry| (bare(&entry.url).starts_with(&query), entry))
        .collect();
    found.sort_by(|(a_prefix, a), (b_prefix, b)| {
        b_prefix
            .cmp(a_prefix)
            .then(b.visits.cmp(&a.visits))
            .then(b.at.total_cmp(&a.at))
    });
    found
        .into_iter()
        .take(limit)
        .map(|(_, entry)| entry.clone())
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddParams {
    user_data: PathBuf,
    url: String,
    #[serde(default)]
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    user_data: PathBuf,
    #[serde(default)]
    query: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveParams {
    user_data: PathBuf,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClearParams {
    user_data: PathBuf,
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Fault> + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The Preview history's disk work panicked"))?
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |since| since.as_millis() as f64)
}

async fn add(call: Call) -> Result<Reply, Fault> {
    let AddParams {
        user_data,
        url,
        title,
    } = call.params()?;
    // An address it may not keep (a credential in it, another scheme) is skipped, never an error for the page.
    if !keepable(&url) {
        return Reply::json(&false);
    }
    blocking(move || {
        let _held = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let file = user_data.join(FILE);
        let mut store = load(&file);
        visited(&mut store, &url, &title, now_ms());
        save(&file, &store)?;
        Reply::json(&true)
    })
    .await
}

async fn list(call: Call) -> Result<Reply, Fault> {
    let ListParams {
        user_data,
        query,
        limit,
    } = call.params()?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_ENTRIES);
    blocking(move || {
        let _held = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        Reply::json(&suggestions(&load(&user_data.join(FILE)), &query, limit))
    })
    .await
}

async fn remove(call: Call) -> Result<Reply, Fault> {
    let RemoveParams { user_data, url } = call.params()?;
    blocking(move || {
        let _held = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let file = user_data.join(FILE);
        let mut store = load(&file);
        let before = store.entries.len();
        store.entries.retain(|entry| entry.url != url);
        if store.entries.len() != before {
            save(&file, &store)?;
        }
        Reply::json(&())
    })
    .await
}

async fn clear(call: Call) -> Result<Reply, Fault> {
    let ClearParams { user_data } = call.params()?;
    blocking(move || {
        let _held = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        save(&user_data.join(FILE), &Store::default())?;
        Reply::json(&())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(urls: &[(&str, &str, f64, u32)]) -> Store {
        Store {
            entries: urls
                .iter()
                .map(|(url, title, at, visits)| Entry {
                    url: (*url).to_owned(),
                    title: (*title).to_owned(),
                    at: *at,
                    visits: *visits,
                })
                .collect(),
        }
    }

    #[test]
    fn keeps_only_web_addresses_without_credentials() {
        assert!(keepable("http://localhost:3000/"));
        assert!(keepable("https://example.com/a?b#c"));
        assert!(!keepable("https://user:pw@example.com/"));
        assert!(!keepable("file:///etc/passwd"));
        assert!(!keepable("omp-visual://v1-abc/index.html"));
        assert!(!keepable("http:///path"));
        assert!(!keepable(&format!("https://example.com/{}", "a".repeat(MAX_URL))));
    }

    #[test]
    fn a_visit_moves_its_address_to_the_front_and_counts_it() {
        let mut kept = store(&[("https://a.test/", "A", 1.0, 1), ("https://b.test/", "B", 2.0, 4)]);
        visited(&mut kept, "https://b.test/", "", 3.0);
        visited(&mut kept, "https://c.test/", "  C  ", 4.0);
        let read: Vec<(&str, &str, u32)> = kept
            .entries
            .iter()
            .map(|entry| (entry.url.as_str(), entry.title.as_str(), entry.visits))
            .collect();
        // An empty title keeps the one seen before.
        assert_eq!(
            read,
            [("https://c.test/", "C", 1), ("https://b.test/", "B", 5), ("https://a.test/", "A", 1)]
        );
    }

    #[test]
    fn keeps_the_newest_addresses_up_to_the_cap() {
        let mut kept = Store::default();
        for index in 0..MAX_ENTRIES + 3 {
            visited(&mut kept, &format!("https://site{index}.test/"), "", index as f64);
        }
        assert_eq!(kept.entries.len(), MAX_ENTRIES);
        assert_eq!(kept.entries[0].url, format!("https://site{}.test/", MAX_ENTRIES + 2));
        assert!(!kept.entries.iter().any(|entry| entry.url == "https://site0.test/"));
    }

    #[test]
    fn suggests_a_host_that_starts_with_the_query_before_other_matches() {
        let kept = store(&[
            ("https://docs.example.com/local", "Docs", 9.0, 9),
            ("http://localhost:5173/", "Vite", 1.0, 1),
            ("https://www.localhost.dev/", "Other", 2.0, 2),
            ("https://unrelated.test/", "Nothing", 3.0, 3),
        ]);
        let urls: Vec<String> = suggestions(&kept, "LOCAL", 8)
            .into_iter()
            .map(|entry| entry.url)
            .collect();
        assert_eq!(
            urls,
            ["https://www.localhost.dev/", "http://localhost:5173/", "https://docs.example.com/local"]
        );
        assert_eq!(suggestions(&kept, "", 2).len(), 2);
        assert_eq!(suggestions(&kept, "vite", 8)[0].url, "http://localhost:5173/");
    }

    #[test]
    fn a_damaged_file_reads_as_no_history() {
        let dir = std::env::temp_dir().join(format!("ompdesk-browsing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(FILE);
        std::fs::write(&file, b"{not json").unwrap();
        assert!(load(&file).entries.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
