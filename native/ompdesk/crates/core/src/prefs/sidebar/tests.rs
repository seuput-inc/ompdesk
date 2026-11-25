use serde::Deserialize;
use serde_json::{Value, json};

use super::*;

/// What `src/main/sidebar-prefs.ts` and `readSidebarPrefs` answered before the owner moved here: each state read, each
/// change sent to each state (the blob it wrote, its log line, or its refusal) and each pin a peer's move carried.
#[derive(Deserialize)]
struct Captured {
    now: f64,
    states: Vec<Value>,
    payloads: Vec<Value>,
    reads: Vec<ReadRow>,
    updates: Vec<UpdateRow>,
    pins: Vec<PinRow>,
}

#[derive(Deserialize)]
struct ReadRow {
    state: usize,
    read: Value,
}

#[derive(Deserialize)]
struct UpdateRow {
    state: usize,
    payload: usize,
    from: String,
    #[serde(default)]
    written: Value,
    #[serde(default)]
    change: Value,
    #[serde(default)]
    log: Value,
    error: Option<String>,
}

#[derive(Deserialize)]
struct PinRow {
    state: usize,
    from: String,
    to: String,
    moved: bool,
    written: Value,
}

fn captured() -> Captured {
    serde_json::from_str(include_str!("../sidebar-captured.json")).unwrap()
}

/// `undefined` was captured as `{"absent": true}`.
fn given(value: &Value) -> Option<&Value> {
    (value != &json!({ "absent": true })).then_some(value)
}

/// The JSON text, so a key out of order fails as a value would.
fn text(value: &Value) -> String {
    serde_json::to_string(value).unwrap()
}

#[test]
fn every_captured_blob_reads_as_the_typescript_read_it() {
    let table = captured();
    assert_eq!(table.reads.len(), table.states.len());
    for row in &table.reads {
        let read = Value::Object(read(given(&table.states[row.state])));
        assert_eq!(text(&read), text(&row.read), "state {}", row.state);
    }
}

#[test]
fn every_captured_change_writes_logs_or_is_refused_as_the_typescript_did() {
    let table = captured();
    assert!(table.updates.len() > 800);
    let mut failures = Vec::new();
    for row in &table.updates {
        let state = given(&table.states[row.state]);
        let payload = given(&table.payloads[row.payload])
            .cloned()
            .unwrap_or(Value::Null);
        let at = format!("state {} payload {}", row.state, row.payload);
        let Some(change) = parse_change(&payload) else {
            if row.error.is_none() {
                failures.push(format!("{at}: refused, the TypeScript took it"));
            }
            continue;
        };
        if row.error.is_some() {
            failures.push(format!("{at}: taken, the TypeScript refused it"));
            continue;
        }
        let written = changed(state, &change, table.now).map_or(Value::Null, Value::Object);
        if text(&written) != text(&row.written) {
            failures.push(format!(
                "{at}: wrote {}, the TypeScript {}",
                text(&written),
                text(&row.written)
            ));
        }
        let applied = !written.is_null();
        let (echo, log) = if applied {
            (json!(change), change.log(&row.from).unwrap_or(Value::Null))
        } else {
            (Value::Null, Value::Null)
        };
        if echo != row.change || text(&log) != text(&row.log) {
            failures.push(format!(
                "{at}: answered {echo} / {log}, the TypeScript {} / {}",
                row.change, row.log
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_captured_peer_move_carries_the_pin_as_the_typescript_did() {
    let table = captured();
    for row in &table.pins {
        let written = pin_moved(given(&table.states[row.state]), &row.from, &row.to);
        assert_eq!(
            written.is_some(),
            row.moved,
            "state {} {} → {}",
            row.state,
            row.from,
            row.to
        );
        let written = written.map_or(Value::Null, Value::Object);
        assert_eq!(
            text(&written),
            text(&row.written),
            "state {} {} → {}",
            row.state,
            row.from,
            row.to
        );
    }
}

#[test]
fn a_change_applies_to_what_is_stored_now_and_a_refusal_leaves_it() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("prefs.json");
    let file = file.to_str().unwrap();
    super::super::set(
        file,
        KEY,
        json!({ "pinnedSessions": ["/s/1"], "grouping": "recent" }),
    )
    .unwrap();

    let applied = update(
        file,
        &json!({ "op": "set-group-pinned", "cwd": "/w", "pinned": true }),
        "web",
    )
    .unwrap();
    assert_eq!(
        json!(applied),
        json!({
            "change": { "op": "set-group-pinned", "cwd": "/w", "pinned": true },
            "log": { "source": "sidebar", "message": "set-group-pinned", "details": { "level": "info", "count": 1, "on": true, "from": "web" } },
        })
    );
    let unchanged = update(
        file,
        &json!({ "op": "set-session-pinned", "path": "/s/1", "pinned": true }),
        "window",
    )
    .unwrap();
    assert_eq!(json!(unchanged), json!({ "change": null, "log": null }));
    let refused = update(
        file,
        &json!({ "op": "set-group-pinned", "cwd": "", "pinned": true }),
        "window",
    );
    assert_eq!(
        refused.err().map(|fault| fault.code.to_string()).as_deref(),
        Some("invalid_preference_key")
    );

    assert!(move_pin(file, "/s/1", "/s/moved").unwrap());
    assert!(!move_pin(file, "/s/1", "/s/other").unwrap());
    let stored = super::super::get(file, KEY).unwrap().unwrap();
    assert_eq!(stored["pinnedGroups"], json!(["/w"]));
    assert_eq!(stored["pinnedSessions"], json!(["/s/moved"]));
    assert!(stored.get("grouping").is_none());
}
