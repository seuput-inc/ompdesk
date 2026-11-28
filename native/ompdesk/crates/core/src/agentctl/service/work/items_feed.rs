//! Protocol 2 reads are scoped to exactly one host. Neither the local store nor this host's
//! version chain contains a paired host's rows.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;

use serde_json::{Value, json};

use super::super::fail::{Fail, R, fail};
use super::super::host::HostState;
use super::super::js::trim;
use super::super::{AgentControl, lock};
use super::bots::{BotView, new_id};
use super::items::{item_store_error, read_facts, session_state};
use crate::agentctl::journal::bots::BotRecord;
use crate::agentctl::journal::items::{ItemRecord, Items};
use crate::agentctl::journal::looks::OPEN_FOR_MS;

const MAX_SAFE: u64 = (1 << 53) - 1;

fn invalid() -> Fail {
    Fail::Tool("Invalid protocol 2 item query.".into())
}

fn text(v: &Value, max: usize) -> R<&str> {
    v.as_str()
        .filter(|s| {
            !s.is_empty()
                && trim(s) == *s
                && !s.contains(char::is_control)
                && s.encode_utf16().take(max + 1).count() <= max
        })
        .ok_or_else(invalid)
}

fn integer(v: &Value, min: u64, max: u64) -> R<u64> {
    v.as_u64()
        .filter(|n| (min..=max).contains(n))
        .ok_or_else(invalid)
}

fn keys(v: &Value, allowed: &[&str]) -> R<()> {
    if v.as_object()
        .is_some_and(|obj| obj.keys().all(|key| allowed.contains(&key.as_str())))
    {
        Ok(())
    } else {
        Err(invalid())
    }
}

enum Query<'a> {
    Feed(Option<&'a str>),
    Page {
        bot: &'a str,
        before: Option<(f64, u32)>,
        unread: Option<u64>,
    },
    Detail {
        bot: &'a str,
        id: &'a Value,
        before: Option<u64>,
        after: Option<u64>,
    },
    Receipt {
        bot: &'a str,
        id: &'a Value,
        request: &'a str,
        question: Option<u64>,
    },
}

impl<'a> Query<'a> {
    fn parse(v: &'a Value) -> R<Self> {
        if v["protocol"] != 2 {
            return Err(invalid());
        }
        let optional_int = |key, min| v.get(key).map(|n| integer(n, min, MAX_SAFE)).transpose();
        match v["action"].as_str() {
            Some("itemsFeed") => {
                keys(v, &["protocol", "action", "since"])?;
                Ok(Self::Feed(
                    v.get("since").map(|s| text(s, 256)).transpose()?,
                ))
            }
            Some("itemsPage") => {
                keys(v, &["protocol", "action", "id", "before", "unreadSince"])?;
                let before = v
                    .get("before")
                    .map(|c| -> R<_> {
                        keys(c, &["at", "number"])?;
                        let at = c["at"]
                            .as_i64()
                            .filter(|n| n.unsigned_abs() <= MAX_SAFE)
                            .ok_or_else(invalid)?;
                        Ok((at as f64, integer(&c["number"], 1, u32::MAX.into())? as u32))
                    })
                    .transpose()?;
                Ok(Self::Page {
                    bot: text(&v["id"], 256)?,
                    before,
                    unread: optional_int("unreadSince", 0)?,
                })
            }
            Some("itemDetail") => {
                keys(
                    v,
                    &[
                        "protocol",
                        "action",
                        "id",
                        "bot",
                        "beforeEvent",
                        "afterEvent",
                    ],
                )?;
                let before = optional_int("beforeEvent", 1)?;
                let after = optional_int("afterEvent", 0)?;
                if before.is_some() && after.is_some() {
                    return Err(invalid());
                }
                let bot = text(&v["bot"], 256)?;
                let id = &v["id"];
                if id.is_string() {
                    text(id, 256)?;
                } else {
                    integer(id, 1, u32::MAX.into())?;
                }
                Ok(Self::Detail {
                    bot,
                    id,
                    before,
                    after,
                })
            }
            Some("itemReceipt") => {
                keys(
                    v,
                    &["protocol", "action", "id", "bot", "requestId", "question"],
                )?;
                let bot = text(&v["bot"], 256)?;
                let id = &v["id"];
                text(id, 256)?;
                Ok(Self::Receipt {
                    bot,
                    id,
                    request: text(&v["requestId"], 200)?,
                    question: optional_int("question", 1)?,
                })
            }
            _ => Err(invalid()),
        }
    }
}

struct View {
    epoch: String,
    offset: u64,
    floor: u64,
    stamp: Option<u64>,
    read_at: f64,
    expires: f64,
}

