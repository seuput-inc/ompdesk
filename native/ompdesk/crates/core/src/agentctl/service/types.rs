//! The shapes the seam carries, as `service.ts` declared them (`ControlTab`, `StoredSession`, `SpawnRequest`, ...), and
//! the tool arguments as `tools.ts`' `ARGS` hand them over once validated.
//!
//! Only the fields the service reads are typed; the rest of an object main sends is dropped on reading. Every type is
//! written back as TypeScript's `undefined` would be (an absent key), so what main receives equals what it received
//! from the TypeScript service.
//!
//! Main keeps Zod's field checks and JavaScript's text coercion. `Host::parse_args` applies the
//! schedule action's cross-field checks before the service reads these structs.

use std::collections::HashMap;

use serde::de::Deserializer;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

fn is_false(value: &bool) -> bool {
    !*value
}

/// A sidecar's status as a row reads it: `running` while a turn or its background work runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TabStatus {
    Asleep,
    Starting,
    Ready,
    Running,
    Exited,
    Error,
    Restarting,
    Waiting,
}

impl TabStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TabStatus::Asleep => "asleep",
            TabStatus::Starting => "starting",
            TabStatus::Ready => "ready",
            TabStatus::Running => "running",
            TabStatus::Exited => "exited",
            TabStatus::Error => "error",
            TabStatus::Restarting => "restarting",
            TabStatus::Waiting => "waiting",
        }
    }

    /// `ready` or `running`: the tab's omp answers commands.
    pub fn is_up(self) -> bool {
        matches!(self, TabStatus::Ready | TabStatus::Running)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StartWait {
    Queued,
    Slow,
}

/// What a paired page's live connections say about unsaved Files edits in a tab (`FileEdits`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileEdits {
    Clean,
    Dirty,
    Unreported,
}

impl FileEdits {
    pub fn to_rules(self) -> crate::agentctl::rules::tab_close::FileEdits {
        use crate::agentctl::rules::tab_close::FileEdits as Rules;
        match self {
            FileEdits::Clean => Rules::Clean,
            FileEdits::Dirty => Rules::Dirty,
            FileEdits::Unreported => Rules::Unreported,
        }
    }
}

/// A tab's git-worktree binding (`IpcTabWorktree`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabWorktree {
    #[serde(default)]
    pub name: String,
    pub branch: String,
    pub base_cwd: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub lifecycle: bool,
}

impl TabWorktree {
    pub fn reference(&self) -> WorktreeRef {
        WorktreeRef {
            path: self.path.clone(),
            branch: self.branch.clone(),
            base_cwd: self.base_cwd.clone(),
        }
    }
}

/// The checkout, its branch and the repo it forked from (`WorktreeRef`): git's one definition.
pub use crate::git::branches::WorktreeRef;

/// How a tab's last finished turn ended (`IpcTabRunOutcome`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    pub stop_reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
}

/// One question of a stock `ask` card.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AskQuestion {
    pub id: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<AskOption>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub multi: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AskOption {
    pub label: String,
}

/// A blocking stock request (`ExtensionUIRequest`) as one record: `method` says which fields it carries.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UiRequest {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<AskQuestion>,
    /// A `form`'s HTML (stock 19.1): the asking session's bridge projects it into questions (`project_ask_form`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
}

/// A blocking request a session waits on, as the pool holds it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlAsk {
    pub id: String,
    pub request: UiRequest,
}

