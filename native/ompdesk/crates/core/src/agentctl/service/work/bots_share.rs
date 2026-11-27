//! Bots on paired computers (orca-bots-remote; the owner's decision of 27 Nov 2026, Orca's
//! `src/main/bots/bot-registry.ts:1-60` keeps a bot on the computer that made it). A bot lives and runs on one
//! computer: its folder, memory, schedules and items stay in that computer's registry. That computer shares its bots
//! and items with the devices paired to it; each device keeps the last copy of every host's and sends its changes to
//! the host that owns the bot (`botsCommand`), whose answer is the next copy. Nothing is replicated and nothing is
//! written on the device.
//!
//! What crosses is versioned as the session list is (`shared/session-list-delta.ts`, `SessionListShare`): the whole
//! copy `{version, state}`, or a change `{base, version, set, remove}` by id, so a change crosses as the rows it touched
//! and a device that missed one (its copy is not at `base`) reads the whole copy again.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{Value, json};

use crate::agentctl::journal::{read_array, stringify, write_text};

/// One kind of row that crosses: a bot, or an item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Bots,
    Items,
}

/// A computer's bots and items by id, in the order its state lists them.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Rows {
    bots: Vec<(String, Value)>,
    items: Vec<(String, Value)>,
}

fn copy_row(row: &Value, kind: Kind) -> Value {
    let mut row = row.clone();
    if kind == Kind::Bots
        && let Some(fields) = row.as_object_mut()
    {
        let workers = fields
            .remove("workers")
            .or_else(|| fields.remove("workerLinks"));
        if let Some(Value::Array(workers)) = workers {
            let links: Vec<Value> = workers
                .iter()
                .filter_map(|worker| {
                    let session = worker["session"].as_str()?;
                    let opener = worker["openedBySession"].as_str()?;
                    (session.ends_with(".jsonl") && opener.ends_with(".jsonl"))
                        .then(|| json!({"session": session, "openedBySession": opener}))
                })
                .collect();
            fields.insert("workerLinks".into(), Value::Array(links));
        }
        for key in ["picture", "launch", "skillProjects"] {
            fields.remove(key);
        }
    }
    row
}

fn rows_of(list: Option<&Value>, kind: Kind) -> Vec<(String, Value)> {
    list.and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| Some((row.get("id")?.as_str()?.to_owned(), copy_row(row, kind))))
                .collect()
        })
        .unwrap_or_default()
}

fn values(rows: &[(String, Value)]) -> Vec<Value> {
    rows.iter().map(|(_, row)| row.clone()).collect()
}

/// What turns `before` into `after`: the rows new or different, and the ids no longer there.
fn diff(before: &[(String, Value)], after: &[(String, Value)]) -> (Vec<Value>, Vec<String>) {
    let set = after
        .iter()
        .filter(|(id, row)| !before.iter().any(|(old, was)| old == id && was == row))
        .map(|(_, row)| row.clone())
        .collect();
    let remove = before
        .iter()
        .filter(|(id, _)| !after.iter().any(|(new, _)| new == id))
        .map(|(id, _)| id.clone())
        .collect();
    (set, remove)
}

/// `rows` with `remove` gone and `set` in place (a new id goes last, as a host lists a new row).
fn apply(rows: &mut Vec<(String, Value)>, kind: Kind, set: Option<&Value>, remove: Option<&Value>) {
    let gone: Vec<&str> = remove
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    rows.retain(|(id, _)| !gone.contains(&id.as_str()));
    for row in set.and_then(Value::as_array).into_iter().flatten() {
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            continue;
        };
        match rows.iter_mut().find(|(known, _)| known == id) {
            Some(slot) => slot.1 = copy_row(row, kind),
            None => rows.push((id.to_owned(), copy_row(row, kind))),
        }
    }
}

impl Rows {
    /// The rows of a `BotsState` (its rooms stay on their computer).
    pub(crate) fn of(state: &Value) -> Rows {
        Rows {
            bots: rows_of(state.get("bots"), Kind::Bots),
            items: rows_of(state.get("items"), Kind::Items),
        }
    }

    pub(crate) fn state(&self) -> Value {
        json!({ "bots": values(&self.bots), "items": values(&self.items) })
    }

