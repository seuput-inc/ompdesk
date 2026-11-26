//! The one owner of the `sidebar` blob in `prefs.json` (was `src/main/sidebar-prefs.ts`): a window, a paired page or
//! a paired computer's layout sends one `SidebarChange`, applied here to the value stored now under the file's one
//! lock, so a page that read the blob earlier never puts an older copy back. A peer that moved a session file moves
//! the host's pin with it the same way.
//!
//! The page applies the same change to its own copy at once (`sidebarPatch` and `readSidebarPrefs` of
//! `src/shared/sidebar-prefs.ts`), so these are the TypeScript's rules again. `sidebar-captured.json` holds what the
//! TypeScript answered, read by the tests here and by `src/shared/sidebar-prefs.test.ts`: both copies store exactly
//! what the page showed. Keys keep their insertion order; JavaScript would list an array-index key first, which no
//! key here is (they are folders, session files and device-qualified folders).

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::agentctl::journal::js_number;
use crate::control::js;
use crate::server::Fault;

const KEY: &str = "sidebar";

/// The footer shortcuts, in their order (`RAIL_PINS`).
const RAIL_PINS: [&str; 9] = [
    "usage",
    "agents",
    "stats",
    "terminal",
    "diff",
    "preview",
    "files",
    "jobs",
    "schedules",
];
const MAX_RECENT_WORKSPACES: usize = 100;
const MAX_ORDERED_LISTS: usize = 300;
const MAX_ORDERED_SESSIONS: usize = 500;
/// `z.string().max(4096)` of a layout path: zod counts a string's code points, not its UTF-16 units.
const MAX_LAYOUT_PATH: usize = 4096;
/// Entries kept per keyed field (`MAX_ENTRIES`), the newest set last.
const MAX_ENTRIES: usize = 500;

/// The keyed text fields one `set-entry` sets (`SIDEBAR_ENTRY_FIELDS`), each `Record<key, string>`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryField {
    ProjectGroups,
    ProjectColors,
    ProjectEmoji,
    SessionEmoji,
    /// `""` says "no parent", so it is never trimmed away.
    SessionParents,
}

impl EntryField {
    fn name(self) -> &'static str {
        match self {
            EntryField::ProjectGroups => "projectGroups",
            EntryField::ProjectColors => "projectColors",
            EntryField::ProjectEmoji => "projectEmoji",
            EntryField::SessionEmoji => "sessionEmoji",
            EntryField::SessionParents => "sessionParents",
        }
    }
}

/// One change, naming only what it sets (`SidebarChange`). Unknown fields are dropped, as zod's object did.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Change {
    SetGroupPinned {
        cwd: String,
        pinned: bool,
    },
    /// This computer's project whose notifications the person muted (its project menu).
    SetGroupMuted {
        cwd: String,
        muted: bool,
    },
    SetSessionPinned {
        path: String,
        pinned: bool,
    },
    /// A session (its file) whose notifications the person muted (its row menu).
    SetSessionMuted {
        path: String,
        muted: bool,
    },
    SetAgentHidden {
        path: String,
        hidden: bool,
    },
    SetGroupAlias {
        cwd: String,
        alias: Option<String>,
    },
    SetGroupOrder {
        order: Vec<String>,
    },
    SetSessionOrder {
        list: String,
        order: Vec<String>,
        #[serde(rename = "move", default, skip_serializing_if = "Option::is_none")]
        moved: Option<MoveField>,
    },
    SetSessionsArchived {
        ids: Vec<String>,
        archived: bool,
    },
    SetRailPin {
        pin: String,
        pinned: bool,
    },
    TouchWorkspace {
        cwd: String,
    },
    /// One keyed entry of an `EntryField`: `value` null removes it.
    SetEntry {
        field: EntryField,
        key: String,
        value: Option<String>,
    },
    /// Every project filed under group `from` moves to `to`, or out of any group (null).
    RenameProjectGroup {
        from: String,
        to: Option<String>,
    },
}

/// `move` of a session order: present means an object, never null.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MoveField {
    path: String,
    over: String,
}

fn layout_path(path: &str) -> bool {
    !path.is_empty() && path.chars().count() <= MAX_LAYOUT_PATH
}

