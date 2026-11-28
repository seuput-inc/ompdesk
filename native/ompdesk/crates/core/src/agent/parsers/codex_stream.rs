//! Pure-Rust JSONL parser for Codex CLI output.
//!
//! Supports both:
//! - `codex app-server` JSON-RPC 2.0 notifications & approval server requests
//! - `codex exec --json` NDJSON lifecycle and item events

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::{extract_text_content, non_empty_str, value_as_u64};
use crate::agent::types::{
    AgentError, AgentEvent, ApprovalKind, BackendId, ProviderCliKind, ResumeHandle,
    SessionLifecycleState, TokenUsage, TurnFinishReason,
};

/// Stateful line-by-line parser normalizing Codex CLI events into [`AgentEvent`].
#[derive(Debug, Default)]
pub struct CodexStreamParser {
    thread_id: Option<String>,
    current_turn_id: Option<String>,
    streamed_text_len: HashMap<String, usize>,
    streamed_tool_len: HashMap<String, usize>,
    streamed_deltas: HashSet<String>,
    started_tools: HashSet<String>,
}

impl CodexStreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn thread_id(&self) -> Option<&str> {
        self.thread_id.as_deref()
    }

    pub fn resume_handle(&self) -> Option<ResumeHandle> {
        self.thread_id
            .as_deref()
            .map(|id| ResumeHandle::new(BackendId::ProviderCli(ProviderCliKind::Codex), id))
    }

    /// Resets per-turn item tracking while preserving the Codex `thread_id`.
    pub fn reset_turn(&mut self) {
        self.current_turn_id = None;
        self.streamed_text_len.clear();
        self.streamed_tool_len.clear();
        self.streamed_deltas.clear();
        self.started_tools.clear();
    }

    /// Parses one JSONL line from Codex `app-server` or `exec --json` stdout.
    pub fn parse_line(&mut self, line: &str) -> Result<Vec<AgentEvent>, AgentError> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let value: Value = serde_json::from_str(trimmed)?;
        let Some(obj) = value.as_object() else {
            return Err(AgentError::Protocol {
                message: "expected JSON object in Codex JSONL line".to_owned(),
            });
        };

        let mut events = Vec::new();
        if let Some(method) = non_empty_str(obj, "method") {
            if let Some(id_val) = obj.get("id")
                && (id_val.is_string() || id_val.is_number())
            {
                self.handle_app_server_request(id_val, method, obj.get("params"), &mut events);
            } else {
                self.handle_app_server_notification(method, obj.get("params"), &mut events);
            }
        } else if let Some(kind) = non_empty_str(obj, "type") {
            self.handle_exec_event(kind, obj, &mut events);
        }
        Ok(events)
    }

    fn handle_app_server_request(
        &mut self,
        id_val: &Value,
        method: &str,
        params: Option<&Value>,
        events: &mut Vec<AgentEvent>,
    ) {
        let request_id = match id_val {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        let params_obj = params.and_then(Value::as_object);
        let lower = method.to_ascii_lowercase();
        let kind = if lower.contains("command") || lower.contains("exec") {
            ApprovalKind::CommandExecution
        } else if lower.contains("file") || lower.contains("patch") {
            ApprovalKind::FileEdit
        } else if lower.contains("userinput") || lower.contains("question") {
            ApprovalKind::UserQuestion
        } else {
            ApprovalKind::ToolExecution
        };

        let tool_name = params_obj
            .and_then(|map| {
                non_empty_str(map, "toolName")
                    .or_else(|| non_empty_str(map, "tool"))
                    .or_else(|| non_empty_str(map, "command"))
            })
            .map(str::to_owned);
        let summary = params_obj
            .and_then(|map| {
                non_empty_str(map, "reason")
                    .or_else(|| non_empty_str(map, "prompt"))
                    .or_else(|| non_empty_str(map, "command"))
                    .or_else(|| non_empty_str(map, "description"))
            })
            .unwrap_or(method)
            .to_owned();

        events.push(AgentEvent::ApprovalRequested {
            request_id,
            tool_name,
            summary,
            kind,
            payload: params.cloned().map(Box::new),
        });
        events.push(AgentEvent::SessionStateChanged {
            state: SessionLifecycleState::WaitingForApproval,
            detail: Some(method.to_owned()),
        });
    }

    fn handle_app_server_notification(
        &mut self,
        method: &str,
        params: Option<&Value>,
        events: &mut Vec<AgentEvent>,
    ) {
        let params_obj = params.and_then(Value::as_object);
        if let Some(tid) = params_obj.and_then(|map| {
            non_empty_str(map, "threadId").or_else(|| {
                map.get("thread")
                    .and_then(Value::as_object)
                    .and_then(|thread| non_empty_str(thread, "id"))
            })
        }) {
            self.thread_id = Some(tid.to_owned());
        }

        match method {
            "thread/started" => {
                events.push(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Ready,
                    detail: self.thread_id.clone(),
                });
            }
            "thread/status/changed" => {
                let status = params_obj.and_then(|map| {
                    non_empty_str(map, "status").or_else(|| {
                        map.get("status")
                            .and_then(Value::as_object)
                            .and_then(|obj| non_empty_str(obj, "type"))
                    })
                });
                let state = match status {
                    Some("active" | "running" | "inProgress") => SessionLifecycleState::Running,
                    Some("idle" | "ready") => SessionLifecycleState::Ready,
                    Some("error" | "failed") => SessionLifecycleState::Error,
                    _ => return,
                };
                events.push(AgentEvent::SessionStateChanged {
                    state,
                    detail: status.map(str::to_owned),
                });
            }
            "turn/started" => {
                let turn_id = params_obj
                    .and_then(|map| {
                        non_empty_str(map, "turnId").or_else(|| {
                            map.get("turn")
                                .and_then(Value::as_object)
                                .and_then(|turn| non_empty_str(turn, "id"))
                        })
                    })
                    .map(str::to_owned);
                let model = params_obj
                    .and_then(|map| non_empty_str(map, "model"))
                    .map(str::to_owned);
                self.current_turn_id = turn_id.clone();
                events.push(AgentEvent::TurnStarted {
                    turn_id,
                    model,
                    resume_handle: self.resume_handle().map(Box::new),
                });
            }
            "turn/completed" => {
                let turn = params_obj.and_then(|map| map.get("turn").and_then(Value::as_object));
                let status = turn
                    .and_then(|map| non_empty_str(map, "status"))
                    .or_else(|| params_obj.and_then(|map| non_empty_str(map, "status")));
                let reason = match status {
                    Some("completed" | "success") | None => TurnFinishReason::Completed,
                    Some("interrupted" | "cancelled" | "aborted") => TurnFinishReason::Interrupted,
                    Some("incomplete" | "max_tokens") => TurnFinishReason::MaxTokens,
                    Some("failed" | "error") => TurnFinishReason::Error,
                    _ => TurnFinishReason::Unknown,
                };
                let turn_id = turn
                    .and_then(|map| non_empty_str(map, "id"))
                    .map(str::to_owned)
                    .or_else(|| self.current_turn_id.take());
                let resume_handle = self.resume_handle().map(Box::new);
                events.push(AgentEvent::TurnFinished {
                    turn_id,
                    reason,
                    resume_handle,
                });
                self.reset_turn();
            }
            "item/agentMessage/delta" => {
                if let Some(map) = params_obj
                    && let Some(delta) = non_empty_str(map, "delta")
                {
                    if let Some(item_id) = non_empty_str(map, "itemId") {
                        self.streamed_deltas.insert(item_id.to_owned());
                    }
                    events.push(AgentEvent::TextDelta {
                        text: delta.to_owned(),
                        block_index: None,
                    });
                }
            }
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                if let Some(map) = params_obj
                    && let Some(delta) = non_empty_str(map, "delta")
                {
                    if let Some(item_id) = non_empty_str(map, "itemId") {
                        self.streamed_deltas.insert(item_id.to_owned());
                    }
                    events.push(AgentEvent::ThinkingDelta {
                        text: delta.to_owned(),
                        block_index: None,
                    });
                }
            }
            "item/started" => {
                if let Some(item) = params_obj
                    .and_then(|map| map.get("item"))
                    .and_then(Value::as_object)
                {
                    self.handle_item_started(item, events);
                }
            }
            "item/commandExecution/outputDelta"
            | "item/fileChange/outputDelta"
            | "command/exec/outputDelta"
            | "process/outputDelta" => {
                if let Some(map) = params_obj
                    && let Some(delta) = non_empty_str(map, "delta")
                {
                    let call_id = non_empty_str(map, "itemId")
                        .or_else(|| non_empty_str(map, "callId"))
                        .or_else(|| non_empty_str(map, "processId"))
                        .unwrap_or("codex-tool")
                        .to_owned();
                    events.push(AgentEvent::ToolCallDelta {
                        call_id,
                        arguments_delta: None,
                        output_delta: Some(delta.to_owned()),
                    });
                }
            }
            "item/completed" => {
                if let Some(item) = params_obj
                    .and_then(|map| map.get("item"))
                    .and_then(Value::as_object)
                {
                    self.handle_item_completed(item, events);
                }
            }
            "thread/tokenUsage/updated" => {
                let usage_obj = params_obj.and_then(|map| {
                    map.get("tokenUsage")
                        .and_then(Value::as_object)
                        .and_then(|token_usage| {
                            token_usage
                                .get("last")
                                .or_else(|| token_usage.get("total"))
                                .and_then(Value::as_object)
                        })
                        .or_else(|| map.get("usage").and_then(Value::as_object))
                });
                if let Some(usage) = usage_obj.map(parse_codex_usage)
                    && !usage.is_empty()
                {
                    events.push(AgentEvent::Usage { usage });
                }
            }
            "error" => {
                let code = params_obj
                    .and_then(|map| non_empty_str(map, "code"))
                    .unwrap_or("codex_error")
                    .to_owned();
                let message = params_obj
                    .and_then(|map| {
                        non_empty_str(map, "message").or_else(|| {
                            map.get("error")
                                .and_then(Value::as_object)
                                .and_then(|err| non_empty_str(err, "message"))
                        })
                    })
                    .unwrap_or("Codex error")
                    .to_owned();
                let retryable = params_obj
                    .and_then(|map| map.get("willRetry"))
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

    fn handle_exec_event(
        &mut self,
        kind: &str,
        obj: &Map<String, Value>,
        events: &mut Vec<AgentEvent>,
    ) {
        if let Some(tid) = non_empty_str(obj, "thread_id") {
            self.thread_id = Some(tid.to_owned());
        }

        match kind {
            "thread.started" => {
                events.push(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Ready,
                    detail: self.thread_id.clone(),
                });
            }
            "turn.started" => {
                let turn_id = non_empty_str(obj, "turn_id").map(str::to_owned);
                let model = non_empty_str(obj, "model").map(str::to_owned);
                self.current_turn_id = turn_id.clone();
                events.push(AgentEvent::TurnStarted {
                    turn_id,
                    model,
                    resume_handle: self.resume_handle().map(Box::new),
                });
            }
            "item.started" => {
                if let Some(item) = obj.get("item").and_then(Value::as_object) {
                    self.handle_item_started(item, events);
                }
            }
            "item.updated" => {
                if let Some(item) = obj.get("item").and_then(Value::as_object) {
                    self.handle_item_updated(item, events);
                }
            }
            "item.completed" => {
                if let Some(item) = obj.get("item").and_then(Value::as_object) {
                    self.handle_item_completed(item, events);
                }
            }
            "turn.completed" => {
                if let Some(usage_obj) = obj.get("usage").and_then(Value::as_object) {
                    let usage = parse_codex_usage(usage_obj);
                    if !usage.is_empty() {
                        events.push(AgentEvent::Usage { usage });
                    }
                }
                let turn_id = non_empty_str(obj, "turn_id")
                    .map(str::to_owned)
                    .or_else(|| self.current_turn_id.take());
                let resume_handle = self.resume_handle().map(Box::new);
                events.push(AgentEvent::TurnFinished {
                    turn_id,
                    reason: TurnFinishReason::Completed,
                    resume_handle,
                });
                self.reset_turn();
            }
            "turn.failed" => {
                let message = obj
                    .get("error")
                    .and_then(|err| match err {
                        Value::String(text) if !text.is_empty() => Some(text.as_str()),
                        Value::Object(map) => non_empty_str(map, "message"),
                        _ => None,
                    })
                    .unwrap_or("Codex turn failed")
                    .to_owned();
                events.push(AgentEvent::Error {
                    code: "turn_failed".to_owned(),
                    message,
                    retryable: false,
                });
                let turn_id = self.current_turn_id.take();
                let resume_handle = self.resume_handle().map(Box::new);
                events.push(AgentEvent::TurnFinished {
                    turn_id,
                    reason: TurnFinishReason::Error,
                    resume_handle,
                });
                self.reset_turn();
            }
            "error" => {
                let message = non_empty_str(obj, "message")
                    .or_else(|| {
                        obj.get("error")
                            .and_then(Value::as_object)
                            .and_then(|err| non_empty_str(err, "message"))
                    })
                    .unwrap_or("Codex stream error")
                    .to_owned();
                events.push(AgentEvent::Error {
                    code: "codex_error".to_owned(),
                    message,
                    retryable: false,
                });
            }
            _ => {}
        }
    }

    fn handle_item_started(&mut self, item: &Map<String, Value>, events: &mut Vec<AgentEvent>) {
        let Some(item_type) = non_empty_str(item, "type") else {
            return;
        };
        if !is_codex_tool_item(item_type) {
            return;
        }
        let call_id = item_id(item);
        if !self.started_tools.insert(call_id.clone()) {
            return;
        }
        let name = codex_tool_name(item_type, item);
        let arguments = codex_tool_arguments(item);
        events.push(AgentEvent::ToolCallStarted {
            call_id,
            name,
            arguments,
        });
    }

    fn handle_item_updated(&mut self, item: &Map<String, Value>, events: &mut Vec<AgentEvent>) {
        let Some(item_type) = non_empty_str(item, "type") else {
            return;
        };
        let id = item_id(item);
        match item_type {
            "agent_message" | "agentMessage" => {
                if let Some(text) = codex_item_text(item)
                    && let Some(delta) =
                        compute_suffix_delta(&mut self.streamed_text_len, &id, &text)
                {
                    events.push(AgentEvent::TextDelta {
                        text: delta,
                        block_index: None,
                    });
                }
            }
            "reasoning" => {
                if let Some(text) = codex_item_text(item)
                    && let Some(delta) =
                        compute_suffix_delta(&mut self.streamed_text_len, &id, &text)
                {
                    events.push(AgentEvent::ThinkingDelta {
                        text: delta,
                        block_index: None,
                    });
                }
            }
            ty if is_codex_tool_item(ty) => {
                if let Some(output) = codex_tool_output(item)
                    && let Some(delta) =
                        compute_suffix_delta(&mut self.streamed_tool_len, &id, &output)
                {
                    events.push(AgentEvent::ToolCallDelta {
                        call_id: id,
                        arguments_delta: None,
                        output_delta: Some(delta),
                    });
                }
            }
            _ => {}
        }
    }

    fn handle_item_completed(&mut self, item: &Map<String, Value>, events: &mut Vec<AgentEvent>) {
        let Some(item_type) = non_empty_str(item, "type") else {
            return;
        };
        let id = item_id(item);
        match item_type {
            "agent_message" | "agentMessage" => {
                if !self.streamed_deltas.contains(&id)
                    && let Some(text) = codex_item_text(item)
                    && let Some(delta) =
                        compute_suffix_delta(&mut self.streamed_text_len, &id, &text)
                {
                    events.push(AgentEvent::TextDelta {
                        text: delta,
                        block_index: None,
                    });
                }
            }
            "reasoning" => {
                if !self.streamed_deltas.contains(&id)
                    && let Some(text) = codex_item_text(item)
                    && let Some(delta) =
                        compute_suffix_delta(&mut self.streamed_text_len, &id, &text)
                {
                    events.push(AgentEvent::ThinkingDelta {
                        text: delta,
                        block_index: None,
                    });
                }
            }
            ty if is_codex_tool_item(ty) => {
                let name = codex_tool_name(ty, item);
                if self.started_tools.insert(id.clone()) {
                    events.push(AgentEvent::ToolCallStarted {
                        call_id: id.clone(),
                        name: name.clone(),
                        arguments: codex_tool_arguments(item),
                    });
                }
                let exit_code = item
                    .get("exit_code")
                    .or_else(|| item.get("exitCode"))
                    .and_then(Value::as_i64);
                let status = non_empty_str(item, "status");
                let is_error = exit_code.is_some_and(|code| code != 0)
                    || matches!(status, Some("failed" | "error" | "declined"));
                events.push(AgentEvent::ToolCallFinished {
                    call_id: id,
                    name: Some(name),
                    output: codex_tool_output(item),
                    is_error,
                });
            }
            _ => {}
        }
    }
}

