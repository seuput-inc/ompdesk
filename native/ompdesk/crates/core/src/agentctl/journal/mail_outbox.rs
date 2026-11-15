//! A report reaches a busy receiver as a stock `aside`; stock journals it at the receiver's next step boundary, so an
//! omp killed first loses it (`mail-outbox.ts`). Main keeps each accepted report, per receiver session file (and paired
//! device), until the receiver's journal holds its id. Every pass asks the receiver's current omp again with the same
//! id: its bridge answers `{duplicate, journaled}` for an id it holds or queued and delivers one it has never seen.
//!
//! Kept in `<userData>/mail-outbox.json` (mode 0o600) until the receiver's journal acknowledges its id.
//! Unconsumed originals never expire or disappear to make room for newer reports.
//!
//! Seams: the clock, and `RedeliverDeps` (the tab pool's `tabOf` and the receiver's bridge answer). The outbox is
//! internally locked (`&self`), so a pass may await the bridge while the host keeps reports. `RedeliverDeps::send`
//! answers `None` where the TypeScript promise rejected or answered nothing: either keeps the report for the next pass.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};

#[cfg(test)]
use super::Clock;
use super::attachments::{Attached, AttachedSet, read_attached, same_attached_refs};
use super::{js_number, number, object, read_array, string, stringify, write_text};
use crate::agentctl::rules::mail::MailDelivery;

/// Old journal spelling only. It never enters the active effect payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HistoricalMailDelivery {
    Aside,
    FollowUp,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutboxMail {
    /// The report's id (`details.id`): the key, and what the receiver's journal is asked for.
    pub id: String,
    /// The receiver's session file (a paired device's own path when `device` is set).
    pub session_path: String,
    pub device: Option<String>,
    /// The reporting session (its file, its tab id when it has none) and its computer: told when a delivery fails.
    pub from: Option<String>,
    pub from_device: Option<String>,
    pub content: String,
    /// What the transcript draws (any JSON value the file held; a report's own is an object).
    pub details: Value,
    pub delivery: MailDelivery,
    pub(crate) historical_delivery: Option<HistoricalMailDelivery>,
    /// What the report carries: its pictures (bytes in the attachment store) and the files landed for its receiver.
    pub attachments: Option<AttachedSet>,
    /// Its record of attachments was damaged: it is never delivered as text alone.
    pub attachments_corrupt: bool,
    pub at: f64,
}

impl OutboxMail {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("id".into(), self.id.clone().into());
        map.insert("sessionPath".into(), self.session_path.clone().into());
        if let Some(device) = self.device.as_ref().filter(|device| !device.is_empty()) {
            map.insert("device".into(), device.clone().into());
        }
        if let Some(from) = self.from.as_ref().filter(|from| !from.is_empty()) {
            map.insert("from".into(), from.clone().into());
        }
        if let Some(from_device) = self.from_device.as_ref().filter(|d| !d.is_empty()) {
            map.insert("fromDevice".into(), from_device.clone().into());
        }
        map.insert("content".into(), self.content.clone().into());
        map.insert("details".into(), self.details.clone());
        let mut delivery = self.delivery.to_json();
        if let Some(tag) = self.historical_delivery {
            delivery["deliverAs"] = match tag {
                HistoricalMailDelivery::Aside => "aside",
                HistoricalMailDelivery::FollowUp => "followUp",
            }
            .into();
        }
        map.insert("delivery".into(), delivery);
        if let Some(attachments) = &self.attachments {
            map.insert("attachments".into(), attachments.to_json());
        }
        if self.attachments_corrupt {
            map.insert("attachmentsCorrupt".into(), true.into());
        }
        map.insert("at".into(), js_number(self.at));
        Value::Object(map)
    }
}

pub(crate) fn parse_entry(value: &Value) -> Option<OutboxMail> {
    let fields = object(value)?;
    let id = string(fields, "id").filter(|id| !id.is_empty())?;
    let session_path = string(fields, "sessionPath").filter(|path| !path.is_empty())?;
    let content = string(fields, "content")?;
    let details = fields
        .get("details")
        .filter(|details| object(details).is_some())?;
    let delivery = object(fields.get("delivery")?)?;
    let at = number(fields, "at")?;
    let (attachments, corrupt) = match read_attached(fields.get("attachments")) {
        Attached::None => (None, false),
        Attached::Set(set) => (Some(set), false),
        Attached::Corrupt => (None, true),
    };
    let trigger_turn = delivery.get("triggerTurn")?.as_bool()?;
    let historical_delivery = match delivery.get("deliverAs") {
        None => None,
        Some(Value::String(kind)) if kind == "aside" => Some(HistoricalMailDelivery::Aside),
        Some(Value::String(kind)) if kind == "followUp" => Some(HistoricalMailDelivery::FollowUp),
        Some(_) => return None,
    };
    Some(OutboxMail {
        id: id.to_owned(),
        session_path: session_path.to_owned(),
        device: string(fields, "device")
            .filter(|d| !d.is_empty())
            .map(str::to_owned),
        from: string(fields, "from")
            .filter(|d| !d.is_empty())
            .map(str::to_owned),
        from_device: string(fields, "fromDevice")
            .filter(|d| !d.is_empty())
            .map(str::to_owned),
        content: content.to_owned(),
        details: details.clone(),
        delivery: MailDelivery { trigger_turn },
        historical_delivery,
        attachments,
        attachments_corrupt: corrupt
            || fields.get("attachmentsCorrupt") == Some(&Value::Bool(true)),
        at,
    })
}

