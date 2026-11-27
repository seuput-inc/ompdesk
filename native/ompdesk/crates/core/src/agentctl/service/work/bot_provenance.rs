//! Which events identify the bot that created a worker, rather than its current opener.

use super::super::AgentControl;
use super::super::fail::{R, fail};
use super::super::types::ControlTab;
use super::bots::worker_seen;
use super::schedule::is_absolute;
use crate::agentctl::journal::bots::{BotRecord, BotWorker, WorkerOrigin};

impl ControlTab {
    pub(in crate::agentctl::service) fn still_new_worker(&self) -> bool {
        !self.session_moved
            && !self.user_touched
            && !self.restored
            && !self.viewing
            && self.former_ids.is_empty()
    }
}

impl AgentControl {
    /// Called only after a new spawn returns, under the same lock as a hand or deletion.
    /// A tab whose new file is not known yet is bound during that spawn's setup, never by an opener scan.
    pub(in crate::agentctl::service) fn record_bot_spawn(
        &self,
        id: &str,
        caller: &ControlTab,
        tab_id: &str,
        device: Option<&str>,
        cwd: &str,
    ) -> R<bool> {
        let state = self.host.state();
        let since = crate::aimemory::value::iso(self.now().max(0.0) as u64);
        let worker = match state.tabs.iter().find(|tab| tab.tab_id == tab_id) {
            Some(tab) if tab.device.as_deref() == device && tab.still_new_worker() => worker_seen(
                tab,
                caller.session_path.as_deref(),
                &since,
                Some(WorkerOrigin::Opened),
            ),
            Some(_) => {
                return fail("The new worker's tab changed before its session could be recorded.");
            }
            None => BotWorker {
                session: tab_id.to_owned(),
                device: device.map(str::to_owned),
                origin: Some(WorkerOrigin::Opened),
                opened_by_session: caller.session_path.clone(),
                cwd: cwd.to_owned(),
                since,
                ..BotWorker::default()
            },
        };
        let pending = worker.session == tab_id;
        let changed = self.bots().observe_worker(Some(id), tab_id, worker);
        if changed {
            self.bots_changed();
        }
        Ok(pending && changed)
    }

    pub(in crate::agentctl::service) async fn bind_bot_spawn(
        &self,
        id: &str,
        caller: &ControlTab,
        tab: &ControlTab,
        path: &str,
    ) -> bool {
        let _assignment = self.bot_moves.lock().await;
        let state = self.host.state();
        if !state.tabs.iter().any(|now| {
            now.tab_id == tab.tab_id
                && now.device == tab.device
                && now.still_new_worker()
                && now
                    .session_path
                    .as_deref()
                    .is_none_or(|file| file.is_empty() || file == path)
        }) {
            return false;
        }
        let changed = {
            let mut bots = self.bots();
            let Some(reservation) = bots.find(id).and_then(|bot| {
                bot.workers.iter().find(|worker| {
                    worker.session == tab.tab_id
                        && worker.device == tab.device
                        && worker.origin == Some(WorkerOrigin::Opened)
                })
            }) else {
                return false;
            };
            let mut worker = worker_seen(
                tab,
                caller.session_path.as_deref(),
                &reservation.since,
                Some(WorkerOrigin::Opened),
            );
            worker.session = path.to_owned();
            bots.observe_worker(Some(id), &tab.tab_id, worker)
        };
        if changed {
            self.bots_changed();
        }
        true
    }

    pub(super) fn worker_opened_by_bot(&self, bot: &BotRecord, worker: &BotWorker) -> bool {
        match worker.origin {
            Some(WorkerOrigin::Opened) => true,
            Some(WorkerOrigin::Handed) => false,
            None => worker.opened_by_session.as_deref().is_some_and(|from| {
                is_absolute(from)
                    && bot.has_session(from)
                    && is_absolute(&worker.session)
                    && self.send_outbox.as_ref().is_some_and(|outbox| {
                        outbox.opened_worker(from, worker.device.as_deref(), &worker.session)
                    })
            }),
        }
    }
}
