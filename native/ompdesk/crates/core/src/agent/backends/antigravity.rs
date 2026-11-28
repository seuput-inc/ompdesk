//! Concrete [`AgentAdapter`] for Antigravity CLI (`agy -p --output-format stream-json`).
//!
//! Spawns the user's installed `agy` CLI directly over `tokio::process` pipes, feeds stdout
//! NDJSON / ACP lines through [`AntigravityStreamParser`], persists the observed session ID across
//! turns and hibernation via `--resume`, and cleanly kills active child processes on `interrupt`,
//! `hibernate`, or `stop`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::{Map, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use super::detect::{CliCommandSpec, DiscoveryEnv, build_tokio_command, detect_cli, detect_cli_in};
use crate::agent::adapter::{AgentAdapter, AgentSession, BoxFuture};
use crate::agent::parsers::{extract_text_content, non_empty_str, value_as_u32, value_as_u64};
use crate::agent::types::{
    AgentCapabilities, AgentError, AgentEvent, ApprovalKind, ApprovalMode, BackendId,
    DiscoverySource, InstalledBackend, ProviderCliKind, ResumeHandle, SessionLifecycleState,
    SessionSpec, TokenUsage, TurnFinishReason, TurnInput,
};

const EVENT_CHANNEL_CAPACITY: usize = 256;

/// Maps OMPdesk [`ApprovalMode`] onto Antigravity CLI (`agy`) approval flags.
pub const fn antigravity_approval_args(mode: ApprovalMode) -> &'static [&'static str] {
    match mode {
        ApprovalMode::Ask => &["--approval-mode", "ask"],
        ApprovalMode::AutoApprove => &["--approval-mode", "auto"],
        ApprovalMode::ReadOnly => &["--approval-mode", "read-only"],
        ApprovalMode::FullAccess => &["--approval-mode", "yolo"],
    }
}

/// Builds the exact `agy` CLI invocation spec for a structured JSON streaming turn.
pub fn build_antigravity_command(
    binary: PathBuf,
    spec: &SessionSpec,
    turn: Option<&TurnInput>,
    resume_id: Option<&str>,
    is_windows: bool,
) -> CliCommandSpec {
    let mut args = vec![
        "-p".to_owned(),
        "--output-format".to_owned(),
        "stream-json".to_owned(),
    ];

    if turn.is_none() {
        args.push("--input-format".to_owned());
        args.push("stream-json".to_owned());
    }

    let effective_resume = resume_id
        .filter(|id| !id.is_empty())
        .or_else(|| spec.resume.as_ref().map(|handle| handle.native_id.as_str()))
        .filter(|id| !id.is_empty());
    if let Some(id) = effective_resume {
        args.push("--resume".to_owned());
        args.push(id.to_owned());
    }

    let effective_model = turn
        .and_then(|input| input.model_override.as_deref())
        .filter(|model| !model.is_empty())
        .or_else(|| spec.model.as_deref().filter(|model| !model.is_empty()));
    if let Some(model) = effective_model {
        args.push("--model".to_owned());
        args.push(model.to_owned());
    }

    args.extend(
        antigravity_approval_args(spec.approval_mode)
            .iter()
            .map(|flag| (*flag).to_owned()),
    );

    if let Some(system_prompt) = spec
        .system_prompt
        .as_deref()
        .filter(|prompt| !prompt.is_empty())
    {
        args.push("--system-prompt".to_owned());
        args.push(system_prompt.to_owned());
    }

    args.extend(spec.extra_args.iter().cloned());
    CliCommandSpec::new(binary, args, is_windows)
}

/// Stateful line-by-line parser normalizing Antigravity CLI (`agy`) stream-json and ACP JSON-RPC
/// notifications into [`AgentEvent`].
#[derive(Debug, Default)]
pub struct AntigravityStreamParser {
    session_id: Option<String>,
    current_turn_id: Option<String>,
    turn_open: bool,
    tool_names: HashMap<String, String>,
    started_tools: HashSet<String>,
}

