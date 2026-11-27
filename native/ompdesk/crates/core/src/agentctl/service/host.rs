//! The seam to main: `AgentControlHost` (`service.ts`) over one `Port<HostState>` (`crate::ports`).
//!
//! - Every **synchronous read** of the TypeScript host is a lookup in `HostState`, main's snapshot (3a's pattern):
//!   main pushes it when it observes a change and every answer carries it. A step that read several of them in one
//!   synchronous block reads ONE `Arc<HostState>` (`Host::state()`) for the whole block.
//! - Every **async method** is an ask with the TypeScript method's name; every **synchronous method with an effect**
//!   (`start`, `setTask`, `view`, `notify`, `reviewChanged`, `recordClosed`) is a tell.
//! - `observe` is `Port::changes()`: a waiter sees every snapshot main pushed, in order (`Host::wait_for`), not only
//!   the latest, so a state that held between two of main's steps is still seen.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::fail::{Fail, R, SavedFolder};
use super::types::{
    AgentMessage, BranchEvidence, BranchFacts, ClosedChild, ControlDevice, ControlTab,
    LandingFacts, MergeOutcome, OpenedChild, RpcCommand, RpcResponse, SafeRemoval, ScheduleCreated,
    ScheduleDraft, SchedulesState, SessionSummary, SpawnRequest, Spawned, StoredSession, Tool,
    WorktreeRef, WorktreeRemoval,
};
use crate::agentctl::app::AppState;
use crate::agentctl::journal::Clock;
use crate::agentctl::journal::attachments::{AttachedSet, AttachmentStore, LandedCache};
use crate::agentctl::journal::mail_outbox::{MailAnswer, MailOutbox, OutboxMail};
use crate::agentctl::rules::mail::MailDelivery;
use crate::pool::AutoCloseTurn;
use crate::ports::Port;

/// Who opened a tab (`host.parentOf`): the opener's tab, and the tag the open carried (`autopilot-child`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Parent {
    pub caller_tab_id: String,
    #[serde(default)]
    pub tag: Option<String>,
}

/// One tombstone of a deleted session (`deletedSessions().at`), by its file and computer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeletedPath {
    pub path: String,
    #[serde(default)]
    pub device: Option<String>,
    pub at: f64,
}

/// The tombstones (`deleted-sessions.ts`): by file and computer, and by saved id alone.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tombstones {
    pub by_path: Vec<DeletedPath>,
    pub by_id: HashMap<String, f64>,
}

/// What main's synchronous reads came to at the moment it pushed (`AgentControlHost`'s sync methods).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostState {
    /// `enabled()`: Settings › Tools & extensions switch.
    pub enabled: bool,
    /// `fullEnabled()`.
    pub full_enabled: bool,
    /// `approveEnabled()`.
    pub approve_enabled: bool,
    /// `manageEnabled()`.
    pub manage_enabled: bool,
    /// `devices()`: the paired hosts.
    pub devices: Vec<ControlDevice>,
    /// `closedChildren()`, newest last.
    pub closed_children: Vec<ClosedChild>,
    /// `tabs(caller)`: every open tab of this app once, in the pool's order, without `here`.
    pub tabs: Vec<ControlTab>,
    /// Each open tab's window (any stable key): `here` and the caller's-window-first order come from the caller's.
    pub window_of: HashMap<String, String>,
    /// `outsideCaller(id)`: the stand-in tab of each process calling over the control socket, never listed in `tabs`.
    pub outside_callers: HashMap<String, ControlTab>,
    /// The window an outside caller acts through (`outsideWindow`); None: none open, its calls are refused.
    pub outside_window: Option<String>,
    /// `parentOf(tabId)`.
    pub parents: HashMap<String, Parent>,
    /// `checkoutPeers(tabId)`.
    pub checkout_peers: HashMap<String, Vec<String>>,
    /// `summaries(device)`: this computer's under `""`, each paired host's under its id.
    pub summaries: HashMap<String, Vec<SessionSummary>>,
    /// `isStopping(callerTabId)`: the tabs whose stop is in flight.
    pub stopping: HashSet<String>,
    /// `deletedAt(...)`.
    pub deleted: Tombstones,
    /// `schedules(device)` is not null: the computers that have a Schedules service (`""` = this one).
    pub schedule_devices: HashSet<String>,
    /// `text(key, params)`: the templates of the current language by the key `host.text` takes (`stopTitle`, ...).
    pub texts: HashMap<String, String>,
    /// What `appPorts` reads synchronously: `manage` is the raw `agentControlManage` preference (not merged with full
    /// control, as `manageEnabled()` is), `full` the raw `agentControlFull`, `korean` the app's language, `sidebar`.
    /// `device(caller)` and `callerTitle(caller)` are lookups in `tabs` and `outside_callers`.
    pub app: AppState,
}

