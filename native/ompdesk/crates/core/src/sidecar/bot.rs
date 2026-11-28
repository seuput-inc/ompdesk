//! One host-authorized launch. A grant moves into its first child and is never reconstructed from a session.

use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::Path;

use serde_json::{json, value::RawValue};

use crate::agentctl::runtime::{
    bot_chat_authority, bot_chat_matches, bot_chat_prior_paths, observe_bot_chat,
};
use crate::server::Fault;

pub(super) struct BotChat {
    port: u64,
    pub id: String,
    state: State,
}

enum State {
    Fresh(HashSet<String>),
    Reopen {
        file: String,
        stock_id: String,
    },
    Observed {
        file: String,
        stock_id: String,
        reopen: bool,
        bound: bool,
    },
}

fn refused() -> Fault {
    Fault::new(
        "bot_chat_changed",
        "The bot chat is no longer available for this launch",
    )
}

impl BotChat {
    pub fn open(port: u64, id: String, cwd: &str, path: Option<&str>) -> Result<Self, Fault> {
        let (folder, stock_id) = bot_chat_authority(port, &id, path)?;
        if folder != cwd {
            return Err(refused());
        }
        let state = match (path, stock_id) {
            (Some(file), Some(stock_id)) => State::Reopen {
                file: file.to_owned(),
                stock_id,
            },
            (None, None) => State::Fresh(bot_chat_prior_paths(port, &id)?),
            _ => return Err(refused()),
        };
        Ok(Self { port, id, state })
    }

    /// Only the lane's initial stock get_state can move a grant to Observed.
    pub fn observe(&mut self, initial: bool, file: Option<&str>, stock_id: Option<&str>) -> bool {
        let (Some(file), Some(stock_id)) = (file, stock_id) else {
            return false;
        };
        let path = Path::new(file);
        if stock_id.trim().is_empty()
            || !path.is_absolute()
            || path.extension().is_none_or(|ext| ext != "jsonl")
        {
            return false;
        }
        let reopen = match &self.state {
            // This child's manager materializes its new journal below. An alias or hard link to
            // an old file is not a fresh home, nor is a missing path already registered for delivery.
            State::Fresh(prior)
                if initial
                    && !prior.contains(file)
                    && std::fs::symlink_metadata(path)
                        .is_err_and(|e| e.kind() == ErrorKind::NotFound) =>
            {
                false
            }
            State::Reopen {
                file: expected,
                stock_id: id,
            } if initial && expected == file && id == stock_id => true,
            State::Observed {
                file: expected,
                stock_id: id,
                ..
            } => return !initial && expected == file && id == stock_id,
            _ => return !initial,
        };
        self.state = State::Observed {
            file: file.to_owned(),
            stock_id: stock_id.to_owned(),
            reopen,
            bound: false,
        };
        true
    }

    /// Stock waits for the first assistant turn to write its journal. Only this child's own manager
    /// may materialize the blank file, and only if its live (cwd, file, id) still matches.
    pub fn new_home(&self, cwd: &str) -> Option<Box<RawValue>> {
        let State::Observed {
            file,
            stock_id,
            reopen: false,
            bound: false,
        } = &self.state
        else {
            return None;
        };
        serde_json::value::to_raw_value(&json!({
            "cwd": cwd, "sessionPath": file, "sessionId": stock_id,
        }))
        .ok()
    }

    pub fn bridge_confirmed(&mut self, cwd: &str) -> bool {
        let State::Observed {
            file,
            stock_id,
            reopen,
            bound,
        } = &mut self.state
        else {
            return false;
        };
        if !*bound {
            *bound = observe_bot_chat(
                self.port,
                &self.id,
                cwd,
                reopen.then_some(file.as_str()),
                file,
                stock_id,
            );
            return *bound;
        }
        self.current(cwd)
    }

    pub fn bound(&self) -> bool {
        matches!(self.state, State::Observed { bound: true, .. })
    }

    pub fn current(&self, cwd: &str) -> bool {
        let saved = match &self.state {
            State::Reopen { file, stock_id }
            | State::Observed {
                file,
                stock_id,
                reopen: true,
                ..
            }
            | State::Observed {
                file,
                stock_id,
                bound: true,
                ..
            } => Some((file.as_str(), stock_id.as_str())),
            _ => None,
        };
        bot_chat_matches(self.port, &self.id, cwd, saved)
    }
}
