use super::*;
use crate::agentctl::journal::attachments::sha256_hex;
use crate::agentctl::journal::items::{ItemMail, ItemMailState, ItemRecord};
use crate::agentctl::journal::send_outbox::SEND_OUTBOX_TTL_MS;

fn still_held(item: &ItemRecord, mail: &ItemMail) -> bool {
    item.is_open()
        && item.work.as_ref().is_some_and(|work| {
            !work.released
                && work.generation == mail.generation
                && work.device == mail.device
                && work.session.as_ref() == Some(&mail.session)
        })
}

fn at_address<'a>(
    state: &'a HostState,
    session: &str,
    device: Option<&str>,
) -> Option<&'a ControlTab> {
    let mut found = state.tabs.iter().filter(|tab| {
        tab.session_path.as_deref() == Some(session)
            && tab.device.as_deref() == device
            && !tab.viewing
    });
    let first = found.next()?;
    found.next().is_none().then_some(first)
}

impl AgentControl {
    pub(in crate::agentctl::service) async fn send_item_mail(
        &self,
        caller: &ControlTab,
        address: &str,
        args: &SendArgs,
    ) -> R<String> {
        if !args.session.is_empty() || args.sessions.is_some() || args.attachments.is_some() {
            return fail("Item mail takes only item, message and request_id.");
        }
        let Some(request) = args
            .request_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
        else {
            return fail("Item mail needs request_id.");
        };
        let Some(outbox) = &self.send_outbox else {
            return fail("Item delivery is unavailable.");
        };
        let board = self
            .bots()
            .of_folder(&caller.cwd)
            .map(|b| (b.id.clone(), b.name.clone()));
        let Some((board, name)) = board.filter(|(id, _)| self.item_assigner(caller, id)) else {
            return fail("Only an authorized chat of the item owner's board can send item mail.");
        };
        let from = caller
            .session_path
            .as_deref()
            .ok_or_else(|| Fail::Tool("No saved sender.".into()))?;
        if self.stopping(&caller.tab_id) {
            return fail("Autopilot is ending: start nothing new.");
        }
        let state = self.host.state();
        let (id, key) = {
            let mut store = self.items();
            let item = store.write_address(&board, address).map_err(Fail::Tool)?;
            let id = item.id.clone();
            // JSON frames the components: paths and user keys containing delimiters cannot alias another sender.
            let key = sha256_hex(json!([board, id, from, request]).to_string().as_bytes());
            let input = sha256_hex(args.message.as_bytes());
            if let Some(known) = item.mail.get(&key) {
                if known.input != input {
                    return fail(
                        "request_conflict: this item mail key already has different input.",
                    );
                }
            } else {
                if super::super::ITEM_MAIL_RESENT
                    .try_with(|resent| *resent)
                    .unwrap_or(false)
                {
                    return fail(
                        "No accepted receipt for that replay. Use a fresh request for the current holder.",
                    );
                }
                let work = item.work.as_ref().filter(|w| item.is_open() && !w.released);
                let Some((work, session)) = work.and_then(|w| Some((w, w.session.as_ref()?)))
                else {
                    return fail("no_holder");
                };
                if session.is_empty()
                    || state
                        .deleted_at_path(session, work.device.as_deref())
                        .is_some()
                {
                    return fail("no_holder");
                }
                match at_address(&state, session, work.device.as_deref()) {
                    Some(tab)
                        if tab.tab_id != caller.tab_id
                            && !tab.hidden
                            && !tab.session_moved
                            && self.refuse_paused(tab).is_ok() => {}
                    // With no live tab, only the recorded assigner can queue for its disconnected child.
                    None if work.requested_by == from
                        && work.accepted_tab.is_some()
                        && work
                            .device
                            .as_deref()
                            .and_then(|d| state.device(d))
                            .is_some_and(|d| d.state.as_str() != "online")
                        && !state.tabs.iter().any(|t| {
                            t.device == work.device && t.session_path.as_ref() == Some(session)
                        }) => {}
                    _ => return fail("The item holder is not available to this sender."),
                }
                let wrapped = caller.wrap_message(&args.message, &name, None);
                let mail = ItemMail {
                    generation: work.generation,
                    sender: from.to_owned(),
                    session: session.clone(),
                    device: work.device.clone(),
                    input,
                    at: self.now(),
                    state: ItemMailState::Pending(wrapped),
                };
                store.commit_mail(&id, &key, mail).map_err(Fail::Tool)?;
            }
            (id, key)
        };
        self.deliver_item_mail(outbox, &id, &key).await
    }

    fn may_send_item_mail(&self, board: &str, mail: &ItemMail, state: &HostState) -> bool {
        let Some(sender) = at_address(state, &mail.sender, None) else {
            return false;
        };
        let Some(target) = at_address(state, &mail.session, mail.device.as_deref()) else {
            return false;
        };
        !target.session_moved
            && sender.tab_id != target.tab_id
            && !self.stopping(&sender.tab_id)
            && self.item_assigner(sender, board)
            && state
                .deleted_at_path(&mail.session, mail.device.as_deref())
                .is_none()
            && self.refuse_hidden(target, sender).is_ok()
            && self.refuse_paused(target).is_ok()
    }