/// `fillText` (`src/shared/fill-text.ts`): `{name}` replaced by its parameter; a count-like parameter also fills
/// `{<name>Plural}` (`{plural}` for `count`) with "" for 1 and "s" otherwise, unless the caller gave that slot.
pub fn fill_text(template: &str, params: &HashMap<String, String>) -> String {
    let mut filled: HashMap<String, String> = params.clone();
    for (name, value) in params {
        let slot = if name == "count" {
            "plural".to_owned()
        } else {
            format!("{name}Plural")
        };
        if params.contains_key(&slot) {
            continue;
        }
        let text = super::js::trim(value);
        if !text.starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        let stripped: String = text
            .chars()
            .filter(|c| !(*c == ',' || super::js::is_space(*c) || *c == '\''))
            .collect();
        let one = stripped.parse::<f64>().is_ok_and(|n| n == 1.0);
        filled.insert(slot, if one { "" } else { "s" }.to_owned());
    }
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_len = after
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
            .count();
        if name_len > 0 && after[name_len..].starts_with('}') {
            match filled.get(&after[..name_len]) {
                Some(value) => out.push_str(value),
                None => out.push_str(&rest[open..open + name_len + 2]),
            }
            rest = &after[name_len + 1..];
        } else {
            out.push('{');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

impl HostState {
    /// `tabs(callerTabId)`: every open tab, the caller's window first (`here`), None when the calling tab is gone.
    /// An outside caller has no tab: it acts through `outside_window`, and none open refuses it.
    pub fn tabs(&self, caller: &str) -> Option<Vec<ControlTab>> {
        let window = if self.tabs.iter().any(|tab| tab.tab_id == caller) {
            self.window_of.get(caller)
        } else if self.outside_callers.contains_key(caller) {
            Some(self.outside_window.as_ref()?)
        } else {
            return None;
        };
        let mut first = Vec::new();
        let mut rest = Vec::new();
        for tab in &self.tabs {
            let mut tab = tab.clone();
            tab.here = window.is_some() && self.window_of.get(&tab.tab_id) == window;
            if tab.here {
                first.push(tab);
            } else {
                rest.push(tab);
            }
        }
        first.append(&mut rest);
        Some(first)
    }

    /// `outsideCaller(id)`.
    pub fn outside_caller(&self, id: &str) -> Option<ControlTab> {
        self.outside_callers.get(id).cloned()
    }

    /// `parentOf(tabId)`.
    pub fn parent_of(&self, tab_id: &str) -> Option<&str> {
        self.parents
            .get(tab_id)
            .map(|parent| parent.caller_tab_id.as_str())
    }

    /// `checkoutPeers(tabId)`.
    pub fn checkout_peers(&self, tab_id: &str) -> &[String] {
        self.checkout_peers.get(tab_id).map_or(&[], Vec::as_slice)
    }

    /// `summaries(device)`: this computer's when `device` is None.
    pub fn summaries(&self, device: Option<&str>) -> &[SessionSummary] {
        self.summaries
            .get(device.unwrap_or(""))
            .map_or(&[], Vec::as_slice)
    }

    /// `summaryOf(tab)`: the row of the tab's session on the computer that runs it.
    pub fn summary_of(&self, tab: &ControlTab) -> Option<&SessionSummary> {
        let key = tab
            .session_path
            .clone()
            .unwrap_or_else(|| format!("tab:{}", tab.tab_id));
        self.summaries(tab.device.as_deref())
            .iter()
            .find(|summary| summary.session_path == key)
    }

    /// `isStopping(callerTabId)`.
    pub fn is_stopping(&self, caller_tab_id: &str) -> bool {
        self.stopping.contains(caller_tab_id)
    }

    /// `deletedAt({path, device})`.
    /// A tombstone of this computer names its file as node's `path.resolve` spelled it (`deleted-sessions.ts`
    /// `keyOf`), and the query is read the same way; a paired device's path is compared as it came.
    pub fn deleted_at_path(&self, path: &str, device: Option<&str>) -> Option<f64> {
        let local;
        let path = match device {
            Some(_) => path,
            None => {
                local = node_resolve(path);
                &local
            }
        };
        self.deleted
            .by_path
            .iter()
            .find(|entry| entry.path == path && entry.device.as_deref() == device)
            .map(|entry| entry.at)
    }

    /// `deletedAt({id})`.
    pub fn deleted_at_id(&self, id: &str) -> Option<f64> {
        self.deleted.by_id.get(id).copied()
    }

    /// `schedules(device)` is not null.
    pub fn has_schedules(&self, device: Option<&str>) -> bool {
        self.schedule_devices.contains(device.unwrap_or(""))
    }

    /// `host.text(key, params)`: the template of `key` in the person's language, filled as `fillText` does.
    pub fn text(&self, key: &str, params: &[(&str, &str)]) -> String {
        let template = self.texts.get(key).map_or(key, String::as_str);
        let params: HashMap<String, String> = params
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        fill_text(template, &params)
    }

    /// `devices().find(device => device.id === id)`.
    pub fn device(&self, id: &str) -> Option<&ControlDevice> {
        self.devices.iter().find(|device| device.id == id)
    }
}

/// Which optional methods of the TypeScript host exist (fixed when the service is opened).
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Caps {
    pub review_changed: bool,
    pub session_pace: bool,
    pub sent_marks: bool,
    pub before_first_prompt: bool,
    pub autopilot: bool,
    pub app_ports: bool,
}

/// How long a command is waited for (`command`'s `timeoutMs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deadline {
    /// The RPC client's own default.
    Default,
    Ms(u64),
    /// No time limit (`NO_DEADLINE`).
    None,
}

#[derive(Serialize)]
struct ParseArgs<'a> {
    tool: &'static str,
    args: &'a Value,
    loose: bool,
}

