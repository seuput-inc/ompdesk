//! Prefs whose switch was removed or merged into another (was `src/main/retired-prefs.ts`). Run on every read of
//! `prefs.json` from disk, before any caller sees the store, so no reader meets a retired key; it changes (and so
//! writes) only what it finds. The user's rule (settings-layout-look › Minimal settings): a merged or removed
//! setting's stored value is carried once, here.

use std::collections::HashSet;
use std::path::Path;

use serde_json::{Map, Value};

use super::{read_key, remove_key, write_key};
use crate::disk::tree::write_atomic_if;

/// Switches merged into one: the old values decide the new one once, before `RETIRED` deletes them. A new value
/// already stored wins, so a later read changes nothing.
struct Merge {
    into: &'static str,
    from: &'static [&'static str],
    value: fn(&[Option<Value>]) -> Option<Value>,
}

const MERGES: &[Merge] = &[
    // One "Keep tools up to date": on by default, off only when every one of the three had been turned off.
    Merge {
        into: "toolsAutoUpdate",
        from: &["ompAutoUpdate", "cliAutoUpdate", "extensionAutoUpdate"],
        value: |old| {
            old.iter()
                .all(|value| *value == Some(Value::Bool(false)))
                .then_some(Value::Bool(false))
        },
    },
    // One "Approve new devices": on when either was on.
    Merge {
        into: "mobileWeb.confirmNewDevices",
        from: &["mobileWeb.confirmNewDevices", "remote.confirmNewDevices"],
        value: |old| {
            old.iter()
                .any(|value| *value == Some(Value::Bool(true)))
                .then_some(Value::Bool(true))
        },
    },
    // One keep-awake switch for work here and for devices using this computer. Both defaulted on, so the work switch
    // is off only when stored off; a stored host `true` turns it on, a host switch never touched does not (the old key
    // goes below, so a later read could not tell that from the person turning the one switch off).
    Merge {
        into: "keepAwakeWhileWorking",
        from: &["keepAwakeWhileWorking", "remote.keepAwake"],
        value: |old| {
            (old[0] == Some(Value::Bool(false)) && old[1] == Some(Value::Bool(true)))
                .then_some(Value::Bool(true))
        },
    },
];

/// Prefs whose switch was removed, each with why.
pub(super) const RETIRED: &[(&str, &str)] = &[
    ("builtinMcp.rea", "OMPdesk no longer ships REA."),
    (
        "modelPool",
        "The model pool was removed; the journal's `ompdesk.model-pool` entries stay in old sessions and are ignored.",
    ),
    (
        "remote.keepAwake",
        "Merged into General's one keep-awake switch (`keepAwakeWhileWorking`).",
    ),
    (
        "worktreeAutoClean",
        "Agent worktrees are swept by OMPdesk's own landed rule, always (worktree-orphans.ts).",
    ),
    (
        "batchNotifications",
        "Desktop notifications and Web Push always batch (notification-batch.ts).",
    ),
    (
        "scheduledRetry",
        "The scheduled retry follows stock `retry.enabled` alone (turn-resume.ts).",
    ),
    (
        "quotaResume",
        "Main waits for every usage limit by itself (turn-resume.ts); the click-to-book resume is gone.",
    ),
    (
        "autopilotShip",
        "Autopilot shipping nobody picked is decided per repository at each start; other levels per run.",
    ),
    (
        "autopilotNotify",
        "An Autopilot run notifies under the app's own notifications switch, never each cycle.",
    ),
    (
        "autopilotBranch",
        "The Autopilot sheet shows only the folder's own branch; the remembered choice is gone.",
    ),
    ("ompAutoUpdate", "One switch, `toolsAutoUpdate` (MERGES)."),
    ("cliAutoUpdate", "One switch, `toolsAutoUpdate` (MERGES)."),
    (
        "extensionAutoUpdate",
        "One switch, `toolsAutoUpdate` (MERGES).",
    ),
    (
        "remote.confirmNewDevices",
        "One switch, `mobileWeb.confirmNewDevices` (MERGES).",
    ),
    (
        "displayPreferences.titleState",
        "The run state in the window title is always shown.",
    ),
    (
        "displayPreferences.showProgress",
        "Run progress on the Dock or taskbar icon is always shown.",
    ),
    (
        "aiMemory",
        "Memory is always on (29 Oct 2026); a stored `false` from an older version is ignored.",
    ),
    (
        "aiMemoryLearn",
        "Learning from conversations is always on (29 Oct 2026).",
    ),
    (
        "aiMemoryServiceOwned",
        "OMPdesk always runs its own memory service (29 Oct 2026).",
    ),
    (
        "workBoard",
        "The work board docks whenever the pane has room (`workBoardFits`).",
    ),
    (
        "macPermissionsAsked",
        "Its ask never reached macOS; `macPermissionsRequested` (mac-permissions.ts) records the asks that did.",
    ),
    (
        "sidebar.grouping",
        "Code sessions are always grouped by project (19 Oct 2026).",
    ),
    (
        "agentDeletedIds",
        "`agent-session-fates.json` (agent-control/session-fates.ts) records what became of every session (10 Nov 2026).",
    ),
    (
        "bot",
        "Sessions are ordinary sessions (the bot feature is removed).",
    ),
    ("botEnabled", "The bot feature is removed."),
    ("botConversations", "The bot feature is removed."),
    ("botRules", "The bot feature is removed."),
];

