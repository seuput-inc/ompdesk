//! The application command policy consumes the original admitted execution, never page-supplied authority.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::callers::CommandAdmission;
use super::source::Source;
use crate::agentctl::service::host::Deadline;
use crate::local_dispatch::{Commands, RpcError, rpc_call};
use crate::local_dispatch::protocol::RpcCommand;
use super::callers::{Admitted, Callers, Principal};
use super::runtime_log::{RuntimeErrorSource, RuntimeLogReport, Writer};
use super::sessions::SessionIndex;
use crate::agentctl::runtime::Runtime;
use crate::agentctl::service::AgentControl;
use crate::autopilot::Service as Autopilot;
use crate::desktop_slot::Service as DesktopSlot;
use crate::local_dispatch::policy::{StopSite, SystemStop, dispatched_command, is_stop, moves_tab, persons_prompt};
use crate::local_dispatch::protocol::{CommandError, CommandResult, RpcResponse};
use crate::local_dispatch::session::Session;
use crate::pool::application::Sidecar;
use crate::pool::application::native::{Host as PoolHost, Service as Pool};
use crate::pool::application::native::dispatch::Completion;
use crate::remote::application_host::{Host as HostedHost, HostServices};
use crate::remote::delivery::DeliveryLedger;
use crate::remote::requests::RemoteRequests;
use crate::server::{Events, Fault, Scope};
use crate::sidecar::application::EffectFuture;
use crate::worktree_lifecycle::manual;
use crate::sidecar::native::Service as LocalSidecar;

