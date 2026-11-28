//! A spawn-private stock connection. Never route a guest line to the Windows stock frame/bridge dispatchers.
use super::{
    guest_state,
    lane::{Msg, StockReply},
    wsl_boundary as boundary,
    wsl_transport::{Bridge, Guest, Stock, Witness},
};
use crate::{
    server::{Fault, Scope},
    setup::wsl,
    wsl_copy::{Registration, Session, Store, TurnDisposition, Writer, reference},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, io, path::PathBuf, time::Duration};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, oneshot, watch};

const WAIT: Duration = Duration::from_secs(15);
const MAX_LINE: usize = 4 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Project {
    profile: PathBuf,
    bridge_dir: PathBuf,
    tab_tag: String,
    parent: Option<String>,
    #[serde(default)]
    parent_unknown: bool,
    #[serde(default)]
    pub resume_pending: bool,
    choice_cwd: Option<String>,
}

pub(super) struct Prepared {
    guest: Guest,
    registered: Option<Session>,
    registration: Registration,
    project: Project,
}

#[derive(Clone, Copy)]
pub(super) enum Reason {
    NotRegistered,
    NotReady,
    NoAuth,
    Unavailable,
}
impl Reason {
    pub fn wire(self) -> &'static str {
        match self {
            Self::NotRegistered => "notRegistered",
            Self::NotReady => "notReady",
            Self::NoAuth => "noAuth",
            Self::Unavailable => "unavailable",
        }
    }
    fn fault(f: Fault) -> Self {
        match f.code.as_ref() {
            "wsl_not_registered" | "wsl_not_v2" => Self::NotRegistered,
            "wsl_not_ready" | "wsl_probe" => Self::NotReady,
            _ => Self::Unavailable,
        }
    }
}

impl Project {
    pub fn tab_record(&self) -> io::Result<Option<(String, bool)>> {
        Store::tab_record(&self.profile, &self.tab_tag)
    }

    pub fn page(&self, path: &str, cwd: &str, request: &Value) -> Result<Value, Fault> {
        let key = reference::parse_ref(path)
            .and_then(Result::ok)
            .ok_or_else(denied)?;
        let s = Store::open(&self.profile)
            .and_then(|s| s.session(key))
            .map_err(|_| denied())?;
        if s.registration().cwd != cwd {
            return Err(denied());
        }
        super::wsl_page::read(&s, request)
    }

    pub async fn prepare(self, cwd: &str, path: Option<&str>) -> Result<Option<Prepared>, Reason> {
        let scope = Scope::detached();
        let (registration, registered) = if let Some(path) = path {
            let key = reference::parse_ref(path)
                .and_then(Result::ok)
                .ok_or(Reason::Unavailable)?;
            let session = Store::open(&self.profile)
                .and_then(|s| s.session(key))
                .map_err(|_| Reason::Unavailable)?;
            let registration = session.registration().clone();
            if registration.cwd != cwd {
                return Err(Reason::Unavailable);
            }
            wsl::admissible(&registration.distro, &scope)
                .await
                .map_err(Reason::fault)?;
            (registration, Some(session))
        } else {
            if self.resume_pending {
                return Ok(None);
            }
            let Some(distro) = wsl::project::target(
                &self.profile,
                self.choice_cwd.as_deref().unwrap_or(cwd),
                &scope,
            )
            .await
            .map_err(Reason::fault)?
            else {
                return Ok(None);
            };
            (self.registration(cwd, distro.id)?, None)
        };
        if !reference::valid_key(&self.tab_tag) {
            return Err(Reason::Unavailable);
        }
        let guest = Guest::prepare(&registration, &self.bridge_dir)
            .await
            .map_err(|_| Reason::Unavailable)?;
        Ok(Some(Prepared {
            guest,
            registered,
            registration,
            project: self,
        }))
    }

    fn registration(&self, cwd: &str, distro: String) -> Result<Registration, Reason> {
        if self.parent_unknown {
            return Err(Reason::Unavailable);
        }
        Ok(Registration {
            distro,
            parent: self.parent.clone(),
            cwd: cwd.into(),
        })
    }
}