#[derive(Deserialize)]
struct PartialSchedule {
    action: String,
    fields: HashMap<String, bool>,
}

#[derive(Deserialize)]
struct ParsedArgs {
    ok: bool,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    error: String,
    schedule: Option<PartialSchedule>,
}

/// A typed wrapper over the port: main's snapshot, its asks and its tells.
#[derive(Clone)]
pub struct Host {
    port: Arc<Port<HostState>>,
    caps: Caps,
    /// Accepted reports wait here until the receiver's journal holds them (`mail-outbox`); None keeps none.
    outbox: Option<(Arc<MailOutbox>, Clock)>,
    /// The bytes of what the outboxes' messages carry, by content (`journal/attachments.rs`).
    pub(super) attachments: Arc<AttachmentStore>,
    /// The paths files landed at on each computer today, so the same bytes are put there once.
    pub(super) landed: Arc<LandedCache>,
    /// What each sender was told about a delivery that cannot go (once each).
    pub(super) troubled: Arc<std::sync::Mutex<HashSet<String>>>,
    /// `Date.now()`.
    pub(super) clock: Clock,
    /// Session files of paused bots' chats on this computer: a report to one is kept, never handed over, until the bot
    /// is resumed (`journal/bots.rs`; the service keeps this in step with the registry).
    pub(crate) held: Arc<std::sync::RwLock<HashSet<String>>>,
}

impl Host {
    pub fn new(port: Arc<Port<HostState>>, caps: Caps) -> Host {
        Host {
            port,
            caps,
            outbox: None,
            attachments: Arc::new(AttachmentStore::new(None)),
            landed: Arc::new(LandedCache::default()),
            troubled: Arc::default(),
            clock: crate::agentctl::journal::system_clock(),
            held: Arc::default(),
        }
    }

    /// `Date.now()` for what the host stamps (a test fixes it).
    pub fn with_clock(mut self, clock: Clock) -> Host {
        self.clock = clock;
        self
    }

    /// The attachments the outboxes still owe are kept in `store`.
    pub fn with_attachments(mut self, store: Arc<AttachmentStore>) -> Host {
        self.attachments = store;
        self
    }

    /// This host keeps every report it hands to a tab until the receiver's journal holds it.
    pub fn with_outbox(mut self, outbox: Arc<MailOutbox>, clock: Clock) -> Host {
        self.outbox = Some((outbox, clock));
        self
    }

    pub fn outbox(&self) -> Option<&Arc<MailOutbox>> {
        self.outbox.as_ref().map(|(outbox, _)| outbox)
    }

    /// Whether a report to `session_path` (on `device`) is held: a paused bot's chat on this computer.
    pub fn holds(&self, session_path: &str, device: Option<&str>) -> bool {
        device.is_none()
            && self
                .held
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains(session_path)
    }

    pub fn port(&self) -> &Arc<Port<HostState>> {
        &self.port
    }

    pub fn caps(&self) -> Caps {
        self.caps
    }

    /// Main's state as main last said it: take it once for a block that read several things synchronously.
    pub fn state(&self) -> Arc<HostState> {
        self.port.state()
    }

    /// Main's state now (one ask): what a step reads after a wait on the core's own clock.
    pub async fn fresh(&self) -> R<Arc<HostState>> {
        Ok(self.port.fresh().await?)
    }

    /// `#nextChange(ms)`: resolves on the next snapshot main pushes, or after `ms` (then with a fresh read).
    pub async fn next_change(&self, ms: u64) {
        let mut changes = self.port.changes();
        tokio::select! {
            _ = changes.recv() => {}
            () = tokio::time::sleep(Duration::from_millis(ms)) => {
                let _ = self.port.fresh().await;
            }
        }
    }

    /// Looks at main's state now and at every snapshot main pushes after it, in order, until `look` finds something
    /// or `ms` pass (None: no limit; then main's fresh state is read once more). A state that held only between two
    /// pushes is seen.
    pub async fn wait_for<T>(
        &self,
        ms: Option<u64>,
        mut look: impl FnMut(&HostState) -> Option<T>,
    ) -> Option<T> {
        let mut changes = self.port.changes();
        if let Some(found) = look(&self.port.state()) {
            return Some(found);
        }
        let deadline = ms.map(|ms| tokio::time::Instant::now() + Duration::from_millis(ms));
        loop {
            let next = match deadline {
                Some(deadline) => tokio::time::timeout_at(deadline, changes.recv()).await.ok(),
                None => Some(changes.recv().await),
            };
            match next {
                Some(Some(state)) => {
                    if let Some(found) = look(&state) {
                        return Some(found);
                    }
                }
                // The port closed.
                Some(None) => return None,
                None => {
                    let fresh = self.port.fresh().await.ok()?;
                    return look(&fresh);
                }
            }
        }
    }