const DONE_KEPT: usize = 200;
type AnswerKey = (String, String);
type AnswerResult = Result<(), String>;
type RunningAnswer = watch::Receiver<Option<AnswerResult>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionDelivery {
    trigger_turn: bool,
    deliver_as: Option<Aside>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Aside {
    Aside,
}

#[derive(Deserialize)]
struct Companion {
    content: Value,
    details: Map<String, Value>,
    delivery: CompanionDelivery,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AnswerTarget {
    Question {
        #[serde(rename = "askId")]
        ask_id: String,
        response: Value,
    },
    Plan {
        plan: RpcCommand,
        #[serde(rename = "planFile")]
        plan_file: String,
        #[serde(rename = "planGeneration")]
        plan_generation: u64,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnswerStep {
    request_id: String,
    companion: Companion,
    #[serde(flatten)]
    target: AnswerTarget,
}

#[derive(Default)]
struct AnswerState {
    done: HashSet<AnswerKey>,
    order: VecDeque<AnswerKey>,
    running: HashMap<AnswerKey, RunningAnswer>,
}

/// `TargetAnswer`'s idempotency belongs to the execution host. A completed attachment answer is kept by request id,
/// while an uncertain/failed one is retryable. Only the actual pool can issue its private question/plan capability.
#[derive(Clone, Default)]
struct TargetAnswers(Arc<Mutex<AnswerState>>);

impl TargetAnswers {
    async fn run(
        &self,
        admission: Arc<CommandAdmission<Source>>,
        commands: Arc<Commands<LocalSidecar>>,
        command: RpcCommand,
        deadline: Deadline,
    ) -> AnswerResult {
        let step: AnswerStep = serde_json::from_value(Value::Object(command.params)).map_err(|error| error.to_string())?;
        match &step.target {
            AnswerTarget::Question { ask_id, response }
                if response["type"] != "extension_ui_response" || response["id"].as_str() != Some(ask_id.as_str()) =>
            {
                return Err("The answer must name the question it claims".into());
            }
            AnswerTarget::Plan { plan, .. } if plan.kind != "plan_approval" => {
                return Err("A plan answer must be a plan_approval command".into());
            }
            _ => {}
        }
        if !step.companion.content.is_string() && !step.companion.content.is_array() {
            return Err("companion.content must be a string or content array".into());
        }
        let key = (admission.selected().tab.clone(), step.request_id.clone());
        let mut answer = {
            let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
            if state.done.contains(&key) {
                return Ok(());
            }
            if let Some(answer) = state.running.get(&key) {
                answer.clone()
            } else {
                let (sender, answer) = watch::channel(None);
                state.running.insert(key.clone(), answer.clone());
                let answers = self.clone();
                tokio::spawn(async move {
                    // The original admission (including its Scope) stays alive through the real note/answer receipts.
                    let result = Self::step(admission, commands, step, deadline).await;
                    let mut state = answers.0.lock().unwrap_or_else(|error| error.into_inner());
                    state.running.remove(&key);
                    if result.is_ok() {
                        state.done.insert(key.clone());
                        state.order.push_back(key);
                        if state.order.len() > DONE_KEPT {
                            if let Some(oldest) = state.order.pop_front() {
                                state.done.remove(&oldest);
                            }
                        }
                    }
                    sender.send_replace(Some(result));
                });
                answer
            }
        };
        loop {
            if let Some(result) = answer.borrow_and_update().clone() {
                return result;
            }
            answer.changed().await.map_err(|_| "The answer step ended without a result".to_owned())?;
        }
    }

    async fn step(
        admission: Arc<CommandAdmission<Source>>,
        commands: Arc<Commands<LocalSidecar>>,
        step: AnswerStep,
        deadline: Deadline,
    ) -> AnswerResult {
        let Companion { content, details, delivery } = step.companion;
        let mut params = Map::from_iter([
            ("content".into(), content),
            ("details".into(), Value::Object(details)),
            ("triggerTurn".into(), Value::Bool(delivery.trigger_turn)),
        ]);
        if delivery.deliver_as.is_some() {
            params.insert("deliverAs".into(), json!("aside"));
        }
        let note = RpcCommand { kind: "agent_control_mail".into(), id: None, params };
        match step.target {
            AnswerTarget::Plan { plan, plan_file, plan_generation } => {
                let claim = admission.claim_plan(plan_file, plan_generation).await.map_err(|error| error.message)?
                    .ok_or_else(|| "That plan is not pending any more, or the plan changed since you read it, or another answer holds it: nothing was added to the session and nothing approved.".to_owned())?;
                let noted = commands.command_with_admission(Arc::clone(&admission), note, deadline).await
                    .map_err(|error| format!("no word came back about what goes with the answer ({error}): the attachments may have reached that session; the plan was not answered. Sending the same answer again is safe."))?;
                companion_delivered(&noted)?;
                if !claim.still_current().await.map_err(|error| error.message)? {
                    return Err("The plan changed or was closed while the attachments were going in (its turn was aborted, or a new proposal replaced it): the attachments reached that session, and no approval was sent to any plan.".into());
                }
                // The opaque capability rechecks this proposal and admission at the canonical local bridge enqueue.
                // Its Drop releases only its own token on every success/error/cancellation path.
                let kind = plan.kind.clone();
                let reply = RpcCommand { kind: kind.clone(), id: plan.id.clone(), params: Map::new() };
                let approval = claim.approve(plan);
                let approved = rpc_call::start(async move {
                    let result = approval.await.map(Some).map_err(|error| CommandError::Other(error.message));
                    local_frame(&reply, result)
                }, kind, deadline).await.map_err(|error| error.to_string())?;
                if approved["success"] != true {
                    let why = approved["error"].as_str().unwrap_or("no reason given");
                    return Err(format!("The plan was not answered ({why}); the attachments reached that session."));
                }
                Ok(())
            }
            AnswerTarget::Question { ask_id, response } => {
                let claim = admission.claim_question(ask_id).await.map_err(|error| error.message)?
                    .ok_or_else(|| "That question is not open any more, or another answer holds it: nothing was added to the session and nothing answered.".to_owned())?;
                let noted = commands.command_with_admission(Arc::clone(&admission), note, deadline).await
                    .map_err(|error| format!("no word came back about what goes with the answer ({error}): the attachments may have reached that session; the answer was not sent. Sending the same answer again is safe."))?;
                companion_delivered(&noted)?;
                if !claim.still_current().await.map_err(|error| error.message)? {
                    return Err(cancelled_question().into());
                }
                let choice = crate::pool::application::asks::describe_answer(&response);
                match claim.answer(response, choice).await {
                    Ok(true) => Ok(()),
                    Ok(false) => Err(cancelled_question().into()),
                    Err(error) => Err(format!("The answer was not delivered ({}); the attachments reached that session. Sending the same answer again is safe.", error.message)),
                }
            }
        }
    }
}

fn cancelled_question() -> &'static str {
    "The session cancelled the question while the attachments were going in (its turn was aborted): the attachments reached that session, the answer did not."
}

fn companion_delivered(response: &Value) -> AnswerResult {
    if response["success"] == true {
        Ok(())
    } else {
        Err(format!("what goes with the answer could not be delivered ({}). Neither the attachments nor the answer were sent.", response["error"].as_str().unwrap_or("no reason given")))
    }
}

enum ResponseTail {
    None,
    SessionFile(String),
    NewSession,
    State,
    ModeChanged,
}

impl ResponseTail {
    fn for_command(command: &RpcCommand) -> Self {
        match command.kind.as_str() {
            "switch_session" => command.string("sessionPath").map(|path| Self::SessionFile(path.to_owned())).unwrap_or(Self::None),
            "new_session" => Self::NewSession,
            "get_state" => Self::State,
            "set_plan_mode" | "set_prewalk" | "set_agents_paused" | "set_goal" |
            "set_fast_mode" | "set_slow_mode" | "set_ultrafast_mode" => Self::ModeChanged,
            _ => Self::None,
        }
    }

    fn completion(self, response: &Value) -> Option<Completion> {
        if response["success"] != true { return None; }
        match self {
            Self::SessionFile(path) if response["data"]["cancelled"] != true => Some(Completion::SessionFile(path)),
            Self::NewSession if response["data"]["cancelled"] != true => Some(Completion::NewSession),
            Self::State => Some(Completion::State {
                session_file: response["data"]["sessionFile"].as_str().map(str::to_owned),
                cwd: response["data"]["cwd"].as_str().filter(|cwd| !cwd.is_empty()).map(str::to_owned),
            }),
            Self::ModeChanged => Some(Completion::ModeChanged),
            _ => None,
        }
    }
}

/// Root supplies the existing per-source local Commands Arc, or forwards the whole command to the execution host.
/// Neither variant issues authority or owns another Source.
pub(crate) enum Route {
    Local(Arc<Commands<LocalSidecar>>),
    Remote,
}

pub(crate) struct Config<P: PoolHost<Sidecar = Source>, R: HostedHost> {
    pub pool: Arc<Pool<P>>,
    pub callers: Arc<Callers>,
    pub control: AgentControl,
    pub runtime: Arc<Runtime>,
    pub autopilot: Arc<Autopilot>,
    pub manual: Arc<manual::Service<P>>,
    pub slot: Arc<DesktopSlot>,
    pub delivery: Arc<DeliveryLedger>,
    pub log: Arc<Writer>,
    pub shell: Events,
    pub version: Arc<str>,
    pub device_id: String,
    pub host_name: String,
    pub sessions: Arc<SessionIndex>,
    pub hosted: Arc<HostServices<R>>,
}

pub(crate) struct Policy<P: PoolHost<Sidecar = Source>, R: HostedHost> {
    config: Config<P, R>,
    answers: TargetAnswers,
}

impl<P: PoolHost<Sidecar = Source>, R: HostedHost> Policy<P, R> {
    pub(crate) fn new(config: Config<P, R>) -> Arc<Self> {
        Arc::new(Self { config, answers: TargetAnswers::default() })
    }

    /// `origin` is the original authenticated page/device's attribution from Root, never command authority.
    /// Hosted RPC already stripped/deduplicated its deliveryId in the same canonical ledger.
    pub(crate) fn command(
        self: &Arc<Self>,
        admission: Arc<CommandAdmission<Source>>,
        route: Route,
        mut command: RpcCommand,
        deadline: Deadline,
        origin: Option<Value>,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        let policy = Arc::clone(self);
        Box::pin(async move {
            let reply = RpcCommand { kind: command.kind.clone(), id: command.id.clone(), params: Map::new() };
            let source = Arc::clone(&admission.selected().sidecar);
            let local = source.is_local();
            let matches_source = matches!((&route, local), (Route::Local(_), true) | (Route::Remote, false));
            let result = if !matches_source {
                Err(Fault::new("tab_stale", "The command route does not name its original source"))
            } else if let Err(error) = admission.effect(|_| Ok(())).await {
                Err(error)
            } else {
                let delivery = (local && admission.connection().is_none() && command.kind == "prompt")
                    .then(|| command.string("deliveryId").filter(|id| !id.is_empty()).map(str::to_owned)).flatten();
                if let Some(delivery) = delivery {
                    command.params.remove("deliveryId");
                    let send = Arc::clone(&policy);
                    policy.config.delivery.run(delivery, move || async move {
                        send.execute(admission, route, command, deadline, origin).await.map_err(RpcError::into_fault).map_err(Into::into)
                    }).await.map_err(|error| error.fault)
                } else {
                    policy.execute(admission, route, command, deadline, origin).await.map_err(RpcError::into_fault)
                }
            };
            let response = match result {
                Ok(response) => correlate(response, &reply),
                // These are the original outer delivery/admission errors, not a promotion of local bridge errors.
                Err(error) => local_frame(&reply, Err(CommandError::local(error.code, error.message))),
            };
            source.before_response();
            response
        })
    }

    async fn execute(
        self: &Arc<Self>,
        admission: Arc<CommandAdmission<Source>>,
        route: Route,
        mut command: RpcCommand,
        deadline: Deadline,
        origin: Option<Value>,
    ) -> Result<Value, RpcError> {
        if persons_prompt(&command) {
            self.config.pool.note_person_prompt(Arc::clone(&admission), Arc::clone(&self.config.runtime)).await?;
        }
        let selected = admission.selected();
        let shared_review = matches!(command.kind.as_str(), "agent_control_review" | "agent_control_family_edits")
            && selected.device.is_some() && selected.sidecar.facts()["shared"] == true;
        if shared_review {
            let review = command.kind == "agent_control_review";
            let mut response = admission.stock_call(serde_json::to_value(command).map_err(|error| Fault::new("invalid_params", error.to_string()))?, deadline).await?;
            if review && response["success"] == true {
                if let Some(data) = response.get_mut("data") {
                    review_from_device(data, selected.device.as_deref().expect("shared review has a device"), &self.config.device_id);
                }
            }
            return Ok(response);
        }
        if matches!(command.kind.as_str(), "agent_control_review" | "agent_control_family_edits") {
            return self.review(admission, &command).await.map_err(Into::into);
        }
        if command.kind == "plan_approval" {
            admission.guard_plan().await?;
        }
        if matches!(command.kind.as_str(), "set_idle_compaction_draft" | "set_next_prompt_draft") {
            let empty = self.config.pool.note_draft_command(
                Arc::clone(&admission), command.kind.clone(), command.is_true("empty"),
            ).await?;
            command.params.insert("empty".into(), json!(empty));
        }
        if command.kind == "set_subagent_subscription" {
            let level = self.config.pool.note_subagent_level_command(
                Arc::clone(&admission), command.string("level").unwrap_or_default().to_owned(),
            ).await?;
            command.params.insert("level".into(), json!(level));
        }
        if command.kind == "switch_session" {
            if let Some(path) = command.string("sessionPath") {
                let blocker = self.config.pool.foreign_session_owner_command(Arc::clone(&admission), path.to_owned()).await?;
                if !blocker.is_null() {
                    let mut response = local_frame(&command, Err(CommandError::local(
                        "session_owned_elsewhere", "Session is already open in another tab",
                    )))?;
                    response["data"] = json!({"ownerTabId":blocker["tabId"],"ownerWinId":blocker["winId"]});
                    return Ok(response);
                }
                if selected.sidecar.is_local() {
                    let held = self.config.hosted.holds_session(path)?;
                    admission.effect(|_| Ok(())).await?;
                    if held {
                        let mut response = local_frame(&command, Err(CommandError::local(
                            "session_owned_elsewhere", "A paired device's tab runs this session",
                        )))?;
                        response["data"] = json!({"hosted":true});
                        return Ok(response);
                    }
                }
                let target_kind = self.config.pool.session_kind_command(
                    Arc::clone(&admission), path.to_owned(), Arc::clone(&self.config.sessions),
                ).await?;
                let source_kind = self.config.pool.command_kind(Arc::clone(&admission)).await?;
                if target_kind != source_kind {
                    return local_frame(&command, Err(CommandError::local(
                        "session_kind_mismatch",
                        format!("Cannot switch from {source_kind} session to {target_kind} session. Open the target session in a new tab instead."),
                    ))).map_err(Into::into);
                }
            }
        }
        self.prepare(Arc::clone(&admission), &command).await?;
        let credentials_changed = matches!(command.kind.as_str(), "login" | "logout");
        let sign_in = if command.kind == "login" {
            self.config.pool.begin_sign_in_command(
                Arc::clone(&admission), command.string("providerId").map(str::to_owned),
            ).await?
        } else { None };
        let outcome: Result<Value, RpcError> = async {
        self.before_send(Arc::clone(&admission), &command, origin.as_ref()).await?;
        let chat_state = command.kind == "get_state"
            && self.config.pool.command_kind(Arc::clone(&admission)).await? == "chat";
        let localize = command.kind == "get_transcript_page" && selected.sidecar.is_local() && admission.connection().is_none();
        let hosted_origin = if localize {
            self.config.pool.command_origin(Arc::clone(&admission)).await?
        } else { None };
        let moving = moves_tab(&command.kind);
        let tail = ResponseTail::for_command(&command);
        let movement = if moving {
            Some(self.config.pool.begin_move_command(Arc::clone(&admission)).await?)
        } else { None };
        let outcome = match route {
            Route::Remote => {
                let outgoing = self.log_command(&admission, command, origin.as_ref());
                admission.stock_call(serde_json::to_value(outgoing).map_err(|error| Fault::new("invalid_params", error.to_string()))?, deadline).await
            }
            Route::Local(commands) => {
                if command.kind == "agent_control_answer" {
                    let reply = RpcCommand { kind: command.kind.clone(), id: command.id.clone(), params: Map::new() };
                    let result = self.answers.run(Arc::clone(&admission), commands, command, deadline).await;
                    return local_frame(&reply, result.map(|()| Some(Value::Null)).map_err(CommandError::Other)).map_err(Into::into);
                }
                if matches!(command.kind.as_str(), "get_autopilot" | "set_autopilot") {
                    let reply = RpcCommand { kind: command.kind.clone(), id: command.id.clone(), params: Map::new() };
                    let mut payload = command;
                    payload.id = None;
                    let payload = serde_json::to_value(payload).map_err(|error| Fault::new("invalid_params", error.to_string()))?;
                    let result = self.config.autopilot.command_admitted(Arc::clone(&admission), commands, payload).await;
                    return local_frame(&reply, result.map(Some)).map_err(Into::into);
                }
                if manual::handles(&command.kind) {
                    let policy = Arc::clone(self);
                    let kind = command.kind.clone();
                    let original = Arc::clone(&admission);
                    return rpc_call::start(async move { policy.manual(original, &command).await }, kind, deadline).await;
                }
                let outgoing = self.log_command(&admission, command, origin.as_ref());
                commands.command_with_admission(Arc::clone(&admission), outgoing, deadline).await
            }
        };
        if let Some(movement) = movement {
            movement.finish(moved_or_unknown(moving, &outcome)).await?;
        }
        let mut response = outcome?;
        if localize && response["success"] == true {
            if let Some(data) = response.get_mut("data") {
                if let Some(owner_name) = hosted_origin.as_ref().and_then(|origin| origin["name"].as_str()) {
                    label_for_viewer(data, owner_name, &self.config.host_name);
                }
                let own_id = origin.as_ref().and_then(|origin| origin["deviceId"].as_str()).unwrap_or("host");
                localize_transcript(data, own_id, &self.config.host_name);
            }
        }
        if chat_state && response["success"] == true {
            if let Some(data) = response.get_mut("data").and_then(Value::as_object_mut) {
                data.insert("kind".into(), json!("chat"));
            } else {
                response["data"] = json!({"kind":"chat"});
            }
        }
        if let Some(completion) = tail.completion(&response) {
            self.config.pool.complete_command(Arc::clone(&admission), completion, self.config.shell.clone()).await?;
        }
        if credentials_changed && response["success"] == true {
            self.config.pool.sync_image_generation_command(Arc::clone(&admission)).await?;
        }
        Ok(response)
        }.await;
        if let Some(sign_in) = sign_in {
            let error = match &outcome {
                Ok(response) if response["success"] != true => Some(response["error"].as_str().unwrap_or("").to_owned()),
                Err(error) => Some(error.to_string()),
                _ => None,
            };
            sign_in.finish(error).await?;
        }
        outcome
    }

    async fn prepare(
        &self,
        admission: Arc<CommandAdmission<Source>>,
        command: &RpcCommand,
    ) -> Result<(), Fault> {
        if is_stop(&command.kind) {
            self.config.pool.note_stopped_command(Arc::clone(&admission)).await?;
            let autopilot = Arc::clone(&self.config.autopilot);
            let tab = admission.selected().tab.clone();
            self.config.pool.command_effect(Arc::clone(&admission), move |_| {
                // The service captures the original run synchronously and owns the retained child-stop work.
                // The input abort does not wait for every child (`void autopilot.aborted` in the original dispatcher).
                drop(autopilot.aborted(&tab));
                Ok(())
            }).await?;
        }
        if matches!(command.kind.as_str(), "prompt" | "steer" | "follow_up" | "bash" | "eval") {
            self.config.pool.note_unstarted_command(Arc::clone(&admission), false).await?;
        }
        Ok(())
    }

    async fn before_send(
        &self,
        admission: Arc<CommandAdmission<Source>>,
        command: &RpcCommand,
        origin: Option<&Value>,
    ) -> Result<(), Fault> {
        let local = admission.selected().sidecar.is_local();
        if local && matches!(command.kind.as_str(), "prompt" | "steer" | "follow_up") {
            let hosted_origin = if origin.is_none() && admission.connection().is_none() {
                self.config.pool.command_origin(Arc::clone(&admission)).await?
            } else { None };
            let host = hosted_origin.map(|_| json!({"deviceId":"host","name":self.config.host_name}));
            let origin = origin.or(host.as_ref());
            if let Some(origin) = origin {
                // Attribution is best effort, never authority; even this enqueue uses the original admission.
                let _ = admission.bridge("prompt_origin_set".into(), Some(json!({"origin":origin,"text":command.params.get("message")})), None).await;
            }
        }
        if admission.channel().is_some() && persons_prompt(command) {
            let control = self.config.control.clone();
            let tab = admission.selected().tab.clone();
            let original = Arc::clone(&admission);
            self.config.pool.command_effect(Arc::clone(&admission), move |_| {
                if let Some(note) = control.person_typed(&tab) {
                    tokio::spawn(async move {
                        let _original_request = original;
                        // A failed best-effort cleanup note never suppresses the person's actual prompt.
                        let _ = note.await;
                    });
                }
                Ok(())
            }).await?;
        }
        if local && (admission.channel().is_some() || admission.connection().is_some()) && persons_prompt(command) {
            // Hosted RPC's original #run marks a real person's prompt as typed even without an IPC channel.
            let steer = command.kind == "steer" || (command.kind == "prompt" && command.string("streamingBehavior") == Some("steer"));
            let note = admission.bridge("typed_prompt".into(), Some(json!({"text":command.params.get("message"),"steer":steer})), None);
            let _ = tokio::time::timeout(std::time::Duration::from_millis(500), note).await;
        }
        Ok(())
    }

    /// App-wide slot actions run before selecting/starting a tab. There is no fabricated selected execution.
    pub(crate) fn slot_command(
        self: &Arc<Self>,
        caller: Admitted,
        connection: Option<RemoteRequests>,
        scope: Scope,
        command: RpcCommand,
    ) -> Option<EffectFuture<'static, Result<Value, Fault>>> {
        if !matches!(command.kind.as_str(), "get_desktop_slot" | "desktop_slot_stop" | "desktop_slot_retry" | "desktop_slot_kill") {
            return None;
        }
        let policy = Arc::clone(self);
        Some(Box::pin(async move {
            let config = &policy.config;
            config.callers.request_effect(&caller, connection.as_ref(), &scope, || {
                if command.kind == "desktop_slot_retry" { config.slot.retry()?; }
                Ok(())
            })?;
            if matches!(command.kind.as_str(), "desktop_slot_stop" | "desktop_slot_kill") {
                if let Some(capture) = config.slot.holder().await? {
                    // A retired holder keeps its exact detached cleanup capability. A false marker result only
                    // means the original pool entry is gone; it must not prevent revoking that captured holder.
                    let session = config.pool.note_slot_stopped(caller.clone(), connection.clone(), scope.clone(), capture.clone()).await?;
                    config.callers.request_effect(&caller, connection.as_ref(), &scope, || {
                        let abort = RpcCommand { kind: "abort".into(), id: None, params: Map::new() };
                        let (_, details) = dispatched_command(abort, StopSite {
                            tab: capture.tab(), session: session.as_deref(),
                            system: Some(if command.kind == "desktop_slot_stop" { SystemStop::ScreenStop } else { SystemStop::ScreenKill }),
                            ..StopSite::default()
                        });
                        if let Some(details) = details {
                            let mut report = RuntimeLogReport::new(RuntimeErrorSource::TurnStop, "desktop-slot");
                            report.details = Some(details);
                            config.log.write(&report, None, None);
                        }
                        Ok(())
                    })?;
                    if command.kind == "desktop_slot_stop" {
                        let stopped = config.callers.request_effect(
                            &caller, connection.as_ref(), &scope, || Ok(config.slot.stop(&capture)),
                        )?;
                        stopped.await?;
                    } else {
                        let killed = config.callers.request_effect(
                            &caller, connection.as_ref(), &scope, || Ok(config.slot.kill(&capture)),
                        )?;
                        if !killed.await? {
                            return local_frame(&command, Err(CommandError::Other("That session's omp has not exited, so the screen stays reserved for it.".into())));
                        }
                    }
                }
            }
            let state = config.callers.request_effect(&caller, connection.as_ref(), &scope, || {
                serde_json::to_value(config.slot.state()).map_err(|error| Fault::new("internal", error.to_string()))
            })?;
            local_frame(&command, Ok(Some(state)))
        }))
    }

    async fn review(&self, admission: Arc<CommandAdmission<Source>>, command: &RpcCommand) -> Result<Value, Fault> {
        let runtime = Arc::clone(&self.config.runtime);
        let tab = admission.selected().tab.clone();
        let original = Arc::clone(&admission);
        if command.kind == "agent_control_review" && command.is_true("live") {
            let work = self.config.pool.command_effect(admission, move |_| {
                // Runtime owns the live-read deduplication and retained work, not a new dispatcher cache.
                Ok(tokio::spawn(async move {
                    let _original_request = original;
                    runtime.live_review(&tab).await
                }))
            }).await?;
            work.await.map_err(|error| Fault::new("agent_control_review_failed", error.to_string()))?;
            return local_frame(command, Ok(Some(Value::Null)));
        }
        let since = command.params.get("since").and_then(Value::as_f64);
        let edits = command.kind == "agent_control_family_edits";
        let work = self.config.pool.command_effect(admission, move |_| {
            Ok(tokio::spawn(async move {
                let _original_request = original;
                if edits { runtime.family_edits(&tab, since).await } else { runtime.review(&tab).await }
            }))
        }).await?;
        let result = work.await.map_err(|error| Fault::new("agent_control_review_failed", error.to_string()))?;
        let code = if edits { "agent_control_family_edits_failed" } else { "agent_control_review_failed" };
        local_frame(command, result.map(Some).map_err(|error| CommandError::local(code, error.message())))
    }

    async fn manual(&self, admission: Arc<CommandAdmission<Source>>, command: &RpcCommand) -> Result<Value, Fault> {
        let selected = admission.selected();
        let session = Session::from_captured(Arc::clone(&selected.sidecar), Arc::clone(&self.config.version), selected.generation)
            .with_admission(Arc::clone(&admission))?;
        let result = self.config.manual.execute(&admission.caller().owner, &session, admission.scope().clone(), command).await;
        selected.sidecar.before_response();
        local_frame(command, result)
    }

    fn log_command(
        &self,
        admission: &CommandAdmission<Source>,
        command: RpcCommand,
        origin: Option<&Value>,
    ) -> RpcCommand {
        let selected = admission.selected();
        let peer = match &admission.caller().principal {
            Principal::Peer { device, .. } => Some(device.as_str()),
            Principal::Page(_) => None,
        };
        let (command, details) = dispatched_command(command, StopSite {
            tab: &selected.tab,
            session: selected.session_file.as_deref(),
            window: admission.window().map(|window| window.id),
            web_device: origin.and_then(|origin| origin["deviceId"].as_str()),
            peer,
            host: selected.device.as_deref(),
            channel: admission.channel(),
            system: None,
        });
        if let Some(details) = details {
            let mut report = RuntimeLogReport::new(RuntimeErrorSource::TurnStop, details["by"].as_str().unwrap_or("undefined"));
            report.details = Some(details);
            self.config.log.write(&report, admission.window().map(|window| window.id as f64), Some(&selected.cwd));
        }
        command
    }
}

fn local_frame(command: &RpcCommand, result: CommandResult) -> Result<Value, Fault> {
    serde_json::to_value(RpcResponse::local(command, result)).map_err(|error| Fault::new("internal", error.to_string()))
}

fn moved_or_unknown(moving: bool, outcome: &Result<Value, RpcError>) -> bool {
    moving && match outcome {
        Ok(response) => response["success"] == true && response["data"]["cancelled"] != true,
        Err(RpcError::Timeout(_)) => true,
        Err(RpcError::Fault(_)) => false,
    }
}

fn correlate(mut response: Value, command: &RpcCommand) -> Result<Value, Fault> {
    let fields = response.as_object_mut().ok_or_else(|| Fault::new("invalid_response", "The command did not return an RPC response frame"))?;
    match &command.id {
        Some(id) => { fields.insert("id".into(), json!(id)); }
        None => { fields.remove("id"); }
    }
    Ok(response)
}

/// The canonical shared-device review projection (`src/shared/agent-control.ts::reviewFromDevice`).
pub(crate) fn review_from_device(review: &mut Value, host: &str, this_device: &str) {
    for item in review.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
        if let Some(fields) = item.as_object_mut() {
            let runs_on = fields.get("device").and_then(Value::as_str).unwrap_or(host).to_owned();
            fields.insert("foreign".into(), Value::Bool(true));
            if runs_on == this_device { fields.remove("device"); } else { fields.insert("device".into(), Value::String(runs_on)); }
        }
    }
}

/// `prompt-origin-contracts.ts::localizePromptOrigins`: a native page must apply the same host/device labels.
/// The bridge's viewer-independent page and every unrelated field stay intact.
fn localize_transcript(data: &mut Value, own_id: &str, host_name: &str) {
    for message in data.get_mut("messages").and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(message) = message.as_object_mut() else { continue };
        let Some(origin) = message.remove("promptFromId") else { continue };
        if origin.as_str() == Some(own_id) {
            message.remove("promptFrom");
        } else if origin == "host" {
            message.insert("promptFrom".into(), json!(host_name));
        }
    }
}

/// `remote/hosted-view.ts::labelForViewer`: a hosted omp labelled its serving device's prompts as its own.
/// A different viewer sees those prompts named, and its own prompts plain. An unlabelled conversation stays plain.
fn label_for_viewer(data: &mut Value, owner_name: &str, viewer_name: &str) {
    let Some(messages) = data.get_mut("messages").and_then(Value::as_array_mut) else { return };
    if !messages.iter().any(|message| message.as_object().is_some_and(|message| message.contains_key("promptFrom"))) {
        return;
    }
    for message in messages {
        if message["role"] != "user" { continue; }
        let Some(message) = message.as_object_mut() else { continue };
        match message.get("promptFrom") {
            None => { message.insert("promptFrom".into(), json!(owner_name)); }
            Some(name) if name == viewer_name => { message.remove("promptFrom"); }
            Some(_) => {}
        }
    }
}

#[cfg(all(test, unix))]
#[path = "dispatch_policy_tests.rs"]
mod tests;