impl Default for View {
    fn default() -> Self {
        Self {
            epoch: new_id("items"),
            offset: 0,
            floor: 0,
            stamp: None,
            read_at: f64::NEG_INFINITY,
            expires: f64::INFINITY,
        }
    }
}

#[derive(Default)]
pub(crate) struct Views {
    local: View,
    peer: View,
}

// An item write advances the store's revision. Each invalidated metadata projection adds one
// to the wire counter and raises the oldest usable base; the two audiences never share bases.
impl View {
    fn current(&self, stamp: u64, now: f64) -> bool {
        self.stamp == Some(stamp) && (self.read_at..self.expires).contains(&now)
    }

    fn sync(&mut self, revision: u64, stamp: u64, now: f64) {
        if !self.current(stamp, now) {
            self.offset += 1;
            self.floor = revision + self.offset;
            self.stamp = Some(stamp);
            self.expires = f64::INFINITY;
        }
        self.read_at = now;
    }

    fn since(&self, version: &str, revision: u64) -> Option<u64> {
        let (epoch, number) = version.rsplit_once('.')?;
        let number = number.parse::<u64>().ok()?;
        (epoch == self.epoch && (self.floor..=revision + self.offset).contains(&number))
            .then(|| number - self.offset)
    }
}

// Runtime facts may change without a registry write. Hash only the tab facts these projections
// read and the external SOUL files' stamps, not the item table or the host's full snapshot.
fn dynamic_stamp(state: &HostState, bots: &[BotRecord]) -> u64 {
    let mut hash = DefaultHasher::new();
    for tab in &state.tabs {
        (
            &tab.tab_id,
            &tab.session_path,
            &tab.device,
            tab.busy,
            session_state(tab),
            tab.scheduled_retry
                .as_ref()
                .filter(|r| r.limit)
                .map(|r| r.at.to_bits()),
        )
            .hash(&mut hash);
    }
    for bot in bots {
        bot.id.hash(&mut hash);
        std::fs::metadata(Path::new(&bot.folder).join("SOUL.md"))
            .ok()
            .map(|s| (s.modified().ok(), s.len()))
            .hash(&mut hash);
    }
    hash.finish()
}

fn decorate(
    row: &mut Value,
    item: &ItemRecord,
    bot: Option<&BotRecord>,
    state: &HostState,
    now: f64,
    detail: bool,
) -> f64 {
    let (stale, limit) = read_facts(state, item, bot, |index, status| {
        if detail {
            row["links"][index]["state"] = json!(status);
        }
    });
    if detail && let Some(fields) = row.as_object_mut() {
        fields.remove("stale");
        fields.remove("limitUntil");
    }
    if stale.is_some_and(|at| now >= at) {
        row["stale"] = Value::Bool(true);
    }
    if let Some(limit) = limit {
        row["limitUntil"] = Value::String(limit);
    }
    stale.filter(|at| *at > now).unwrap_or(f64::INFINITY)
}

fn decorate_rows(
    rows: &mut Value,
    items: &Items,
    bots: &[BotRecord],
    state: &HostState,
    now: f64,
) -> R<f64> {
    let mut expires = f64::INFINITY;
    for row in rows.as_array_mut().ok_or_else(invalid)? {
        let item = row["id"]
            .as_str()
            .and_then(|id| items.get(id))
            .ok_or_else(invalid)?;
        let bot = bots.iter().find(|bot| bot.id == item.bot);
        expires = expires.min(decorate(row, item, bot, state, now, false));
    }
    Ok(expires)
}

impl AgentControl {
    /// Only the owner's entry accepts a host. Main validates the remote reply for this request
    /// at the link boundary (including a negotiated old-host projection); errors stay errors.
    pub(crate) async fn items_query(&self, mut request: Value) -> R<Value> {
        let device = request
            .as_object_mut()
            .and_then(|r| r.remove("device"))
            .ok_or_else(invalid)?;
        let query = Query::parse(&request)?;
        if device.is_null() {
            return self.read_items_v2(query, false);
        }
        let device = text(&device, 256)?;
        if self.host.state().device(device).is_none() {
            return fail("Select a paired computer by its id.");
        }
        let answer: Value = self
            .host
            .ask(
                "remoteItemsQuery",
                json!({"device":device,"request":request}),
            )
            .await?;
        if answer["protocol"] != 2 {
            return fail("The paired computer did not answer the protocol 2 item query.");
        }
        Ok(answer)
    }

    pub(crate) fn items_query_from(&self, request: &Value) -> R<Value> {
        self.read_items_v2(Query::parse(request)?, true)
    }