impl Change {
    /// What `SidebarChangeSchema` refused beyond the shape serde checks: empty strings, too-long layout paths,
    /// a shortcut that is not one, an alias field that is absent rather than null.
    fn valid(&self, raw: &Value) -> bool {
        let paths = |items: &[String]| items.iter().all(|item| layout_path(item));
        match self {
            Change::SetGroupPinned { cwd, .. } => layout_path(cwd),
            Change::SetGroupMuted { cwd, .. } => layout_path(cwd),
            Change::SetSessionPinned { path, .. } => layout_path(path),
            Change::SetSessionMuted { path, .. } => layout_path(path),
            Change::SetGroupOrder { order } => paths(order),
            Change::SetSessionOrder { list, order, moved } => {
                layout_path(list)
                    && paths(order)
                    && moved
                        .as_ref()
                        .is_none_or(|moved| layout_path(&moved.path) && layout_path(&moved.over))
                    && raw.get("move") != Some(&Value::Null)
            }
            Change::SetSessionsArchived { ids, .. } => paths(ids),
            Change::SetAgentHidden { path, .. } => !path.is_empty(),
            Change::SetGroupAlias { cwd, .. } => !cwd.is_empty() && raw.get("alias").is_some(),
            Change::SetRailPin { pin, .. } => RAIL_PINS.contains(&pin.as_str()),
            Change::TouchWorkspace { cwd } => !cwd.is_empty(),
            Change::SetEntry { key, value, .. } => {
                layout_path(key)
                    && value
                        .as_ref()
                        .is_none_or(|value| value.chars().count() <= MAX_LAYOUT_PATH)
                    && raw.get("value").is_some()
            }
            Change::RenameProjectGroup { from, .. } => !from.is_empty() && raw.get("to").is_some(),
        }
    }

    fn op(&self) -> &'static str {
        match self {
            Change::SetGroupPinned { .. } => "set-group-pinned",
            Change::SetGroupMuted { .. } => "set-group-muted",
            Change::SetSessionPinned { .. } => "set-session-pinned",
            Change::SetSessionMuted { .. } => "set-session-muted",
            Change::SetAgentHidden { .. } => "set-agent-hidden",
            Change::SetGroupAlias { .. } => "set-group-alias",
            Change::SetGroupOrder { .. } => "set-group-order",
            Change::SetSessionOrder { .. } => "set-session-order",
            Change::SetSessionsArchived { .. } => "set-sessions-archived",
            Change::SetRailPin { .. } => "set-rail-pin",
            Change::TouchWorkspace { .. } => "touch-workspace",
            Change::SetEntry { .. } => "set-entry",
            Change::RenameProjectGroup { .. } => "rename-project-group",
        }
    }

    /// The runtime log's line for a change that moved what the sidebar remembers in order; the workspace clock moves
    /// on every switch and says nothing. `from`: a desktop window, a paired page or a paired computer.
    fn log(&self, from: &str) -> Option<Value> {
        let details = match self {
            Change::SetSessionOrder { list, order, .. } => {
                json!({ "list": list, "count": order.len() })
            }
            Change::SetGroupOrder { order } => json!({ "count": order.len() }),
            Change::SetSessionsArchived { ids, archived } => {
                json!({ "count": ids.len(), "on": archived })
            }
            Change::SetSessionPinned { pinned, .. } | Change::SetGroupPinned { pinned, .. } => {
                json!({ "count": 1, "on": pinned })
            }
            _ => return None,
        };
        let mut line = Map::new();
        line.insert("level".into(), json!("info"));
        line.extend(
            details
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.clone(), v.clone())),
        );
        line.insert("from".into(), json!(from));
        Some(json!({ "source": "sidebar", "message": self.op(), "details": line }))
    }
}

/// A change as the page sends it, or `None` for anything else.
pub fn parse_change(raw: &Value) -> Option<Change> {
    let change: Change = serde_json::from_value(raw.clone()).ok()?;
    change.valid(raw).then_some(change)
}

// ---- readSidebarPrefs ---------------------------------------------------------------------------------------------

fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|item| !item.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

fn strings(items: &[String]) -> Value {
    Value::Array(items.iter().cloned().map(Value::String).collect())
}