/// One open tab of this app (any window), as the pool knows it. `here` is set by `HostState::tabs` for the caller.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlTab {
    pub tab_id: String,
    /// "" while the session has no title.
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub status: TabStatus,
    /// `error` because another live omp still holds its session.
    #[serde(default, skip_serializing_if = "is_false")]
    pub session_held: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_wait: Option<StartWait>,
    #[serde(default)]
    pub busy: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub resuming: bool,
    /// Its cut-off turn did not go on by itself and waits for the person (`off`, `crash-loop`, `failed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cut_off: Option<String>,
    #[serde(default)]
    pub asks: Vec<ControlAsk>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub here: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<TabWorktree>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<RunOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) close_turn: Option<crate::pool::AutoCloseTurn>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub auto_closable: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub looked: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub user_touched: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub drafting: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub restored: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busy_since: Option<f64>,
    /// The ids this session's tab had before relaunches, newest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub former_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_edits: Option<FileEdits>,
    /// A view of a tab another party holds (a paired host's window or another device's tab there, or a tab this
    /// computer runs for a paired device): one omp, shared, and closing the view only leaves it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub viewing: bool,
    /// The tab's window's latest answer to an agent close (`closeId` of the view event).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_answer: Option<CloseAnswer>,
    /// A tab here not started since a relaunch (`asleep`) on a paired host's session that a tab on that host holds:
    /// who holds it there and what that tab does, from the host's summary every row reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_open: Option<OpenElsewhere>,
    /// Its turn ended and stock's background work (subagents, async jobs) still runs (`IpcTabInfo.settling`).
    #[serde(default, skip_serializing_if = "is_false")]
    pub settling: bool,
    /// Stock's auto-retry saga its running turn is in (`IpcTabInfo.retrySaga`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_saga: Option<RetrySaga>,
    /// Its failed turn retries by itself (`IpcTabInfo.scheduledRetry`): a backoff, or a wait for a provider's limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_retry: Option<ScheduledRetry>,
    /// Its turn waits for the internet connection and goes on once it is back (`IpcTabInfo.awaitingConnection`).
    #[serde(default, skip_serializing_if = "is_false")]
    pub awaiting_connection: bool,
    /// The process tag of the tab's omp on this computer (`SessionProcesses`), absent for a paired host's tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_tag: Option<String>,
    /// The tab's own omp, whose browser relay listens: never one of the session's servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omp_pid: Option<u32>,
}

/// Stock's auto-retry saga a running turn is in (`IpcRetrySaga`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrySaga {
    pub attempt: u32,
    pub max_attempts: u32,
    #[serde(default)]
    pub error_message: String,
}

/// A failed turn's own retry main armed (`IpcScheduledRetry`): `limit` waits for a provider's usage limit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRetry {
    /// Epoch ms.
    pub at: f64,
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub limit: bool,
}

impl ControlTab {
    /// `tab.task` and `tab.title` as a name: the title, else the task, else "".
    pub fn name(&self) -> &str {
        if self.title.is_empty() {
            self.task.as_deref().unwrap_or("")
        } else {
            &self.title
        }
    }

    /// For a tab here not started since a relaunch on a paired host's session: what the tab that host holds on it
    /// does (`host_open`). None for any other tab, or while the host's summary does not say.
    pub fn host_work(&self) -> Option<StoredWork> {
        if self.status != TabStatus::Asleep || self.device.is_none() {
            return None;
        }
        self.host_open.as_ref()?.work
    }
}

/// What a window did with an agent's close (`shared/agent-control.ts` `AgentCloseOutcome`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseOutcome {
    /// It let go of the tab; main's release follows.
    Closing,
    /// It keeps its last tab.
    LastTab,
    /// The tab's Files editor holds unsaved edits: the window asked the person first.
    UnsavedEdits,
    /// An automatic close met a tab the person is at.
    InUse,
    /// The window holds no such tab.
    NotHere,
}

/// A window's answer to the agent close `close_id`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseAnswer {
    pub close_id: u64,
    pub outcome: CloseOutcome,
}

/// What the tab holding a saved session elsewhere does with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StoredWork {
    Turn,
    Background,
    Waiting,
    Idle,
}

/// Where a saved session no tab of this app holds is open (`StoredSession.elsewhere`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct OpenElsewhere {
    /// The paired device whose tab there holds it; absent: that computer's own window, or a host that does not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work: Option<StoredWork>,
}

/// A saved session (stock's session index on this computer or a paired device), open in a tab or not.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub first_message: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub modified: String,
    #[serde(default)]
    pub messages: usize,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elsewhere: Option<OpenElsewhere>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// `ControlTab | StoredSession`: what a name resolves to (`"busy" in target` is `Tab`).
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Tab(Box<ControlTab>),
    Stored(Box<StoredSession>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceState {
    Connecting,
    Online,
    Offline,
}

impl DeviceState {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceState::Connecting => "connecting",
            DeviceState::Online => "online",
            DeviceState::Offline => "offline",
        }
    }
}

/// A paired host this computer can run sessions on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlDevice {
    pub id: String,
    pub name: String,
    pub state: DeviceState,
}

