//! Links a person or an agent attached to a session (Orca's workspace references, `src/cli/references/reference.ts`,
//! MIT; was the store rules of `src/main/local/session-links.ts`): kept per session file in `<userData>/session-links.json`,
//! at most `SESSION_LINKS_MAX` per session and `SESSION_LINK_SESSIONS_MAX` sessions (the least recently changed go
//! first), each change under the file's one lock. A link arrives already read by the page's and main's one URL parser
//! (`sessionLink`, `src/shared/session-links.ts`); a deleted session's links go with its tombstone
//! (`sessions/deleted.rs`).

use serde_json::{Map, Value};

use super::path::INTERNAL_KEY;
use super::prefs;
use crate::server::Fault;

/// At most this many links per session (the oldest goes).
const SESSION_LINKS_MAX: usize = 20;
/// At most this many sessions keep links (the least recently changed go).
const SESSION_LINK_SESSIONS_MAX: usize = 2000;

/// The file next to the tombstone record `deleted` (both in userData).
pub(crate) fn file_beside(deleted: &std::path::Path) -> std::path::PathBuf {
    deleted.with_file_name("session-links.json")
}

/// The links of every session, or of `session` alone (`{}` when it keeps none).
pub(super) fn list(file: &str, session: Option<&str>) -> Result<Value, Fault> {
    let prefs = prefs(file)?;
    let state = prefs.current()?;
    let mut all = state.store.clone();
    all.shift_remove(INTERNAL_KEY);
    Ok(Value::Object(match session {
        None => all,
        Some(session) => all
            .shift_remove(session)
            .filter(|links| !links.is_null())
            .map(|links| Map::from_iter([(session.to_string(), links)]))
            .unwrap_or_default(),
    }))
}

/// Adds `link` to `session` (or moves it to the newest place); the session becomes the most recently changed.
pub(super) fn add(file: &str, session: &str, link: Value) -> Result<Value, Fault> {
    let prefs = prefs(file)?;
    let mut state = prefs.current()?;
    let internal = state.store.shift_remove(INTERNAL_KEY);
    let kept = state.store.shift_remove(session);
    let mut links: Vec<Value> = kept
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item["url"] != link["url"])
        .cloned()
        .collect();
    links.push(link.clone());
    links.drain(..links.len().saturating_sub(SESSION_LINKS_MAX));
    let gone = state
        .store
        .len()
        .saturating_sub(SESSION_LINK_SESSIONS_MAX - 1);
    let mut next: Map<String, Value> = std::mem::take(&mut state.store)
        .into_iter()
        .skip(gone)
        .collect();
    next.insert(session.to_string(), Value::Array(links));
    if let Some(internal) = internal {
        next.insert(INTERNAL_KEY.to_string(), internal);
    }
    state.store = next;
    prefs.changed(state);
    Ok(link)
}

/// Removes the link whose URL is `url`; an absent one changes nothing. The session's links left.
pub(super) fn remove(file: &str, session: &str, url: &str) -> Result<Value, Fault> {
    let prefs = prefs(file)?;
    let mut state = prefs.current()?;
    let kept: Vec<Value> = state
        .store
        .get(session)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let left: Vec<Value> = kept
        .iter()
        .filter(|item| item["url"].as_str() != Some(url))
        .cloned()
        .collect();
    if left.len() == kept.len() {
        return Ok(Value::Array(kept));
    }
    if left.is_empty() {
        state.store.shift_remove(session);
    } else {
        state
            .store
            .insert(session.to_string(), Value::Array(left.clone()));
    }
    prefs.changed(state);
    Ok(Value::Array(left))
}

/// A deleted session's links go with it.
pub(crate) fn drop_session(file: &std::path::Path, session: &str) {
    let Some(file) = file.to_str() else { return };
    let Ok(prefs) = prefs(file) else { return };
    let Ok(mut state) = prefs.current() else {
        return;
    };
    if state.store.shift_remove(session).is_some() {
        prefs.changed(state);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn file(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-core-session-links-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("session-links.json").to_str().unwrap().to_string()
    }

    fn link(url: &str) -> Value {
        json!({"url": url, "kind": "url"})
    }

    #[test]
    fn a_link_moves_to_the_newest_place_and_a_session_keeps_the_newest_twenty() {
        let file = file("cap");
        add(&file, "/s/a.jsonl", link("https://a.test/1")).unwrap();
        add(&file, "/s/a.jsonl", link("https://a.test/2")).unwrap();
        add(&file, "/s/a.jsonl", link("https://a.test/1")).unwrap();
        assert_eq!(
            list(&file, Some("/s/a.jsonl")).unwrap(),
            json!({"/s/a.jsonl": [link("https://a.test/2"), link("https://a.test/1")]})
        );
        for n in 0..SESSION_LINKS_MAX {
            add(&file, "/s/a.jsonl", link(&format!("https://b.test/{n}"))).unwrap();
        }
        let kept = list(&file, Some("/s/a.jsonl")).unwrap()["/s/a.jsonl"].clone();
        assert_eq!(kept.as_array().unwrap().len(), SESSION_LINKS_MAX);
        assert_eq!(kept[0], link("https://b.test/0"));
        assert_eq!(list(&file, Some("/s/none.jsonl")).unwrap(), json!({}));
    }

    #[test]
    fn the_least_recently_changed_session_goes_first() {
        let file = file("sessions");
        for n in 0..SESSION_LINK_SESSIONS_MAX {
            add(&file, &format!("/s/{n}.jsonl"), link("https://a.test")).unwrap();
        }
        add(&file, "/s/0.jsonl", link("https://b.test")).unwrap();
        add(&file, "/s/new.jsonl", link("https://a.test")).unwrap();
        let all = list(&file, None).unwrap();
        let all = all.as_object().unwrap();
        assert_eq!(all.len(), SESSION_LINK_SESSIONS_MAX);
        assert!(all.contains_key("/s/0.jsonl"));
        assert!(!all.contains_key("/s/1.jsonl"));
        assert_eq!(all.keys().last().unwrap(), "/s/new.jsonl");
    }

    #[test]
    fn a_removed_link_and_a_deleted_session_leave_and_an_absent_one_changes_nothing() {
        let file = file("remove");
        add(&file, "/s/a.jsonl", link("https://a.test/1")).unwrap();
        add(&file, "/s/a.jsonl", link("https://a.test/2")).unwrap();
        add(&file, "/s/b.jsonl", link("https://a.test/1")).unwrap();
        assert_eq!(
            remove(&file, "/s/a.jsonl", "https://a.test/9").unwrap(),
            json!([link("https://a.test/1"), link("https://a.test/2")])
        );
        assert_eq!(
            remove(&file, "/s/a.jsonl", "https://a.test/1").unwrap(),
            json!([link("https://a.test/2")])
        );
        assert_eq!(
            remove(&file, "/s/a.jsonl", "https://a.test/2").unwrap(),
            json!([])
        );
        assert_eq!(list(&file, Some("/s/a.jsonl")).unwrap(), json!({}));
        drop_session(std::path::Path::new(&file), "/s/b.jsonl");
        assert_eq!(list(&file, None).unwrap(), json!({}));
    }
}