fn valid_rail_pins(value: Option<&Value>) -> Value {
    // An absent entry is "not chosen yet"; any saved array, empty included, is the user's choice.
    let Some(value) = value else {
        return json!(["usage"]);
    };
    let chosen = value.as_array().map(Vec::as_slice).unwrap_or_default();
    let pins = RAIL_PINS
        .iter()
        .filter(|pin| chosen.iter().any(|item| item.as_str() == Some(pin)));
    Value::Array(pins.map(|pin| json!(pin)).collect())
}

fn valid_aliases(value: Option<&Value>) -> Map<String, Value> {
    let Some(Value::Object(aliases)) = value else {
        return Map::new();
    };
    aliases
        .iter()
        .filter(|(cwd, alias)| !cwd.is_empty() && alias.is_string())
        .map(|(cwd, alias)| (cwd.clone(), alias.clone()))
        .collect()
}

fn valid_session_order(value: Option<&Value>) -> Map<String, Value> {
    let Some(Value::Object(lists)) = value else {
        return Map::new();
    };
    let skip = lists.len().saturating_sub(MAX_ORDERED_LISTS);
    let mut out = Map::new();
    for (list, order) in lists.iter().skip(skip) {
        if list.is_empty() || !order.is_array() {
            continue;
        }
        let mut paths = string_list(Some(order));
        paths.truncate(MAX_ORDERED_SESSIONS);
        if !paths.is_empty() {
            out.insert(list.clone(), strings(&paths));
        }
    }
    out
}

fn valid_recency(value: Option<&Value>) -> Map<String, Value> {
    let Some(Value::Object(stamps)) = value else {
        return Map::new();
    };
    stamps
        .iter()
        .filter(|(key, stamp)| {
            !key.is_empty() && stamp.as_f64().is_some_and(|n| n.is_finite() && n > 0.0)
        })
        .map(|(key, stamp)| (key.clone(), stamp.clone()))
        .collect()
}

/// The stored blob as the sidebar holds it (`readSidebarPrefs`): malformed or missing parts fall back to defaults
/// and unknown keys are dropped, in its field order.
pub fn read(value: Option<&Value>) -> Map<String, Value> {
    let blob = value.and_then(Value::as_object);
    let field = |key: &str| blob.and_then(|blob| blob.get(key));
    let mut out = Map::new();
    out.insert(
        "pinnedGroups".into(),
        strings(&string_list(field("pinnedGroups"))),
    );
    out.insert(
        "pinnedSessions".into(),
        strings(&string_list(field("pinnedSessions"))),
    );
    out.insert(
        "groupAliases".into(),
        Value::Object(valid_aliases(field("groupAliases"))),
    );
    out.insert(
        "workspaceLastUsed".into(),
        Value::Object(valid_recency(field("workspaceLastUsed"))),
    );
    out.insert(
        "groupOrder".into(),
        strings(&string_list(field("groupOrder"))),
    );
    out.insert(
        "sessionOrder".into(),
        Value::Object(valid_session_order(field("sessionOrder"))),
    );
    out.insert(
        "archivedSessions".into(),
        strings(&string_list(field("archivedSessions"))),
    );
    out.insert("railPins".into(), valid_rail_pins(field("railPins")));
    out.insert(
        "agentHidden".into(),
        strings(&string_list(field("agentHidden"))),
    );
    out.insert(
        "mutedGroups".into(),
        strings(&string_list(field("mutedGroups"))),
    );
    out.insert(
        "mutedSessions".into(),
        strings(&string_list(field("mutedSessions"))),
    );
    for entries in [
        EntryField::ProjectGroups,
        EntryField::ProjectColors,
        EntryField::ProjectEmoji,
        EntryField::SessionEmoji,
        EntryField::SessionParents,
    ] {
        let name = entries.name();
        out.insert(name.into(), Value::Object(valid_aliases(field(name))));
    }
    out
}

// ---- sidebarPatch -------------------------------------------------------------------------------------------------

fn list_of(state: &Map<String, Value>, field: &str) -> Vec<String> {
    string_list(state.get(field))
}

fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

fn with_item(list: Vec<String>, item: &str, present: bool) -> Vec<String> {
    if list.iter().any(|entry| entry == item) == present {
        return list;
    }
    if present {
        let mut list = list;
        list.push(item.to_owned());
        list
    } else {
        list.into_iter().filter(|entry| entry != item).collect()
    }
}

