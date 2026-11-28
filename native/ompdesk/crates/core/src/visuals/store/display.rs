//! What the window needs for All visuals, the page URL and its version menu. Never serialize storage fields here.
use super::{Kind, Record, Version};
use serde::{Serialize, Serializer};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary<'a> {
    id: &'a str,
    label: &'a str,
    kind: Kind,
    target: &'a str,
    cwd: &'a str,
    created_at: u64,
    updated_at: u64,
    versions: usize,
}

#[derive(Serialize)]
struct Item<'a> {
    record: Summary<'a>,
    entry: &'a str,
    latest: u64,
    versions: Menu<'a>,
}

struct Menu<'a>(&'a [Version]);
impl Serialize for Menu<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Choice {
            version: u64,
            created_at: u64,
        }
        serializer.collect_seq(self.0.iter().map(|v| Choice {
            version: v.version,
            created_at: v.created_at,
        }))
    }
}

fn item(r: &Record) -> Item<'_> {
    Item {
        record: Summary {
            id: &r.id,
            label: &r.label,
            kind: r.kind,
            target: &r.target,
            cwd: &r.cwd,
            created_at: r.created_at,
            updated_at: r.updated_at,
            versions: r.versions.len(),
        },
        entry: &r.entry,
        latest: r.versions.last().map_or(0, |v| v.version),
        versions: Menu(if r.kind == Kind::Url {
            &[]
        } else {
            &r.versions
        }),
    }
}

pub(super) struct History<'a>(pub(super) &'a [Record]);
impl Serialize for History<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(item))
    }
}

/// Just `record` of each catalog item, matching `VisualStore.list()` for `preview:visuals`.
pub(super) struct Summaries<'a>(pub(super) &'a [Record]);
impl Serialize for Summaries<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(|r| item(r).record))
    }
}

pub(super) fn opened(
    record: &Record,
    added: bool,
    evicted: &[Record],
) -> Result<crate::server::Reply, crate::server::Fault> {
    struct Ids<'a>(&'a [Record]);
    impl Serialize for Ids<'_> {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_seq(self.0.iter().map(|r| &r.id))
        }
    }
    #[derive(Serialize)]
    struct Opened<'a> {
        item: Item<'a>,
        added: bool,
        evicted: Ids<'a>,
    }
    crate::server::Reply::json(&Opened {
        item: item(record),
        added,
        evicted: Ids(evicted),
    })
}
