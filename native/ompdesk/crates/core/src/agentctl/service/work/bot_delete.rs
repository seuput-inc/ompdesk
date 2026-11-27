//! The owner previews and executes the same classification on the computer that owns the bot.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde_json::{Value, json};

use super::super::AgentControl;
use super::super::fail::{Fail, R, fail};
use crate::agentctl::journal::bots::BotRecord;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Chat,
    Worker,
    Keep,
}

type Key = (Option<String>, String);

fn saved_file_exists(path: &str) -> R<bool> {
    Path::new(path)
        .try_exists()
        .map_err(|error| Fail::Tool(format!("{path}: {error}")))
}

#[derive(Default)]
pub(super) struct DeletePlan(BTreeMap<Key, Action>);

impl DeletePlan {
    pub(super) fn counts(&self) -> Value {
        let (mut chats, mut workers, mut kept) = (0, 0, 0);
        for action in self.0.values() {
            match action {
                Action::Chat => chats += 1,
                Action::Worker => workers += 1,
                Action::Keep => kept += 1,
            }
        }
        json!({ "chats": chats, "workers": workers, "kept": kept })
    }

    pub(super) fn chats(&self) -> impl Iterator<Item = &String> {
        self.0
            .iter()
            .filter_map(|((_, path), action)| (*action == Action::Chat).then_some(path))
    }

    pub(super) async fn apply(&self, control: &AgentControl, id: &str) -> R<()> {
        let mut pending = self.0.iter();
        while let Some(((device, session), action)) = pending.next() {
            if let Err(error) = control
                .host
                .cleanup_bot_session(session, device.as_deref(), *action == Action::Keep)
                .await
            {
                let left = pending
                    .map(|((host, path), _)| {
                        format!("{path} ({})", host.as_deref().unwrap_or("local"))
                    })
                    .collect::<Vec<_>>();
                let unattempted = if left.is_empty() {
                    String::new()
                } else {
                    format!(" Not processed: {}.", left.join(", "))
                };
                return fail(format!(
                    "{session} on {}: {}.{unattempted} The bot was kept. Retry its deletion to finish.",
                    device.as_deref().unwrap_or("this computer"),
                    error.message()
                ));
            }
            if *action != Action::Chat {
                control.bots().change(id, |bot| {
                    bot.workers
                        .retain(|worker| worker.session != *session || worker.device != *device)
                });
                control.bots_changed();
            }
        }
        Ok(())
    }

    pub(super) fn covers(&self, remaining: &Self) -> bool {
        remaining
            .0
            .iter()
            .all(|(key, action)| self.0.get(key) == Some(action))
    }
}

impl AgentControl {
    pub(super) async fn bot_delete_plan(&self, bot: &BotRecord) -> R<DeletePlan> {
        if bot.moving.is_some() {
            return fail("The bot's folder is moving. Try again after the move.");
        }
        let stored = self.host.stored(None, None).await?;
        let state = self.host.state();
        let mut plan = DeletePlan::default();
        let mut local: HashMap<&str, &str> = stored
            .iter()
            .filter(|row| row.device.is_none())
            .map(|row| (row.path.as_str(), row.cwd.as_str()))
            .collect();
        for tab in state.tabs.iter().filter(|tab| tab.device.is_none()) {
            let path = tab
                .session_path
                .as_deref()
                .filter(|p| !p.is_empty())
                .unwrap_or(&tab.tab_id);
            local.insert(path, &tab.cwd);
        }
        for (&path, &cwd) in &local {
            if cwd == bot.folder {
                plan.0.insert((None, path.to_owned()), Action::Chat);
            }
        }
        for path in bot.home.iter().chain(&bot.sessions) {
            // A header-only chat need not have a picker row or an open tab.
            if !local.contains_key(path.as_str()) && saved_file_exists(path)? {
                plan.0.insert((None, path.clone()), Action::Chat);
            }
        }
        for worker in &bot.workers {
            let key = (worker.device.clone(), worker.session.clone());
            if plan.0.contains_key(&key) {
                continue;
            }
            let other_chat = match worker.device.as_deref() {
                None => {
                    let cwd = match local.get(worker.session.as_str()) {
                        Some(cwd) => *cwd,
                        None if state
                            .tabs
                            .iter()
                            .any(|tab| tab.device.is_none() && tab.tab_id == worker.session) =>
                        {
                            return fail(format!(
                                "Worker {} now has a session file. Reopen the delete confirmation after its link updates.",
                                worker.session
                            ));
                        }
                        None if saved_file_exists(&worker.session)? => &worker.cwd,
                        None => continue,
                    };
                    self.bots().all().iter().any(|other| {
                        other.id != bot.id
                            && (other.folder == cwd || other.has_session(&worker.session))
                    })
                }
                Some(device) => self
                    .across()
                    .copies
                    .has_chat(device, &worker.session, &worker.cwd),
            };
            let owned = !other_chat && self.worker_opened_by_bot(bot, worker);
            plan.0
                .insert(key, if owned { Action::Worker } else { Action::Keep });
        }
        Ok(plan)
    }
}