/// Empty when the list already holds `next`, so a change that changes nothing writes nothing.
fn list_patch(state: &Map<String, Value>, field: &str, next: Vec<String>) -> Map<String, Value> {
    let mut patch = Map::new();
    if list_of(state, field) != next {
        patch.insert(field.into(), strings(&next));
    }
    patch
}

fn one(field: &str, value: Value) -> Map<String, Value> {
    let mut patch = Map::new();
    patch.insert(field.into(), value);
    patch
}

/// The fields `change` moves when applied to `state` (a `read` blob), empty when it moves none. `now` is the clock the
/// workspace MRU stamps with; it only has to grow, so the page's clock and this one may differ.
pub fn patch(state: &Map<String, Value>, change: &Change, now: f64) -> Map<String, Value> {
    match change {
        Change::SetGroupPinned { cwd, pinned } => list_patch(
            state,
            "pinnedGroups",
            with_item(list_of(state, "pinnedGroups"), cwd, *pinned),
        ),
        Change::SetGroupMuted { cwd, muted } => list_patch(
            state,
            "mutedGroups",
            with_item(list_of(state, "mutedGroups"), cwd, *muted),
        ),
        Change::SetSessionPinned { path, pinned } => list_patch(
            state,
            "pinnedSessions",
            with_item(list_of(state, "pinnedSessions"), path, *pinned),
        ),
        Change::SetSessionMuted { path, muted } => list_patch(
            state,
            "mutedSessions",
            with_item(list_of(state, "mutedSessions"), path, *muted),
        ),
        Change::SetAgentHidden { path, hidden } => list_patch(
            state,
            "agentHidden",
            with_item(list_of(state, "agentHidden"), path, *hidden),
        ),
        Change::SetGroupAlias { cwd, alias } => {
            let alias = alias
                .as_deref()
                .map(js::trim)
                .filter(|alias| !alias.is_empty());
            let mut aliases = valid_aliases(state.get("groupAliases"));
            if aliases.get(cwd).and_then(Value::as_str) == alias {
                return Map::new();
            }
            match alias {
                Some(alias) => {
                    aliases.insert(cwd.clone(), json!(alias));
                }
                None => {
                    aliases.shift_remove(cwd);
                }
            }
            one("groupAliases", Value::Object(aliases))
        }
        Change::SetGroupOrder { order } => {
            list_patch(state, "groupOrder", unique(order.iter().cloned()))
        }
        Change::SetSessionOrder { list, order, .. } => {
            // The list just ordered moves to the end, so the oldest ordered lists are the ones a cap drops.
            let mut lists = valid_session_order(state.get("sessionOrder"));
            lists.shift_remove(list);
            lists.insert(list.clone(), strings(&unique(order.iter().cloned())));
            one(
                "sessionOrder",
                Value::Object(valid_session_order(Some(&Value::Object(lists)))),
            )
        }
        Change::SetSessionsArchived { ids, archived } => {
            let current = list_of(state, "archivedSessions");
            let next = if *archived {
                unique(current.into_iter().chain(ids.iter().cloned()))
            } else {
                current.into_iter().filter(|id| !ids.contains(id)).collect()
            };
            list_patch(state, "archivedSessions", next)
        }
        Change::SetRailPin { pin, pinned } => {
            let current = list_of(state, "railPins");
            if current.contains(pin) == *pinned {
                return Map::new();
            }
            let next: Vec<String> = if *pinned {
                RAIL_PINS
                    .iter()
                    .filter(|item| **item == pin || current.iter().any(|c| c == *item))
                    .map(|item| (*item).to_owned())
                    .collect()
            } else {
                current.into_iter().filter(|item| item != pin).collect()
            };
            one("railPins", strings(&next))
        }
        Change::TouchWorkspace { cwd } => {
            let mut stamps = valid_recency(state.get("workspaceLastUsed"));
            let latest = stamps
                .values()
                .filter_map(Value::as_f64)
                .fold(0.0, f64::max);
            stamps.insert(cwd.clone(), js_number(now.max(latest + 1.0)));
            let mut entries: Vec<(String, Value)> = stamps.into_iter().collect();
            // Newest first; a stable sort keeps equal stamps in their order, as `Array.prototype.sort` does.
            entries.sort_by(|a, b| {
                let stamp = |entry: &(String, Value)| entry.1.as_f64().unwrap_or(0.0);
                stamp(b).total_cmp(&stamp(a))
            });
            entries.truncate(MAX_RECENT_WORKSPACES);
            one(
                "workspaceLastUsed",
                Value::Object(entries.into_iter().collect()),
            )
        }
        Change::SetEntry { field, key, value } => {
            let name = field.name();
            let value = match field {
                EntryField::SessionParents => value.clone(),
                _ => value
                    .as_deref()
                    .map(js::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned),
            };
            let mut entries = valid_aliases(state.get(name));
            if entries.get(key).and_then(Value::as_str) == value.as_deref() {
                return Map::new();
            }
            entries.shift_remove(key);
            if let Some(value) = value {
                entries.insert(key.clone(), json!(value));
            }
            let skip = entries.len().saturating_sub(MAX_ENTRIES);
            one(
                name,
                Value::Object(entries.into_iter().skip(skip).collect()),
            )
        }
        Change::RenameProjectGroup { from, to } => {
            let to = to.as_deref().map(js::trim).filter(|to| !to.is_empty());
            if to == Some(from.as_str()) {
                return Map::new();
            }
            let mut moved = false;
            let mut next = Map::new();
            for (cwd, group) in valid_aliases(state.get("projectGroups")) {
                if group.as_str() != Some(from.as_str()) {
                    next.insert(cwd, group);
                } else {
                    moved = true;
                    if let Some(to) = to {
                        next.insert(cwd, json!(to));
                    }
                }
            }
            if moved {
                one("projectGroups", Value::Object(next))
            } else {
                Map::new()
            }
        }
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |since| since.as_millis() as f64)
}