/// What `host.spawn` is asked for.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<SpawnWorktree>,
    /// Absent = the caller's machine, `Some(None)` = this computer, `Some(Some(id))` = that paired host.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_path: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub restore_saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub join: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SpawnWorktree {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

/// What `host.spawn` answers.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawned {
    pub tab_id: String,
    #[serde(default)]
    pub worktree: Option<TabWorktree>,
    #[serde(default)]
    pub prepared: Option<String>,
}

/// A session opened by `open`, handed to `beforeFirstPrompt` before its first message is sent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedChild {
    pub tab_id: String,
    pub caller_tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<ChildWorktree>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChildWorktree {
    pub path: String,
    pub branch: String,
}

/// The saved session a released tab held (`TabActivity` `released`), with what only the host knows of it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasedSession {
    pub path: String,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub former_ids: Vec<String>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub opened_by_session: Option<String>,
    /// Its opener hears that it was closed: an agent's own child, not an Autopilot run's (the run reads those itself).
    #[serde(default)]
    pub tell_opener: bool,
}

/// A tool call's result: what the agent reads, and whether it failed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutcome {
    pub text: String,
    pub is_error: bool,
}

/// An RPC command to a tab's omp, passed through as JSON (`{type, ...}`).
pub type RpcCommand = Value;

/// `RpcResponse`: the omp's (or a handler's) answer to a command.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RpcResponse {
    #[serde(default)]
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl RpcResponse {
    /// A refusal the service writes itself (`{ type: "response", success: false, error }`).
    pub fn refused(error: impl Into<String>) -> RpcResponse {
        RpcResponse {
            error: Some(error.into()),
            ..RpcResponse::default()
        }
    }

    /// No answer came, so the command may still run: a local omp's `RPC timeout (…)`, or main's
    /// `rpc_delivery_unknown`, which a paired host's tab gets when `tab.command` timed out on the link (the host may
    /// have delivered it and answered too late).
    pub fn unanswered(&self) -> bool {
        !self.success && (super::fail::unanswered_text(self.error.as_deref()) || self.unconfirmed())
    }

    /// The unanswered case where the command left this computer and its fate is unknown (`rpc_delivery_unknown`).
    pub fn unconfirmed(&self) -> bool {
        !self.success && self.code.as_deref() == Some("rpc_delivery_unknown")
    }
}

// ---- messages ---------------------------------------------------------------------------------------------------

/// A block of a message's content; the kinds the service reads, anything else is `Other`.
#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Text(String),
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
        intent: Option<String>,
    },
    Other,
}

impl<'de> Deserialize<'de> for Block {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Block, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        Ok(match value.get("type").and_then(Value::as_str) {
            Some("text") => Block::Text(text("text").unwrap_or_default()),
            Some("toolCall") => Block::ToolCall {
                id: text("id").unwrap_or_default(),
                name: text("name").unwrap_or_default(),
                arguments: value.get("arguments").cloned().unwrap_or(Value::Null),
                intent: text("intent"),
            },
            _ => Block::Other,
        })
    }
}

/// `MessageContent[] | string`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Blocks(Vec<Block>),
}

/// A transcript message (`AgentMessage`), the fields the service reads.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub content: Option<Content>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub exit_code: Option<serde_json::Number>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub is_error: bool,
    /// Only this fact from stock's `details.toolCommands` is needed after reading the result.
    #[serde(
        default,
        rename = "details",
        deserialize_with = "command_reported_done"
    )]
    pub command_reported_done: bool,
    #[serde(default)]
    pub synthetic: Option<bool>,
    #[serde(default)]
    pub attribution: Option<String>,
}

fn command_reported_done<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    let details = Value::deserialize(deserializer)?;
    Ok(details
        .get("toolCommands")
        .and_then(Value::as_array)
        .is_some_and(|commands| {
            commands.iter().any(|command| {
                command.get("tool").and_then(Value::as_str) == Some(Tool::Report.name())
                    && command.get("mode").and_then(Value::as_str) == Some("execute")
                    && command.get("exitCode").and_then(Value::as_i64) == Some(0)
                    && command.get("args").is_some_and(super::text::done_to_opener)
            })
        }))
}