fn is_codex_tool_item(item_type: &str) -> bool {
    matches!(
        item_type,
        "command_execution"
            | "commandExecution"
            | "file_change"
            | "fileChange"
            | "mcp_tool_call"
            | "mcpToolCall"
            | "web_search"
            | "webSearch"
            | "function_call"
    )
}

fn item_id(item: &Map<String, Value>) -> String {
    non_empty_str(item, "id")
        .or_else(|| non_empty_str(item, "call_id"))
        .or_else(|| non_empty_str(item, "callId"))
        .unwrap_or("codex-item")
        .to_owned()
}

fn codex_tool_name(item_type: &str, item: &Map<String, Value>) -> String {
    if let Some(tool) = non_empty_str(item, "tool").or_else(|| non_empty_str(item, "name")) {
        return tool.to_owned();
    }
    match item_type {
        "command_execution" | "commandExecution" => "shell".to_owned(),
        "file_change" | "fileChange" => "apply_patch".to_owned(),
        "mcp_tool_call" | "mcpToolCall" => "mcp_tool".to_owned(),
        "web_search" | "webSearch" => "web_search".to_owned(),
        other => other.to_owned(),
    }
}

fn codex_tool_arguments(item: &Map<String, Value>) -> Option<Box<Value>> {
    if let Some(args) = item.get("arguments").or_else(|| item.get("input")) {
        return Some(Box::new(args.clone()));
    }
    if let Some(command) = item.get("command") {
        return Some(Box::new(serde_json::json!({ "command": command })));
    }
    if let Some(changes) = item.get("changes") {
        return Some(Box::new(serde_json::json!({ "changes": changes })));
    }
    None
}

