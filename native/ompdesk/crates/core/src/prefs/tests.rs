use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::path::{Part, parse};
use super::{delete, flush, get, read_key, remove_key, set, store, update, write_key};

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
fn a_file_that_is_not_json_is_moved_aside_and_its_last_good_copy_comes_back() {
    // One test for both cases: `recovered` is the process's one list, and another test asking it would take ours.
    let dir = temp();
    let file = dir.path().join("prefs.json");
    let name = file.to_str().unwrap();
    set(name, "theme", json!("dark")).unwrap();
    flush(Duration::from_secs(10));
    assert!(dir.path().join("prefs.json.bak").exists());
    std::fs::write(&file, "{ not json").unwrap();

    assert_eq!(get(name, "theme").unwrap(), Some(json!("dark")));
    set(name, "language", json!("ko")).unwrap();
    flush(Duration::from_secs(10));
    let aside: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with("prefs.json.corrupt-"))
        .collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(
        std::fs::read_to_string(dir.path().join(&aside[0])).unwrap(),
        "{ not json"
    );

    // No good copy: the store starts empty.
    let bare = dir.path().join("window-state.json");
    std::fs::write(&bare, "").unwrap();
    let bare_name = bare.to_str().unwrap();
    assert!(store(bare_name).unwrap().is_empty());

    let ours = |entry: &Value| {
        entry["quarantined"].as_str().is_some_and(|q| {
            aside.iter().any(|a| a == q) || q.starts_with("window-state.json.corrupt-")
        })
    };
    let told: Vec<Value> = super::recovered().into_iter().filter(ours).collect();
    assert_eq!(told.len(), 2, "{told:?}");
    assert_eq!(told[0]["file"], json!("prefs.json"));
    assert_eq!(told[0]["restored"], json!(true));
    assert_eq!(told[1]["file"], json!("window-state.json"));
    assert_eq!(told[1]["restored"], json!(false));
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

#[test]
fn removed_modes_leave_live_shortcuts_alone() {
    let mut store = serde_json::from_value(json!({
        "autoMode": true,
        "keymapOverrides": {"plan.toggle": "p", "goal.toggle": "g"}
    }))
    .unwrap();
    assert!(super::retired::migrate(&mut store, temp().path()));
    assert_eq!(json!(store), json!({"keymapOverrides": {"goal.toggle": "g"}}));
}

#[test]
fn a_retired_theme_becomes_its_successor_and_any_other_value_stays() {
    let dir = temp();
    let mut store = serde_json::from_value::<Map<String, Value>>(json!({
        "themeName": "sepia",
        "systemLightTheme": "frost",
        "systemDarkTheme": "tokyo-night",
        "theme": "nord",
    }))
    .unwrap();
    assert!(super::retired::migrate(&mut store, dir.path()));
    assert_eq!(
        Value::Object(store.clone()),
        json!({
            "themeName": "gruvbox-light",
            "systemLightTheme": "solarized-light",
            "systemDarkTheme": "github-dark",
            "theme": "nord",
        })
    );
    for kept in [
        json!("system"),
        json!("hc-dark"),
        json!("unknown"),
        json!(3),
        json!("toString"),
    ] {
        let mut store = Map::new();
        store.insert("themeName".into(), kept.clone());
        assert!(!super::retired::migrate(&mut store, dir.path()), "{kept}");
        assert_eq!(store.get("themeName"), Some(&kept));
    }
}

#[test]
fn an_update_patches_the_value_it_read_and_answers_what_is_held() {
    let dir = temp();
    let file = dir.path().join("prefs.json");
    let name = file.to_str().unwrap();
    set(
        name,
        "sidebar",
        json!({ "pinnedSessions": ["/a"], "other": 1 }),
    )
    .unwrap();

    let moved = update(name, "sidebar", |current| {
        let mut next = current.cloned()?;
        next["pinnedSessions"] = json!(["/b"]);
        Some(next)
    })
    .unwrap();
    assert_eq!(moved, Some(json!({ "pinnedSessions": ["/b"], "other": 1 })));
    assert_eq!(
        get(name, "sidebar.pinnedSessions").unwrap(),
        Some(json!(["/b"]))
    );

    let left = update(name, "sidebar", |_| None).unwrap();
    assert_eq!(left, moved);
    assert_eq!(
        update(name, "missing", |current| current.cloned()).unwrap(),
        None
    );
}
