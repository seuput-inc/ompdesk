use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use crate::routines::text::clip;

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Activity {
    Busy {
        tab_id: String,
    },
    Idle {
        tab_id: String,
        outcome: Option<Outcome>,
    },
    Ask {
        tab_id: String,
        request_id: String,
        text: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Outcome {
    stop_reason: Option<String>,
    error_message: Option<String>,
}

/// Facts sampled together at the pool edge. `root` is the shared sidebar's openerOfSessions result,
/// not a second native interpretation of which family owns this tab.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tab {
    session_file: String,
    title: String,
    cwd: String,
    root: Option<String>,
}

pub(crate) struct Session {
    kinds: Vec<String>,
    folder: Option<String>,
    told: HashMap<String, String>,
}

impl Session {
    pub fn new(event: &Value) -> Self {
        Self {
            kinds: event["events"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            folder: event["folder"].as_str().map(normalized),
            told: HashMap::new(),
        }
    }

    pub fn notice(
        &mut self,
        activity: Activity,
        tab: Option<Tab>,
        wake: Option<&str>,
    ) -> Option<String> {
        let (id, kind, key, detail) = match activity {
            Activity::Busy { tab_id } => {
                self.told.remove(&tab_id);
                return None;
            }
            Activity::Ask {
                tab_id,
                request_id,
                text,
            } => (tab_id, "waiting", format!("ask:{request_id}"), text),
            Activity::Idle { tab_id, outcome } => {
                let outcome = outcome?;
                let kind = match outcome.stop_reason.as_deref() {
                    Some("aborted") => return None,
                    Some("error") => "failed",
                    _ => "done",
                };
                (
                    tab_id,
                    kind,
                    kind.to_owned(),
                    outcome.error_message.unwrap_or_default(),
                )
            }
        };
        if !self.kinds.iter().any(|wanted| wanted == kind) || self.told.get(&id) == Some(&key) {
            return None;
        }
        let tab = tab?;
        if tab.session_file.is_empty()
            || wake
                .is_some_and(|wake| wake == tab.session_file || Some(wake) == tab.root.as_deref())
        {
            return None;
        }
        if self.folder.as_ref().is_some_and(|folder| {
            folder.is_empty()
                || !format!("/{}/", normalized(&tab.cwd)).contains(&format!("/{folder}/"))
        }) {
            return None;
        }
        self.told.insert(id, key);
        let title = clip(&tab.title, 120);
        let title = if title.is_empty() { "Untitled" } else { &title };
        let mut line = format!("Session \"{title}\" in {} ", tab.cwd);
        line.push_str(match kind {
            "waiting" => "is waiting for an answer",
            "failed" => "failed its turn",
            _ => "finished its turn",
        });
        if kind != "done" {
            let detail = clip(&detail, 200);
            if !detail.is_empty() {
                line.push_str(": ");
                line.push_str(&detail);
            }
        }
        Some(line)
    }
}

fn normalized(path: &str) -> String {
    path.replace('\\', "/").trim_matches('/').to_lowercase()
}
