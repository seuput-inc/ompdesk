//! The recall gate's local document frequencies. Cursors and counts are committed together only
//! after both streams finish. Deletions are not subtracted until a store change or rewind rebuilds them.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::store::{Store, cursor_fits, position};
use super::wire::Source;
use crate::aimemory::client::Server;
use crate::disk::tree::write_atomic;
use crate::server::{Events, Fault, Scope};
use crate::stock::request_in_process;

const PAGE: u64 = 200;

#[derive(Default, Deserialize, Serialize)]
struct Corpus {
    v: u8,
    store: String,
    native: u64,
    synced: u64,
    n: u64,
    df: BTreeMap<String, u64>,
}

impl Corpus {
    fn parse(bytes: &[u8]) -> Option<Self> {
        let state: Self = serde_json::from_slice(bytes).ok()?;
        (state.v == 1 && state.df.values().all(|count| *count <= state.n)).then_some(state)
    }

    fn cursor(&mut self, source: Source) -> &mut u64 {
        match source {
            Source::Native => &mut self.native,
            Source::Synced => &mut self.synced,
        }
    }

    fn add(&mut self, terms: Vec<Vec<String>>, rows: usize) -> Result<(), Fault> {
        if terms.len() != rows {
            return Err(Fault::new(
                "memory_facts",
                "Missing recall terms for a conclusion",
            ));
        }
        self.n = self
            .n
            .checked_add(rows as u64)
            .ok_or_else(|| Fault::new("invalid_corpus", "Too many conclusions"))?;
        // contentTerms returns distinct terms for each body, including an empty list for an empty body.
        for term in terms.into_iter().flatten() {
            *self.df.entry(term).or_default() += 1;
        }
        Ok(())
    }
}

pub(crate) async fn refresh(
    file: PathBuf,
    server: Server,
    events: &Events,
    stock_host: &str,
    scope: Scope,
) -> Result<(), Fault> {
    let store = Store::new(server);
    let mut saved = tokio::fs::read(&file)
        .await
        .ok()
        .and_then(|bytes| Corpus::parse(&bytes));
    'attempt: for _ in 0..2 {
        let mut known = saved.is_some();
        let mut changed = !known;
        let mut state = saved.take().unwrap_or_else(|| Corpus {
            v: 1,
            ..Corpus::default()
        });
        for source in [Source::Native, Source::Synced] {
            loop {
                let cursor = *state.cursor(source);
                let page = store.conclusions(source, cursor, PAGE).await?;
                if known && !cursor_fits(&page, cursor, Some(&state.store)) {
                    continue 'attempt;
                }
                if !known {
                    state.store = page.store;
                    known = true;
                }
                let next = position(&page.next);
                if next < cursor || (next == cursor && (page.more || !page.rows.is_empty())) {
                    return Err(Fault::new(
                        "invalid_corpus",
                        "Conclusion page did not advance",
                    ));
                }
                if !page.rows.is_empty() {
                    let count = page.rows.len();
                    let bodies = Value::Array(
                        page.rows
                            .into_iter()
                            .map(|row| Value::String(row.body))
                            .collect(),
                    );
                    let terms = request_in_process(
                        events,
                        stock_host,
                        "memory.recallTerms",
                        &bodies,
                        Duration::from_secs(30),
                    )
                    .await?;
                    let terms = serde_json::from_value(terms)
                        .map_err(|error| Fault::new("memory_facts", error.to_string()))?;
                    state.add(terms, count)?;
                }
                changed |= next != cursor;
                *state.cursor(source) = next;
                if !page.more {
                    break;
                }
            }
        }
        if changed {
            tokio::task::spawn_blocking(move || {
                let bytes = serde_json::to_vec(&state)
                    .map_err(|error| Fault::new("internal", error.to_string()))?;
                write_atomic(&file, &bytes, 0o600, 0o777, &scope)
            })
            .await
            .map_err(|error| Fault::new("internal", error.to_string()))??;
        }
        return Ok(());
    }
    Err(Fault::new(
        "invalid_corpus",
        "Conclusion store changed during rebuild",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_each_captured_document_including_those_without_terms() {
        let captured: Value = serde_json::from_str(include_str!("recall-corpus.json")).unwrap();
        let terms = serde_json::from_value(captured["terms"].clone()).unwrap();
        let mut state = Corpus::default();
        state
            .add(terms, captured["bodies"].as_array().unwrap().len())
            .unwrap();
        assert_eq!(json!({"n": state.n, "df": state.df}), captured["stats"]);
        assert!(state.add(vec![], 1).is_err());
    }

    #[test]
    fn rebuilds_an_unusable_stats_file() {
        let saved = br#"{"v":1,"store":"db","native":2,"synced":0,"n":2,"df":{"term":2}}"#;
        assert_eq!(Corpus::parse(saved).unwrap().native, 2);
        assert!(Corpus::parse(b"{").is_none());
        let unknown = br#"{"v":2,"store":"db","native":0,"synced":0,"n":0,"df":{}}"#;
        let broken = br#"{"v":1,"store":"db","native":0,"synced":0,"n":1,"df":{"term":"broken"}}"#;
        assert!(Corpus::parse(unknown).is_none());
        assert!(Corpus::parse(broken).is_none());
    }
}