impl AntigravityStreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn resume_handle(&self) -> Option<ResumeHandle> {
        self.session_id
            .as_deref()
            .map(|id| ResumeHandle::new(BackendId::ProviderCli(ProviderCliKind::Antigravity), id))
    }

    /// Resets per-turn state while preserving the observed Antigravity session ID and tool names.
    pub fn reset_turn(&mut self) {
        self.current_turn_id = None;
        self.turn_open = false;
        self.started_tools.clear();
    }

    /// Parses one NDJSON line emitted by `agy` into zero or more normalized [`AgentEvent`]s.
    pub fn parse_line(&mut self, line: &str) -> Result<Vec<AgentEvent>, AgentError> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let value: Value = serde_json::from_str(trimmed)?;
        let Some(obj) = value.as_object() else {
            return Err(AgentError::Protocol {
                message: "expected JSON object in Antigravity stream line".to_owned(),
            });
        };

        self.capture_session_id(obj);

        let mut events = Vec::new();
        if let Some(method) = non_empty_str(obj, "method") {
            self.handle_acp_method(method, obj, &mut events);
            return Ok(events);
        }

        if let Some(kind) = non_empty_str(obj, "type") {
            self.handle_stream_event(kind, obj, &mut events);
        }
        Ok(events)
    }

    fn capture_session_id(&mut self, obj: &Map<String, Value>) {
        let direct = non_empty_str(obj, "session_id")
            .or_else(|| non_empty_str(obj, "sessionId"))
            .or_else(|| non_empty_str(obj, "conversation_id"))
            .or_else(|| non_empty_str(obj, "conversationId"));
        if let Some(id) = direct {
            self.session_id = Some(id.to_owned());
            return;
        }
        if let Some(params) = obj.get("params").and_then(Value::as_object)
            && let Some(id) =
                non_empty_str(params, "sessionId").or_else(|| non_empty_str(params, "session_id"))
        {
            self.session_id = Some(id.to_owned());
        }
    }

    fn ensure_turn_open(
        &mut self,
        turn_id: Option<String>,
        model: Option<String>,
        events: &mut Vec<AgentEvent>,
    ) {
        if self.turn_open {
            return;
        }
        self.turn_open = true;
        if turn_id.is_some() {
            self.current_turn_id = turn_id.clone();
        }
        events.push(AgentEvent::TurnStarted {
            turn_id: self.current_turn_id.clone(),
            model,
            resume_handle: self.resume_handle().map(Box::new),
        });
    }

    fn handle_stream_event(
        &mut self,
        kind: &str,
        obj: &Map<String, Value>,
        events: &mut Vec<AgentEvent>,
    ) {
        match kind {
            "init" | "system" | "session_started" => {
                let model = non_empty_str(obj, "model").map(str::to_owned);
                events.push(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Ready,
                    detail: model,
                });
            }
            "turn_start" | "message_start" => {
                let turn_id = non_empty_str(obj, "turn_id")
                    .or_else(|| non_empty_str(obj, "turnId"))
                    .or_else(|| non_empty_str(obj, "id"))
                    .map(str::to_owned);
                let model = non_empty_str(obj, "model").map(str::to_owned);
                self.ensure_turn_open(turn_id, model, events);
            }
            "text_delta" | "content_delta" | "assistant_delta" => {
                let resolved = non_empty_str(obj, "delta")
                    .or_else(|| non_empty_str(obj, "text"))
                    .map(str::to_owned)
                    .or_else(|| obj.get("content").and_then(extract_text_content));
                if let Some(text) = resolved {
                    self.ensure_turn_open(None, None, events);
                    events.push(AgentEvent::TextDelta {
                        text,
                        block_index: value_as_u32(
                            obj.get("block_index").or_else(|| obj.get("index")),
                        ),
                    });
                }
            }
            "thinking_delta" | "thought_delta" => {
                if let Some(text) =
                    non_empty_str(obj, "delta").or_else(|| non_empty_str(obj, "text"))
                {
                    self.ensure_turn_open(None, None, events);
                    events.push(AgentEvent::ThinkingDelta {
                        text: text.to_owned(),
                        block_index: value_as_u32(
                            obj.get("block_index").or_else(|| obj.get("index")),
                        ),
                    });
                }
            }
            "tool_call_start" | "tool_use" => {
                let call_id = non_empty_str(obj, "call_id")
                    .or_else(|| non_empty_str(obj, "callId"))
                    .or_else(|| non_empty_str(obj, "id"))
                    .unwrap_or("agy-tool")
                    .to_owned();
                let name = non_empty_str(obj, "name")
                    .or_else(|| non_empty_str(obj, "tool_name"))
                    .or_else(|| non_empty_str(obj, "toolName"))
                    .unwrap_or("tool")
                    .to_owned();
                let arguments = obj
                    .get("arguments")
                    .or_else(|| obj.get("input"))
                    .cloned()
                    .map(Box::new);
                self.ensure_turn_open(None, None, events);
                self.tool_names.insert(call_id.clone(), name.clone());
                self.started_tools.insert(call_id.clone());
                events.push(AgentEvent::ToolCallStarted {
                    call_id,
                    name,
                    arguments,
                });
            }
            "tool_call_delta" => {
                let Some(call_id) = non_empty_str(obj, "call_id")
                    .or_else(|| non_empty_str(obj, "callId"))
                    .or_else(|| non_empty_str(obj, "id"))
                else {
                    return;
                };
                let arguments_delta = non_empty_str(obj, "arguments_delta")
                    .or_else(|| non_empty_str(obj, "argumentsDelta"))
                    .map(str::to_owned);
                let output_delta = non_empty_str(obj, "output_delta")
                    .or_else(|| non_empty_str(obj, "outputDelta"))
                    .or_else(|| non_empty_str(obj, "delta"))
                    .map(str::to_owned);
                if arguments_delta.is_some() || output_delta.is_some() {
                    self.ensure_turn_open(None, None, events);
                    events.push(AgentEvent::ToolCallDelta {
                        call_id: call_id.to_owned(),
                        arguments_delta,
                        output_delta,
                    });
                }
            }
            "tool_call_end" | "tool_result" => {
                let Some(call_id) = non_empty_str(obj, "call_id")
                    .or_else(|| non_empty_str(obj, "callId"))
                    .or_else(|| non_empty_str(obj, "id"))
                else {
                    return;
                };
                let name = non_empty_str(obj, "name")
                    .or_else(|| non_empty_str(obj, "tool_name"))
                    .or_else(|| non_empty_str(obj, "toolName"))
                    .map(str::to_owned)
                    .or_else(|| self.tool_names.get(call_id).cloned());
                let output = obj
                    .get("output")
                    .or_else(|| obj.get("result"))
                    .or_else(|| obj.get("content"))
                    .and_then(extract_text_content);
                let is_error = obj
                    .get("is_error")
                    .or_else(|| obj.get("isError"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                events.push(AgentEvent::ToolCallFinished {
                    call_id: call_id.to_owned(),
                    name,
                    output,
                    is_error,
                });
            }
            "approval_request" | "permission_request" => {
                self.push_approval(obj, events);
            }
            "usage" => {
                let target = obj.get("usage").and_then(Value::as_object).unwrap_or(obj);
                let usage = parse_antigravity_usage(target);
                if !usage.is_empty() {
                    events.push(AgentEvent::Usage { usage });
                }
            }
            "result" | "turn_end" | "done" => {
                if let Some(usage_obj) = obj.get("usage").and_then(Value::as_object) {
                    let usage = parse_antigravity_usage(usage_obj);
                    if !usage.is_empty() {
                        events.push(AgentEvent::Usage { usage });
                    }
                }
                let is_error = obj
                    .get("is_error")
                    .or_else(|| obj.get("isError"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if is_error {
                    let message = non_empty_str(obj, "error")
                        .or_else(|| non_empty_str(obj, "message"))
                        .unwrap_or("Antigravity CLI turn failed")
                        .to_owned();
                    events.push(AgentEvent::Error {
                        code: "antigravity_error".to_owned(),
                        message,
                        retryable: false,
                    });
                }
                let reason = if is_error {
                    TurnFinishReason::Error
                } else {
                    map_antigravity_finish_reason(
                        non_empty_str(obj, "reason")
                            .or_else(|| non_empty_str(obj, "stop_reason"))
                            .or_else(|| non_empty_str(obj, "stopReason"))
                            .or_else(|| non_empty_str(obj, "subtype")),
                    )
                };
                let turn_id = non_empty_str(obj, "turn_id")
                    .or_else(|| non_empty_str(obj, "turnId"))
                    .map(str::to_owned)
                    .or_else(|| self.current_turn_id.clone());
                let resume_handle = self.resume_handle().map(Box::new);
                self.reset_turn();
                events.push(AgentEvent::TurnFinished {
                    turn_id,
                    reason,
                    resume_handle,
                });
            }
            "error" => {
                let code = non_empty_str(obj, "code")
                    .unwrap_or("antigravity_error")
                    .to_owned();
                let message = non_empty_str(obj, "message")
                    .or_else(|| non_empty_str(obj, "error"))
                    .unwrap_or("Antigravity CLI error")
                    .to_owned();
                let retryable = obj
                    .get("retryable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                events.push(AgentEvent::Error {
                    code,
                    message,
                    retryable,
                });
            }
            _ => {}
        }
    }

    fn handle_acp_method(
        &mut self,
        method: &str,
        obj: &Map<String, Value>,
        events: &mut Vec<AgentEvent>,
    ) {
        let Some(params) = obj.get("params").and_then(Value::as_object) else {
            return;
        };
        match method {
            "session/update" => {
                let update = params
                    .get("update")
                    .and_then(Value::as_object)
                    .unwrap_or(params);
                match non_empty_str(update, "sessionUpdate") {
                    Some("agent_message_chunk") => {
                        if let Some(text) = update
                            .get("content")
                            .and_then(extract_text_content)
                            .or_else(|| non_empty_str(update, "text").map(str::to_owned))
                        {
                            self.ensure_turn_open(None, None, events);
                            events.push(AgentEvent::TextDelta {
                                text,
                                block_index: None,
                            });
                        }
                    }
                    Some("agent_thought_chunk") => {
                        if let Some(text) = update
                            .get("content")
                            .and_then(extract_text_content)
                            .or_else(|| non_empty_str(update, "text").map(str::to_owned))
                        {
                            self.ensure_turn_open(None, None, events);
                            events.push(AgentEvent::ThinkingDelta {
                                text,
                                block_index: None,
                            });
                        }
                    }
                    Some("tool_call") => {
                        let call_id = non_empty_str(update, "toolCallId")
                            .unwrap_or("acp-tool")
                            .to_owned();
                        let name = non_empty_str(update, "title")
                            .or_else(|| non_empty_str(update, "kind"))
                            .unwrap_or("tool")
                            .to_owned();
                        let arguments = update.get("rawInput").cloned().map(Box::new);
                        self.ensure_turn_open(None, None, events);
                        self.tool_names.insert(call_id.clone(), name.clone());
                        self.started_tools.insert(call_id.clone());
                        events.push(AgentEvent::ToolCallStarted {
                            call_id,
                            name,
                            arguments,
                        });
                    }
                    Some("tool_call_update") => {
                        let Some(call_id) = non_empty_str(update, "toolCallId") else {
                            return;
                        };
                        let status = non_empty_str(update, "status");
                        let output = update
                            .get("rawOutput")
                            .or_else(|| update.get("content"))
                            .and_then(extract_text_content);
                        match status {
                            Some("completed" | "failed") => {
                                events.push(AgentEvent::ToolCallFinished {
                                    call_id: call_id.to_owned(),
                                    name: self.tool_names.get(call_id).cloned(),
                                    output,
                                    is_error: status == Some("failed"),
                                });
                            }
                            _ => {
                                if let Some(delta) = output {
                                    events.push(AgentEvent::ToolCallDelta {
                                        call_id: call_id.to_owned(),
                                        arguments_delta: None,
                                        output_delta: Some(delta),
                                    });
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            "session/request_permission" => {
                let request_id = obj
                    .get("id")
                    .map(|val| match val {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .unwrap_or_else(|| "acp-perm".to_owned());
                let tool_call = params.get("toolCall").and_then(Value::as_object);
                let tool_name = tool_call
                    .and_then(|tc| non_empty_str(tc, "title").or_else(|| non_empty_str(tc, "kind")))
                    .map(str::to_owned);
                let summary = tool_name
                    .clone()
                    .unwrap_or_else(|| "Antigravity permission requested".to_owned());
                let kind = classify_approval_kind(
                    tool_call.and_then(|tc| non_empty_str(tc, "kind")),
                    tool_name.as_deref(),
                );
                events.push(AgentEvent::ApprovalRequested {
                    request_id,
                    tool_name,
                    summary,
                    kind,
                    payload: Some(Box::new(Value::Object(params.clone()))),
                });
                events.push(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::WaitingForApproval,
                    detail: Some(method.to_owned()),
                });
            }
            _ => {}
        }
    }

    fn push_approval(&self, obj: &Map<String, Value>, events: &mut Vec<AgentEvent>) {
        let request_id = non_empty_str(obj, "request_id")
            .or_else(|| non_empty_str(obj, "requestId"))
            .or_else(|| non_empty_str(obj, "id"))
            .unwrap_or("agy-approval")
            .to_owned();
        let tool_name = non_empty_str(obj, "tool_name")
            .or_else(|| non_empty_str(obj, "toolName"))
            .or_else(|| non_empty_str(obj, "tool"))
            .map(str::to_owned);
        let summary = non_empty_str(obj, "summary")
            .or_else(|| non_empty_str(obj, "reason"))
            .or_else(|| non_empty_str(obj, "message"))
            .unwrap_or("Antigravity approval requested")
            .to_owned();
        let kind = classify_approval_kind(non_empty_str(obj, "kind"), tool_name.as_deref());
        events.push(AgentEvent::ApprovalRequested {
            request_id,
            tool_name,
            summary,
            kind,
            payload: Some(Box::new(Value::Object(obj.clone()))),
        });
        events.push(AgentEvent::SessionStateChanged {
            state: SessionLifecycleState::WaitingForApproval,
            detail: None,
        });
    }
}

fn classify_approval_kind(kind_hint: Option<&str>, tool_name: Option<&str>) -> ApprovalKind {
    let hint = kind_hint
        .or(tool_name)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if hint.contains("command") || hint.contains("shell") || hint.contains("exec") {
        ApprovalKind::CommandExecution
    } else if hint.contains("edit") || hint.contains("write") || hint.contains("file") {
        ApprovalKind::FileEdit
    } else if hint.contains("question") || hint.contains("ask") {
        ApprovalKind::UserQuestion
    } else if !hint.is_empty() {
        ApprovalKind::ToolExecution
    } else {
        ApprovalKind::Generic
    }
}

fn parse_antigravity_usage(obj: &Map<String, Value>) -> TokenUsage {
    TokenUsage {
        input_tokens: value_as_u64(obj.get("input_tokens").or_else(|| obj.get("inputTokens"))),
        output_tokens: value_as_u64(obj.get("output_tokens").or_else(|| obj.get("outputTokens"))),
        cache_read_tokens: value_as_u64(
            obj.get("cache_read_tokens")
                .or_else(|| obj.get("cacheReadTokens")),
        ),
        cache_write_tokens: value_as_u64(
            obj.get("cache_write_tokens")
                .or_else(|| obj.get("cacheWriteTokens")),
        ),
        reasoning_tokens: value_as_u64(
            obj.get("reasoning_tokens")
                .or_else(|| obj.get("reasoningTokens")),
        ),
        cost_usd: obj
            .get("cost_usd")
            .or_else(|| obj.get("costUsd"))
            .and_then(Value::as_f64),
    }
}

fn map_antigravity_finish_reason(reason: Option<&str>) -> TurnFinishReason {
    match reason {
        Some("completed" | "success" | "end_turn" | "stop") | None => TurnFinishReason::Completed,
        Some("interrupted" | "cancelled" | "aborted") => TurnFinishReason::Interrupted,
        Some("max_tokens" | "length") => TurnFinishReason::MaxTokens,
        Some("tool_use" | "tool_calls") => TurnFinishReason::ToolUse,
        Some("error" | "failed") => TurnFinishReason::Error,
        _ => TurnFinishReason::Unknown,
    }
}

/// Pumps NDJSON / ACP lines from `reader` through [`AntigravityStreamParser`] into `tx`, returning
/// the observed [`ResumeHandle`] if `agy` reported a session ID.
pub async fn pump_antigravity_stream<R: AsyncBufRead + Unpin>(
    mut reader: R,
    parser: &mut AntigravityStreamParser,
    tx: &mpsc::Sender<AgentEvent>,
) -> Result<Option<ResumeHandle>, AgentError> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            break;
        }
        match parser.parse_line(&line) {
            Ok(events) => {
                for event in events {
                    if tx.send(event).await.is_err() {
                        return Ok(parser.resume_handle());
                    }
                }
            }
            Err(error) => {
                let _ = tx
                    .send(AgentEvent::Error {
                        code: error.code().to_owned(),
                        message: error.to_string(),
                        retryable: false,
                    })
                    .await;
            }
        }
    }
    Ok(parser.resume_handle())
}

struct AntigravitySessionRuntime {
    spec: SessionSpec,
    binary: PathBuf,
    is_windows: bool,
    event_tx: mpsc::Sender<AgentEvent>,
    resume_handle: StdMutex<Option<ResumeHandle>>,
    active_cancel: StdMutex<Option<oneshot::Sender<()>>>,
}

impl AntigravitySessionRuntime {
    fn cancel_active_turn(&self) -> bool {
        let cancel = self
            .active_cancel
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(tx) = cancel {
            let _ = tx.send(());
            true
        } else {
            false
        }
    }

    fn current_resume_handle(&self) -> Option<ResumeHandle> {
        self.resume_handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_resume_handle(&self, handle: ResumeHandle) {
        *self
            .resume_handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(handle);
    }
}

/// Concrete [`AgentAdapter`] driving Google Antigravity CLI (`agy`) over structured JSON streams.
pub struct AntigravityCliAdapter {
    binary_override: Option<PathBuf>,
    discovery_env: Option<DiscoveryEnv>,
    sessions: Arc<StdMutex<HashMap<String, Arc<AntigravitySessionRuntime>>>>,
}

impl Default for AntigravityCliAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl AntigravityCliAdapter {
    pub fn new() -> Self {
        Self {
            binary_override: None,
            discovery_env: None,
            sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// Pins an explicit `agy` binary path (useful for tests and custom installs).
    pub fn with_binary(binary: impl Into<PathBuf>) -> Self {
        Self {
            binary_override: Some(binary.into()),
            discovery_env: None,
            sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// Uses a custom [`DiscoveryEnv`] instead of reading the host environment.
    pub fn with_discovery_env(env: DiscoveryEnv) -> Self {
        Self {
            binary_override: None,
            discovery_env: Some(env),
            sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    fn resolve_binary(&self) -> Result<(PathBuf, bool), AgentError> {
        let is_windows = self
            .discovery_env
            .as_ref()
            .map_or(cfg!(windows), |env| env.is_windows);
        if let Some(path) = &self.binary_override {
            return Ok((path.clone(), is_windows));
        }
        let info = match &self.discovery_env {
            Some(env) => detect_cli_in(self.id(), env),
            None => detect_cli(self.id()),
        };
        info.binary_path
            .map(|path| (path, is_windows))
            .ok_or_else(|| AgentError::NotInstalled {
                backend: self.id(),
                detail: info
                    .detail
                    .unwrap_or_else(|| "agy CLI binary not found on PATH".to_owned()),
            })
    }

    fn lookup_session(
        &self,
        session_id: &str,
    ) -> Result<Arc<AntigravitySessionRuntime>, AgentError> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session_id)
            .cloned()
            .ok_or(AgentError::SessionNotReady {
                state: SessionLifecycleState::Stopped,
            })
    }
}

impl AgentAdapter for AntigravityCliAdapter {
    fn id(&self) -> BackendId {
        BackendId::ProviderCli(ProviderCliKind::Antigravity)
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::provider_cli(ProviderCliKind::Antigravity)
    }

    fn detect_installed(&self) -> BoxFuture<'_, InstalledBackend> {
        let report = if let Some(path) = &self.binary_override {
            let mut installed =
                InstalledBackend::available(self.id(), DiscoverySource::UserInstall);
            installed.executable_path = Some(path.clone());
            installed
        } else {
            let info = match &self.discovery_env {
                Some(env) => detect_cli_in(self.id(), env),
                None => detect_cli(self.id()),
            };
            info.to_installed_backend()
        };
        Box::pin(async move { report })
    }

    fn start(&self, spec: SessionSpec) -> BoxFuture<'_, Result<AgentSession, AgentError>> {
        let resolved = self.resolve_binary();
        let backend = self.id();
        let caps = self.capabilities();
        let sessions = Arc::clone(&self.sessions);
        Box::pin(async move {
            let (binary, is_windows) = resolved?;
            if let Some(resume) = &spec.resume
                && resume.backend != backend
            {
                return Err(AgentError::InvalidResumeHandle {
                    expected: backend,
                    found: resume.backend,
                });
            }
            let (tx, rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
            let initial_resume = spec.resume.clone();
            let session_id = spec.session_id.clone();

            let runtime = Arc::new(AntigravitySessionRuntime {
                spec,
                binary,
                is_windows,
                event_tx: tx.clone(),
                resume_handle: StdMutex::new(initial_resume.clone()),
                active_cancel: StdMutex::new(None),
            });
            sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(session_id.clone(), runtime);

            let _ = tx
                .send(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Ready,
                    detail: None,
                })
                .await;

            let mut session = AgentSession::new(session_id, backend, caps, rx);
            if let Some(handle) = initial_resume {
                session.set_resume_handle(handle);
            }
            Ok(session)
        })
    }

    fn send_turn<'a>(
        &'a self,
        session: &'a AgentSession,
        input: TurnInput,
    ) -> BoxFuture<'a, Result<(), AgentError>> {
        let runtime = self.lookup_session(session.id());
        Box::pin(async move {
            let runtime = runtime?;
            let resume_id = runtime
                .current_resume_handle()
                .map(|handle| handle.native_id);
            let cmd_spec = build_antigravity_command(
                runtime.binary.clone(),
                &runtime.spec,
                Some(&input),
                resume_id.as_deref(),
                runtime.is_windows,
            );
            let mut cmd =
                build_tokio_command(&cmd_spec, Some(&runtime.spec.cwd), &runtime.spec.env, &[]);

            let mut child = cmd.spawn().map_err(|error| AgentError::SpawnFailed {
                message: format!("failed to spawn agy CLI: {error}"),
            })?;

            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(input.prompt.as_bytes()).await?;
                if !input.prompt.ends_with('\n') {
                    stdin.write_all(b"\n").await?;
                }
                stdin.shutdown().await?;
            }

            let stdout = child.stdout.take().ok_or_else(|| AgentError::SpawnFailed {
                message: "agy CLI child stdout pipe unavailable".to_owned(),
            })?;

            let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
            {
                let mut guard = runtime
                    .active_cancel
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Some(previous) = guard.replace(cancel_tx) {
                    let _ = previous.send(());
                }
            }

            let runtime_bg = Arc::clone(&runtime);
            tokio::spawn(async move {
                let mut parser = AntigravityStreamParser::new();
                let reader = BufReader::new(stdout);
                let tx = runtime_bg.event_tx.clone();
                let mut interrupted = false;

                tokio::select! {
                    result = pump_antigravity_stream(reader, &mut parser, &tx) => {
                        match result {
                            Ok(Some(handle)) => runtime_bg.set_resume_handle(handle),
                            Ok(None) => {}
                            Err(error) => {
                                let _ = tx
                                    .send(AgentEvent::Error {
                                        code: error.code().to_owned(),
                                        message: error.to_string(),
                                        retryable: error.is_retryable(),
                                    })
                                    .await;
                            }
                        }
                        let _ = child.wait().await;
                    }
                    _ = &mut cancel_rx => {
                        interrupted = true;
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                    }
                }

                if let Some(handle) = parser.resume_handle() {
                    runtime_bg.set_resume_handle(handle);
                }
                if interrupted {
                    let _ = tx
                        .send(AgentEvent::TurnFinished {
                            turn_id: input.turn_id,
                            reason: TurnFinishReason::Interrupted,
                            resume_handle: runtime_bg.current_resume_handle().map(Box::new),
                        })
                        .await;
                }
                let _ = runtime_bg
                    .active_cancel
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take();
            });

            Ok(())
        })
    }

    fn interrupt<'a>(&'a self, session: &'a AgentSession) -> BoxFuture<'a, Result<(), AgentError>> {
        let runtime = self.lookup_session(session.id());
        Box::pin(async move {
            let runtime = runtime?;
            let _ = runtime.cancel_active_turn();
            Ok(())
        })
    }

    fn hibernate<'a>(
        &'a self,
        session: &'a mut AgentSession,
    ) -> BoxFuture<'a, Result<ResumeHandle, AgentError>> {
        let session_id = session.id().to_owned();
        let runtime = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&session_id);
        Box::pin(async move {
            let handle = if let Some(rt) = runtime {
                let _ = rt.cancel_active_turn();
                let _ = rt.event_tx.try_send(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Hibernated,
                    detail: None,
                });
                rt.current_resume_handle()
                    .or_else(|| session.resume_handle().cloned())
                    .or_else(|| rt.spec.resume.clone())
            } else {
                session.resume_handle().cloned()
            };

            session.set_pid(None);
            session.set_state(SessionLifecycleState::Hibernated);

            let Some(handle) = handle else {
                return Err(AgentError::InvalidSpec {
                    message: "Antigravity session has no observed session_id to hibernate with"
                        .to_owned(),
                });
            };
            session.set_resume_handle(handle.clone());
            Ok(handle)
        })
    }

    fn resume(
        &self,
        handle: ResumeHandle,
        mut spec: SessionSpec,
    ) -> BoxFuture<'_, Result<AgentSession, AgentError>> {
        let expected = self.id();
        if handle.backend != expected {
            return Box::pin(async move {
                Err(AgentError::InvalidResumeHandle {
                    expected,
                    found: handle.backend,
                })
            });
        }
        spec.resume = Some(handle);
        self.start(spec)
    }

    fn stop<'a>(&'a self, session: &'a mut AgentSession) -> BoxFuture<'a, Result<(), AgentError>> {
        let session_id = session.id().to_owned();
        let runtime = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&session_id);
        Box::pin(async move {
            if let Some(rt) = runtime {
                let _ = rt.cancel_active_turn();
                let _ = rt.event_tx.try_send(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Stopped,
                    detail: None,
                });
            }
            session.set_pid(None);
            session.set_state(SessionLifecycleState::Stopped);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::agent::types::InstallStatus;

    #[test]
    fn builds_antigravity_argv_with_resume_model_approval_and_windows_shim() {
        let mut spec = SessionSpec::new("tab-agy", "/repo");
        spec.model = Some("gemini-2.5-pro".to_owned());
        spec.approval_mode = ApprovalMode::AutoApprove;
        spec.system_prompt = Some("Focus on Rust safety.".to_owned());
        spec.extra_args = vec!["--sandbox".to_owned(), "workspace".to_owned()];

        let mut turn = TurnInput::text("Audit agent/mod.rs");
        turn.model_override = Some("gemini-3-pro".to_owned());

        let cmd = build_antigravity_command(
            PathBuf::from("C:\\Users\\dev\\AppData\\Roaming\\npm\\agy.cmd"),
            &spec,
            Some(&turn),
            Some("agy-sess-12"),
            true,
        );

        assert!(cmd.use_cmd_shim);
        assert_eq!(
            cmd.args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--resume",
                "agy-sess-12",
                "--model",
                "gemini-3-pro",
                "--approval-mode",
                "auto",
                "--system-prompt",
                "Focus on Rust safety.",
                "--sandbox",
                "workspace",
            ]
        );

        let persistent = build_antigravity_command(
            PathBuf::from("/usr/local/bin/agy"),
            &SessionSpec::new("tab-agy-2", "/repo"),
            None,
            None,
            false,
        );
        assert!(!persistent.use_cmd_shim);
        assert_eq!(
            persistent.args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--input-format",
                "stream-json",
                "--approval-mode",
                "ask",
            ]
        );
    }

    #[tokio::test]
    async fn pumps_antigravity_stream_json_and_acp_notifications() {
        let stream = concat!(
            "{\"type\":\"init\",\"session_id\":\"agy-conv-77\",\"model\":\"gemini-3-pro\"}\n",
            "{\"type\":\"thinking_delta\",\"delta\":\"Planning...\",\"block_index\":0}\n",
            "{\"type\":\"text_delta\",\"delta\":\"Hello from agy!\",\"block_index\":1}\n",
            "{\"type\":\"tool_call_start\",\"call_id\":\"tc-1\",\"name\":\"read_file\",\"arguments\":{\"path\":\"Cargo.toml\"}}\n",
            "{\"type\":\"tool_call_delta\",\"call_id\":\"tc-1\",\"output_delta\":\"[package]\"}\n",
            "{\"type\":\"tool_call_end\",\"call_id\":\"tc-1\",\"output\":\"[package]\\nname=\\\"ompdesk-core\\\"\",\"is_error\":false}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"agy-conv-77\",\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":\" More text.\"}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"session/request_permission\",\"params\":{\"sessionId\":\"agy-conv-77\",\"toolCall\":{\"title\":\"run_command\",\"kind\":\"shell\"}}}\n",
            "{\"type\":\"result\",\"reason\":\"completed\",\"usage\":{\"input_tokens\":120,\"output_tokens\":45,\"reasoning_tokens\":15,\"cost_usd\":0.002}}\n",
        );

        let (tx, mut rx) = mpsc::channel(32);
        let mut parser = AntigravityStreamParser::new();
        let handle = pump_antigravity_stream(BufReader::new(Cursor::new(stream)), &mut parser, &tx)
            .await
            .unwrap()
            .unwrap();
        drop(tx);

        assert_eq!(
            handle,
            ResumeHandle::new(
                BackendId::ProviderCli(ProviderCliKind::Antigravity),
                "agy-conv-77"
            )
        );

        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }

        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::SessionStateChanged {
                state: SessionLifecycleState::Ready,
                detail: Some(model)
            } if model == "gemini-3-pro"
        )));
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::ThinkingDelta { text, block_index: Some(0) } if text == "Planning..."
        )));
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::TextDelta { text, .. } if text == "Hello from agy!"
        )));
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::TextDelta { text, .. } if text == " More text."
        )));
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::ToolCallStarted { call_id, name, .. } if call_id == "tc-1" && name == "read_file"
        )));
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::ToolCallFinished { call_id, is_error: false, .. } if call_id == "tc-1"
        )));
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::ApprovalRequested { request_id, kind: ApprovalKind::CommandExecution, .. } if request_id == "9"
        )));
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::Usage { usage } if usage.input_tokens == 120 && usage.output_tokens == 45 && usage.reasoning_tokens == 15
        )));
        assert!(matches!(
            events.last(),
            Some(AgentEvent::TurnFinished {
                reason: TurnFinishReason::Completed,
                resume_handle: Some(h),
                ..
            }) if h.native_id == "agy-conv-77"
        ));
    }

    #[test]
    fn parser_rejects_non_object_and_malformed_json_and_handles_error_events() {
        let mut parser = AntigravityStreamParser::new();
        assert!(parser.parse_line("   \n").unwrap().is_empty());
        assert_eq!(
            parser.parse_line("[1, 2, 3]").unwrap_err().code(),
            "protocol"
        );
        assert_eq!(
            parser.parse_line("{not-json").unwrap_err().code(),
            "protocol"
        );

        let err_events = parser
            .parse_line(
                r#"{"type":"error","code":"rate_limit","message":"try later","retryable":true}"#,
            )
            .unwrap();
        assert_eq!(
            err_events,
            vec![AgentEvent::Error {
                code: "rate_limit".to_owned(),
                message: "try later".to_owned(),
                retryable: true,
            }]
        );
    }

    #[tokio::test]
    async fn declares_capabilities_reports_missing_binary_and_round_trips_hibernate_resume() {
        let empty_env = DiscoveryEnv {
            path_dirs: Vec::new(),
            extra_dirs: Vec::new(),
            managed_dirs: Vec::new(),
            pathext: vec![".exe".to_owned(), ".cmd".to_owned()],
            is_windows: cfg!(windows),
        };
        let missing_adapter = AntigravityCliAdapter::with_discovery_env(empty_env);
        assert_eq!(
            missing_adapter.id(),
            BackendId::ProviderCli(ProviderCliKind::Antigravity)
        );
        let caps = missing_adapter.capabilities();
        assert!(caps.streaming_text);
        assert!(caps.streaming_thinking);
        assert!(caps.structured_tool_calls);
        assert!(caps.resume);
        assert!(caps.idle_hibernation);
        assert!(caps.requires_external_cli);
        assert!(!caps.built_in_tool_loop);

        let detected = missing_adapter.detect_installed().await;
        assert_eq!(detected.status, InstallStatus::Missing);
        let start_err = missing_adapter
            .start(SessionSpec::new("tab-missing", "/tmp"))
            .await
            .unwrap_err();
        assert_eq!(start_err.code(), "not_installed");

        let adapter = AntigravityCliAdapter::with_binary("/usr/local/bin/agy");
        assert!(adapter.detect_installed().await.is_available());

        // Starting without a resume handle and hibernating before any turn fails cleanly.
        let mut fresh = adapter
            .start(SessionSpec::new("tab-fresh", "/tmp"))
            .await
            .unwrap();
        let no_handle_err = adapter.hibernate(&mut fresh).await.unwrap_err();
        assert_eq!(no_handle_err.code(), "invalid_spec");

        // Starting with an existing handle supports hibernate -> resume.
        let mut spec = SessionSpec::new("tab-resumed", "/tmp");
        spec.resume = Some(ResumeHandle::new(
            BackendId::ProviderCli(ProviderCliKind::Antigravity),
            "agy-resume-88",
        ));
        let mut session = adapter.start(spec).await.unwrap();
        let handle = adapter.hibernate(&mut session).await.unwrap();
        assert_eq!(session.state(), SessionLifecycleState::Hibernated);
        assert_eq!(handle.native_id, "agy-resume-88");

        let mut resumed = adapter
            .resume(handle.clone(), SessionSpec::new("tab-resumed", "/tmp"))
            .await
            .unwrap();
        assert_eq!(resumed.resume_handle(), Some(&handle));
        adapter.stop(&mut resumed).await.unwrap();
        assert_eq!(resumed.state(), SessionLifecycleState::Stopped);

        // Mismatched backend handle is rejected.
        let mismatch = adapter
            .resume(
                ResumeHandle::new(BackendId::Omp, "/tmp/omp.jsonl"),
                SessionSpec::new("tab-mismatch", "/tmp"),
            )
            .await
            .unwrap_err();
        assert_eq!(mismatch.code(), "invalid_resume_handle");
    }
}