struct State {
    file: Option<PathBuf>,
    /// Oldest first.
    entries: Vec<OutboxMail>,
    /// Only this prefix was loaded or included in a successful save; pending ownership includes the suffix.
    saved_prefix: usize,
}

impl State {
    fn save(&mut self) {
        if let Err(error) = self.persist() {
            eprintln!("[mail-outbox] not saved: {error}");
        }
    }

    fn persist(&mut self) -> Result<(), String> {
        if let Some(file) = &self.file {
            let text = stringify(self.entries.iter().map(OutboxMail::to_json).collect());
            write_text(file, &text, Some(0o600))?;
        }
        // Fileless instances are intentionally memory-only, never a Disk acknowledgement.
        self.saved_prefix = self.entries.len();
        Ok(())
    }
}

pub struct MailOutbox {
    state: Mutex<State>,
}

impl MailOutbox {
    pub fn new(file: Option<PathBuf>) -> MailOutbox {
        let mut state = State {
            file,
            entries: Vec::new(),
            saved_prefix: 0,
        };
        if let Some(file) = state.file.clone() {
            for item in read_array(&file) {
                if let Some(entry) = parse_entry(&item) {
                    match state.entries.iter_mut().find(|held| held.id == entry.id) {
                        Some(held) => *held = entry,
                        None => state.entries.push(entry),
                    }
                }
            }
        }
        state.saved_prefix = state.entries.len();
        MailOutbox {
            state: Mutex::new(state),
        }
    }

    #[cfg(test)]
    pub fn with_clock(file: Option<PathBuf>, _now: Clock) -> MailOutbox {
        Self::new(file)
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A same-id retry joins the first envelope without changing its position or contents.
    pub fn keep(&self, entry: OutboxMail) -> Result<(), String> {
        let mut state = self.state();
        if let Some(original) = state
            .entries
            .iter()
            .find(|original| original.id == entry.id)
        {
            if original.session_path != entry.session_path
                || original.device != entry.device
                || original.from != entry.from
                || original.from_device != entry.from_device
                || original.content != entry.content
                || original.details != entry.details
                || original.delivery != entry.delivery
                || original.attachments_corrupt != entry.attachments_corrupt
                || !same_attached_refs(original.attachments.as_ref(), entry.attachments.as_ref())
            {
                return Err(
                    "An existing report has different content, recipient or attachments".into(),
                );
            }
        } else {
            state.entries.push(entry);
        }
        state.persist()
    }

    /// The files of a report landed again (their uploads were deleted): its text and files as they stand now.
    pub fn relanded(&self, id: &str, content: &str, details: &Value, attachments: &AttachedSet) {
        let mut state = self.state();
        let Some(kept) = state.entries.iter_mut().find(|held| held.id == id) else {
            return;
        };
        kept.content = content.to_owned();
        kept.details = details.clone();
        kept.attachments = Some(attachments.clone());
        state.save();
    }

    /// The SHA-256 of every attachment a report still waiting names: what the attachment store must keep.
    pub fn attachment_shas(&self) -> std::collections::HashSet<String> {
        self.pending()
            .iter()
            .flat_map(|entry| entry.attachments.iter())
            .flat_map(|set| set.shas().map(str::to_owned))
            .collect()
    }

    /// The receiver's journal holds `id`: nothing more to do for it.
    pub fn settle(&self, id: &str) {
        let mut state = self.state();
        if let Some(at) = state.entries.iter().position(|held| held.id == id) {
            state.entries.remove(at);
            if at < state.saved_prefix {
                state.saved_prefix -= 1;
            }
            state.save();
        }
    }

    /// The reports still waiting for their receiver's journal, oldest first.
    pub fn pending(&self) -> Vec<OutboxMail> {
        self.state().entries.clone()
    }

    /// Retry the same canonical save; failed originals stay visible to dedup and attachment retention only.
    fn delivery_pending(&self) -> Vec<OutboxMail> {
        let mut state = self.state();
        if state.saved_prefix < state.entries.len() {
            state.save();
        }
        state.entries[..state.saved_prefix].to_vec()
    }
}

/// The receiver's bridge answer to a report (`agent_control_mail`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MailAnswer {
    pub duplicate: bool,
    pub journaled: bool,
}

pub trait RedeliverDeps: Sync {
    /// The live tab holding the receiver's session file now (it has a new id after a relaunch), if any.
    fn tab_of(&self, session_path: &str, device: Option<&str>) -> Option<String>;
    /// The receiver's bridge answer to the report; `None` when it could not be asked or said nothing.
    fn send(
        &self,
        tab_id: &str,
        mail: &OutboxMail,
    ) -> impl Future<Output = Option<MailAnswer>> + Send;
}

/// One pass over the outbox: each report whose receiver has a live tab is sent again with its id. An answer that says
/// the journal holds it settles it; any other answer keeps it for the next pass.
pub async fn redeliver_mail<D: RedeliverDeps>(outbox: &MailOutbox, deps: &D) {
    for mail in outbox.delivery_pending() {
        let Some(tab_id) = deps.tab_of(&mail.session_path, mail.device.as_deref()) else {
            continue;
        };
        if let Some(answer) = deps.send(&tab_id, &mail).await
            && answer.duplicate
            && answer.journaled
        {
            outbox.settle(&mail.id);
        }
    }
}
