//! Validate stock's guest-only identity and project it onto the host registration.
#[cfg(test)]
use std::time::Instant;

use serde_json::value::RawValue;
use serde_json::{Value, json};
#[cfg(test)]
use tokio::sync::{mpsc, oneshot};

#[cfg(test)]
use super::lane::{Msg, StockReply};
use crate::server::Fault;
use crate::wsl_copy::Writer;
use crate::wsl_copy::reference::{format_ref, parse_ref};

pub(super) fn refusal(path: &str) -> Option<Fault> {
    Some(match parse_ref(path)? {
        Ok(_) => Fault::new(
            "wsl_session_unavailable",
            "This session requires its WSL host. Windows omp cannot open it.",
        ),
        Err(e) => Fault::new("invalid_wsl_session", e.to_string()),
    })
}

pub(super) fn command_refusal<'a>(field: impl Fn(&str) -> Option<&'a RawValue>) -> Option<Fault> {
    let text = |key| serde_json::from_str::<String>(field(key)?.get()).ok();
    for key in ["sessionPath", "parentSession", "sessionFile", "sessionId"] {
        if let Some(fault) = text(key).as_deref().and_then(refusal) {
            return Some(fault);
        }
    }
    if field("path").is_some() && text("type").as_deref() == Some("move_session") {
        return text("path").as_deref().and_then(refusal);
    }
    None
}

// A late / unsolicited Windows response can be forwarded as an event, but cannot claim a host identity.
pub(super) fn unclaimed_reference(text: &str) -> bool {
    use std::collections::BTreeMap;
    let Ok(envelope) = serde_json::from_str::<BTreeMap<String, &RawValue>>(text) else {
        return false;
    };
    let Some(data) = envelope
        .get("data")
        .filter(|data| data.get().starts_with('{'))
    else {
        return false;
    };
    let Ok(fields) = serde_json::from_str::<BTreeMap<String, &RawValue>>(data.get()) else {
        return false;
    };
    ["sessionFile", "sessionId"].into_iter().any(|key| {
        fields
            .get(key)
            .and_then(|field| serde_json::from_str::<String>(field.get()).ok())
            .is_some_and(|s| parse_ref(&s).is_some())
    })
}

fn invalid() -> Fault {
    Fault::new(
        "invalid_guest_state",
        "The WSL host could not verify this session's state.",
    )
}

#[cfg(test)]
pub(super) enum Probe {
    Offered(oneshot::Sender<Result<(u64, bool), Fault>>),
    Asked {
        seq: u64,
        reply: StockReply,
        deadline: Option<Instant>,
    },
}

#[cfg(test)]
pub struct Answer {
    pub seq: u64,
    pub writer: Writer,
    pub directory: String,
    pub response: Value,
    pub done: oneshot::Sender<Result<Writer, Fault>>,
}

#[cfg(test)]
struct Cancel {
    inbox: mpsc::UnboundedSender<Msg>,
    seq: u64,
}

#[cfg(test)]
impl Drop for Cancel {
    fn drop(&mut self) {
        let _ = self.inbox.send(Msg::CancelGuest(self.seq));
    }
}

/// Test seam for a single correlated exchange, with no admission or execution surface in a production build.
#[cfg(test)]
pub async fn serve_guest_state<F, Fut>(
    tab: &str,
    writer: Writer,
    guest_home: &str,
    exchange: F,
) -> Result<Writer, Fault>
where
    F: FnOnce(Value) -> Fut,
    Fut: Future<Output = Result<Value, Fault>>,
{
    let home = guest_home.strip_prefix('/').ok_or_else(invalid)?;
    if home.split('/').any(|p| matches!(p, "" | "." | ".."))
        || home.contains('\\')
        || home.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let directory = format!("{guest_home}/.ompdesk-sessions/{}", writer.session_key());
    let reference = format_ref(writer.session_key());
    let inbox = super::inbox_of(tab).ok_or_else(invalid)?;
    let (offer, request) = oneshot::channel();
    inbox
        .send(Msg::OfferGuest { reference, offer })
        .map_err(|_| invalid())?;
    let (seq, brief) = request.await.map_err(|_| invalid())??;
    let _cancel = Cancel {
        inbox: inbox.clone(),
        seq,
    };
    let id = format!("{}-{seq}", writer.spawn_id());
    let response = exchange(json!({"type":"get_state", "id":id, "brief":brief})).await?;
    let (done, result) = oneshot::channel();
    inbox
        .send(Msg::GuestAnswer(Box::new(Answer {
            seq,
            writer,
            directory,
            response,
            done,
        })))
        .map_err(|_| invalid())?;
    result.await.map_err(|_| invalid())?
}

// resources/gui-bridge/wsl/original.ts sessionName. Ownership, links and filesystem type are checked in Linux.
pub(super) fn valid_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".jsonl") else {
        return false;
    };
    if stem.is_empty()
        || name.len() > 255
        || name
            .chars()
            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
    {
        return false;
    }
    let device = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    let reserved = ["con", "prn", "aux", "nul", "conin$", "conout$", "clock$"]
        .iter()
        .any(|s| device.eq_ignore_ascii_case(s));
    let port = device
        .get(..3)
        .is_some_and(|s| s.eq_ignore_ascii_case("com") || s.eq_ignore_ascii_case("lpt"))
        && device
            .get(3..)
            .is_some_and(|s| s.chars().count() == 1 && "0123456789¹²³".contains(s));
    !reserved && !port
}

#[cfg(test)]
impl Answer {
    pub(super) fn project(&mut self) -> Result<Value, Fault> {
        let id = format!("{}-{}", self.writer.spawn_id(), self.seq);
        project(
            &mut self.writer,
            &self.directory,
            &self.response,
            &id,
            self.seq,
        )
    }
}

pub(super) fn project(
    writer: &mut Writer,
    directory: &str,
    response: &Value,
    id: &str,
    seq: u64,
) -> Result<Value, Fault> {
    if response["type"] != "response"
        || response["command"] != "get_state"
        || response["id"].as_str() != Some(id)
        || response["success"] != true
    {
        return Err(invalid());
    }
    let stock = &response["data"];
    let file = stock["sessionFile"].as_str().ok_or_else(invalid)?;
    let (parent, name) = file.rsplit_once('/').ok_or_else(invalid)?;
    if parent != directory || !valid_name(name) {
        return Err(invalid());
    }
    writer
        .bind_stock_id(stock["sessionId"].as_str().ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    writer.remember_original(name).map_err(|_| invalid())?;
    let reference = format_ref(writer.session_key());
    let registration = writer.registration();
    let mut data = json!({
        "sessionId":reference, "sessionFile":reference, "cwd":registration.cwd,
        "openedBySession":registration.parent, "parentSession":registration.parent,
    });
    // Pre-admission projects identity and scalar run facts only, never tool grants, model configuration or paths.
    for key in [
        "isStreaming",
        "isCompacting",
        "isSettled",
        "hasPendingAsyncWork",
    ] {
        if let Some(value) = stock[key].as_bool() {
            data[key] = value.into();
        }
    }
    for key in ["messageCount", "queuedMessageCount"] {
        if let Some(value) = stock[key].as_u64() {
            data[key] = value.into();
        }
    }
    Ok(json!({
        "type":"response", "command":"get_state", "id":format!("gui-{seq}"),
        "success":true, "data":data,
    }))
}
