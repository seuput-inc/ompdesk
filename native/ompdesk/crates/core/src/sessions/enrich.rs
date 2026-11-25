//! OMPdesk's two display fields, read against the stock listing's size and original mtime.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::activity::last_activity;
use super::search::open_journal;
use super::title::{TitleScan, read_title};
use super::{INDEXES, blocking, locked};
use crate::server::{Call, Fault, Reply};
use crate::stock::request_in_process;

#[derive(Deserialize)]
struct Params {
    index: String,
    host: String,
    root: PathBuf,
    full: bool,
    rows: Vec<Row>,
}

#[derive(Deserialize)]
struct Row {
    path: PathBuf,
    id: String,
    modified: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Patch<'a> {
    row: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auto_title: Option<&'a str>,
}

struct Known {
    id: String,
    modified: String,
    size: u64,
    at: Option<i64>,
    title: Option<TitleScan>,
    complete: bool,
    listed: bool,
}

#[derive(Default)]
pub(super) struct Cache {
    root: PathBuf,
    rows: HashMap<PathBuf, Known>,
}

struct Unparsed {
    row: usize,
    dates: Vec<String>,
    cacheable: bool,
}

impl Cache {
    fn refresh(
        &mut self,
        root: &Path,
        row: &mut Row,
        position: usize,
        unparsed: &mut Vec<Unparsed>,
    ) {
        if let Some(before) = self.rows.get_mut(&row.path)
            && before.complete
            && before.size == row.size
            && before.modified == row.modified
            && before.id == row.id
        {
            before.listed = true;
            return;
        }
        let previous = self.rows.remove(&row.path);
        let Some((mut file, _)) = open_journal(root, &row.path) else {
            return;
        };
        let previous = previous
            .filter(|before| before.id == row.id)
            .and_then(|before| before.title);
        let title = read_title(&mut file, row.size, previous);
        let mut dates = Vec::new();
        let at = last_activity(&mut file, row.size, &mut dates);
        if at.is_err() {
            dates.clear();
        }
        let mut complete = title.is_ok() && at.is_ok();
        if !dates.is_empty() {
            unparsed.push(Unparsed {
                row: position,
                dates,
                cacheable: std::mem::take(&mut complete),
            });
        }
        self.rows.insert(
            row.path.clone(),
            Known {
                id: std::mem::take(&mut row.id),
                modified: std::mem::take(&mut row.modified),
                size: row.size,
                complete,
                at: at.ok().flatten(),
                title: title.ok().flatten(),
                listed: true,
            },
        );
    }

    fn scan(&mut self, params: &mut Params) -> Vec<Unparsed> {
        let mut unparsed = Vec::new();
        if params.full {
            for known in self.rows.values_mut() {
                known.listed = false;
            }
        }
        if params.root.is_absolute()
            && let Ok(root) = params.root.canonicalize()
        {
            if self.root != root {
                self.root.clone_from(&root);
                self.rows.clear();
            }
            for (position, row) in params.rows.iter_mut().enumerate() {
                self.refresh(&root, row, position, &mut unparsed);
            }
        } else {
            self.rows.clear();
        }
        if params.full {
            self.rows.retain(|_, known| known.listed);
        }
        unparsed
    }
}

pub(super) async fn listed(call: Call) -> Result<Reply, Fault> {
    let mut params: Params = call.params()?;
    let cache = Arc::clone(
        &locked(&INDEXES)
            .entry(std::mem::take(&mut params.index))
            .or_default()
            .enrichment,
    );
    let mut cache = cache.lock_owned().await;
    let (mut cache, params, mut pending) = blocking(move || {
        let pending = cache.scan(&mut params);
        Ok((cache, params, pending))
    })
    .await?;

    // Only exceptional timestamps cross to Bun, never file paths, entries or message bodies.
    // Leave the row retryable until the worker has answered; warm lists keep only milliseconds.
    if !pending.is_empty() {
        let groups = serde_json::Value::Array(
            pending
                .iter_mut()
                .map(|row| serde_json::Value::from(std::mem::take(&mut row.dates)))
                .collect(),
        );
        let answer = request_in_process(
            &call.events,
            &params.host,
            "sessions.parseDates",
            &groups,
            Duration::from_secs(30),
        )
        .await?;
        let times: Vec<Option<i64>> = serde_json::from_value(answer)
            .map_err(|_| Fault::new("stock_answer", "Invalid parsed session dates"))?;
        if times.len() != pending.len() {
            return Err(Fault::new("stock_answer", "Missing parsed session dates"));
        }
        for (entry, time) in pending.into_iter().zip(times) {
            if let Some(known) = cache.rows.get_mut(&params.rows[entry.row].path) {
                known.at = time.or(known.at);
                known.complete = entry.cacheable;
            }
        }
    }
    let patches: Vec<_> = params
        .rows
        .iter()
        .enumerate()
        .filter_map(|(row, input)| {
            let known = cache.rows.get(&input.path)?;
            let auto_title = known.title.as_ref().and_then(TitleScan::shown);
            (known.at.is_some() || auto_title.is_some()).then_some(Patch {
                row,
                at: known.at,
                auto_title,
            })
        })
        .collect();
    Reply::json(&patches)
}