fn codex_item_text(item: &Map<String, Value>) -> Option<String> {
    if let Some(text) = non_empty_str(item, "text") {
        return Some(text.to_owned());
    }
    item.get("content")
        .or_else(|| item.get("summary"))
        .and_then(extract_text_content)
}

fn codex_tool_output(item: &Map<String, Value>) -> Option<String> {
    for key in ["aggregated_output", "aggregatedOutput", "output", "result"] {
        if let Some(val) = item.get(key)
            && let Some(text) = extract_text_content(val)
        {
            return Some(text);
        }
    }
    None
}

fn parse_codex_usage(usage: &Map<String, Value>) -> TokenUsage {
    TokenUsage {
        input_tokens: value_as_u64(
            usage
                .get("input_tokens")
                .or_else(|| usage.get("inputTokens")),
        ),
        output_tokens: value_as_u64(
            usage
                .get("output_tokens")
                .or_else(|| usage.get("outputTokens")),
        ),
        cache_read_tokens: value_as_u64(
            usage
                .get("cached_input_tokens")
                .or_else(|| usage.get("cachedInputTokens")),
        ),
        cache_write_tokens: 0,
        reasoning_tokens: value_as_u64(
            usage
                .get("reasoning_output_tokens")
                .or_else(|| usage.get("reasoningOutputTokens")),
        ),
        cost_usd: None,
    }
}