    /// Called by the execution lane only after its own live process and assignment were authenticated.
    pub(crate) fn permits_item_mail(
        &self,
        item: &str,
        generation: u64,
        session: &str,
        device: Option<&str>,
        key: &str,
        fingerprint: &str,
    ) -> bool {
        let store = self.items();
        let Some(row) = store.get(item) else {
            return false;
        };
        let Some(mail) = row.mail.get(key) else {
            return false;
        };
        let ItemMailState::Pending(body) = &mail.state else {
            return false;
        };
        let state = self.host.state();
        still_held(row, mail)
            && mail.at + SEND_OUTBOX_TTL_MS > self.now()
            && mail.generation == generation
            && mail.session == session
            && mail.device.as_deref() == device
            && sha256_hex(body.as_bytes()) == fingerprint
            && self.may_send_item_mail(&row.bot, mail, &state)
            && at_address(&state, session, device).is_some_and(|tab| !tab.drafting)
    }

    pub(super) async fn redeliver_item_mail(&self, outbox: &SendOutbox) -> R<()> {
        let pending = self.items().pending_mail();
        for (item, key) in pending {
            self.deliver_item_mail(outbox, &item, &key).await?;
        }
        Ok(())
    }

    async fn deliver_item_mail(&self, outbox: &SendOutbox, id: &str, key: &str) -> R<String> {
        let missing = || Fail::Tool("holder_changed".into());
        // Use the regular receiver lane so retries, a sweep and two live senders don't overtake a handoff.
        let lane = self
            .items()
            .get(id)
            .and_then(|r| r.mail.get(key))
            .map(|m| receiver_key(&m.session, m.device.as_deref()))
            .ok_or_else(missing)?;
        outbox.lane(&lane, async {
            let (mail, board, held) = {
                let store = self.items();
                let item = store.get(id).ok_or_else(missing)?;
                let mail = item.mail.get(key).ok_or_else(missing)?;
                (mail.clone(), item.bot.clone(), still_held(item, mail))
            };
            let receipt = |mail: &ItemMail| format!("Item {id} generation {} mail {key}: {}.", mail.generation, mail.state.status());
            let finish = |mut mail: ItemMail, disposition| {
                mail.state = disposition;
                let text = receipt(&mail);
                self.items().commit_mail(id, key, mail).map_err(Fail::Tool)?;
                Ok(text)
            };
            let ItemMailState::Pending(message) = &mail.state else { return Ok(receipt(&mail)); };
            let state = self.host.state();
            if !held || state.deleted_at_path(&mail.session, mail.device.as_deref()).is_some() {
                return finish(mail, ItemMailState::HolderChanged);
            }
            if self.now() >= mail.at + SEND_OUTBOX_TTL_MS { return finish(mail, ItemMailState::Expired); }
            let Some(tab) = at_address(&state, &mail.session, mail.device.as_deref()) else { return Ok(receipt(&mail)); };
            if at_address(&state, &mail.sender, None).is_none() { return Ok(receipt(&mail)); }
            if !self.may_send_item_mail(&board, &mail, &state) { return finish(mail, ItemMailState::AccessRevoked); }
            if mail.device.as_deref().is_some_and(|id| state.device(id).is_none_or(|d| d.state.as_str() != "online")) {
                return Ok(receipt(&mail));
            }
            if tab.status == super::super::types::TabStatus::Asleep { self.host.start(&tab.tab_id); }
            if tab.drafting || !tab.status.is_up() { return Ok(receipt(&mail)); }
            // Query a paired queue before spending a model command: the previous delivery's reply may have been lost.
            if mail.device.is_some() {
                let mark = format!("item-mail:{key}:{}", sha256_hex(mail.session.as_bytes()));
                let probe = json!({"type":"agent_control_sent","marks":[mark]});
                let Ok(response) = self.host.command(&tab.tab_id, &probe, Deadline::Ms(self.tuning.state_timeout_ms)).await else {
                    return Ok(receipt(&mail));
                };
                let Some(data) = response.data.filter(|_| response.success) else { return Ok(receipt(&mail)); };
                if data["itemMail"].as_str() != Some(mark.as_str()) { return finish(mail, ItemMailState::UnsupportedReceiver); }
                if data["matches"] != true { return Ok(receipt(&mail)); }
                if data["journaled"].as_array().is_some_and(|list| list.iter().any(|m| m.as_str() == Some(mark.as_str()))) {
                    return finish(mail, ItemMailState::Delivered);
                }
                if data["queued"] != false || !self.permits_item_mail(id, mail.generation, &mail.session,
                    mail.device.as_deref(), key, &sha256_hex(message.as_bytes())) {
                    return Ok(receipt(&mail));
                }
            }
            let command = json!({"type":"agent_control_item_mail", "item":id, "generation":mail.generation,
                "session":mail.session, "key":key, "message":message});
            let result = self.host.command(&tab.tab_id, &command, Deadline::Ms(self.tuning.prompt_ms)).await;
            // No plain prompt fallback. A queued aside stays owed until the receiver flushes its journal.
            match result {
                Ok(answer) if answer.success => {
                    let Some(data) = answer.data.filter(|d| d["key"] == key) else {
                        return finish(mail, ItemMailState::UnsupportedReceiver);
                    };
                    self.arrive(&tab.tab_id);
                    if data["journaled"] == true { finish(mail, ItemMailState::Delivered) } else { Ok(receipt(&mail)) }
                }
                Ok(answer) if answer.error.as_deref().is_some_and(|e| e.contains("Unknown command") || e.contains("Unknown bridge method")) =>
                    finish(mail, ItemMailState::UnsupportedReceiver),
                _ => Ok(receipt(&mail)),
            }
        }).await
    }
}