/// What `change` did: the change as applied and its runtime-log line, or nothing when it moved nothing.
#[derive(Serialize)]
pub struct Applied {
    change: Option<Change>,
    log: Option<Value>,
}

/// The blob `change` leaves, or `None` when it moves nothing (`{ ...current, ...patch }`).
fn changed(current: Option<&Value>, change: &Change, now: f64) -> Option<Map<String, Value>> {
    let mut state = read(current);
    let patch = patch(&state, change, now);
    if patch.is_empty() {
        return None;
    }
    state.extend(patch);
    Some(state)
}

/// Applies one change (`raw`, as the page sent it) to the stored blob, writing it only when something moved. A
/// payload that is not a change is refused and leaves the blob alone.
pub fn update(file: &str, raw: &Value, from: &str) -> Result<Applied, Fault> {
    let change = parse_change(raw)
        .ok_or_else(|| Fault::new("invalid_preference_key", "Invalid sidebar change"))?;
    let mut moved = false;
    super::update(file, KEY, |current| {
        let next = changed(current, &change, now_ms())?;
        moved = true;
        Some(Value::Object(next))
    })?;
    Ok(if moved {
        Applied {
            log: change.log(from),
            change: Some(change),
        }
    } else {
        Applied {
            change: None,
            log: None,
        }
    })
}

/// The blob with `from`'s pin on `to`, or `None` when `from` was not pinned.
fn pin_moved(current: Option<&Value>, from: &str, to: &str) -> Option<Map<String, Value>> {
    let mut prefs = read(current);
    let pinned = list_of(&prefs, "pinnedSessions");
    if from == to || !pinned.iter().any(|path| path == from) {
        return None;
    }
    let next = unique(
        pinned
            .into_iter()
            .map(|path| if path == from { to.to_owned() } else { path }),
    );
    prefs.insert("pinnedSessions".into(), strings(&next));
    Some(prefs)
}

/// A peer moved the host's session file `from` to `to`: its pin moves along in one write. Whether it was pinned.
pub fn move_pin(file: &str, from: &str, to: &str) -> Result<bool, Fault> {
    let mut moved = false;
    super::update(file, KEY, |current| {
        let next = pin_moved(current, from, to)?;
        moved = true;
        Some(Value::Object(next))
    })?;
    Ok(moved)
}

#[cfg(test)]
mod tests;