/// One page of `get_transcript_page`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPage {
    pub messages: Vec<AgentMessage>,
    #[serde(default)]
    pub total_messages: usize,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub start_index: Option<usize>,
    #[serde(default)]
    pub prev_cursor: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct TodoTask {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct TodoPhase {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub tasks: Vec<TodoTask>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ModelInfo {
    pub provider: String,
    pub id: String,
}

/// `get_state {brief: true}`'s answer (`RpcSessionState`), the fields the service reads.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateInfo {
    #[serde(default)]
    pub model: Option<ModelInfo>,
    #[serde(default)]
    pub is_streaming: bool,
    #[serde(default)]
    pub is_settled: Option<bool>,
    #[serde(default)]
    pub todo_phases: Vec<TodoPhase>,
    #[serde(default)]
    pub queued_message_count: Option<f64>,
}

// ---- summaries --------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SummaryAgent {
    #[serde(default)]
    pub status: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SummaryFailure {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SummaryAsk {
    Approval,
    Input,
}

/// What every row shows of a live session, as the service reads it (`SessionSummary`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_path: String,
    #[serde(default)]
    pub tab_id: String,
    #[serde(default)]
    pub cwd: String,
    pub status: TabStatus,
    #[serde(default, skip_serializing_if = "is_false")]
    pub settling: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask: Option<SummaryAsk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<SummaryFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_for: Option<String>,
    #[serde(default)]
    pub agents: Vec<SummaryAgent>,
}

impl SessionSummary {
    /// `isUnsavedSession`: a tab whose omp has named no session file yet is summarized under `tab:<id>`.
    pub fn is_unsaved(&self) -> bool {
        self.session_path.starts_with("tab:")
    }
}

/// `runningAgentCount`: the subagents of a summary that run now (not waiting, not failed).
pub fn running_agent_count(summary: Option<&SessionSummary>) -> usize {
    summary.map_or(0, |summary| {
        summary
            .agents
            .iter()
            .filter(|agent| matches!(agent.status.as_str(), "started" | "running" | "pending"))
            .count()
    })
}

/// `hostedSummaries`: the sessions a computer runs for its paired devices that a list can show by file.
pub fn hosted_summaries(sessions: &[SessionSummary]) -> Vec<SessionSummary> {
    sessions
        .iter()
        .filter(|summary| summary.open_for.is_some() && !summary.is_unsaved())
        .cloned()
        .collect()
}

// ---- closed children --------------------------------------------------------------------------------------------

/// What an opened session ran on and cost, split by billing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CostSplit {
    pub charged: f64,
    pub estimate: f64,
}

/// An opened session main closed after its work landed (`ClosedChild`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedChild {
    pub path: String,
    pub opened_by_session: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_ids: Option<Vec<String>>,
    pub closed_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split: Option<CostSplit>,
}

// ---- schedules --------------------------------------------------------------------------------------------------

/// What fires an event schedule.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "lowercase")]
pub enum ScheduleEvent {
    Webhook {
        key: String,
        /// "Only when" tests, quoted fields, the old key after a rotate and the sender that signs calls: the
        /// schedules' own (`schedules/hooks.rs`), carried through an update as they were.
        #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
        filter: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        contains: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pick: Option<Vec<String>>,
        #[serde(
            default,
            rename = "previousKey",
            skip_serializing_if = "Option::is_none"
        )]
        previous_key: Option<Value>,
        #[serde(default, rename = "signedBy", skip_serializing_if = "Option::is_none")]
        signed_by: Option<String>,
    },
    Github {
        repo: String,
        events: Vec<String>,
        /// Only events by these logins, with this text in their title or text, or with this label.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        contains: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Files {
        path: String,
    },
    Git {
        repo: String,
        branch: String,
    },
    Session {
        events: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        folder: Option<String>,
    },
    Email {
        account: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subject: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
    },
    /// An ICS feed's events, `leadMinutes` before each starts.
    Calendar {
        url: String,
        #[serde(rename = "leadMinutes")]
        lead_minutes: i64,
    },
}

/// When a schedule starts (`ScheduleFrequency`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ScheduleFrequency {
    Interval {
        minutes: f64,
    },
    Daily {
        time: String,
        days: Vec<u8>,
    },
    Once {
        at: String,
    },
    /// Five-field cron in local time.
    Cron {
        expr: String,
    },
    Event {
        event: Box<ScheduleEvent>,
        /// A wait's deadline (ISO): it runs once, on its event or then.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<String>,
    },
}