    fn has(&self, kind: Kind, id: &str) -> bool {
        let rows = match kind {
            Kind::Bots => &self.bots,
            Kind::Items => &self.items,
        };
        rows.iter().any(|(known, _)| known == id)
    }
}

/// `a` comes before `b` of the same run (`epoch.n`); versions of two runs are never compared.
fn older(a: &str, b: &str) -> bool {
    let (Some((epoch_a, n_a)), Some((epoch_b, n_b))) = (a.rsplit_once('.'), b.rsplit_once('.'))
    else {
        return false;
    };
    epoch_a == epoch_b
        && matches!((n_a.parse::<u64>(), n_b.parse::<u64>()), (Ok(x), Ok(y)) if x < y)
}

/// What this computer shares with its paired devices: its rows at a version (`epoch.n`, a new epoch each run, so a
/// copy of another run never matches).
pub(crate) struct Share {
    epoch: String,
    n: u64,
    rows: Option<Rows>,
}

impl Share {
    pub(crate) fn new(epoch: String) -> Share {
        Share {
            epoch,
            n: 0,
            rows: None,
        }
    }

    fn version(&self) -> String {
        format!("{}.{}", self.epoch, self.n)
    }

    /// Takes this computer's state as it is now: the change devices get, None when nothing changed or nothing was
    /// shared before (a device reads the whole copy as its link comes up).
    pub(crate) fn take(&mut self, state: &Value) -> Option<Value> {
        let rows = Rows::of(state);
        let held = self.rows.as_ref();
        if held == Some(&rows) {
            return None;
        }
        let base = self.version();
        self.n += 1;
        let change = held.map(|held| {
            let (bots, bots_gone) = diff(&held.bots, &rows.bots);
            let (items, items_gone) = diff(&held.items, &rows.items);
            json!({
                "base": base,
                "version": self.version(),
                "set": { "bots": bots, "items": items },
                "remove": { "bots": bots_gone, "items": items_gone },
            })
        });
        self.rows = Some(rows);
        change
    }

    /// The whole copy at its version (`{version, state}`); call `take` first.
    pub(crate) fn whole(&self) -> Value {
        json!({
            "version": self.version(),
            "state": self.rows.as_ref().map(Rows::state).unwrap_or_else(|| Rows::default().state()),
        })
    }
}

/// A paired host's bots as this computer last heard them.
#[derive(Clone, Debug)]
pub(crate) struct HostCopy {
    pub(crate) name: String,
    pub(crate) online: bool,
    version: String,
    rows: Rows,
}

/// Every paired host's copy, by its device id, kept in `bots-remote.json` beside the bots (0600, written whole on each
/// change, its link read as down when loaded), so a host that is away after a relaunch still lists its bots.
#[derive(Default)]
pub(crate) struct Copies {
    file: Option<PathBuf>,
    hosts: BTreeMap<String, HostCopy>,
}

