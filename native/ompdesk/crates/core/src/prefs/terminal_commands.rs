//! `terminalCommands` in prefs.json: the saved terminal commands run in a shell as typed, so a write keeps only a list
//! the page's parser (`parseTerminalCommands`, `src/shared/terminal-commands.ts`, which stays the page's) reads whole:
//! every entry an object with a non-empty string `id` no other entry has, and a `label` and a `command` with text
//! besides `String.prototype.trim`'s spaces, at most `MAX_COMMANDS` of them (was main's PREFS_SET check).
//! `terminal-commands-cases.json` holds both sides to the same answers (`src/shared/terminal-commands.test.ts`).

use std::collections::HashSet;

use serde_json::Value;

use crate::control::js::is_blank;
use crate::server::Fault;

pub(super) const KEY: &str = "terminalCommands";
const MAX_COMMANDS: usize = 200;

fn reads_whole(value: &Value) -> bool {
    let Some(items) = value.as_array() else {
        return false;
    };
    let mut ids = HashSet::new();
    items.len() <= MAX_COMMANDS
        && items.iter().all(|item| {
            let text = |key: &str| item.get(key).and_then(Value::as_str);
            match (text("id"), text("label"), text("command")) {
                (Some(id), Some(label), Some(command)) => {
                    !id.is_empty() && !is_blank(label) && !is_blank(command) && ids.insert(id)
                }
                _ => false,
            }
        })
}

/// Refuses a list the page could not read whole, in the words main's check used.
pub(super) fn check(value: &Value) -> Result<(), Fault> {
    if reads_whole(value) {
        Ok(())
    } else {
        Err(Fault::new(
            "invalid_preference_key",
            "Invalid saved terminal commands",
        ))
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    #[derive(Deserialize)]
    struct Case {
        whole: bool,
        value: Value,
    }

    #[test]
    fn a_list_is_kept_only_when_the_page_reads_it_whole() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("terminal-commands-cases.json")).unwrap();
        for case in cases {
            assert_eq!(reads_whole(&case.value), case.whole, "{}", case.value);
        }
    }

    #[test]
    fn at_most_two_hundred_commands() {
        let list = |count: usize| {
            Value::Array(
                (0..count)
                    .map(|n| json!({"id": n.to_string(), "label": "L", "command": "c"}))
                    .collect(),
            )
        };
        assert!(reads_whole(&list(MAX_COMMANDS)));
        assert!(!reads_whole(&list(MAX_COMMANDS + 1)));
    }
}