/// A scheduled run as the control tools see it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRow {
    pub id: String,
    pub name: String,
    pub frequency: ScheduleFrequency,
    pub cwd: String,
    pub enabled: bool,
    /// Next start (ISO), null when it will not run.
    pub next_run: Option<String>,
    /// How the last run ended; null before the first.
    pub last_status: Option<String>,
    /// A wake-up of a session on this computer (`target: "self"`), not a fresh run.
    #[serde(default, skip_serializing_if = "is_false")]
    pub wakes: bool,
}

/// One kept run of a schedule (`ScheduleRun`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub schedule_id: String,
    /// `schedule`, `manual` or `event`.
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// What a schedule is saved as (`ScheduleDraft`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDraft {
    pub name: String,
    pub prompt: String,
    pub cwd: String,
    pub frequency: ScheduleFrequency,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub auto_approve: bool,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_session: Option<String>,
    /// A shell command that must succeed before each start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precheck: Option<String>,
    /// Where a fresh run's answer goes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub results_to: Option<ScheduleResultsTo>,
    /// A fresh run's `--thinking` level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// A fresh run starts in a new worktree of `cwd` each time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<bool>,
}

/// `ScheduleDraft.resultsTo`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ScheduleResultsTo {
    Session { session: String },
    Notify,
}

/// A saved schedule (`Schedule`): its draft plus the id, creation time and the device that saved it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(flatten)]
    pub draft: ScheduleDraft,
}

/// The Schedules service's state (`SchedulesState`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulesState {
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub schedules: Vec<Schedule>,
    #[serde(default)]
    pub runs: Vec<ScheduleRun>,
    #[serde(default)]
    pub next_runs: HashMap<String, Option<String>>,
}

/// `schedules.create`'s answer: the new id and the state after it.
#[derive(Clone, Debug, Deserialize)]
pub struct ScheduleCreated {
    pub id: String,
    pub state: SchedulesState,
}

// ---- git facts --------------------------------------------------------------------------------------------------

pub use crate::git::branches::{BranchFacts, FileChange};

/// What merging a branch would do, without doing it (`MergePrediction`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MergePrediction {
    Clean,
    Conflict { files: Vec<String> },
    Unknown { reason: String },
}

/// `BranchEvidence`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchEvidence {
    pub diff: String,
    pub diff_omitted: f64,
    pub merge: MergePrediction,
}

/// `LandingFacts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingFacts {
    pub has_work: bool,
    pub landed: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub squashed: bool,
    pub clean: bool,
}

/// What a safe removal did (`WorktreeRemoval`), its whole answer and what became of the branch's copy on `origin`:
/// git's own types.
pub use crate::git::branches::{RemoteCopy, Removal as WorktreeRemoval, SafeRemoval};

/// A worktree hook's report (`WorktreeSetupReport`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetupReport {
    pub script: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub exit_code: Option<f64>,
    #[serde(default)]
    pub timed_out: bool,
    #[serde(default)]
    pub duration_ms: f64,
    /// Where the hook's whole output was kept.
    #[serde(default)]
    pub log_path: String,
    /// The end of its output.
    #[serde(default)]
    pub output_tail: String,
}

/// `MergeOutcome`, as one record: `merged` says which of the three it is.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub merged: bool,
    #[serde(default)]
    pub sha: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub post_merge: Option<WorktreeSetupReport>,
    /// With `merged: true`: what became of the branch's copy on `origin` (none when it has none, or from a paired host
    /// older than the cleanup).
    #[serde(default)]
    pub remote: Option<RemoteCopy>,
    /// With `merged: false`: `hook` or `conflict`.
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub hook: Option<WorktreeSetupReport>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub predicted: bool,
}

// ---- autopilot --------------------------------------------------------------------------------------------------