    // ---- asks ---------------------------------------------------------------------------------------------------

    pub(super) async fn ask<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        args: Value,
    ) -> R<T> {
        Ok(self.port.ask(method, &args).await?)
    }

    /// Zod and JavaScript's string coercions run in main. Schedule action checks follow every
    /// continuable field error, before the caller is resolved or a schedule is touched.
    pub async fn parse_args(&self, tool: Tool, args: &Value, loose: bool) -> R<Value> {
        let request = ParseArgs {
            tool: tool.name(),
            args,
            loose,
        };
        let answer: ParsedArgs = self.port.ask("args.parse", &request).await?;
        let mut issues = answer.error;
        if tool == Tool::Schedule {
            let issue = |message: &str| {
                if !issues.is_empty() {
                    issues.push_str("; ");
                }
                issues.push_str(message);
            };
            if answer.ok {
                let action = answer.args["action"].as_str().unwrap_or("");
                super::schedules::action_issues(
                    action,
                    |key| answer.args.get(key).map(|value| value.as_str() != Some("")),
                    issue,
                );
            } else if let Some(partial) = answer.schedule {
                super::schedules::action_issues(
                    &partial.action,
                    |key| partial.fields.get(key).copied(),
                    issue,
                );
            }
        }
        if answer.ok && issues.is_empty() {
            Ok(answer.args)
        } else if issues.is_empty() {
            Err(Fail::Tool("invalid arguments".to_owned()))
        } else if loose {
            Err(Fail::Tool(format!(
                "Invalid arguments for {}: {issues}",
                tool.name()
            )))
        } else {
            Err(Fail::Tool(format!("Invalid arguments: {issues}")))
        }
    }

    /// `mail(tabId, content, details, delivery)`: one report into a session. A queued aside is journaled at the
    /// receiver's next step boundary (or when a quit disposes it); a killed omp loses it, and one restarting cannot
    /// take it at all. So it is kept before it is sent, until the receiver's journal holds it, and sent again to
    /// whatever omp holds the receiver's session next. A caller outside OMPdesk has no session: its report goes to
    /// its event stream, and nothing is kept.
    pub async fn mail(
        &self,
        tab_id: &str,
        content: &str,
        details: &Value,
        delivery: MailDelivery,
    ) -> R<()> {
        self.mail_attached(tab_id, content, details, delivery, None)
            .await
    }

    /// `mail` with what the report carries: its pictures go inline (read from the attachment store), its files are
    /// named in the text. The entry kept names them, so a redelivery brings them again.
    pub async fn mail_attached(
        &self,
        tab_id: &str,
        content: &str,
        details: &Value,
        delivery: MailDelivery,
        attached: Option<&AttachedSet>,
    ) -> R<()> {
        let images = self.stored_images(attached).await?;
        let kept = self.outbox.as_ref().and_then(|(outbox, clock)| {
            let id = details.get("id")?.as_str()?;
            let state = self.state();
            let tab = state.tabs.iter().find(|tab| tab.tab_id == tab_id)?;
            // The reporting session, told when this cannot be delivered with its attachments.
            let sender = details.get("from").and_then(Value::as_str).map(|from| {
                match state.tabs.iter().find(|tab| tab.tab_id == from) {
                    Some(tab) => (
                        tab.session_path
                            .clone()
                            .filter(|p| !p.is_empty())
                            .unwrap_or_else(|| from.to_owned()),
                        tab.device.clone().filter(|d| !d.is_empty()),
                    ),
                    None => (from.to_owned(), None),
                }
            });
            outbox.keep(OutboxMail {
                id: id.to_owned(),
                session_path: tab.session_path.clone().filter(|path| !path.is_empty())?,
                device: tab.device.clone().filter(|device| !device.is_empty()),
                from: sender.as_ref().map(|(path, _)| path.clone()),
                from_device: sender.as_ref().and_then(|(_, device)| device.clone()),
                content: content.to_owned(),
                details: details.clone(),
                delivery,
                attachments: attached.cloned(),
                attachments_corrupt: false,
                at: clock(),
            });
            Some((
                outbox,
                id.to_owned(),
                tab.session_path.clone(),
                tab.device.clone(),
            ))
        });
        // A paused bot's chat: kept above, handed over by the pass that runs when the bot is resumed.
        if let Some((_, _, Some(path), device)) = &kept
            && self.holds(path, device.as_deref())
        {
            return Ok(());
        }
        let answer = self
            .send_mail_with(tab_id, content, details, delivery, &images)
            .await?;
        if let (Some((outbox, id, _, _)), Some(answer)) = (kept, answer)
            && answer.duplicate
            && answer.journaled
        {
            outbox.settle(&id);
        }
        Ok(())
    }

    /// One report to a tab's omp; the bridge's answer (`{duplicate, journaled}` for an id it already holds or queued).
    pub async fn send_mail(
        &self,
        tab_id: &str,
        content: &str,
        details: &Value,
        delivery: MailDelivery,
    ) -> R<Option<MailAnswer>> {
        self.send_mail_with(tab_id, content, details, delivery, &[])
            .await
    }

    /// `send_mail` with pictures: stock's custom message content is then the text and its image blocks.
    pub async fn send_mail_with(
        &self,
        tab_id: &str,
        content: &str,
        details: &Value,
        delivery: MailDelivery,
        images: &[Value],
    ) -> R<Option<MailAnswer>> {
        let content = if images.is_empty() {
            json!(content)
        } else {
            let mut blocks = vec![json!({ "type": "text", "text": content })];
            blocks.extend(images.iter().cloned());
            Value::Array(blocks)
        };
        let answer: Value = self
            .ask(
                "mail",
                json!({ "tabId": tab_id, "content": content, "details": details, "delivery": delivery.to_json() }),
            )
            .await?;
        Ok(answer.is_object().then(|| MailAnswer {
            duplicate: answer.get("duplicate").and_then(Value::as_bool) == Some(true),
            journaled: answer.get("journaled").and_then(Value::as_bool) == Some(true),
        }))
    }

    /// `botHome {device, name}`: the home chat file of the bot `name` on paired host `device`, which refuses unless this
    /// computer is in that bot's reach.
    pub async fn bot_home(&self, device: &str, name: &str) -> R<String> {
        let answer: Value = self
            .ask("botHome", json!({ "device": device, "name": name }))
            .await?;
        match answer.get("path").and_then(Value::as_str) {
            Some(path) => Ok(path.to_owned()),
            None => Err(Fail::other(
                "The paired computer did not name the bot's home chat.",
            )),
        }
    }

    /// `botsCommand {device, request}`: the owner's change to a bot or item of paired host `device`, which that host
    /// makes (`host.bots.command`); it answers its copy after it (`{version, state, refused?}`), or the file asked for.
    pub async fn bots_on(&self, device: &str, request: &Value) -> R<Value> {
        self.ask(
            "botsCommand",
            json!({ "device": device, "request": request }),
        )
        .await
    }

    /// `connectorCredential {service, account}`: what one reply through a bot's connector posts with (`slack`: the
    /// app's bot token; `github`: main's gh runner and home; `linear`: the tracker account with its header), from
    /// main's keystore for that post only, never kept or told.
    pub async fn connector_credential(&self, service: &str, account: &str) -> R<Value> {
        self.ask(
            "connectorCredential",
            json!({ "service": service, "account": account }),
        )
        .await
    }

    /// `botsRoomPostTo {device, post}`: one of this computer's bots posted in a group of paired device `device`, which
    /// main hands to that device's connection (`host.bots.roomPost`). False: the device is not connected.
    pub async fn room_post_to(&self, device: &str, post: &Value) -> R<bool> {
        let answer: Value = self
            .ask("botsRoomPostTo", json!({ "device": device, "post": post }))
            .await?;
        Ok(answer.get("sent").and_then(Value::as_bool) == Some(true))
    }

    /// `setOpener {tabId, openerTabId}`: `openerTabId` becomes `tabId`'s opener, as a session it opened would have it
    /// (the pool's `setTabOpener`, kept across a relaunch): a session handed to a bot, or one whose lost opener the call
    /// journal names (`Runtime::recover_openers`).
    pub async fn set_opener(&self, tab_id: &str, opener_tab_id: &str) -> R<()> {
        self.ask(
            "setOpener",
            json!({ "tabId": tab_id, "openerTabId": opener_tab_id }),
        )
        .await
    }

    /// `reach {sessionPath}`: the tab holding a session this computer runs, started when it is asleep; with none, the
    /// session is opened in a background tab of the front window. The tab that held it before (None: it is opening).
    pub async fn reach(&self, session_path: &str) -> R<Option<String>> {
        self.ask("reach", json!({ "sessionPath": session_path }))
            .await
    }

    /// `command(tabId, command, timeoutMs)`: a command through the GUI's RPC dispatcher.
    pub async fn command(
        &self,
        tab_id: &str,
        command: &RpcCommand,
        deadline: Deadline,
    ) -> R<RpcResponse> {
        let mut args = json!({ "tabId": tab_id, "command": command });
        match deadline {
            Deadline::Default => {}
            Deadline::Ms(ms) => args["timeoutMs"] = json!(ms),
            Deadline::None => args["noDeadline"] = json!(true),
        }
        self.ask("command", args).await
    }

    /// `spawn(callerTabId, request)`. A stored session whose folder is gone fails with `Fail::FolderMissing`.
    pub async fn spawn(&self, caller_tab_id: &str, request: &SpawnRequest) -> R<Spawned> {
        let answer: Value = self
            .ask(
                "spawn",
                json!({ "callerTabId": caller_tab_id, "request": request }),
            )
            .await?;
        if let Some(missing) = answer.get("folderMissing") {
            return Err(Fail::FolderMissing {
                folder: missing
                    .get("folder")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                saved: missing
                    .get("saved")
                    .and_then(|saved| serde_json::from_value::<SavedFolder>(saved.clone()).ok()),
            });
        }
        serde_json::from_value(answer)
            .map_err(|error| Fail::other(format!("spawn: main answered {error}")))
    }

    /// Release a tab a paired web page owns in main.
    pub(crate) async fn release(
        &self,
        caller_tab_id: &str,
        tab_id: &str,
        expected_turn: Option<&AutoCloseTurn>,
    ) -> R<bool> {
        let mut args = json!({ "callerTabId": caller_tab_id, "tabId": tab_id });
        if let Some(turn) = expected_turn {
            args["expectedTurn"] = json!(turn);
        }
        self.ask("release", args).await
    }

    /// `exited(tabId)`: resolves once the omp of a tab the window closed has exited.
    pub async fn exited(&self, tab_id: &str) -> R<()> {
        self.ask("exited", json!({ "tabId": tab_id })).await
    }

    /// `confirm(callerTabId, title, message)`: a confirmation card; false on refusal, dismissal or failure.
    pub async fn confirm(&self, caller_tab_id: &str, title: &str, message: &str) -> R<bool> {
        self.ask(
            "confirm",
            json!({ "callerTabId": caller_tab_id, "title": title, "message": message }),
        )
        .await
    }

    /// `answer(tabId, requestId, response)`.
    pub async fn answer(&self, tab_id: &str, request_id: &str, response: &Value) -> R<()> {
        self.ask(
            "answer",
            json!({ "tabId": tab_id, "requestId": request_id, "response": response }),
        )
        .await
    }

    /// `escalateAsk(tabId, requestId, chatTabId)`: the card a bot holds shows in the windows of its chat `chatTabId`,
    /// where the owner answers it for the tab that asked (`route.rs`). False when the card is not open any more.
    pub async fn escalate_ask(
        &self,
        tab_id: &str,
        request_id: &str,
        chat_tab_id: Option<&str>,
    ) -> R<bool> {
        self.ask(
            "escalateAsk",
            json!({ "tabId": tab_id, "requestId": request_id, "chatTabId": chat_tab_id }),
        )
        .await
    }

    /// `markAnswered(tabId, byTitle)`.
    pub async fn mark_answered(&self, tab_id: &str, by_title: &str) -> R<()> {
        self.ask(
            "markAnswered",
            json!({ "tabId": tab_id, "byTitle": by_title }),
        )
        .await
    }

    /// `deleteSession(callerTabId, tabId)`.
    pub async fn delete_session(&self, caller_tab_id: &str, tab_id: &str) -> R<()> {
        self.ask(
            "deleteSession",
            json!({ "callerTabId": caller_tab_id, "tabId": tab_id }),
        )
        .await
    }

    /// `deleteStored(session)`.
    pub async fn delete_stored(&self, session: &StoredSession) -> R<()> {
        self.ask("deleteStored", json!({ "session": session }))
            .await
    }

    /// `bots.release(folder)`: before a bot's folder moves, main stops the omp of every tab of this computer in
    /// `folder` and answers once each has exited (Windows refuses to rename a folder a process runs in);
    /// `relocate_bot` starts them again in the new folder.
    pub async fn release_folder(&self, folder: &str) -> R<()> {
        self.ask("bots.release", json!({ "folder": folder })).await
    }

    /// `bots.relocate(from, to, sessions)`: a bot's folder moved from `from` to `to`; main moves each of its chats'
    /// `sessions` into `to` (an open chat, stopped by `release_folder`, starts again on its moved file there) and
    /// answers each session's file now, by its file before. A session it cannot move yet is refused, and the whole
    /// call with it, to be asked again.
    pub async fn relocate_bot(
        &self,
        from: &str,
        to: &str,
        sessions: &[String],
    ) -> R<std::collections::HashMap<String, String>> {
        self.ask(
            "bots.relocate",
            json!({ "from": from, "to": to, "sessions": sessions }),
        )
        .await
    }

    /// `stored(device, query)`: saved sessions on this computer or a paired host.
    pub async fn stored(&self, device: Option<&str>, query: Option<&str>) -> R<Vec<StoredSession>> {
        self.ask("stored", json!({ "device": device, "query": query }))
            .await
    }

    /// `storedMessages(session)`: a saved session's transcript, read-only.
    pub async fn stored_messages(&self, session: &StoredSession) -> R<Vec<AgentMessage>> {
        self.ask("storedMessages", json!({ "session": session }))
            .await
    }

    /// `sessionPace(session)`: how a session spent its time, as `session-pace.ts` reads it; None when unreadable.
    /// Always None where main has no pace (`caps.sessionPace` false).
    pub async fn session_pace(&self, path: &str, device: Option<&str>) -> R<Option<Value>> {
        if !self.caps.session_pace {
            return Ok(None);
        }
        self.ask("sessionPace", json!({ "path": path, "device": device }))
            .await
    }

    /// `branchFacts(worktree, device)`.
    pub async fn branch_facts(
        &self,
        worktree: &WorktreeRef,
        device: Option<&str>,
    ) -> R<BranchFacts> {
        self.ask(
            "branchFacts",
            json!({ "worktree": worktree, "device": device }),
        )
        .await
    }

    /// `branchEvidence(worktree, diffChars, device)`.
    pub async fn branch_evidence(
        &self,
        worktree: &WorktreeRef,
        diff_chars: usize,
        device: Option<&str>,
    ) -> R<BranchEvidence> {
        self.ask(
            "branchEvidence",
            json!({ "worktree": worktree, "diffChars": diff_chars, "device": device }),
        )
        .await
    }

    /// `mergeBranch(worktree, label, device)`.
    pub async fn merge_branch(
        &self,
        worktree: &WorktreeRef,
        label: &str,
        device: Option<&str>,
    ) -> R<MergeOutcome> {
        self.ask(
            "mergeBranch",
            json!({ "worktree": worktree, "label": label, "device": device }),
        )
        .await
    }

    /// `landing(worktree, device)`.
    pub async fn landing(&self, worktree: &WorktreeRef, device: Option<&str>) -> R<LandingFacts> {
        self.ask("landing", json!({ "worktree": worktree, "device": device }))
            .await
    }

    /// `removeSafeWorktree(worktree, device)`.
    pub async fn remove_safe_worktree(
        &self,
        worktree: &WorktreeRef,
        device: Option<&str>,
    ) -> R<Option<SafeRemoval>> {
        self.ask(
            "removeSafeWorktree",
            json!({ "worktree": worktree, "device": device }),
        )
        .await
    }

    /// `discardWorktree(worktree, device)`.
    pub async fn discard_worktree(
        &self,
        worktree: &WorktreeRef,
        device: Option<&str>,
    ) -> R<Option<WorktreeRemoval>> {
        self.ask(
            "discardWorktree",
            json!({ "worktree": worktree, "device": device }),
        )
        .await
    }

    /// `sentMarks(tabId, marks)`: the receiver's bridge about message markers; None when it cannot be asked.
    pub async fn sent_marks(&self, tab_id: &str, marks: &[String]) -> R<Option<Value>> {
        if !self.caps.sent_marks {
            return Ok(None);
        }
        self.ask("sentMarks", json!({ "tabId": tab_id, "marks": marks }))
            .await
    }

    /// `beforeFirstPrompt(child)`: awaited after the child is ready and before its first prompt; a failure closes the
    /// child and fails the open.
    pub async fn before_first_prompt(&self, child: &OpenedChild) -> R<()> {
        if !self.caps.before_first_prompt {
            return Ok(());
        }
        self.ask("beforeFirstPrompt", json!({ "child": child }))
            .await
    }

    /// `autopilot.plan(sourceTabId)` → `{defaultBranch}`.
    pub async fn autopilot_plan(&self, source_tab_id: &str) -> R<Option<String>> {
        let answer: Value = self
            .ask("autopilot.plan", json!({ "sourceTabId": source_tab_id }))
            .await?;
        Ok(answer
            .get("defaultBranch")
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    /// `autopilot.start(callerTabId, sourceTabId, options)` → the run's status with its `tabId`.
    pub async fn autopilot_start(
        &self,
        caller_tab_id: &str,
        source_tab_id: &str,
        options: &Value,
    ) -> R<super::types::RunStatus> {
        self.ask(
            "autopilot.start",
            json!({ "callerTabId": caller_tab_id, "sourceTabId": source_tab_id, "options": options }),
        )
        .await
    }

    /// `autopilot.status(tabId)`.
    pub async fn autopilot_status(&self, tab_id: &str) -> R<super::types::RunStatus> {
        self.ask("autopilot.status", json!({ "tabId": tab_id }))
            .await
    }

    /// `autopilot.stop(tabId, now)`.
    pub async fn autopilot_stop(&self, tab_id: &str, now: bool) -> R<super::types::RunStatus> {
        self.ask("autopilot.stop", json!({ "tabId": tab_id, "now": now }))
            .await
    }

    /// The Schedules service of `device` (None: this computer): `command(request)` of `SchedulesApi`, the one entry
    /// both this computer's service and a paired host's (`host.schedules.command`) answer.
    pub async fn schedules_command(
        &self,
        device: Option<&str>,
        request: &Value,
    ) -> R<SchedulesState> {
        self.ask(
            "schedules.command",
            json!({ "device": device, "request": request }),
        )
        .await
    }

    /// `create(draft)`: the new id comes from the save itself.
    pub async fn schedules_create(
        &self,
        device: Option<&str>,
        draft: &ScheduleDraft,
    ) -> R<ScheduleCreated> {
        self.ask(
            "schedules.create",
            json!({ "device": device, "draft": draft }),
        )
        .await
    }

    // ---- appPorts (`ompdesk_app`'s ports, as `AppControl` reads them) --------------------------------------------------

    /// `appPorts.getPref(key)`: a stored preference's value on this computer; None when nothing is stored.
    pub async fn app_get_pref(&self, key: &str) -> R<Option<Value>> {
        self.ask("appPorts.getPref", json!({ "key": key })).await
    }

    /// `appPorts.setPref(tabId, key, value)`: through `PREFS_SET` in the caller's window.
    pub async fn app_set_pref(&self, tab_id: &str, key: &str, value: &Value) -> R<()> {
        self.ask(
            "appPorts.setPref",
            json!({ "tabId": tab_id, "key": key, "value": value }),
        )
        .await
    }

    /// `appPorts.rpc(tabId, command)`: a command through the caller's omp (a refusal is an answer, not a failure).
    pub async fn app_rpc(&self, tab_id: &str, command: &RpcCommand) -> R<RpcResponse> {
        self.ask(
            "appPorts.rpc",
            json!({ "tabId": tab_id, "command": command }),
        )
        .await
    }

    /// `appPorts.invoke(tabId, channel, args)`: an IPC handler of the caller's window.
    pub async fn app_invoke(&self, tab_id: &str, channel: &str, args: &[Value]) -> R<Value> {
        self.ask(
            "appPorts.invoke",
            json!({ "tabId": tab_id, "channel": channel, "args": args }),
        )
        .await
    }

    /// `appPorts.note(tabId, text)`: journals a line in the caller's session.
    pub async fn app_note(&self, tab_id: &str, text: &str) -> R<()> {
        self.ask("appPorts.note", json!({ "tabId": tab_id, "text": text }))
            .await
    }

    /// `appPorts.openPrivacyPane(pane)`.
    pub async fn app_open_privacy_pane(&self, pane: &str) -> R<()> {
        self.ask("appPorts.openPrivacyPane", json!({ "pane": pane }))
            .await
    }

    /// `appPorts.fire(tabId, channel, args)`: an IPC channel with no answer.
    pub fn app_fire(&self, tab_id: &str, channel: &str, args: &[Value]) {
        self.port.tell(
            "appPorts.fire",
            &json!({ "tabId": tab_id, "channel": channel, "args": args }),
        );
    }

    /// `appPorts.send(tabId, event)`: an event for the caller's window (`AgentAppEvent`).
    pub fn app_send(&self, tab_id: &str, event: &Value) {
        self.port
            .tell("appPorts.send", &json!({ "tabId": tab_id, "event": event }));
    }

    // ---- tells --------------------------------------------------------------------------------------------------

    /// `start(tabId)`: start a tab that has no process yet.
    pub fn start(&self, tab_id: &str) {
        self.port.tell("start", &json!({ "tabId": tab_id }));
    }

    /// `setTask(tabId, task)`.
    pub fn set_task(&self, tab_id: &str, task: &str) {
        self.port
            .tell("setTask", &json!({ "tabId": tab_id, "task": task }));
    }

    /// `view(callerTabId, event)`: show a tab in the caller's window (`AgentControlViewEvent`).
    pub fn view(&self, caller_tab_id: &str, tab_id: &str, how: &str) {
        self.tell_view(caller_tab_id, json!({ "tabId": tab_id, "how": how }));
    }

    /// `view(callerTabId, event)` with `how: "close"`: the window holding the tab closes it as the person's close
    /// would and answers `close_id` with what it did (main's `answerClose`, read back as `ControlTab.close_answer`).
    /// `auto`: a close the app decided on itself, which the window refuses for a tab the person is at.
    pub(crate) fn close_view(
        &self,
        caller_tab_id: &str,
        tab_id: &str,
        auto: bool,
        close_id: u64,
        expected_turn: Option<&AutoCloseTurn>,
    ) {
        let mut event = json!({ "tabId": tab_id, "how": "close", "closeId": close_id });
        if auto {
            event["auto"] = json!(true);
        }
        if let Some(turn) = expected_turn {
            event["expectedTurn"] = json!(turn);
        }
        self.tell_view(caller_tab_id, event);
    }

    fn tell_view(&self, caller_tab_id: &str, event: Value) {
        self.port.tell(
            "view",
            &json!({ "callerTabId": caller_tab_id, "event": event }),
        );
    }

    /// `notify(callerTabId, title, body)`.
    pub fn notify(&self, caller_tab_id: &str, title: &str, body: &str) {
        self.port.tell(
            "notify",
            &json!({ "callerTabId": caller_tab_id, "title": title, "body": body }),
        );
    }

    /// `reviewChanged(parentTabId)`: a child's report changed what its opener's work board shows.
    pub fn review_changed(&self, parent_tab_id: &str) {
        if self.caps.review_changed {
            self.port
                .tell("reviewChanged", &json!({ "parentTabId": parent_tab_id }));
        }
    }

    /// `recordClosed(child)`: remember a session closed after its work landed.
    pub fn record_closed(&self, child: &ClosedChild) {
        self.port.tell("recordClosed", &json!({ "child": child }));
    }
}

/// node's `path.resolve(path)` in this process: absolute against its working folder (on Windows a rooted path takes
/// the working folder's drive), separators the platform's, `.` and `..` taken lexically.
pub(crate) fn node_resolve(path: &str) -> String {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
    let mut resolved = std::path::PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other),
        }
    }
    resolved.to_string_lossy().into_owned()
}