/// Side panel views the panel no longer holds (21 Oct 2026): a default view among them is forgotten and their
/// `panel.<view>` shortcuts leave `keymapOverrides`.
const RETIRED_PANEL_VIEWS: &[&str] = &["jobs", "plan", "logs", "queue", "tree", "work", "memory"];

fn has(store: &Map<String, Value>, key: &str) -> bool {
    matches!(read_key(store, key), Ok(Some(_)))
}

fn get(store: &Map<String, Value>, key: &str) -> Option<Value> {
    read_key(store, key).ok().flatten()
}

/// Migrates `store`, the content of `<user_data>/prefs.json`; whether anything changed.
pub(super) fn migrate(store: &mut Map<String, Value>, user_data: &Path) -> bool {
    let before = store.clone();
    if has(store, "bot") || has(store, "botConversations") {
        retire_bot_wakes(store, &user_data.join("schedules.json"));
    }
    for merge in MERGES {
        if has(store, merge.into) && !merge.from.contains(&merge.into) {
            continue;
        }
        let old: Vec<Option<Value>> = merge.from.iter().map(|key| get(store, key)).collect();
        if let Some(value) = (merge.value)(&old)
            && get(store, merge.into).as_ref() != Some(&value)
        {
            let _ = write_key(store, merge.into, value);
        }
    }
    for (key, _) in RETIRED {
        if has(store, key) {
            let _ = remove_key(store, key);
        }
    }
    if let Some(Value::String(tab)) = store.get("defaultPanelTab")
        && RETIRED_PANEL_VIEWS.contains(&tab.as_str())
    {
        store.shift_remove("defaultPanelTab");
    }
    if let Some(Value::Object(overrides)) = store.get_mut("keymapOverrides") {
        overrides.retain(|id, _| {
            !RETIRED_PANEL_VIEWS
                .iter()
                .any(|view| id.strip_prefix("panel.") == Some(*view))
        });
    }
    *store != before
}

/// The schedules that woke the former bot's current conversations are turned off (kept listed, so a recurring one
/// stays visible; a one-time `[agent]` wake is then spent and the hourly prune clears it).
fn retire_bot_wakes(store: &Map<String, Value>, file: &Path) {
    let mut paths = HashSet::new();
    if let Some(Value::String(path)) = get(store, "bot")
        && !path.is_empty()
    {
        paths.insert(path);
    }
    if let Some(Value::Object(conversations)) = get(store, "botConversations")
        && let Some(Value::Object(current)) = conversations.get("current")
    {
        for entry in current.values() {
            if let Some(Value::String(path)) = entry.get("path") {
                paths.insert(path.clone());
            }
        }
    }
    if paths.is_empty() {
        return;
    }
    let Ok(text) = std::fs::read_to_string(file) else {
        return;
    };
    let Ok(mut stored) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let Some(Value::Array(schedules)) = stored.get_mut("schedules") else {
        return;
    };
    let mut changed = false;
    for schedule in schedules.iter_mut() {
        let Value::Object(schedule) = schedule else {
            continue;
        };
        let wakes_bot = matches!(schedule.get("wakeSession"), Some(Value::String(path)) if paths.contains(path));
        if wakes_bot && schedule.get("enabled") != Some(&Value::Bool(false)) {
            schedule.insert("enabled".into(), Value::Bool(false));
            changed = true;
        }
    }
    if !changed {
        return;
    }
    let text = serde_json::to_string_pretty(&stored).expect("JSON always serializes");
    if let Err(fault) = write_atomic_if(file, text.as_bytes(), None, 0o777, &|| true) {
        eprintln!(
            "ompdesk-core: the former bot's schedules could not be turned off: {}",
            fault.message
        );
    }
}
