use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::path::{Part, parse};
use super::{delete, flush, get, read_key, remove_key, set, store, write_key};

#[derive(Deserialize)]
struct Vectors {
    stores: Vec<Map<String, Value>>,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    store: usize,
    op: String,
    key: String,
    #[serde(default)]
    value: Value,
    outcome: Value,
}

/// What conf 16.0.0 (electron-store 12's) answered for each key and operation, captured before it was removed:
/// two stores, 65 keys, get/has/delete and a set of three values each.
#[test]
fn every_key_reads_and_writes_as_conf_did() {
    let vectors: Vectors = serde_json::from_str(include_str!("vectors.json")).unwrap();
    let mut failures = Vec::new();
    for case in &vectors.cases {
        let mut store = vectors.stores[case.store].clone();
        let outcome = match case.op.as_str() {
            "get" => read_key(&store, &case.key).map(|value| {
                json!({ "present": value.is_some(), "value": value.unwrap_or(Value::Null) })
            }),
            "has" => read_key(&store, &case.key).map(|value| json!({ "value": value.is_some() })),
            "set" => write_key(&mut store, &case.key, case.value.clone())
                .map(|()| json!({ "store": store })),
            "delete" => remove_key(&mut store, &case.key).map(|()| json!({ "store": store })),
            other => panic!("unknown op {other}"),
        }
        .unwrap_or_else(|fault| json!({ "error": fault.message }));
        if outcome != case.outcome {
            failures.push(format!(
                "{} {:?} on store {} (value {}): got {outcome}, conf {}",
                case.op, case.key, case.store, case.value, case.outcome
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn paths_split_as_dot_prop_splits_them() {
    let key = |k: &str| Part::Key(k.into());
    assert_eq!(parse("a.b").unwrap(), Some(vec![key("a"), key("b")]));
    assert_eq!(parse("a\\.b").unwrap(), Some(vec![key("a.b")]));
    assert_eq!(
        parse("a[2].b").unwrap(),
        Some(vec![key("a"), Part::Index(2), key("b")])
    );
    assert_eq!(parse("a.2").unwrap(), Some(vec![key("a"), Part::Index(2)]));
    assert_eq!(parse("a[01]").unwrap(), Some(vec![key("a"), key("01")]));
    assert_eq!(parse("a.__proto__").unwrap(), None);
    assert!(parse("a[1").is_err());
    assert!(parse("a[x]").is_err());
}

fn temp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[test]
fn a_change_is_read_back_at_once_and_reaches_the_file_in_conf_format() {
    let dir = temp();
    let file = dir.path().join("prefs.json");
    std::fs::write(&file, "\u{feff}{\"theme\":\"dark\"}").unwrap();
    let file = file.to_str().unwrap();

    set(file, "gui.panelWidth", json!(320)).unwrap();
    set(file, "language", json!("ko")).unwrap();
    delete(file, "theme").unwrap();
    assert_eq!(
        get(file, "gui").unwrap(),
        Some(json!({ "panelWidth": 320 }))
    );
    assert_eq!(get(file, "theme").unwrap(), None);

    flush(Duration::from_secs(10));
    assert_eq!(
        std::fs::read_to_string(file).unwrap(),
        "{\n\t\"gui\": {\n\t\t\"panelWidth\": 320\n\t},\n\t\"language\": \"ko\"\n}"
    );
}

#[test]
fn a_file_edited_on_disk_is_read_again() {
    let dir = temp();
    let file = dir.path().join("prefs.json");
    let name = file.to_str().unwrap();
    set(name, "a", json!(1)).unwrap();
    flush(Duration::from_secs(10));
    std::fs::write(&file, "{\"a\": 2, \"edited\": [true, false, null]}").unwrap();
    assert_eq!(get(name, "a").unwrap(), Some(json!(2)));
    assert_eq!(
        store(name).unwrap(),
        serde_json::from_value::<Map<String, Value>>(
            json!({ "a": 2, "edited": [true, false, null] })
        )
        .unwrap()
    );
}

#[test]
fn a_file_that_is_not_json_is_refused_and_left_alone() {
    let dir = temp();
    let file = dir.path().join("prefs.json");
    std::fs::write(&file, "{ not json").unwrap();
    let name = file.to_str().unwrap();
    assert_eq!(get(name, "a").unwrap_err().code, "invalid_json");
    assert!(set(name, "a", json!(1)).is_err());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");
}

#[test]
fn a_missing_file_is_an_empty_store_until_something_is_set() {
    let dir = temp();
    let file = dir.path().join("nested").join("window-state.json");
    let name = file.to_str().unwrap();
    assert!(store(name).unwrap().is_empty());
    assert!(!file.exists());
    set(name, "windowState", json!({ "width": 800 })).unwrap();
    flush(Duration::from_secs(10));
    assert_eq!(
        serde_json::from_str::<Value>(&std::fs::read_to_string(&file).unwrap()).unwrap(),
        json!({ "windowState": { "width": 800 } })
    );
}

#[test]
fn every_retired_pref_leaves_and_a_live_one_stays() {
    let dir = temp();
    for (key, _) in super::retired::RETIRED {
        let mut store =
            serde_json::from_value::<Map<String, Value>>(json!({ "language": "en" })).unwrap();
        write_key(&mut store, key, json!(false)).unwrap();
        assert!(super::retired::migrate(&mut store, dir.path()), "{key}");
        assert_eq!(read_key(&store, key).unwrap(), None, "{key}");
        assert_eq!(read_key(&store, "language").unwrap(), Some(json!("en")));
        assert!(
            !super::retired::migrate(&mut store, dir.path()),
            "{key} twice"
        );
    }
}