pub(super) enum Notice {
    Ready(Value),
    Frame(Value),
    Answer(u64, Value, StockReply),
    Closed { reason: Reason, fallback: bool },
}
struct Sink {
    inbox: mpsc::UnboundedSender<Msg>,
    generation: u64,
}
impl Sink {
    async fn post(&self, value: Notice) -> io::Result<()> {
        let (ack, done) = oneshot::channel();
        self.inbox
            .send(Msg::WslNotice(self.generation, value, ack))
            .map_err(|_| unavailable())?;
        done.await.map_err(|_| unavailable())
    }
}
struct Request {
    seq: u64,
    value: Value,
    reply: StockReply,
}
pub(super) struct Active {
    requests: mpsc::Sender<Request>,
    stop: watch::Sender<bool>,
    pub done: watch::Receiver<bool>,
    pub confirmed: watch::Receiver<bool>,
}
impl Active {
    pub fn request(&self, seq: u64, command: &serde_json::value::RawValue, reply: StockReply) {
        let Some(value) = serde_json::from_str(command.get())
            .ok()
            .as_ref()
            .and_then(boundary::command)
        else {
            let _ = reply.send(Err(denied()));
            return;
        };
        if let Err(e) = self.requests.try_send(Request { seq, value, reply }) {
            let _ = e.into_inner().reply.send(Err(denied()));
        }
    }
    pub fn stop(self) -> watch::Receiver<bool> {
        self.stop.send_replace(true);
        self.done
    }
}
fn denied() -> Fault {
    Fault::new(
        "wsl_command_unavailable",
        "This command is unavailable on this WSL session.",
    )
}
fn unavailable() -> io::Error {
    io::Error::other("WSL session unavailable")
}

impl Prepared {
    #[cfg(all(test, unix))]
    pub(super) fn fixture(exe: PathBuf, registration: Registration, project: Project) -> Self {
        Self {
            guest: Guest::fixture(exe, registration.clone()),
            registered: None,
            registration,
            project,
        }
    }

    pub fn start(
        self,
        generation: u64,
        inbox: mpsc::UnboundedSender<Msg>,
    ) -> io::Result<(Active, String, String)> {
        let fresh = self.registered.is_none();
        let session = match self.registered {
            Some(s) => s,
            None => Store::open(&self.project.profile)?
                .register_tab(&self.project.tab_tag, self.registration)?,
        };
        let writer = session.admit()?;
        let reference = reference::format_ref(session.key());
        let cwd = session.registration().cwd.clone();
        let (requests, rx) = mpsc::channel(16);
        let (stop, cancel) = watch::channel(false);
        let (ended, done) = watch::channel(false);
        let (proof, confirmed) = watch::channel(false);
        let sink = Sink { generation, inbox };
        tokio::spawn(async move {
            let mut writer = Some(writer);
            let guest = self.guest;
            let mut admitted = false;
            let outcome = run(
                &guest,
                &mut writer,
                &self.project.tab_tag,
                fresh,
                &sink,
                rx,
                cancel,
                &mut admitted,
            )
            .await;
            // Even an exited wsl.exe, or a launch future returning Err, is not a stop receipt.
            let stopped = match writer.as_ref() {
                Some(w) => reconcile(&guest, w).await.is_ok(),
                None => false,
            };
            let fallback = fresh
                && !admitted
                && stopped
                && writer
                    .as_ref()
                    .is_some_and(|w| w.retire_candidate().is_ok());
            drop(writer);
            proof.send_replace(stopped);
            ended.send_replace(true); // host actor finished; the journal fences reuse even when service state is unknown
            let _ = sink
                .post(Notice::Closed {
                    reason: if stopped {
                        outcome.err().unwrap_or(Reason::Unavailable)
                    } else {
                        Reason::Unavailable
                    },
                    fallback,
                })
                .await;
        });
        Ok((
            Active {
                requests,
                stop,
                done,
                confirmed,
            },
            reference,
            cwd,
        ))
    }
}

async fn reconcile(guest: &Guest, writer: &Writer) -> io::Result<()> {
    if let Some(prior) = writer.prior()? {
        let (invocation_id, uid) = prior.receipt.ok_or_else(unavailable)?;
        let witness = Witness { invocation_id, uid };
        guest.stop(&prior.spawn, &witness).await?;
        writer.stopped(&prior.spawn, &witness.invocation_id, witness.uid)?;
    }
    Ok(())
}

async fn write(stdin: &mut ChildStdin, value: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    tokio::time::timeout(WAIT, stdin.write_all(&bytes)).await??;
    Ok(())
}

