//! Only main's authenticated, host-observed live sidecar may pin a peer bot's home or acknowledge its mail.

use serde::Deserialize;
use serde_json::{Value, json};

use super::super::AgentControl;
use super::super::fail::{Fail, R};
use crate::agentctl::journal::bots::BotRecord;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeerHome {
    device: String,
    cwd: String,
    session_id: String,
    session_path: String,
}

impl PeerHome {
    fn matches(&self, bot: &BotRecord) -> bool {
        !self.device.is_empty()
            && !self.session_id.is_empty()
            && std::path::Path::new(&self.session_path).is_absolute()
            && self.session_path.ends_with(".jsonl")
            && bot.folder == self.cwd
            && bot.moving.is_none()
            && bot
                .creation_receipt
                .as_ref()
                .is_some_and(|receipt| receipt.device == self.device)
            && bot.peer_create.as_ref().is_some_and(|peer| {
                match (peer.session_id.as_deref(), bot.home.as_deref()) {
                    (None, None) => true,
                    (Some(id), Some(path)) => id == self.session_id && path == self.session_path,
                    _ => false,
                }
            })
    }
}

impl AgentControl {
    pub(crate) fn peer_home_candidate(&self, seen: &PeerHome) -> bool {
        self.bots()
            .of_folder(&seen.cwd)
            .is_some_and(|bot| seen.matches(bot))
    }

    pub(crate) fn observe_peer_home(&self, seen: &PeerHome) -> R<Value> {
        let mut bots = self.bots();
        let Some(bot) = bots.of_folder(&seen.cwd).filter(|bot| seen.matches(bot)) else {
            return Ok(Value::Null);
        };
        let id = bot.id.clone();
        let changed = bot.home.is_none();
        if changed {
            let journal = std::fs::symlink_metadata(&seen.session_path).map_err(|err| {
                Fail::Tool(format!("The host has not kept this chat's journal: {err}"))
            })?;
            if !journal.is_file() || journal.len() == 0 {
                return Err(Fail::Tool(
                    "The host has not kept this chat's journal.".into(),
                ));
            }
            bots.change_peer(&id, |bot| {
                bot.home = Some(seen.session_path.clone());
                if !bot.sessions.contains(&seen.session_path) {
                    bot.sessions.push(seen.session_path.clone());
                }
                bot.peer_create
                    .as_mut()
                    .expect("matched creator")
                    .session_id = Some(seen.session_id.clone());
            })
            .map_err(Fail::Tool)?;
        }
        let bot = bots.find(&id).expect("pinned under registry lock");
        let has_routines = bot
            .peer_create
            .as_ref()
            .is_some_and(|peer| !peer.routines.is_empty());
        let installed = if has_routines {
            bots.install_routines(&id)
        } else {
            Ok(())
        };
        let bot = bots.find(&id).expect("pinned under registry lock");
        let peer = bot.peer_create.as_ref().expect("matched creator");
        let now = self.now();
        let pending = peer
            .mail
            .as_ref()
            .filter(|mail| !mail.journaled && !bot.paused)
            .zip(bot.kickoff.as_deref())
            .map_or(Value::Null, |(mail, text)| {
                let content = crate::agentctl::rules::mail::mail_text(
                    &super::bot_first_run::kickoff_mail(&mail.id, text, now),
                );
                json!({"id":mail.id,"text":text,"content":content})
            });
        let state = self.host.state();
        let tab = state
            .tabs
            .iter()
            .find(|tab| {
                tab.device.is_none() && tab.session_path.as_deref() == Some(&seen.session_path)
            })
            .map_or("", |tab| tab.tab_id.as_str());
        let mut context = super::bots::bot_context(bot, &self.items(), &state.tabs, tab, now);
        context["bot"]["firstRun"] = json!(!pending.is_null());
        drop(bots);
        if changed || (has_routines && installed.is_ok()) {
            self.bots_changed();
        }
        installed.map_err(Fail::Tool)?;
        Ok(json!({"context":context,"mail":pending}))
    }

    pub(crate) fn settle_peer_home(
        &self,
        seen: &PeerHome,
        id: &str,
        journaled: bool,
        limited: bool,
    ) -> R<bool> {
        if !journaled && !limited {
            return Ok(false);
        }
        let mut bots = self.bots();
        let Some(bot) = bots
            .of_folder(&seen.cwd)
            .filter(|bot| bot.home.is_some() && seen.matches(bot))
        else {
            return Ok(false);
        };
        let Some(mail) = bot
            .peer_create
            .as_ref()
            .and_then(|peer| peer.mail.as_ref())
            .filter(|mail| mail.id == id)
        else {
            return Ok(false);
        };
        if mail.journaled {
            return Ok(journaled);
        }
        if limited && mail.limited {
            return Ok(true);
        }
        let key = bot.id.clone();
        bots.change_peer(&key, |bot| {
            let mail = bot
                .peer_create
                .as_mut()
                .and_then(|peer| peer.mail.as_mut())
                .expect("matched mail");
            mail.journaled = journaled;
            mail.limited = limited;
        })
        .map_err(Fail::Tool)?;
        drop(bots);
        self.bots_changed();
        Ok(true)
    }
}