fn compute_suffix_delta(
    seen: &mut HashMap<String, usize>,
    item_id: &str,
    full_text: &str,
) -> Option<String> {
    let previous = seen.get(item_id).copied().unwrap_or(0);
    if previous >= full_text.len() || !full_text.is_char_boundary(previous) {
        return None;
    }
    seen.insert(item_id.to_owned(), full_text.len());
    let suffix = &full_text[previous..];
    (!suffix.is_empty()).then(|| suffix.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_exec_jsonl_lifecycle_and_incremental_updates() {
        let mut parser = CodexStreamParser::new();

        let lines = [
            r#"{"type":"thread.started","thread_id":"thr-101"}"#,
            r#"{"type":"turn.started","turn_id":"turn-1","model":"gpt-5.3-codex"}"#,
            r#"{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"cargo fmt --check"}}"#,
            r#"{"type":"item.updated","item":{"id":"cmd-1","type":"command_execution","aggregated_output":"Checking..."}}"#,
            r#"{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","aggregated_output":"Checking... OK","exit_code":0,"status":"completed"}}"#,
            r#"{"type":"item.updated","item":{"id":"msg-1","type":"agent_message","text":"All "}}"#,
            r#"{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"All formatted."}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":500,"cached_input_tokens":200,"output_tokens":45}}"#,
        ];

        let mut all = Vec::new();
        for line in lines {
            all.extend(parser.parse_line(line).unwrap());
        }

        assert_eq!(parser.thread_id(), Some("thr-101"));
        assert!(matches!(
            &all[0],
            AgentEvent::SessionStateChanged {
                state: SessionLifecycleState::Ready,
                ..
            }
        ));
        assert!(matches!(
            &all[1],
            AgentEvent::TurnStarted {
                turn_id: Some(id),
                resume_handle: Some(handle),
                ..
            } if id == "turn-1" && handle.native_id == "thr-101"
        ));
        assert!(matches!(
            &all[2],
            AgentEvent::ToolCallStarted { call_id, name, .. } if call_id == "cmd-1" && name == "shell"
        ));
        assert!(matches!(
            &all[3],
            AgentEvent::ToolCallDelta {
                call_id,
                output_delta: Some(delta),
                ..
            } if call_id == "cmd-1" && delta == "Checking..."
        ));
        assert!(matches!(
            &all[4],
            AgentEvent::ToolCallFinished {
                call_id,
                is_error: false,
                ..
            } if call_id == "cmd-1"
        ));
        // Incremental text suffix: "All " followed only by "formatted."
        assert_eq!(
            all[5],
            AgentEvent::TextDelta {
                text: "All ".to_owned(),
                block_index: None,
            }
        );
        assert_eq!(
            all[6],
            AgentEvent::TextDelta {
                text: "formatted.".to_owned(),
                block_index: None,
            }
        );
        assert!(matches!(
            &all[7],
            AgentEvent::Usage { usage } if usage.input_tokens == 500 && usage.cache_read_tokens == 200
        ));
        assert!(matches!(
            &all[8],
            AgentEvent::TurnFinished {
                reason: TurnFinishReason::Completed,
                ..
            }
        ));
    }

    #[test]
    fn parses_codex_app_server_notifications_and_approval_requests() {
        let mut parser = CodexStreamParser::new();

        let started = r#"{"method":"thread/started","params":{"thread":{"id":"thr-app-7"}}}"#;
        let _ = parser.parse_line(started).unwrap();
        assert_eq!(parser.thread_id(), Some("thr-app-7"));

        let delta =
            r#"{"method":"item/agentMessage/delta","params":{"itemId":"m1","delta":"Hi!"}}"#;
        assert_eq!(
            parser.parse_line(delta).unwrap(),
            vec![AgentEvent::TextDelta {
                text: "Hi!".to_owned(),
                block_index: None,
            }]
        );

        // Already-streamed item/completed must not re-emit text.
        let completed = r#"{"method":"item/completed","params":{"item":{"id":"m1","type":"agentMessage","text":"Hi!"}}}"#;
        assert!(parser.parse_line(completed).unwrap().is_empty());

        let approval = r#"{"id":14,"method":"item/commandExecution/requestApproval","params":{"command":"rm -rf target","reason":"Clean build dir"}}"#;
        let evs = parser.parse_line(approval).unwrap();
        assert_eq!(evs.len(), 2);
        assert!(matches!(
            &evs[0],
            AgentEvent::ApprovalRequested {
                request_id,
                kind: ApprovalKind::CommandExecution,
                summary,
                ..
            } if request_id == "14" && summary == "Clean build dir"
        ));
    }
}
