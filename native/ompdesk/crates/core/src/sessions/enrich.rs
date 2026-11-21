//! OMPdesk's two display fields, read against the stock listing's size and original mtime.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::activity::last_activity;
use super::search::open_journal;
use super::title::{TitleScan, read_title};
use super::{INDEXES, locked};
use crate::server::{Fault, Reply};

#[derive(Deserialize)]
pub(super) struct Params {
    index: String,
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

impl Cache {
    fn refresh(&mut self, root: &Path, row: &mut Row) {
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
        let at = last_activity(&mut file, row.size);
        self.rows.insert(
            row.path.clone(),
            Known {
                id: std::mem::take(&mut row.id),
                modified: std::mem::take(&mut row.modified),
                size: row.size,
                complete: title.is_ok() && at.is_ok(),
                at: at.ok().flatten(),
                title: title.ok().flatten(),
                listed: true,
            },
        );
    }
}

pub(super) fn listed(mut params: Params) -> Result<Reply, Fault> {
    let cache = Arc::clone(&locked(&INDEXES).entry(params.index).or_default().enrichment);
    let mut cache = locked(&cache);
    if params.full {
        for known in cache.rows.values_mut() {
            known.listed = false;
        }
    }
    if params.root.is_absolute()
        && let Ok(root) = params.root.canonicalize()
    {
        if cache.root != root {
            cache.root.clone_from(&root);
            cache.rows.clear();
        }
        for row in &mut params.rows {
            cache.refresh(&root, row);
        }
    } else {
        cache.rows.clear();
    }
    if params.full {
        cache.rows.retain(|_, known| known.listed);
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