impl Copies {
    /// The copies kept in `file` (None: memory only); a damaged entry is left out.
    pub(crate) fn load(file: Option<PathBuf>) -> Copies {
        let mut legacy = false;
        let hosts = file
            .as_deref()
            .map(read_array)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|entry| {
                legacy |= entry["state"]["bots"]
                    .as_array()
                    .is_some_and(|bots| bots.iter().any(|bot| bot.get("picture").is_some()));
                let text = |key: &str| entry.get(key)?.as_str().map(str::to_owned);
                Some((
                    text("device")?,
                    HostCopy {
                        name: text("name")?,
                        online: false,
                        version: text("version")?,
                        rows: Rows::of(entry.get("state")?),
                    },
                ))
            })
            .collect();
        let copies = Copies { file, hosts };
        if legacy {
            copies.save();
        }
        copies
    }

    fn save(&self) {
        let Some(file) = &self.file else { return };
        let entries: Vec<Value> = self
            .hosts
            .iter()
            .map(|(device, copy)| {
                json!({ "device": device, "name": copy.name, "version": copy.version, "state": copy.rows.state() })
            })
            .collect();
        if let Err(error) = write_text(file, &stringify(entries), Some(0o600)) {
            eprintln!("[bots] paired hosts' bots not saved: {error}");
        }
    }

    /// Applies what `device` sent: its whole copy, a change of the copy held, or (no change) its name and link. False
    /// when the change is made on a version this copy does not hold: the whole copy is read again.
    pub(crate) fn apply(
        &mut self,
        device: &str,
        name: &str,
        online: bool,
        change: Option<&Value>,
    ) -> bool {
        let Some(change) = change else {
            if let Some(copy) = self.hosts.get_mut(device) {
                copy.name = name.to_owned();
                copy.online = online;
            }
            return true;
        };
        let version = change.get("version").and_then(Value::as_str).unwrap_or("");
        if let Some(state) = change.get("state") {
            let behind = self
                .hosts
                .get(device)
                .is_some_and(|copy| older(version, &copy.version));
            if behind {
                // A read that answers behind a change already applied keeps the newer copy.
                if let Some(copy) = self.hosts.get_mut(device) {
                    copy.name = name.to_owned();
                    copy.online = online;
                }
                return true;
            }
            self.hosts.insert(
                device.to_owned(),
                HostCopy {
                    name: name.to_owned(),
                    online,
                    version: version.to_owned(),
                    rows: Rows::of(state),
                },
            );
            self.save();
            return true;
        }
        let base = change.get("base").and_then(Value::as_str).unwrap_or("");
        let Some(copy) = self
            .hosts
            .get_mut(device)
            .filter(|copy| copy.version == base && !version.is_empty())
        else {
            return false;
        };
        let (set, remove) = (change.get("set"), change.get("remove"));
        apply(
            &mut copy.rows.bots,
            Kind::Bots,
            set.and_then(|set| set.get("bots")),
            remove.and_then(|remove| remove.get("bots")),
        );
        apply(
            &mut copy.rows.items,
            Kind::Items,
            set.and_then(|set| set.get("items")),
            remove.and_then(|remove| remove.get("items")),
        );
        copy.version = version.to_owned();
        copy.name = name.to_owned();
        copy.online = online;
        self.save();
        true
    }

    /// A host no longer paired: its copy goes.
    pub(crate) fn forget(&mut self, device: &str) -> bool {
        let gone = self.hosts.remove(device).is_some();
        if gone {
            self.save();
        }
        gone
    }

    /// The host whose copy holds the bot or item `id`.
    pub(crate) fn owner(&self, kind: Kind, id: &str) -> Option<String> {
        self.hosts
            .iter()
            .find(|(_, copy)| copy.rows.has(kind, id))
            .map(|(device, _)| device.clone())
    }

    /// The copy of paired host `device`.
    pub(crate) fn host(&self, device: &str) -> Option<&HostCopy> {
        self.hosts.get(device)
    }

    pub(crate) fn has_chat(&self, device: &str, session: &str, folder: &str) -> bool {
        self.host(device).is_some_and(|host| {
            host.rows.bots.iter().any(|(_, bot)| {
                bot["folder"].as_str() == Some(folder)
                    || bot["home"].as_str() == Some(session)
                    || bot["sessions"].as_array().is_some_and(|chats| {
                        chats.iter().any(|chat| chat.as_str() == Some(session))
                    })
            })
        })
    }

    /// A paired host's bot by its id, else its name (any case): its host and its row.
    pub(crate) fn bot(&self, key: &str) -> Option<(String, Value)> {
        let rows = || {
            self.hosts
                .iter()
                .flat_map(|(device, copy)| copy.rows.bots.iter().map(move |(_, bot)| (device, bot)))
        };
        let named = |bot: &Value| {
            bot.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.to_lowercase() == key.to_lowercase())
        };
        rows()
            .find(|(_, bot)| bot.get("id").and_then(Value::as_str) == Some(key))
            .or_else(|| rows().find(|(_, bot)| named(bot)))
            .map(|(device, bot)| (device.clone(), bot.clone()))
    }

    /// The bot of paired host `device` whose chats run in `folder` (a tab of that host in it is one of its chats).
    pub(crate) fn bot_in_folder(&self, device: &str, folder: &str) -> Option<Value> {
        self.hosts
            .get(device)?
            .rows
            .bots
            .iter()
            .map(|(_, bot)| bot)
            .find(|bot| bot.get("folder").and_then(Value::as_str) == Some(folder))
            .cloned()
    }

    /// `BotsState.remote`: each host's copy with its name and whether its link is up.
    pub(crate) fn json(&self) -> Vec<Value> {
        self.hosts
            .iter()
            .map(|(device, copy)| {
                let mut value = copy.rows.state();
                value["device"] = json!(device);
                value["name"] = json!(copy.name);
                value["online"] = json!(copy.online);
                value
            })
            .collect()
    }
}