/// A run's whole status (`AutopilotStatus`), the fields `describeRun` reads.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus {
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub cycle: Option<f64>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub ship: Option<RunShip>,
    #[serde(default)]
    pub settings: Option<RunSettings>,
    #[serde(default)]
    pub now: Option<RunNow>,
    #[serde(default)]
    pub red_streak: Option<f64>,
    #[serde(default)]
    pub cycles: Vec<RunCycle>,
    #[serde(default)]
    pub children: Vec<RunChild>,
    #[serde(default)]
    pub quota_reset_at: Option<f64>,
    /// With `autopilot.start`: the run's tab.
    #[serde(default)]
    pub tab_id: Option<String>,
    /// Whether the tab is a run at all (`active: false` for a tab that is no run).
    #[serde(default)]
    pub active: Option<bool>,
    /// `parent` runs cycles; a `child` is a session a parent's cycle opened (absent when inactive).
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSettings {
    #[serde(default)]
    pub ship: Option<ShipPolicy>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunShip {
    #[serde(default)]
    pub policy: Option<ShipPolicy>,
    #[serde(default)]
    pub queue: Vec<ShipQueueItem>,
    #[serde(default)]
    pub release: Option<ShipRelease>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipPolicy {
    #[serde(default)]
    pub auto_release: AutoRelease,
    #[serde(default)]
    pub auto_push: bool,
    #[serde(default)]
    pub remote: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct AutoRelease {
    #[serde(default)]
    pub on: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ShipQueueItem {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub sha: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipRelease {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub run_url: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct RunNow {
    #[serde(default)]
    pub n: f64,
    #[serde(default)]
    pub area: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct RunCycle {
    #[serde(default)]
    pub n: f64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub reverted: bool,
    #[serde(default)]
    pub verify: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct RunChild {
    #[serde(default)]
    pub status: String,
}

/// `ompdesk_autopilot start`'s options as the start sheet's (`AutopilotStartOptions`): passed to main as JSON.
pub type StartOptions = Map<String, Value>;

// ---- tool arguments (validated in TypeScript) ------------------------------------------------------------------

/// `worktree`: `true`, `false` or `{branch, base}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WorktreeArg {
    Flag(bool),
    Spec(SpawnWorktree),
}

/// One session of `ompdesk_session_open` (`OpenOne`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct OpenOne {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reopen: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// `goal` makes the first message the session goal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeArg>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub throwaway: Option<bool>,
    /// From a bot's chat: the item (its number or id) the session works on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
}

/// `ompdesk_session_open`'s arguments: the single-session fields, or `sessions`, and where to show the tabs.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct OpenArgs {
    #[serde(default)]
    pub sessions: Option<Vec<OpenOne>>,
    /// `background`, or a placement (`focus`, `split-right`, `split-down`).
    #[serde(default)]
    pub show: Option<String>,
    #[serde(flatten)]
    pub single: OpenOne,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ListArgs {
    /// `window`, `app` or `stored`.
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    /// `running`, `waiting` or `idle`.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub mine: Option<bool>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct SendArgs {
    /// One session; empty when `sessions` names several.
    #[serde(default)]
    pub session: String,
    /// Several sessions, each a name or `@children` / `@idle` (the caller's open children, or those of them idle).
    #[serde(default)]
    pub sessions: Option<Vec<String>>,
    pub message: String,
    #[serde(default)]
    pub attachments: Option<Vec<Attachment>>,
    #[serde(default)]
    pub request_id: Option<String>,
}

/// One attachment of a call (exactly one field): a file where the caller's omp runs, or the n-th newest picture of
/// its conversation (`tools.ts` `Attachment`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Attachment {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub image: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ReportCheck {
    pub command: String,
    pub passed: bool,
}

/// `ReportArgs`: `kind` is one of `MAIL_KINDS`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ReportArgs {
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub files: Option<Vec<String>>,
    #[serde(default)]
    pub checks: Option<Vec<ReportCheck>>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub dispatch: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<Attachment>>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ResultArgs {
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub sessions: Option<Vec<String>>,
    #[serde(default)]
    pub wait: Option<bool>,
    /// `all` or `any`.
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ReadArgs {
    pub session: String,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub before: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct AnswerItem {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub selected: Option<Vec<String>>,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct AnswerArgs {
    pub session: String,
    #[serde(default)]
    pub attachments: Option<Vec<Attachment>>,
    #[serde(default)]
    pub request: Option<String>,
    #[serde(default)]
    pub choice: Option<String>,
    #[serde(default)]
    pub approve: Option<bool>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub answers: Option<Vec<AnswerItem>>,
    /// The bot a question was routed to passes it on to the owner (`route.rs`).
    #[serde(default)]
    pub escalate: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct FocusArgs {
    pub session: String,
    /// `focus`, `split-right` or `split-down`.
    #[serde(default)]
    pub how: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct NotifyArgs {
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct StopArgs {
    pub session: String,
    #[serde(default)]
    pub close: Option<bool>,
    #[serde(default)]
    pub delete: Option<bool>,
    #[serde(default)]
    pub device: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct CompareArgs {
    #[serde(default)]
    pub sessions: Option<Vec<String>>,
    #[serde(default)]
    pub criteria: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct MergeArgs {
    pub session: String,
}

/// `ScheduleArgs`; `on` is the validated trigger as `ScheduleOn`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ScheduleArgs {
    /// `create`, `list`, `cancel`, `update`, `pause`, `resume`, `run` or `runs`.
    pub action: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub every_minutes: Option<f64>,
    #[serde(default)]
    pub daily_at: Option<String>,
    #[serde(default)]
    pub days: Option<Vec<u8>>,
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default)]
    pub in_minutes: Option<f64>,
    #[serde(default)]
    pub on: Option<ScheduleOn>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub device: Option<String>,
    /// `self` or `bot:<name>`.
    #[serde(default)]
    pub target: Option<String>,
    /// With `on`: a wait's deadline (ISO), or the same as minutes from now.
    #[serde(default)]
    pub by: Option<String>,
    #[serde(default)]
    pub within_minutes: Option<f64>,
    /// A shell command each start waits on; empty removes it.
    #[serde(default)]
    pub precheck: Option<String>,
    /// `self` or `notify`.
    #[serde(default)]
    pub results_to: Option<String>,
    /// A start: five-field cron in local time.
    #[serde(default)]
    pub cron: Option<String>,
    /// A fresh run's `--thinking` level; empty removes it.
    #[serde(default)]
    pub thinking: Option<String>,
    /// A fresh run in a new worktree each time.
    #[serde(default)]
    pub worktree: Option<bool>,
}

/// `ompdesk_schedule`'s `on`: the trigger as the tool takes it (a webhook's key is made by the service).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "source", rename_all = "lowercase")]
pub enum ScheduleOn {
    Webhook {
        #[serde(default, rename = "where")]
        filter: Option<Value>,
        #[serde(default)]
        contains: Option<String>,
        #[serde(default)]
        pick: Option<Vec<String>>,
    },
    Github {
        repo: String,
        events: Vec<String>,
        #[serde(default)]
        from: Option<Vec<String>>,
        #[serde(default)]
        contains: Option<String>,
        #[serde(default)]
        label: Option<String>,
    },
    Files {
        path: String,
    },
    Git {
        #[serde(default)]
        repo: Option<String>,
        branch: String,
    },
    Session {
        events: Vec<String>,
        #[serde(default)]
        folder: Option<String>,
    },
    Email {
        account: String,
        #[serde(default)]
        from: Option<String>,
        #[serde(default)]
        subject: Option<String>,
        #[serde(default)]
        to: Option<String>,
    },
    Calendar {
        url: String,
        #[serde(default)]
        lead_minutes: Option<i64>,
    },
}

/// `ompdesk_autopilot start`'s branch choice.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AutopilotBranch {
    New {
        #[serde(default)]
        name: Option<String>,
    },
    Existing {
        name: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct AutopilotLimits {
    #[serde(default)]
    pub tokens: Option<f64>,
    #[serde(default)]
    pub minutes: Option<f64>,
    #[serde(default)]
    pub cycles: Option<f64>,
    #[serde(default)]
    pub usd: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct AutopilotAdvanced {
    #[serde(default)]
    pub focus: Option<Vec<String>>,
    #[serde(default)]
    pub cadence: Option<f64>,
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub limits: Option<AutopilotLimits>,
}

/// `ompdesk_autopilot start`'s arguments.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct AutopilotStart {
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub guide: Option<String>,
    /// `commit`, `push` or `release`.
    #[serde(default)]
    pub ship: Option<String>,
    #[serde(default)]
    pub branch: Option<AutopilotBranch>,
    #[serde(default)]
    pub advanced: Option<AutopilotAdvanced>,
}

/// `ompdesk_autopilot`'s arguments, by `action`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum AutopilotArgs {
    Start(Box<AutopilotStart>),
    Status {
        session: String,
    },
    Stop {
        session: String,
        #[serde(default)]
        now: Option<bool>,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct AppListArgs {
    #[serde(default)]
    pub area: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct AppArgs {
    pub action: String,
    #[serde(default)]
    pub args: Option<Map<String, Value>>,
}

/// `ompdesk_bot`'s arguments (`BotArgs` of `tools.ts`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct BotArgs {
    /// `create`, `offer`, `list`, `pause`, `resume`, `set`, `look_around` or `hand`. `offer` takes `name` and the
    /// purpose in `text`.
    pub action: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    /// A bot's name or id.
    #[serde(default)]
    pub bot: Option<String>,
    /// `""` clears it.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub auto_approve: Option<bool>,
    /// 0 = never stale.
    #[serde(default)]
    pub stale_days: Option<f64>,
    #[serde(default)]
    pub reach: Option<Vec<String>>,
    #[serde(default)]
    pub on: Option<bool>,
    #[serde(default)]
    pub time: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

/// `ompdesk_item`'s arguments (`ItemArgs` of `tools.ts`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ItemArgs {
    /// `add`, `set`, `comment`, `done`, `cancel`, `link`, `list` or `show`.
    pub action: String,
    /// Its number or id.
    #[serde(default)]
    pub item: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub done_means: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub ask: Option<String>,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    #[serde(default)]
    pub recommended: Option<u32>,
    #[serde(default)]
    pub wait: Option<String>,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub snooze_until: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub pr: Option<String>,
    /// Several questions asked at once (`set`): each with its quick replies.
    #[serde(default)]
    pub asks: Option<Vec<AskArg>>,
}

/// One question of `ItemArgs.asks`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct AskArg {
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub recommended: Option<u32>,
    #[serde(default)]
    pub multi: bool,
}

/// `ompdesk_room`'s arguments (`RoomArgs` of `tools.ts`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct RoomArgs {
    /// `list`, `read` or `post`.
    pub action: String,
    /// Its id or name.
    #[serde(default)]
    pub room: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// The control tools' names (`AGENT_CONTROL_TOOLS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    List,
    Open,
    Send,
    Result,
    Read,
    Answer,
    Focus,
    Notify,
    Stop,
    Compare,
    Merge,
    Schedule,
    Autopilot,
    AppList,
    App,
    Report,
    Bot,
    Item,
    Room,
}

impl Tool {
    pub const ALL: [Tool; 19] = [
        Tool::List,
        Tool::Open,
        Tool::Send,
        Tool::Result,
        Tool::Read,
        Tool::Answer,
        Tool::Focus,
        Tool::Notify,
        Tool::Stop,
        Tool::Compare,
        Tool::Merge,
        Tool::Schedule,
        Tool::Autopilot,
        Tool::AppList,
        Tool::App,
        Tool::Report,
        Tool::Bot,
        Tool::Item,
        Tool::Room,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Tool::List => "ompdesk_sessions",
            Tool::Open => "ompdesk_session_open",
            Tool::Send => "ompdesk_session_send",
            Tool::Result => "ompdesk_session_result",
            Tool::Read => "ompdesk_session_read",
            Tool::Answer => "ompdesk_session_answer",
            Tool::Focus => "ompdesk_tab_focus",
            Tool::Notify => "ompdesk_notify",
            Tool::Stop => "ompdesk_session_stop",
            Tool::Compare => "ompdesk_compare",
            Tool::Merge => "ompdesk_merge",
            Tool::Schedule => "ompdesk_schedule",
            Tool::Autopilot => "ompdesk_autopilot",
            Tool::AppList => "ompdesk_app_list",
            Tool::App => "ompdesk_app",
            Tool::Report => "ompdesk_report",
            Tool::Bot => "ompdesk_bot",
            Tool::Item => "ompdesk_item",
            Tool::Room => "ompdesk_room",
        }
    }

    pub fn from_name(name: &str) -> Option<Tool> {
        Tool::ALL.into_iter().find(|tool| tool.name() == name)
    }
}