async fn line(reader: &mut (impl AsyncBufRead + Unpin)) -> io::Result<Value> {
    let mut bytes = Vec::new();
    (&mut *reader)
        .take(MAX_LINE as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .await?;
    if bytes.len() > MAX_LINE || bytes.last() != Some(&b'\n') {
        return Err(unavailable());
    }
    serde_json::from_slice(&bytes).map_err(Into::into)
}

// Own partial lines across select! iterations; never enqueue more than one unread frame per pipe.
fn frames(mut reader: impl AsyncBufRead + Unpin + Send + 'static) -> mpsc::Receiver<Value> {
    let (tx, rx) = mpsc::channel(1);
    tokio::spawn(async move {
        while let Ok(v) = line(&mut reader).await {
            if tx.send(v).await.is_err() {
                break;
            }
        }
    });
    rx
}

struct Relay {
    input: ChildStdin,
    frames: mpsc::Receiver<Value>,
    next: u64,
    _child: tokio::process::Child,
}
impl Relay {
    fn new(bridge: Bridge) -> Self {
        Self {
            input: bridge.stdin,
            frames: frames(bridge.stdout),
            next: 0,
            _child: bridge.child,
        }
    }
    async fn call(&mut self, method: &'static str, params: Value) -> io::Result<Value> {
        self.next += 1;
        let id = self.next;
        write(
            &mut self.input,
            &json!({"id":id,"method":method,"params":params}),
        )
        .await?;
        tokio::time::timeout(WAIT, async {
            while let Some(v) = self.frames.recv().await {
                if v["id"] == id && v.get("event").is_none() {
                    return if v["ok"] == true {
                        Ok(v["result"].clone())
                    } else {
                        Err(unavailable())
                    };
                }
            }
            Err(unavailable())
        })
        .await?
    }
}

struct Peer {
    stdin: ChildStdin,
    frames: mpsc::Receiver<Value>,
    _child: tokio::process::Child,
}
impl Peer {
    fn new(stock: Stock) -> Self {
        let mut stderr = stock.stderr;
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
        Self {
            stdin: stock.stdin,
            frames: frames(BufReader::new(stock.stdout)),
            _child: stock.child,
        }
    }
    async fn exchange(&mut self, id: &str, mut command: Value) -> io::Result<Value> {
        command["id"] = id.into();
        write(&mut self.stdin, &command).await?;
        tokio::time::timeout(WAIT, async {
            while let Some(v) = self.frames.recv().await {
                if v["type"] == "response" && v["id"] == id && v["command"] == command["type"] {
                    return if v["success"] == true {
                        Ok(v)
                    } else {
                        Err(unavailable())
                    };
                }
            }
            Err(unavailable())
        })
        .await?
    }
}

async fn checkpoint(
    guest: &Guest,
    slot: &mut Option<Writer>,
    witness: &Witness,
    name: &str,
    stock: &str,
    entry: Option<&str>,
) -> io::Result<bool> {
    let mut writer = slot.take().ok_or_else(unavailable)?;
    let (guest, witness, name, stock, entry) = (
        guest.clone(),
        witness.clone(),
        name.to_owned(),
        stock.to_owned(),
        entry.map(str::to_owned),
    );
    let (writer, result) = tokio::task::spawn_blocking(move || {
        let result = guest
            .checkpoint(
                &mut writer,
                &witness,
                &name,
                &stock,
                entry.as_deref().map_or(
                    TurnDisposition::SnapshotOnly,
                    TurnDisposition::ConfirmedJournalTurn,
                ),
            )
            .and_then(|r| {
                if r.recovery == crate::wsl_copy::Recovery::Divergent {
                    Err(unavailable())
                } else {
                    Ok(r.turn_resolved)
                }
            });
        (writer, result)
    })
    .await
    .map_err(io::Error::other)?;
    *slot = Some(writer);
    result
}

#[allow(clippy::too_many_arguments)]
async fn run(
    guest: &Guest,
    slot: &mut Option<Writer>,
    tag: &str,
    fresh: bool,
    sink: &Sink,
    requests: mpsc::Receiver<Request>,
    mut cancel: watch::Receiver<bool>,
    admitted: &mut bool,
) -> Result<(), Reason> {
    let writer = slot.as_mut().ok_or(Reason::Unavailable)?;
    reconcile(guest, writer)
        .await
        .map_err(|_| Reason::Unavailable)?;
    let old = writer.original().map_err(|_| Reason::Unavailable)?;
    if !fresh && old.is_none() || *cancel.borrow() {
        return Err(Reason::Unavailable);
    }
    let stock = guest
        .launch(writer, tag, old.as_deref(), |w| {
            writer.attached(&w.invocation_id, w.uid)
        })
        .await
        .map_err(|_| Reason::Unavailable)?;
    let witness = stock.witness.clone();
    let mut peer = Peer::new(stock);
    tokio::time::timeout(WAIT, async {
        while let Some(frame) = peer.frames.recv().await {
            if frame["type"] == "ready" {
                return Ok(());
            }
        }
        Err(Reason::NotReady)
    })
    .await
    .map_err(|_| Reason::NotReady)??;
    let mut relay = Relay::new(
        guest
            .bridge(writer.spawn_id(), &witness)
            .await
            .map_err(|_| Reason::NotReady)?,
    );
    let auth = relay
        .call("wsl_admission", json!({}))
        .await
        .map_err(|_| Reason::NotReady)?;
    if auth["home"].as_str() != Some(guest.home.as_str()) {
        return Err(Reason::Unavailable);
    }
    match auth["available"].as_bool() {
        Some(true) => (),
        Some(false) => return Err(Reason::NoAuth),
        None => return Err(Reason::NotReady),
    }
    let directory = format!("{}/.ompdesk-sessions/{}", guest.home, writer.session_key());
    let state = peer
        .exchange("init-state", json!({"type":"get_state"}))
        .await
        .map_err(|_| Reason::NotReady)?;
    let stock_id = state["data"]["sessionId"]
        .as_str()
        .ok_or(Reason::Unavailable)?
        .to_owned();
    let outward = guest_state::project(writer, &directory, &state, "init-state", 0)
        .map_err(|_| Reason::Unavailable)?;
    let name = writer
        .original()
        .ok()
        .flatten()
        .ok_or(Reason::Unavailable)?;
    let (interrupted, completion) = writer
        .pending_completion()
        .map_err(|_| Reason::Unavailable)?;
    let resolved = checkpoint(
        guest,
        slot,
        &witness,
        &name,
        &stock_id,
        completion.as_deref(),
    )
    .await
    .map_err(|_| Reason::NotReady)?;
    if interrupted && !resolved {
        return Err(Reason::Unavailable);
    }
    peer.exchange("init-tools", json!({"type":"set_host_tools","tools":[{"name":boundary::HOST_TOOL,"description":"Identify this tab's execution host.","parameters":{"type":"object","properties":{},"additionalProperties":false},"loadMode":"essential"}]})).await.map_err(|_| Reason::NotReady)?;
    if *cancel.borrow() {
        return Err(Reason::Unavailable);
    }
    *admitted = true;
    sink.post(Notice::Ready(outward))
        .await
        .map_err(|_| Reason::Unavailable)?;
    let result = serve(
        guest,
        slot,
        &witness,
        &name,
        &stock_id,
        &directory,
        sink,
        &mut peer,
        &mut relay,
        requests,
        &mut cancel,
    )
    .await;
    // An orderly close still captures a changed title or a now-persisted interrupted prefix. No completion is inferred.
    result.map_err(|_| Reason::Unavailable)?;
    checkpoint(guest, slot, &witness, &name, &stock_id, None)
        .await
        .map(|_| ())
        .map_err(|_| Reason::Unavailable)
}

#[allow(clippy::too_many_arguments)]
async fn serve(
    guest: &Guest,
    slot: &mut Option<Writer>,
    witness: &Witness,
    name: &str,
    stock: &str,
    directory: &str,
    sink: &Sink,
    peer: &mut Peer,
    relay: &mut Relay,
    mut requests: mpsc::Receiver<Request>,
    cancel: &mut watch::Receiver<bool>,
) -> io::Result<()> {
    let mut pending: HashMap<String, Request> = HashMap::new();
    let mut last_assistant = None;
    loop {
        let writer = slot.as_mut().ok_or_else(unavailable)?;
        tokio::select! { biased;
            _ = cancel.changed() => return Ok(()),
            req = requests.recv() => {
                let Some(mut req) = req else { return Ok(()); };
                pending.retain(|_, r| !r.reply.is_closed());
                if req.reply.is_closed() { continue; }
                if pending.len() >= 16 || (req.value["type"] == "prompt" && writer.begin_turn().is_err()) { let _ = req.reply.send(Err(denied())); continue; }
                let id = format!("{}-{}",writer.spawn_id(),req.seq);
                req.value["id"] = id.as_str().into();
                write(&mut peer.stdin, &req.value).await?;
                if req.value["type"] == "prompt" { last_assistant = None; }
                pending.insert(id,req);
            }
            v = peer.frames.recv() => {
                let v = v.ok_or_else(unavailable)?;
                match v["type"].as_str() {
                    Some("response") => {
                        let Some(id) = v["id"].as_str() else { continue; };
                        let Some(req) = pending.remove(id) else { continue; };
                        if req.reply.is_closed() { continue; }
                        if v["command"] != req.value["type"] || v["success"] != true { let _ = req.reply.send(Err(denied())); continue; }
                        let mut out = json!({"type":"response","command":req.value["type"],"success":true,"id":format!("gui-{}",req.seq)});
                        match v["command"].as_str() {
                            Some("get_state") => out = guest_state::project(writer, directory, &v, id, req.seq).map_err(|_| unavailable())?,
                            Some("get_messages") => out["data"] = json!({"messages":boundary::messages(&v["data"]["messages"]).ok_or_else(unavailable)?}),
                            Some("prompt" | "abort") => (),
                            _ => return Err(unavailable()),
                        }
                        sink.post(Notice::Answer(req.seq,out,req.reply)).await?;
                    }
                    Some("host_tool_call") => { if let Some(out) = boundary::host_tool(&v) { write(&mut peer.stdin,&out).await?; } }
                    Some("message_end") => {
                        if let Some(out) = boundary::event(&v) {
                            if v["message"]["role"] == "assistant" { last_assistant = Some(v["message"].clone()); }
                            sink.post(Notice::Frame(out)).await?;
                        }
                    }
                    Some("agent_end") => {
                        let mut out = boundary::event(&v).ok_or_else(unavailable)?;
                        let last = last_assistant.take().or_else(|| v["messages"].as_array()?.iter().rev().find(|m| m["role"] == "assistant").cloned()).ok_or_else(unavailable)?;
                        let reply = relay.call("sessions.attach_entry_ids", json!({"messages":[last]})).await?;
                        let expected = boundary::message(&last).ok_or_else(unavailable)?;
                        let decorated = reply["messages"].as_array().filter(|m| m.len() == 1).ok_or_else(unavailable)?;
                        let mut actual = boundary::message(&decorated[0]).ok_or_else(unavailable)?;
                        let entry = actual.as_object_mut().and_then(|m| m.remove("entryId")).ok_or_else(unavailable)?;
                        let mut expected = expected;
                        expected.as_object_mut().ok_or_else(unavailable)?.remove("entryId");
                        if expected != actual { return Err(unavailable()); }
                        let id = boundary::token(&entry).ok_or_else(unavailable)?;
                        writer.completing(id)?;
                        let resolved = checkpoint(guest,slot,witness,name,stock,Some(id)).await?;
                        let messages = out["messages"].as_array_mut().ok_or_else(unavailable)?;
                        if let Some(m) = messages.iter_mut().rev().find(|m| **m == expected) { m["entryId"] = entry; }
                        else { expected["entryId"] = entry; messages.push(expected); }
                        sink.post(Notice::Frame(out)).await?;
                        if !resolved { return Err(unavailable()); }
                    }
                    _ => { if let Some(out) = boundary::event(&v) { sink.post(Notice::Frame(out)).await?; } }
                }
            }
            // Unsolicited bridge frames never select a Windows handler, file or tab.
            event = relay.frames.recv() => if event.is_none() { return Err(unavailable()); },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choice_root_is_never_the_registered_worktree_and_an_unknown_opener_is_not_a_root() {
        let mut p: Project = serde_json::from_value(json!({"profile":"host","bridgeDir":"package","tabTag":"tag","choiceCwd":"root","parent":"parent-ref"})).unwrap();
        let reg = p.registration("worktree", "chosen".into()).ok().unwrap();
        assert_eq!(reg.cwd, "worktree");
        assert_eq!(reg.parent.as_deref(), Some("parent-ref"));
        p.parent_unknown = true;
        assert!(matches!(
            p.registration("worktree", "chosen".into()),
            Err(Reason::Unavailable)
        ));
    }

    #[tokio::test]
    async fn recovering_a_pending_tab_without_a_reservation_never_chooses_a_guest() {
        let p: Project = serde_json::from_value(json!({"profile":"unreadable","bridgeDir":"package","tabTag":"tag","resumePending":true})).unwrap();
        assert!(matches!(p.prepare("worktree", None).await, Ok(None)));
    }
}