/// A group on a paired device that asked one of this computer's bots (`roomAsk`): the bot's post to it goes back there.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AskedRoom {
    pub(crate) bot: String,
    pub(crate) room: String,
    pub(crate) name: String,
    pub(crate) device: String,
    pub(crate) device_name: String,
}

/// What this computer shares, what it holds of its hosts', and the devices' groups its bots were asked in.
pub(crate) struct Across {
    pub(crate) share: Share,
    pub(crate) copies: Copies,
    /// Kept for this run only: a bot asked again after a relaunch is remembered again.
    pub(crate) asked: Vec<AskedRoom>,
}

impl Across {
    /// A new run's (its versions start a new epoch), over the copies kept in `file`.
    pub(crate) fn started(file: Option<PathBuf>) -> Across {
        Across {
            share: Share::new(super::bots::new_id("bots")),
            copies: Copies::load(file),
            asked: Vec::new(),
        }
    }

    /// Remembers that `asked.device`'s group asked `asked.bot` (its name and the device's as they are now).
    pub(crate) fn remember(&mut self, asked: AskedRoom) {
        self.asked
            .retain(|known| !(known.bot == asked.bot && known.room == asked.room));
        self.asked.push(asked);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(bots: &[(&str, &str)], items: &[(&str, &str)]) -> Value {
        json!({
            "bots": bots.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
            "items": items.iter().map(|(id, status)| json!({ "id": id, "status": status })).collect::<Vec<_>>(),
            "rooms": [{ "id": "room-1" }],
        })
    }

    #[test]
    fn paired_copies_keep_saved_worker_links_but_not_worker_activity() {
        let mut share = Share::new("epoch".into());
        let mut host = state(&[("bot", "Courier")], &[]);
        host["bots"][0]["workers"] = json!([
            {"session": "/child.jsonl", "openedBySession": "/parent.jsonl", "title": "local", "cwd": "/repo"},
            {"session": "closed-before-save", "openedBySession": "/parent.jsonl"},
            {"session": "/legacy.jsonl"}
        ]);
        share.take(&host);
        let mut copies = Copies::default();
        assert!(copies.apply("host", "Studio", true, Some(&share.whole())));
        let row = &copies.json()[0]["bots"][0];
        assert_eq!(
            row["workerLinks"],
            json!([{"session": "/child.jsonl", "openedBySession": "/parent.jsonl"}])
        );
        assert!(row.get("workers").is_none());
        host["bots"][0]["workers"] = json!([]);
        assert!(copies.apply("host", "Studio", true, share.take(&host).as_ref()));
        assert_eq!(copies.json()[0]["bots"][0]["workerLinks"], json!([]));
    }

    #[test]
    fn a_change_crosses_as_the_rows_it_touched_and_rebuilds_the_hosts_copy() {
        let mut share = Share::new("e1".into());
        let first = state(
            &[("bot-a", "Ada"), ("bot-b", "Bo")],
            &[("item-1", "planned")],
        );
        assert_eq!(share.take(&first), None);
        let whole = share.whole();
        assert_eq!(whole["version"], "e1.1");
        assert_eq!(whole["state"]["rooms"], Value::Null);
        assert_eq!(share.take(&first), None);
        let mut copies = Copies::default();
        assert!(copies.apply("dev-a", "Mini", true, Some(&whole)));

        let next = state(
            &[("bot-a", "Ada"), ("bot-b", "Bob")],
            &[("item-2", "needs_you")],
        );
        let change = share.take(&next).unwrap();
        assert_eq!(change["base"], "e1.1");
        assert_eq!(change["version"], "e1.2");
        assert_eq!(
            change["set"]["bots"],
            json!([{ "id": "bot-b", "name": "Bob" }])
        );
        assert_eq!(change["remove"]["items"], json!(["item-1"]));
        assert!(copies.apply("dev-a", "Mini", true, Some(&change)));
        let held = copies.json();
        assert_eq!(held[0]["bots"], next["bots"]);
        assert_eq!(held[0]["items"], next["items"]);
        assert_eq!(held[0]["name"], "Mini");
        assert_eq!(
            copies.owner(Kind::Items, "item-2").as_deref(),
            Some("dev-a")
        );
        assert!(copies.owner(Kind::Items, "item-1").is_none());
        // The same change again is on a version the copy left: the whole copy is read again.
        assert!(!copies.apply("dev-a", "Mini", true, Some(&change)));
    }

    #[test]
    fn a_read_behind_the_copy_keeps_it_and_another_runs_copy_replaces_it() {
        let mut share = Share::new("e1".into());
        share.take(&state(&[("bot-a", "Ada")], &[]));
        let old = share.whole();
        let change = share.take(&state(&[("bot-a", "Ada!")], &[])).unwrap();
        let mut copies = Copies::default();
        copies.apply("dev-a", "Mini", true, Some(&old));
        copies.apply("dev-a", "Mini", true, Some(&change));
        copies.apply("dev-a", "Mini", false, Some(&old));
        assert_eq!(copies.json()[0]["bots"][0]["name"], "Ada!");
        assert_eq!(copies.json()[0]["online"], false);
        let mut restarted = Share::new("e2".into());
        restarted.take(&state(&[("bot-c", "Cy")], &[]));
        copies.apply("dev-a", "Mini", true, Some(&restarted.whole()));
        assert_eq!(copies.json()[0]["bots"][0]["name"], "Cy");
        // A change with no copy behind it is never applied.
        assert!(!Copies::default().apply("dev-b", "Air", true, Some(&change)));
        assert!(copies.forget("dev-a"));
        assert!(copies.json().is_empty());
    }

    #[test]
    fn the_link_going_down_keeps_the_last_copy() {
        let mut share = Share::new("e1".into());
        share.take(&state(&[("bot-a", "Ada")], &[("item-1", "needs_you")]));
        let mut copies = Copies::default();
        copies.apply("dev-a", "Mini", true, Some(&share.whole()));
        assert!(copies.apply("dev-a", "Mini", false, None));
        let held = copies.json();
        assert_eq!(held[0]["online"], false);
        assert_eq!(held[0]["items"][0]["id"], "item-1");
        // A host never heard of gets no copy from its link alone.
        assert!(copies.apply("dev-z", "Z", false, None));
        assert_eq!(copies.json().len(), 1);
    }

    #[test]
    fn a_relaunch_keeps_each_hosts_last_copy_with_its_link_down() {
        let dir = crate::fs::disk::make_temp_dir("ompdesk-bots-remote-").unwrap();
        let file = dir.join("bots-remote.json");
        let mut share = Share::new("e1".into());
        share.take(&state(&[("bot-a", "Ada")], &[("item-1", "needs_you")]));
        let mut copies = Copies::load(Some(file.clone()));
        copies.apply("dev-a", "Mini", true, Some(&share.whole()));
        let change = share
            .take(&state(&[("bot-a", "Ada")], &[("item-1", "working")]))
            .unwrap();
        copies.apply("dev-a", "Mini", true, Some(&change));
        let mut old = read_array(&file);
        old[0]["state"]["bots"][0]["picture"] = json!("data:image/png;base64,AAAA");
        std::fs::write(&file, serde_json::to_vec(&old).unwrap()).unwrap();
        let again = Copies::load(Some(file.clone()));
        assert!(again.json()[0]["bots"][0].get("picture").is_none());
        assert!(
            read_array(&file)[0]["state"]["bots"][0]
                .get("picture")
                .is_none()
        );
        let held = again.json();
        assert_eq!(held[0]["online"], false);
        assert_eq!(held[0]["name"], "Mini");
        assert_eq!(held[0]["items"][0]["status"], "working");
        // Its next change applies on the version the copy kept.
        let mut again = again;
        let next = share
            .take(&state(&[("bot-a", "Ada")], &[("item-1", "done")]))
            .unwrap();
        assert!(again.apply("dev-a", "Mini", true, Some(&next)));
        assert!(again.forget("dev-a"));
        assert!(Copies::load(Some(file)).json().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
