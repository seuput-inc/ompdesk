//! Pure-Rust NDJSON parser for Claude Code `--output-format stream-json`.
//!
//! Handles both `--include-partial-messages` (`stream_event` wrapping Anthropic Messages SSE
//! deltas) and non-partial `assistant` / `user` / `control_request` / `result` envelopes without
//! duplicating streamed blocks.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::{
    extract_text_content, map_anthropic_stop_reason, non_empty_str, parse_anthropic_usage,
    value_as_u32,
};
use crate::agent::types::{
    AgentError, AgentEvent, ApprovalKind, BackendId, ProviderCliKind, ResumeHandle,
    SessionLifecycleState, TurnFinishReason,
};

/// Stateful line-by-line parser for Claude Code `stream-json` stdout.
#[derive(Debug, Default)]
pub struct ClaudeStreamParser {
    session_id: Option<String>,
    current_turn_id: Option<String>,
    turn_open: bool,
    last_stop_reason: Option<TurnFinishReason>,
    active_tool_calls: HashMap<u32, String>,
    tool_names: HashMap<String, String>,
    started_tool_ids: HashSet<String>,
    streamed_text_in_msg: bool,
    streamed_thinking_in_msg: bool,
    last_message_id: Option<String>,
}

impl ClaudeStreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn resume_handle(&self) -> Option<ResumeHandle> {
        self.session_id
            .as_deref()
            .map(|id| ResumeHandle::new(BackendId::ProviderCli(ProviderCliKind::ClaudeCode), id))
    }

    /// Resets per-turn streaming state while retaining `session_id` and tool-name lookup history.
    pub fn reset_turn(&mut self) {
        self.current_turn_id = None;
        self.turn_open = false;
        self.last_stop_reason = None;
        self.active_tool_calls.clear();
        self.started_tool_ids.clear();
        self.streamed_text_in_msg = false;
        self.streamed_thinking_in_msg = false;
        self.last_message_id = None;
    }

    /// Parses one NDJSON line from Claude Code stdout into zero or more normalized events.
    pub fn parse_line(&mut self, line: &str) -> Result<Vec<AgentEvent>, AgentError> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let value: Value = serde_json::from_str(trimmed)?;
        let Some(obj) = value.as_object() else {
            return Err(AgentError::Protocol {
                message: "expected JSON object in Claude stream-json line".to_owned(),
            });
        };

        if let Some(session_id) = non_empty_str(obj, "session_id") {
            self.session_id = Some(session_id.to_owned());
        }

        let mut events = Vec::new();
        match non_empty_str(obj, "type") {
            Some("system") => self.handle_system(obj, &mut events),
            Some("stream_event") => self.handle_stream_event(obj, &mut events),
            Some("assistant") => self.handle_assistant(obj, &mut events),
            Some("user") => self.handle_user(obj, &mut events),
            Some("control_request") => self.handle_control_request(obj, &mut events),
            Some("result") => self.handle_result(obj, &mut events),
            _ => {}
        }
        Ok(events)
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
        self.current_turn_id = turn_id.clone();
        events.push(AgentEvent::TurnStarted {
            turn_id,
            model,
            resume_handle: self.resume_handle().map(Box::new),
        });
    }

    fn handle_system(&mut self, obj: &Map<String, Value>, events: &mut Vec<AgentEvent>) {
        match non_empty_str(obj, "subtype") {
            Some("init") => {
                let model = non_empty_str(obj, "model").map(str::to_owned);
                events.push(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Ready,
                    detail: model,
                });
            }
            Some("status") => {
                let status = non_empty_str(obj, "status").map(str::to_owned);
                events.push(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Running,
                    detail: status,
                });
            }
            Some("api_retry") => {
                let message = non_empty_str(obj, "error")
                    .or_else(|| non_empty_str(obj, "message"))
                    .unwrap_or("retrying API request")
                    .to_owned();
                events.push(AgentEvent::Error {
                    code: "api_retry".to_owned(),
                    message,
                    retryable: true,
                });
            }
            _ => {}
        }
    }

    fn handle_stream_event(&mut self, obj: &Map<String, Value>, events: &mut Vec<AgentEvent>) {
        let Some(event) = obj.get("event").and_then(Value::as_object) else {
            return;
        };
        match non_empty_str(event, "type") {
            Some("message_start") => {
                let message = event.get("message").and_then(Value::as_object);
                let msg_id = message
                    .and_then(|msg| non_empty_str(msg, "id"))
                    .map(str::to_owned);
                let model = message
                    .and_then(|msg| non_empty_str(msg, "model"))
                    .map(str::to_owned);

                self.streamed_text_in_msg = false;
                self.streamed_thinking_in_msg = false;
                self.active_tool_calls.clear();
                self.last_message_id = msg_id.clone();

                self.ensure_turn_open(msg_id, model, events);

                if let Some(usage_obj) = message
                    .and_then(|msg| msg.get("usage"))
                    .and_then(Value::as_object)
                {
                    let usage = parse_anthropic_usage(usage_obj);
                    if !usage.is_empty() {
                        events.push(AgentEvent::Usage { usage });
                    }
                }
            }
            Some("content_block_start") => {
                let index = value_as_u32(event.get("index"));
                let Some(block) = event.get("content_block").and_then(Value::as_object) else {
                    return;
                };
                if non_empty_str(block, "type") == Some("tool_use")
                    && let (Some(id), Some(name)) =
                        (non_empty_str(block, "id"), non_empty_str(block, "name"))
                {
                    let call_id = id.to_owned();
                    let tool_name = name.to_owned();
                    if let Some(idx) = index {
                        self.active_tool_calls.insert(idx, call_id.clone());
                    }
                    self.tool_names.insert(call_id.clone(), tool_name.clone());
                    self.started_tool_ids.insert(call_id.clone());
                    self.ensure_turn_open(None, None, events);
                    events.push(AgentEvent::ToolCallStarted {
                        call_id,
                        name: tool_name,
                        arguments: None,
                    });
                }
            }
            Some("content_block_delta") => {
                let index = value_as_u32(event.get("index"));
                let Some(delta) = event.get("delta").and_then(Value::as_object) else {
                    return;
                };
                match non_empty_str(delta, "type") {
                    Some("text_delta") => {
                        if let Some(text) = non_empty_str(delta, "text") {
                            self.ensure_turn_open(None, None, events);
                            self.streamed_text_in_msg = true;
                            events.push(AgentEvent::TextDelta {
                                text: text.to_owned(),
                                block_index: index,
                            });
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(thinking) = non_empty_str(delta, "thinking") {
                            self.ensure_turn_open(None, None, events);
                            self.streamed_thinking_in_msg = true;
                            events.push(AgentEvent::ThinkingDelta {
                                text: thinking.to_owned(),
                                block_index: index,
                            });
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(partial) = non_empty_str(delta, "partial_json") {
                            let call_id = index
                                .and_then(|idx| self.active_tool_calls.get(&idx).cloned())
                                .unwrap_or_else(|| format!("block-{}", index.unwrap_or_default()));
                            events.push(AgentEvent::ToolCallDelta {
                                call_id,
                                arguments_delta: Some(partial.to_owned()),
                                output_delta: None,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                if let Some(index) = value_as_u32(event.get("index")) {
                    self.active_tool_calls.remove(&index);
                }
            }
            Some("message_delta") => {
                if let Some(delta) = event.get("delta").and_then(Value::as_object)
                    && let Some(reason) = non_empty_str(delta, "stop_reason")
                {
                    self.last_stop_reason = Some(map_anthropic_stop_reason(Some(reason)));
                }
                if let Some(usage_obj) = event.get("usage").and_then(Value::as_object) {
                    let usage = parse_anthropic_usage(usage_obj);
                    if !usage.is_empty() {
                        events.push(AgentEvent::Usage { usage });
                    }
                }
            }
            Some("error") => {
                let err_obj = event.get("error").and_then(Value::as_object);
                let code = err_obj
                    .and_then(|err| non_empty_str(err, "type"))
                    .unwrap_or("stream_error")
                    .to_owned();
                let message = err_obj
                    .and_then(|err| non_empty_str(err, "message"))
                    .unwrap_or("Claude stream error")
                    .to_owned();
                let retryable = matches!(code.as_str(), "overloaded_error" | "rate_limit_error");
                events.push(AgentEvent::Error {
                    code,
                    message,
                    retryable,
                });
            }
            _ => {}
        }
    }

    fn handle_assistant(&mut self, obj: &Map<String, Value>, events: &mut Vec<AgentEvent>) {
        if let Some(err_code) = non_empty_str(obj, "error") {
            let message = obj
                .get("message")
                .and_then(Value::as_object)
                .and_then(|msg| msg.get("content"))
                .and_then(extract_text_content)
                .unwrap_or_else(|| err_code.to_owned());
            let retryable = matches!(err_code, "rate_limit" | "overloaded" | "server_error");
            events.push(AgentEvent::Error {
                code: err_code.to_owned(),
                message,
                retryable,
            });
            return;
        }

        let Some(message) = obj.get("message").and_then(Value::as_object) else {
            return;
        };
        let msg_id = non_empty_str(message, "id").map(str::to_owned);
        let model = non_empty_str(message, "model").map(str::to_owned);
        if msg_id.is_some() && msg_id != self.last_message_id {
            self.streamed_text_in_msg = false;
            self.streamed_thinking_in_msg = false;
            self.last_message_id = msg_id.clone();
        }

        self.ensure_turn_open(msg_id, model, events);

        if let Some(blocks) = message.get("content").and_then(Value::as_array) {
            for (index, block) in blocks.iter().enumerate() {
                let Some(part) = block.as_object() else {
                    continue;
                };
                let block_index = u32::try_from(index).ok();
                match non_empty_str(part, "type") {
                    Some("text") => {
                        if !self.streamed_text_in_msg
                            && let Some(text) = non_empty_str(part, "text")
                        {
                            events.push(AgentEvent::TextDelta {
                                text: text.to_owned(),
                                block_index,
                            });
                        }
                    }
                    Some("thinking") => {
                        if !self.streamed_thinking_in_msg
                            && let Some(thinking) = non_empty_str(part, "thinking")
                        {
                            events.push(AgentEvent::ThinkingDelta {
                                text: thinking.to_owned(),
                                block_index,
                            });
                        }
                    }
                    Some("tool_use") => {
                        if let (Some(id), Some(name)) =
                            (non_empty_str(part, "id"), non_empty_str(part, "name"))
                        {
                            let call_id = id.to_owned();
                            let tool_name = name.to_owned();
                            self.tool_names.insert(call_id.clone(), tool_name.clone());
                            if self.started_tool_ids.insert(call_id.clone()) {
                                let arguments = part.get("input").cloned().map(Box::new);
                                events.push(AgentEvent::ToolCallStarted {
                                    call_id,
                                    name: tool_name,
                                    arguments,
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        self.streamed_text_in_msg = false;
        self.streamed_thinking_in_msg = false;
    }

    fn handle_user(&mut self, obj: &Map<String, Value>, events: &mut Vec<AgentEvent>) {
        let Some(blocks) = obj
            .get("message")
            .and_then(Value::as_object)
            .and_then(|msg| msg.get("content"))
            .and_then(Value::as_array)
        else {
            return;
        };

        for block in blocks {
            let Some(part) = block.as_object() else {
                continue;
            };
            if non_empty_str(part, "type") != Some("tool_result") {
                continue;
            }
            let Some(tool_use_id) = non_empty_str(part, "tool_use_id") else {
                continue;
            };
            let is_error = part
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let output = part.get("content").and_then(extract_text_content);
            let name = self.tool_names.get(tool_use_id).cloned();
            events.push(AgentEvent::ToolCallFinished {
                call_id: tool_use_id.to_owned(),
                name,
                output,
                is_error,
            });
        }
    }

    fn handle_control_request(&mut self, obj: &Map<String, Value>, events: &mut Vec<AgentEvent>) {
        let Some(request_id) = non_empty_str(obj, "request_id") else {
            return;
        };
        let Some(request) = obj.get("request").and_then(Value::as_object) else {
            return;
        };
        let subtype = non_empty_str(request, "subtype");
        let tool_name = non_empty_str(request, "tool_name").map(str::to_owned);
        if subtype != Some("can_use_tool") && tool_name.is_none() {
            return;
        }
        let kind = match tool_name.as_deref() {
            Some("Bash" | "bash") => ApprovalKind::CommandExecution,
            Some("Edit" | "Write" | "MultiEdit" | "NotebookEdit") => ApprovalKind::FileEdit,
            Some("AskUserQuestion") => ApprovalKind::UserQuestion,
            Some(_) => ApprovalKind::ToolExecution,
            None => ApprovalKind::Generic,
        };
        let summary = non_empty_str(request, "description")
            .or_else(|| non_empty_str(request, "message"))
            .map(str::to_owned)
            .unwrap_or_else(|| match &tool_name {
                Some(name) => format!("Approve tool {name}"),
                None => "Approval requested".to_owned(),
            });
        let payload = request.get("input").cloned().map(Box::new);

        events.push(AgentEvent::ApprovalRequested {
            request_id: request_id.to_owned(),
            tool_name: tool_name.clone(),
            summary,
            kind,
            payload,
        });
        events.push(AgentEvent::SessionStateChanged {
            state: SessionLifecycleState::WaitingForApproval,
            detail: tool_name,
        });
    }

    fn handle_result(&mut self, obj: &Map<String, Value>, events: &mut Vec<AgentEvent>) {
        let mut usage = obj
            .get("usage")
            .and_then(Value::as_object)
            .map(parse_anthropic_usage)
            .unwrap_or_default();
        if let Some(cost) = obj.get("total_cost_usd").and_then(Value::as_f64) {
            usage.cost_usd = Some(cost);
        }
        if !usage.is_empty() {
            events.push(AgentEvent::Usage { usage });
        }

        let is_error = obj
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let subtype = non_empty_str(obj, "subtype");
        if is_error {
            let message = non_empty_str(obj, "result")
                .or_else(|| non_empty_str(obj, "error"))
                .unwrap_or("Claude turn failed")
                .to_owned();
            events.push(AgentEvent::Error {
                code: subtype.unwrap_or("result_error").to_owned(),
                message,
                retryable: false,
            });
        }

        let reason = if is_error {
            TurnFinishReason::Error
        } else {
            match subtype {
                Some("error_max_turns") => TurnFinishReason::MaxTokens,
                Some("interrupted" | "aborted") => TurnFinishReason::Interrupted,
                Some("success") => TurnFinishReason::Completed,
                _ => self.last_stop_reason.unwrap_or(TurnFinishReason::Completed),
            }
        };

        let turn_id = self.current_turn_id.take();
        let resume_handle = self.resume_handle().map(Box::new);
        events.push(AgentEvent::TurnFinished {
            turn_id,
            reason,
            resume_handle,
        });
        self.reset_turn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_streaming_claude_turn_without_duplicating_final_assistant_blocks() {
        let mut parser = ClaudeStreamParser::new();

        let init = r#"{"type":"system","subtype":"init","session_id":"sess-42","model":"claude-sonnet-4-6"}"#;
        let evs = parser.parse_line(init).unwrap();
        assert_eq!(
            evs,
            vec![AgentEvent::SessionStateChanged {
                state: SessionLifecycleState::Ready,
                detail: Some("claude-sonnet-4-6".to_owned()),
            }]
        );
        assert_eq!(parser.session_id(), Some("sess-42"));

        let msg_start = r#"{"type":"stream_event","session_id":"sess-42","event":{"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":120,"cache_read_input_tokens":30}}}}"#;
        let evs = parser.parse_line(msg_start).unwrap();
        assert_eq!(evs.len(), 2);
        assert!(matches!(
            &evs[0],
            AgentEvent::TurnStarted {
                turn_id: Some(id),
                model: Some(model),
                resume_handle: Some(handle),
            } if id == "msg_1" && model == "claude-sonnet-4-6" && handle.native_id == "sess-42"
        ));

        let thinking = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Inspecting Cargo.toml"}}}"#;
        assert_eq!(
            parser.parse_line(thinking).unwrap(),
            vec![AgentEvent::ThinkingDelta {
                text: "Inspecting Cargo.toml".to_owned(),
                block_index: Some(0),
            }]
        );

        let text = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Checking..."}}}"#;
        assert_eq!(
            parser.parse_line(text).unwrap(),
            vec![AgentEvent::TextDelta {
                text: "Checking...".to_owned(),
                block_index: Some(1),
            }]
        );

        let tool_start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read"}}}"#;
        assert_eq!(
            parser.parse_line(tool_start).unwrap(),
            vec![AgentEvent::ToolCallStarted {
                call_id: "toolu_1".to_owned(),
                name: "Read".to_owned(),
                arguments: None,
            }]
        );

        let tool_delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"Cargo.toml\"}"}}}"#;
        assert_eq!(
            parser.parse_line(tool_delta).unwrap(),
            vec![AgentEvent::ToolCallDelta {
                call_id: "toolu_1".to_owned(),
                arguments_delta: Some("{\"path\":\"Cargo.toml\"}".to_owned()),
                output_delta: None,
            }]
        );

        // Complete assistant echo for the same message must NOT duplicate already-streamed items.
        let assistant_echo = r#"{"type":"assistant","session_id":"sess-42","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"Inspecting Cargo.toml"},{"type":"text","text":"Checking..."},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"path":"Cargo.toml"}}]}}"#;
        assert!(parser.parse_line(assistant_echo).unwrap().is_empty());

        let tool_result = r#"{"type":"user","session_id":"sess-42","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"[workspace]"}],"is_error":false}]}}"#;
        assert_eq!(
            parser.parse_line(tool_result).unwrap(),
            vec![AgentEvent::ToolCallFinished {
                call_id: "toolu_1".to_owned(),
                name: Some("Read".to_owned()),
                output: Some("[workspace]".to_owned()),
                is_error: false,
            }]
        );

        let result = r#"{"type":"result","subtype":"success","is_error":false,"session_id":"sess-42","total_cost_usd":0.012,"usage":{"input_tokens":120,"output_tokens":55,"cache_read_input_tokens":30}}"#;
        let evs = parser.parse_line(result).unwrap();
        assert_eq!(evs.len(), 2);
        assert!(matches!(
            &evs[0],
            AgentEvent::Usage { usage } if usage.output_tokens == 55 && usage.cost_usd == Some(0.012)
        ));
        assert!(matches!(
            &evs[1],
            AgentEvent::TurnFinished {
                reason: TurnFinishReason::Completed,
                resume_handle: Some(handle),
                ..
            } if handle.native_id == "sess-42"
        ));
    }

    #[test]
    fn parses_permission_control_request_and_rejects_invalid_json() {
        let mut parser = ClaudeStreamParser::new();
        let req = r#"{"type":"control_request","request_id":"perm-9","request":{"subtype":"can_use_tool","tool_name":"Bash","description":"Run cargo fmt","input":{"command":"cargo fmt --check"}}}"#;
        let evs = parser.parse_line(req).unwrap();
        assert_eq!(
            evs,
            vec![
                AgentEvent::ApprovalRequested {
                    request_id: "perm-9".to_owned(),
                    tool_name: Some("Bash".to_owned()),
                    summary: "Run cargo fmt".to_owned(),
                    kind: ApprovalKind::CommandExecution,
                    payload: Some(Box::new(json!({ "command": "cargo fmt --check" }))),
                },
                AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::WaitingForApproval,
                    detail: Some("Bash".to_owned()),
                },
            ]
        );

        assert!(parser.parse_line("   ").unwrap().is_empty());
        assert_eq!(
            parser.parse_line("not json").unwrap_err().code(),
            "protocol"
        );
        assert_eq!(parser.parse_line("[1, 2]").unwrap_err().code(), "protocol");
    }
}
