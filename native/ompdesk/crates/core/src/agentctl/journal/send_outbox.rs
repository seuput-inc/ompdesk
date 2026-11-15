//! Original instructions retained until the receiving journal acknowledges their stable markers.
//! A handover or an empty in-memory queue is not an acknowledgement. Historical delivery tags are
//! preserved as storage data only; every delivery uses the single current-instruction path.
//! Per-receiver lanes preserve the original order across retries and relaunches.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

#[cfg(test)]
use super::Clock;
use super::attachments::{Attached, AttachedSet, attached_sig, read_attached, same_attached_refs};
use super::{js_number, number, object, read_array, string, stringify, write_text};

/// Decoded only to preserve an existing journal row; never controls delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoricalStreamingBehavior {
    Steer,
    FollowUp,
}

impl HistoricalStreamingBehavior {
    fn as_str(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "followUp",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutboxSend {
    /// The marker the message carries: what the receiver's journal is asked for.
    pub mark: String,
    /// The dispatch number of an opener's message to its child (`dN`).
    pub dispatch: Option<i64>,
    /// The receiver's session file (a paired device's own path when `device` is set).
    pub session_path: String,
    pub device: Option<String>,
    /// The sender's session file (its tab id when it has none).
    pub from: String,
    /// The computer the sender's session runs on, when a paired device's: where it is told a delivery failed.
    pub from_device: Option<String>,
    /// What the sender wrote.
    pub body: String,
    /// The prompt as sent: wrapped, with its markers.
    pub message: String,
    /// What the message carries: its pictures (bytes in the attachment store) and the files landed for its receiver.
    pub attachments: Option<AttachedSet>,
    /// Its record of attachments was damaged: it is never delivered as text alone.
    pub attachments_corrupt: bool,
    historical_streaming_behavior: Option<HistoricalStreamingBehavior>,
    /// The receiver omp it was handed to, or `tab:<tab id>`; absent: not handed to any omp yet.
    pub instance: Option<String>,
    pub at: f64,
    /// `instance` set after the entry was made lands after `at` in the file, as an assignment to an object did.
    instance_last: bool,
}

impl OutboxSend {
    /// An entry as the service makes one (no instance yet).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        mark: String,
        dispatch: Option<i64>,
        session_path: String,
        device: Option<String>,
        from: String,
        body: String,
        message: String,
        at: f64,
    ) -> OutboxSend {
        OutboxSend {
            mark,
            dispatch,
            session_path,
            device: device.filter(|device| !device.is_empty()),
            from,
            from_device: None,
            body,
            message,
            attachments: None,
            attachments_corrupt: false,
            historical_streaming_behavior: None,
            instance: None,
            at,
            instance_last: false,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("mark".into(), self.mark.clone().into());
        if let Some(dispatch) = self.dispatch {
            map.insert("dispatch".into(), dispatch.into());
        }
        map.insert("sessionPath".into(), self.session_path.clone().into());
        if let Some(device) = &self.device {
            map.insert("device".into(), device.clone().into());
        }
        map.insert("from".into(), self.from.clone().into());
        if let Some(from_device) = &self.from_device {
            map.insert("fromDevice".into(), from_device.clone().into());
        }
        map.insert("body".into(), self.body.clone().into());
        map.insert("message".into(), self.message.clone().into());
        if let Some(attachments) = &self.attachments {
            map.insert("attachments".into(), attachments.to_json());
        }
        if self.attachments_corrupt {
            map.insert("attachmentsCorrupt".into(), true.into());
        }
        if let Some(behavior) = self.historical_streaming_behavior {
            map.insert("streamingBehavior".into(), behavior.as_str().into());
        }
        if let Some(instance) = self.instance.as_ref().filter(|_| !self.instance_last) {
            map.insert("instance".into(), instance.clone().into());
        }
        map.insert("at".into(), js_number(self.at));
        if let Some(instance) = self.instance.as_ref().filter(|_| self.instance_last) {
            map.insert("instance".into(), instance.clone().into());
        }
        Value::Object(map)
    }
}

/// What the receiver's bridge answers about markers (`agent_control_sent`).
#[derive(Debug, Clone, PartialEq)]
pub struct SentAnswer {
    pub instance: String,
    pub journaled: Vec<String>,
}

/// A receiver session: its file on the computer it is saved on.
pub fn receiver_key(session_path: &str, device: Option<&str>) -> String {
    format!("{}\n{session_path}", device.unwrap_or(""))
}

fn entry_key(session_path: &str, device: Option<&str>, mark: &str) -> String {
    format!("{}\n{mark}", receiver_key(session_path, device))
}

fn key_of(entry: &OutboxSend) -> String {
    entry_key(&entry.session_path, entry.device.as_deref(), &entry.mark)
}

pub(crate) fn parse_entry(value: &Value) -> Option<OutboxSend> {
    let fields = object(value)?;
    let mark = string(fields, "mark").filter(|mark| !mark.is_empty())?;
    let session_path = string(fields, "sessionPath").filter(|path| !path.is_empty())?;
    let from = string(fields, "from")?;
    let body = string(fields, "body")?;
    let message = string(fields, "message").filter(|message| !message.is_empty())?;
    let historical_streaming_behavior = match fields.get("streamingBehavior") {
        None => None,
        Some(Value::String(value)) if value == "steer" => Some(HistoricalStreamingBehavior::Steer),
        Some(Value::String(value)) if value == "followUp" => {
            Some(HistoricalStreamingBehavior::FollowUp)
        }
        _ => return None,
    };
    let at = number(fields, "at")?;
    // A record of attachments that cannot be read never reads as "none": the message would go without them.
    let (attachments, corrupt) = match read_attached(fields.get("attachments")) {
        Attached::None => (None, false),
        Attached::Set(set) => (Some(set), false),
        Attached::Corrupt => (None, true),
    };
    let dispatch = number(fields, "dispatch")
        .filter(|n| n.fract() == 0.0)
        .map(|n| n as i64);
    Some(OutboxSend {
        mark: mark.to_owned(),
        dispatch,
        session_path: session_path.to_owned(),
        device: string(fields, "device")
            .filter(|d| !d.is_empty())
            .map(str::to_owned),
        from: from.to_owned(),
        from_device: string(fields, "fromDevice")
            .filter(|d| !d.is_empty())
            .map(str::to_owned),
        body: body.to_owned(),
        message: message.to_owned(),
        attachments,
        attachments_corrupt: corrupt
            || fields.get("attachmentsCorrupt") == Some(&Value::Bool(true)),
        historical_streaming_behavior,
        instance: string(fields, "instance")
            .filter(|i| !i.is_empty())
            .map(str::to_owned),
        at,
        instance_last: false,
    })
}

struct State {
    file: Option<PathBuf>,
    /// Oldest first.
    entries: Vec<(String, OutboxSend)>,
    /// Only this prefix was loaded or included in a successful save. The suffix still owns its originals.
    saved_prefix: usize,
}

pub struct SendOutbox {
    state: Mutex<State>,
    /// One delivery at a time per receiver session.
    lanes: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl State {
    fn position(&self, key: &str) -> Option<usize> {
        self.entries.iter().position(|(held, _)| held == key)
    }

    fn save(&mut self) {
        if let Err(error) = self.persist() {
            eprintln!("[send-outbox] not saved: {error}");
        }
    }

    fn persist(&mut self) -> Result<(), String> {
        if let Some(file) = &self.file {
            let text = stringify(
                self.entries
                    .iter()
                    .map(|(_, entry)| entry.to_json())
                    .collect(),
            );
            write_text(file, &text, Some(0o600))?;
        }
        // A deliberately fileless outbox keeps its existing in-memory behavior, not a Disk acknowledgement.
        self.saved_prefix = self.entries.len();
        Ok(())
    }

    fn pending(&self) -> Vec<OutboxSend> {
        self.entries
            .iter()
            .map(|(_, entry)| entry.clone())
            .collect()
    }
}

impl SendOutbox {
    pub fn new(file: Option<PathBuf>) -> SendOutbox {
        let mut state = State {
            file,
            entries: Vec::new(),
            saved_prefix: 0,
        };
        if let Some(file) = state.file.clone() {
            for item in read_array(&file) {
                if let Some(entry) = parse_entry(&item) {
                    let key = key_of(&entry);
                    match state.position(&key) {
                        Some(at) => state.entries[at].1 = entry,
                        None => state.entries.push((key, entry)),
                    }
                }
            }
        }
        state.saved_prefix = state.entries.len();
        SendOutbox {
            state: Mutex::new(state),
            lanes: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    pub fn with_clock(file: Option<PathBuf>, _now: Clock) -> SendOutbox {
        Self::new(file)
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Same-key retries preserve the first envelope and its position; conflicts leave it untouched.
    pub fn keep(&self, entry: OutboxSend) -> Result<(), String> {
        let mut state = self.state();
        let key = key_of(&entry);
        if let Some(at) = state.position(&key) {
            let original = &state.entries[at].1;
            if original.from != entry.from
                || original.from_device != entry.from_device
                || original.body != entry.body
                || original.attachments_corrupt != entry.attachments_corrupt
                || !same_attached_refs(original.attachments.as_ref(), entry.attachments.as_ref())
            {
                return Err("An existing instruction has different content or attachments".into());
            }
        } else {
            state.entries.push((key, entry));
        }
        state.persist()
    }

    /// The message is in the hands of the omp `instance` (it queues or runs it).
    pub fn handed(&self, entry: &OutboxSend, instance: &str) {
        let mut state = self.state();
        let Some(at) = state.position(&key_of(entry)) else {
            return;
        };
        let kept = &mut state.entries[at].1;
        if kept.instance.as_deref() == Some(instance) {
            return;
        }
        if kept.instance.is_none() {
            kept.instance_last = true;
        }
        kept.instance = Some(instance.to_owned());
        state.save();
    }

    /// The receiver's journal holds it (or it will never be owed again): nothing more to do.
    pub fn settle(&self, session_path: &str, device: Option<&str>, mark: &str) {
        let mut state = self.state();
        if let Some(at) = state.position(&entry_key(session_path, device, mark)) {
            state.entries.remove(at);
            if at < state.saved_prefix {
                state.saved_prefix -= 1;
            }
            state.save();
        }
    }

    /// Every message still owed, oldest first.
    pub fn pending(&self) -> Vec<OutboxSend> {
        self.state().pending()
    }

    /// The messages still owed to one receiver session, oldest first.
    pub fn owed_to(&self, session_path: &str, device: Option<&str>) -> Vec<OutboxSend> {
        let key = receiver_key(session_path, device);
        self.pending()
            .into_iter()
            .filter(|entry| receiver_key(&entry.session_path, entry.device.as_deref()) == key)
            .collect()
    }

    /// Retry the canonical save before exposing new originals to the delivery consumer.
    fn delivery_to(&self, session_path: &str, device: Option<&str>) -> (Vec<OutboxSend>, bool) {
        let mut state = self.state();
        if state.saved_prefix < state.entries.len() {
            state.save();
        }
        let mut ready = Vec::new();
        let mut all_saved = true;
        for (at, (_, entry)) in state.entries.iter().enumerate() {
            if entry.session_path == session_path
                && entry.device.as_deref().unwrap_or("") == device.unwrap_or("")
            {
                if at < state.saved_prefix {
                    ready.push(entry.clone());
                } else {
                    all_saved = false;
                }
            }
        }
        (ready, all_saved)
    }

    /// The highest dispatch number still owed to a receiver (0: none), above which a new dispatch is numbered.
    pub fn last_dispatch(&self, session_path: &str, device: Option<&str>) -> i64 {
        self.owed_to(session_path, device)
            .iter()
            .map(|entry| entry.dispatch.unwrap_or(0))
            .fold(0, i64::max)
    }

    /// The same message (and the same attachments, `sig`: `attached_sig`) from the same sender, still owed to the
    /// receiver: a resend joins it.
    pub fn waiting(
        &self,
        from: &str,
        session_path: &str,
        device: Option<&str>,
        body: &str,
        sig: &str,
    ) -> Option<OutboxSend> {
        self.owed_to(session_path, device)
            .into_iter()
            .find(|entry| {
                entry.from == from
                    && entry.body == body
                    && attached_sig(entry.attachments.as_ref()) == sig
            })
    }

    /// The files of a message landed again (their uploads were deleted): its text and files as they stand now.
    pub fn relanded(&self, entry: &OutboxSend, message: &str, attachments: &AttachedSet) {
        let mut state = self.state();
        let Some(at) = state.position(&key_of(entry)) else {
            return;
        };
        let kept = &mut state.entries[at].1;
        kept.message = message.to_owned();
        kept.attachments = Some(attachments.clone());
        state.save();
    }

    /// The SHA-256 of every attachment a message still owed names: what the attachment store must keep.
    pub fn attachment_shas(&self) -> std::collections::HashSet<String> {
        self.pending()
            .iter()
            .flat_map(|entry| entry.attachments.iter())
            .flat_map(|set| set.shas().map(str::to_owned))
            .collect()
    }

    /// Run `work` alone for one receiver session (deliveries to it never overlap).
    pub async fn lane<T>(&self, key: &str, work: impl Future<Output = T>) -> T {
        let lane = {
            let mut lanes = self
                .lanes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            lanes.entry(key.to_owned()).or_default().clone()
        };
        let result = {
            let _alone = lane.lock().await;
            work.await
        };
        let mut lanes = self
            .lanes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Ours and the map's are the only handles left: nobody waits on it.
        if Arc::strong_count(&lane) == 2 {
            lanes.remove(key);
        }
        result
    }
}

/// How handing a prompt over went: taken (or queued behind a command still running there), or refused or unsent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandOver {
    Handed,
    Refused,
}

/// What `deliver_owed` asks of main (`OwedDeps`).
pub trait OwedDeps: Sync {
    /// The live tab holding the receiver's session now (a new id after a relaunch); none while it is not open or
    /// starting.
    fn tab_of(&self, session_path: &str, device: Option<&str>) -> Option<String>;
    /// The receiver's bridge about the markers; `None` when it cannot be asked (starting, going away).
    fn sent(
        &self,
        tab_id: &str,
        marks: &[String],
    ) -> impl Future<Output = Option<SentAnswer>> + Send;
    /// Hand the prompt to the receiver's omp.
    fn prompt(&self, tab_id: &str, entry: &OutboxSend) -> impl Future<Output = HandOver> + Send;
}

/// Hand one receiver session what is still owed to it, in order: settle what its journal holds; leave what its
/// current omp already holds; send the rest to it once. Stops at the first message it cannot hand over. Resolves true
/// when nothing owed is left unhanded. Run inside the receiver's lane.
pub async fn deliver_owed<D: OwedDeps>(
    outbox: &SendOutbox,
    deps: &D,
    session_path: &str,
    device: Option<&str>,
) -> bool {
    let (owed, all_saved) = outbox.delivery_to(session_path, device);
    if owed.is_empty() {
        return all_saved;
    }
    let Some(tab_id) = deps.tab_of(session_path, device) else {
        return false;
    };
    let marks: Vec<String> = owed.iter().map(|entry| entry.mark.clone()).collect();
    let Some(answer) = deps.sent(&tab_id, &marks).await else {
        return false;
    };
    for entry in &owed {
        if answer.journaled.contains(&entry.mark) {
            outbox.settle(&entry.session_path, entry.device.as_deref(), &entry.mark);
            continue;
        }
        let same_tab = format!("tab:{tab_id}");
        if entry.instance.as_deref() == Some(answer.instance.as_str())
            || entry.instance.as_deref() == Some(same_tab.as_str())
        {
            outbox.handed(entry, &answer.instance);
            continue;
        }
        if deps.prompt(&tab_id, entry).await == HandOver::Refused {
            return false;
        }
        outbox.handed(entry, &answer.instance);
    }
    all_saved
}

/// One pass over every receiver owed a message (the runtime's sweep).
pub async fn redeliver_sends<D: OwedDeps>(outbox: &SendOutbox, deps: &D) {
    let mut receivers: Vec<(String, String, Option<String>)> = Vec::new();
    for entry in outbox.pending() {
        let key = receiver_key(&entry.session_path, entry.device.as_deref());
        match receivers.iter_mut().find(|(held, ..)| *held == key) {
            Some(held) => *held = (key, entry.session_path, entry.device),
            None => receivers.push((key, entry.session_path, entry.device)),
        }
    }
    for (key, session_path, device) in receivers {
        outbox
            .lane(
                &key,
                deliver_owed(outbox, deps, &session_path, device.as_deref()),
            )
            .await;
    }
}