    fn read_items_v2(&self, query: Query<'_>, peer: bool) -> R<Value> {
        if let Query::Feed(since) = query {
            return self.items_feed(since, peer);
        }
        let state = self.host.state();
        let now = self.now();
        let bots = self.bots();
        let items = self.items();
        let own = |id: &str| {
            bots.all()
                .iter()
                .find(|b| b.id == id)
                .ok_or_else(|| Fail::Tool("No such bot on this computer.".into()))
        };
        let mut answer = match query {
            Query::Page {
                bot,
                before,
                unread,
            } => {
                let bot = own(bot)?;
                let mut page = items.items_page(&bot.id, before, unread, now);
                decorate_rows(
                    &mut page["closed"],
                    &items,
                    std::slice::from_ref(bot),
                    &state,
                    now,
                )?;
                page
            }
            Query::Detail {
                bot,
                id,
                before,
                after,
            } => {
                let bot = own(bot)?;
                let mut detail = items
                    .item_detail(&bot.id, id, before, after)
                    .map_err(item_store_error)?;
                let item = detail["item"]["id"]
                    .as_str()
                    .and_then(|id| items.get(id))
                    .ok_or_else(invalid)?;
                decorate(&mut detail["item"], item, Some(bot), &state, now, true);
                detail
            }
            Query::Receipt {
                bot,
                id,
                request,
                question,
            } => {
                own(bot)?;
                items
                    .item_receipt(bot, id, request, question)
                    .map_err(item_store_error)?
            }
            Query::Feed(_) => unreachable!(),
        };
        answer["protocol"] = json!(2);
        Ok(answer)
    }

    fn items_feed(&self, since: Option<&str>, peer: bool) -> R<Value> {
        let mut views = lock(&self.items_feed);
        let state = self.host.state();
        let state = state.as_ref();
        let now = self.now();
        let view = if peer {
            &mut views.peer
        } else {
            &mut views.local
        };
        let bots = self.bots();
        let stamp = dynamic_stamp(state, bots.all());
        let mut items = self.items();
        let clock_changed = items.refresh_archive_clock(now);
        let revision = items.feed_revision();
        if clock_changed || (view.stamp.is_some() && !view.current(stamp, now)) {
            self.host.port().tell("itemsV2Changed", &json!({}));
        }
        view.sync(revision, stamp, now);
        let base = since.and_then(|version| view.since(version, revision));
        let mut answer = items.feed_rows(base);
        let seed = answer.get("open").is_some();
        let field = if seed { "open" } else { "set" };
        let expiry = decorate_rows(&mut answer[field], &items, bots.all(), state, now)?;
        drop(items);
        if seed {
            view.expires = expiry;
            let records = bots.all().to_owned();
            drop(bots);
            // Rooms and looks have their own locks, never taken with the bots or items locks.
            for bot in &records {
                if answer["counts"].get(&bot.id).is_none() {
                    answer["counts"][&bot.id] =
                        json!({"openCount":0,"closedTotal":0,"archiveRevision":0});
                }
            }
            let metadata = self.bot_metadata(
                &records,
                state,
                now,
                if peer { BotView::Peer } else { BotView::Local },
            );
            if let Value::Object(fields) = metadata {
                for (key, value) in fields {
                    if key == "looks" {
                        for look in value.as_array().into_iter().flatten() {
                            for at in look["items"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|s| s["createdAt"].as_f64())
                            {
                                view.expires = view.expires.min((at + OPEN_FOR_MS).next_up());
                            }
                        }
                    }
                    answer[key] = value;
                }
            }
        } else {
            view.expires = view.expires.min(expiry);
            answer["base"] = json!(since);
        }
        answer["protocol"] = json!(2);
        answer["kind"] = json!(if seed { "seed" } else { "delta" });
        answer["version"] = json!(format!("{}.{}", view.epoch, revision + view.offset));
        Ok(answer)
    }

    pub(super) fn items_v2_changed(&self, metadata: bool) {
        if metadata {
            let mut views = lock(&self.items_feed);
            views.local.stamp = None;
            views.peer.stamp = None;
        }
        self.host.port().tell("itemsV2Changed", &json!({}));
    }

    pub(super) fn observe_items_v2(&self, state: &HostState) {
        let mut views = lock(&self.items_feed);
        if views.local.stamp.is_none() && views.peer.stamp.is_none() {
            return;
        }
        let stamp = dynamic_stamp(state, self.bots().all());
        let now = self.now();
        let Views { local, peer } = &mut *views;
        let mut changed = self.items().refresh_archive_clock(now);
        for view in [local, peer] {
            if view.stamp.is_some() && !view.current(stamp, now) {
                view.stamp = None;
                changed = true;
            }
        }
        if changed {
            self.host.port().tell("itemsV2Changed", &json!({}));
        }
    }
}
