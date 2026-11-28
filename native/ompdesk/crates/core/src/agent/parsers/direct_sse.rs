//! Pure-Rust incremental SSE framer and parser for Direct LLM API streaming.
//!
//! Normalizes Server-Sent Events from:
//! - **Anthropic Messages API** (`/v1/messages`)
//! - **OpenAI Responses API** (`/v1/responses`)
//! - **OpenAI Chat Completions SSE** (used by OpenRouter and OpenAI-compatible gateways)

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::{
    map_anthropic_stop_reason, non_empty_str, parse_anthropic_usage, value_as_u32, value_as_u64,
};
use crate::agent::types::{
    AgentError, AgentEvent, BackendId, DirectApiProvider, ResumeHandle, TokenUsage,
    TurnFinishReason,
};

/// One decoded Server-Sent Event frame (dispatched on a blank line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub event: Option<String>,
    pub data: String,
    pub id: Option<String>,
}

/// Incremental W3C SSE byte-stream decoder safe across arbitrary chunk and UTF-8 splits.
#[derive(Debug, Default)]
pub struct SseFrameDecoder {
    line_buf: Vec<u8>,
    event: Option<String>,
    data_lines: Vec<String>,
    id: Option<String>,
}

impl SseFrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds arbitrary bytes from an HTTP chunk and returns every completed [`SseFrame`].
    pub fn push_bytes(&mut self, chunk: &[u8]) -> Result<Vec<SseFrame>, AgentError> {
        let mut frames = Vec::new();
        for &byte in chunk {
            if byte == b'\n' {
                if self.line_buf.last() == Some(&b'\r') {
                    self.line_buf.pop();
                }
                let raw = std::mem::take(&mut self.line_buf);
                let line = String::from_utf8(raw).map_err(|error| AgentError::Protocol {
                    message: format!("invalid UTF-8 in SSE stream: {error}"),
                })?;
                if let Some(frame) = self.process_line(&line) {
                    frames.push(frame);
                }
            } else {
                self.line_buf.push(byte);
            }
        }
        Ok(frames)
    }

    pub fn push_str(&mut self, chunk: &str) -> Result<Vec<SseFrame>, AgentError> {
        self.push_bytes(chunk.as_bytes())
    }

    /// Flushes any trailing unterminated line and pending event data at EOF.
    pub fn finish(&mut self) -> Result<Vec<SseFrame>, AgentError> {
        let mut frames = Vec::new();
        if !self.line_buf.is_empty() {
            if self.line_buf.last() == Some(&b'\r') {
                self.line_buf.pop();
            }
            let raw = std::mem::take(&mut self.line_buf);
            let line = String::from_utf8(raw).map_err(|error| AgentError::Protocol {
                message: format!("invalid UTF-8 at SSE EOF: {error}"),
            })?;
            if let Some(frame) = self.process_line(&line) {
                frames.push(frame);
            }
        }
        if let Some(frame) = self.flush_frame() {
            frames.push(frame);
        }
        Ok(frames)
    }

    fn process_line(&mut self, line: &str) -> Option<SseFrame> {
        if line.is_empty() {
            return self.flush_frame();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, raw_value) = match line.split_once(':') {
            Some((field, rest)) => (field, rest.strip_prefix(' ').unwrap_or(rest)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(raw_value.to_owned()),
            "data" => self.data_lines.push(raw_value.to_owned()),
            "id" if !raw_value.contains('\0') => self.id = Some(raw_value.to_owned()),
            _ => {}
        }
        None
    }

    fn flush_frame(&mut self) -> Option<SseFrame> {
        let event = self.event.take();
        if self.data_lines.is_empty() {
            return None;
        }
        let data = std::mem::take(&mut self.data_lines).join("\n");
        Some(SseFrame {
            event,
            data,
            id: self.id.clone(),
        })
    }
}

/// Stateful streaming parser converting Direct LLM API SSE bytes into [`AgentEvent`].
#[derive(Debug)]
pub struct DirectSseParser {
    provider: DirectApiProvider,
    decoder: SseFrameDecoder,
    turn_id: Option<String>,
    turn_started: bool,
    turn_finished: bool,
    stop_reason: Option<TurnFinishReason>,
    pending_usage: TokenUsage,
    anthropic_tools: HashMap<u32, String>,
    openai_item_calls: HashMap<String, String>,
    chat_tool_calls: HashMap<u32, String>,
    saw_tool_call: bool,
}

impl DirectSseParser {
    pub fn new(provider: DirectApiProvider) -> Self {
        Self {
            provider,
            decoder: SseFrameDecoder::new(),
            turn_id: None,
            turn_started: false,
            turn_finished: false,
            stop_reason: None,
            pending_usage: TokenUsage::default(),
            anthropic_tools: HashMap::new(),
            openai_item_calls: HashMap::new(),
            chat_tool_calls: HashMap::new(),
            saw_tool_call: false,
        }
    }

    pub fn provider(&self) -> DirectApiProvider {
        self.provider
    }

    pub fn resume_handle(&self) -> Option<ResumeHandle> {
        self.turn_id
            .as_deref()
            .map(|id| ResumeHandle::new(BackendId::DirectApi(self.provider), id))
    }

    pub fn feed_bytes(&mut self, chunk: &[u8]) -> Result<Vec<AgentEvent>, AgentError> {
        let frames = self.decoder.push_bytes(chunk)?;
        self.parse_frames(&frames)
    }

    pub fn feed_str(&mut self, chunk: &str) -> Result<Vec<AgentEvent>, AgentError> {
        let frames = self.decoder.push_str(chunk)?;
        self.parse_frames(&frames)
    }

    pub fn finish(&mut self) -> Result<Vec<AgentEvent>, AgentError> {
        let frames = self.decoder.finish()?;
        self.parse_frames(&frames)
    }

    pub fn feed_frame(&mut self, frame: &SseFrame) -> Result<Vec<AgentEvent>, AgentError> {
        let data = frame.data.trim();
        if data.is_empty() {
            return Ok(Vec::new());
        }
        if data == "[DONE]" {
            let mut events = Vec::new();
            if !self.turn_finished && self.turn_started {
                self.turn_finished = true;
                events.push(AgentEvent::TurnFinished {
                    turn_id: self.turn_id.clone(),
                    reason: self.stop_reason.unwrap_or(TurnFinishReason::Completed),
                    resume_handle: self.resume_handle().map(Box::new),
                });
            }
            return Ok(events);
        }

        let value: Value = serde_json::from_str(data)?;
        let Some(obj) = value.as_object() else {
            return Err(AgentError::Protocol {
                message: "expected JSON object in SSE data payload".to_owned(),
            });
        };

        let mut events = Vec::new();
        match self.provider {
            DirectApiProvider::Anthropic => {
                self.handle_anthropic(frame.event.as_deref(), obj, &mut events);
            }
            DirectApiProvider::OpenAi => {
                if obj.contains_key("choices") {
                    self.handle_chat_completions(obj, &mut events);
                } else {
                    self.handle_openai_responses(frame.event.as_deref(), obj, &mut events);
                }
            }
            DirectApiProvider::OpenRouter | DirectApiProvider::OpenAiCompatible => {
                let ev_type = non_empty_str(obj, "type").or(frame.event.as_deref());
                if ev_type.is_some_and(|ty| ty.starts_with("response.")) {
                    self.handle_openai_responses(frame.event.as_deref(), obj, &mut events);
                } else {
                    self.handle_chat_completions(obj, &mut events);
                }
            }
        }
        Ok(events)
    }

    fn parse_frames(&mut self, frames: &[SseFrame]) -> Result<Vec<AgentEvent>, AgentError> {
        let mut events = Vec::new();
        for frame in frames {
            events.extend(self.feed_frame(frame)?);
        }
        Ok(events)
    }

    fn handle_anthropic(
        &mut self,
        sse_event: Option<&str>,
        obj: &Map<String, Value>,
        events: &mut Vec<AgentEvent>,
    ) {
        let ev_type = non_empty_str(obj, "type").or(sse_event);
        match ev_type {
            Some("message_start") => {
                let message = obj.get("message").and_then(Value::as_object);
                let msg_id = message
                    .and_then(|msg| non_empty_str(msg, "id"))
                    .map(str::to_owned);
                let model = message
                    .and_then(|msg| non_empty_str(msg, "model"))
                    .map(str::to_owned);
                self.turn_id = msg_id.clone();
                self.turn_started = true;
                self.turn_finished = false;
                if let Some(usage_obj) = message
                    .and_then(|msg| msg.get("usage"))
                    .and_then(Value::as_object)
                {
                    self.pending_usage = parse_anthropic_usage(usage_obj);
                }
                events.push(AgentEvent::TurnStarted {
                    turn_id: msg_id,
                    model,
                    resume_handle: self.resume_handle().map(Box::new),
                });
            }
            Some("content_block_start") => {
                let index = value_as_u32(obj.get("index"));
                let Some(block) = obj.get("content_block").and_then(Value::as_object) else {
                    return;
                };
                if non_empty_str(block, "type") == Some("tool_use")
                    && let (Some(id), Some(name)) =
                        (non_empty_str(block, "id"), non_empty_str(block, "name"))
                {
                    let call_id = id.to_owned();
                    if let Some(idx) = index {
                        self.anthropic_tools.insert(idx, call_id.clone());
                    }
                    self.saw_tool_call = true;
                    events.push(AgentEvent::ToolCallStarted {
                        call_id,
                        name: name.to_owned(),
                        arguments: None,
                    });
                }
            }
            Some("content_block_delta") => {
                let index = value_as_u32(obj.get("index"));
                let Some(delta) = obj.get("delta").and_then(Value::as_object) else {
                    return;
                };
                match non_empty_str(delta, "type") {
                    Some("text_delta") => {
                        if let Some(text) = non_empty_str(delta, "text") {
                            events.push(AgentEvent::TextDelta {
                                text: text.to_owned(),
                                block_index: index,
                            });
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(thinking) = non_empty_str(delta, "thinking") {
                            events.push(AgentEvent::ThinkingDelta {
                                text: thinking.to_owned(),
                                block_index: index,
                            });
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(partial) = non_empty_str(delta, "partial_json") {
                            let call_id = index
                                .and_then(|idx| self.anthropic_tools.get(&idx).cloned())
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
                if let Some(index) = value_as_u32(obj.get("index")) {
                    self.anthropic_tools.remove(&index);
                }
            }
            Some("message_delta") => {
                if let Some(delta) = obj.get("delta").and_then(Value::as_object)
                    && let Some(reason) = non_empty_str(delta, "stop_reason")
                {
                    self.stop_reason = Some(map_anthropic_stop_reason(Some(reason)));
                }
                if let Some(usage_obj) = obj.get("usage").and_then(Value::as_object) {
                    let delta_usage = parse_anthropic_usage(usage_obj);
                    if delta_usage.input_tokens > 0 {
                        self.pending_usage.input_tokens = delta_usage.input_tokens;
                    }
                    if delta_usage.output_tokens > 0 {
                        self.pending_usage.output_tokens = delta_usage.output_tokens;
                    }
                    if delta_usage.cache_read_tokens > 0 {
                        self.pending_usage.cache_read_tokens = delta_usage.cache_read_tokens;
                    }
                    if delta_usage.cache_write_tokens > 0 {
                        self.pending_usage.cache_write_tokens = delta_usage.cache_write_tokens;
                    }
                    if !self.pending_usage.is_empty() {
                        events.push(AgentEvent::Usage {
                            usage: self.pending_usage.clone(),
                        });
                    }
                }
            }
            Some("message_stop") => {
                if !self.turn_finished {
                    self.turn_finished = true;
                    let fallback = if self.saw_tool_call {
                        TurnFinishReason::ToolUse
                    } else {
                        TurnFinishReason::Completed
                    };
                    events.push(AgentEvent::TurnFinished {
                        turn_id: self.turn_id.clone(),
                        reason: self.stop_reason.unwrap_or(fallback),
                        resume_handle: self.resume_handle().map(Box::new),
                    });
                }
            }
            Some("error") => {
                let err_obj = obj.get("error").and_then(Value::as_object);
                let code = err_obj
                    .and_then(|err| non_empty_str(err, "type"))
                    .unwrap_or("anthropic_error")
                    .to_owned();
                let message = err_obj
                    .and_then(|err| non_empty_str(err, "message"))
                    .unwrap_or("Anthropic SSE error")
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

    fn handle_openai_responses(
        &mut self,
        sse_event: Option<&str>,
        obj: &Map<String, Value>,
        events: &mut Vec<AgentEvent>,
    ) {
        let ev_type = non_empty_str(obj, "type").or(sse_event);
        match ev_type {
            Some("response.created") => {
                let resp = obj.get("response").and_then(Value::as_object);
                let id = resp
                    .and_then(|map| non_empty_str(map, "id"))
                    .map(str::to_owned);
                let model = resp
                    .and_then(|map| non_empty_str(map, "model"))
                    .map(str::to_owned);
                self.turn_id = id.clone();
                self.turn_started = true;
                self.turn_finished = false;
                events.push(AgentEvent::TurnStarted {
                    turn_id: id,
                    model,
                    resume_handle: self.resume_handle().map(Box::new),
                });
            }
            Some("response.output_item.added") => {
                let Some(item) = obj.get("item").and_then(Value::as_object) else {
                    return;
                };
                if matches!(
                    non_empty_str(item, "type"),
                    Some("function_call" | "mcp_call" | "custom_tool_call")
                ) {
                    let call_id = non_empty_str(item, "call_id")
                        .or_else(|| non_empty_str(item, "id"))
                        .unwrap_or("fn-call")
                        .to_owned();
                    let name = non_empty_str(item, "name")
                        .unwrap_or("function_call")
                        .to_owned();
                    if let Some(item_id) = non_empty_str(item, "id") {
                        self.openai_item_calls
                            .insert(item_id.to_owned(), call_id.clone());
                    }
                    self.saw_tool_call = true;
                    events.push(AgentEvent::ToolCallStarted {
                        call_id,
                        name,
                        arguments: None,
                    });
                }
            }
            Some("response.output_text.delta") => {
                if let Some(delta) = non_empty_str(obj, "delta") {
                    events.push(AgentEvent::TextDelta {
                        text: delta.to_owned(),
                        block_index: value_as_u32(obj.get("output_index")),
                    });
                }
            }
            Some("response.reasoning_text.delta" | "response.reasoning_summary_text.delta") => {
                if let Some(delta) = non_empty_str(obj, "delta") {
                    events.push(AgentEvent::ThinkingDelta {
                        text: delta.to_owned(),
                        block_index: value_as_u32(obj.get("output_index")),
                    });
                }
            }
            Some("response.function_call_arguments.delta") => {
                if let Some(delta) = non_empty_str(obj, "delta") {
                    let item_id = non_empty_str(obj, "item_id").unwrap_or("fn-call");
                    let call_id = self
                        .openai_item_calls
                        .get(item_id)
                        .cloned()
                        .unwrap_or_else(|| item_id.to_owned());
                    events.push(AgentEvent::ToolCallDelta {
                        call_id,
                        arguments_delta: Some(delta.to_owned()),
                        output_delta: None,
                    });
                }
            }
            Some("response.completed") => {
                let resp = obj.get("response").and_then(Value::as_object);
                if let Some(usage_obj) = resp
                    .and_then(|map| map.get("usage"))
                    .and_then(Value::as_object)
                {
                    let usage = parse_openai_usage(usage_obj);
                    if !usage.is_empty() {
                        events.push(AgentEvent::Usage { usage });
                    }
                }
                if !self.turn_finished {
                    self.turn_finished = true;
                    let reason = if self.saw_tool_call {
                        TurnFinishReason::ToolUse
                    } else {
                        TurnFinishReason::Completed
                    };
                    events.push(AgentEvent::TurnFinished {
                        turn_id: self.turn_id.clone(),
                        reason,
                        resume_handle: self.resume_handle().map(Box::new),
                    });
                }
            }
            Some("response.incomplete") => {
                let resp = obj.get("response").and_then(Value::as_object);
                if let Some(usage_obj) = resp
                    .and_then(|map| map.get("usage"))
                    .and_then(Value::as_object)
                {
                    let usage = parse_openai_usage(usage_obj);
                    if !usage.is_empty() {
                        events.push(AgentEvent::Usage { usage });
                    }
                }
                let reason = match resp
                    .and_then(|map| map.get("incomplete_details"))
                    .and_then(Value::as_object)
                    .and_then(|details| non_empty_str(details, "reason"))
                {
                    Some("max_output_tokens") => TurnFinishReason::MaxTokens,
                    _ => TurnFinishReason::Interrupted,
                };
                if !self.turn_finished {
                    self.turn_finished = true;
                    events.push(AgentEvent::TurnFinished {
                        turn_id: self.turn_id.clone(),
                        reason,
                        resume_handle: self.resume_handle().map(Box::new),
                    });
                }
            }
            Some("response.failed" | "error") => {
                let err_obj = obj
                    .get("response")
                    .and_then(Value::as_object)
                    .and_then(|resp| resp.get("error"))
                    .or_else(|| obj.get("error"))
                    .and_then(Value::as_object);
                let code = err_obj
                    .and_then(|err| non_empty_str(err, "code"))
                    .or_else(|| non_empty_str(obj, "code"))
                    .unwrap_or("openai_error")
                    .to_owned();
                let message = err_obj
                    .and_then(|err| non_empty_str(err, "message"))
                    .or_else(|| non_empty_str(obj, "message"))
                    .unwrap_or("OpenAI SSE error")
                    .to_owned();
                let retryable = matches!(code.as_str(), "rate_limit_exceeded" | "server_error");
                events.push(AgentEvent::Error {
                    code,
                    message,
                    retryable,
                });
                if ev_type == Some("response.failed") && !self.turn_finished {
                    self.turn_finished = true;
                    events.push(AgentEvent::TurnFinished {
                        turn_id: self.turn_id.clone(),
                        reason: TurnFinishReason::Error,
                        resume_handle: self.resume_handle().map(Box::new),
                    });
                }
            }
            _ => {}
        }
    }

    fn handle_chat_completions(&mut self, obj: &Map<String, Value>, events: &mut Vec<AgentEvent>) {
        if let Some(err_obj) = obj.get("error").and_then(Value::as_object) {
            let code = non_empty_str(err_obj, "code")
                .or_else(|| non_empty_str(err_obj, "type"))
                .unwrap_or("api_error")
                .to_owned();
            let message = non_empty_str(err_obj, "message")
                .unwrap_or("OpenAI-compatible API error")
                .to_owned();
            events.push(AgentEvent::Error {
                code,
                message,
                retryable: false,
            });
            return;
        }

        if !self.turn_started {
            self.turn_started = true;
            self.turn_id = non_empty_str(obj, "id").map(str::to_owned);
            let model = non_empty_str(obj, "model").map(str::to_owned);
            events.push(AgentEvent::TurnStarted {
                turn_id: self.turn_id.clone(),
                model,
                resume_handle: self.resume_handle().map(Box::new),
            });
        }

        if let Some(choices) = obj.get("choices").and_then(Value::as_array) {
            for choice in choices {
                let Some(choice_obj) = choice.as_object() else {
                    continue;
                };
                let choice_idx = value_as_u32(choice_obj.get("index"));
                if let Some(delta) = choice_obj.get("delta").and_then(Value::as_object) {
                    if let Some(reasoning) = non_empty_str(delta, "reasoning_content")
                        .or_else(|| non_empty_str(delta, "reasoning"))
                    {
                        events.push(AgentEvent::ThinkingDelta {
                            text: reasoning.to_owned(),
                            block_index: choice_idx,
                        });
                    }
                    if let Some(content) = non_empty_str(delta, "content") {
                        events.push(AgentEvent::TextDelta {
                            text: content.to_owned(),
                            block_index: choice_idx,
                        });
                    }
                    if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
                        for tc in tool_calls {
                            let Some(tc_obj) = tc.as_object() else {
                                continue;
                            };
                            let tc_idx = value_as_u32(tc_obj.get("index")).unwrap_or(0);
                            let func = tc_obj.get("function").and_then(Value::as_object);
                            let call_id = if let Some(id) = non_empty_str(tc_obj, "id") {
                                let name = func
                                    .and_then(|f| non_empty_str(f, "name"))
                                    .unwrap_or("tool")
                                    .to_owned();
                                self.chat_tool_calls.insert(tc_idx, id.to_owned());
                                self.saw_tool_call = true;
                                events.push(AgentEvent::ToolCallStarted {
                                    call_id: id.to_owned(),
                                    name,
                                    arguments: None,
                                });
                                id.to_owned()
                            } else if let Some(existing_id) = self.chat_tool_calls.get(&tc_idx) {
                                existing_id.clone()
                            } else {
                                format!("tool-{tc_idx}")
                            };
                            if let Some(args_delta) =
                                func.and_then(|f| non_empty_str(f, "arguments"))
                            {
                                events.push(AgentEvent::ToolCallDelta {
                                    call_id,
                                    arguments_delta: Some(args_delta.to_owned()),
                                    output_delta: None,
                                });
                            }
                        }
                    }
                }
                if let Some(finish) = non_empty_str(choice_obj, "finish_reason") {
                    let reason = match finish {
                        "stop" => TurnFinishReason::Completed,
                        "length" => TurnFinishReason::MaxTokens,
                        "tool_calls" | "function_call" => TurnFinishReason::ToolUse,
                        "content_filter" => TurnFinishReason::Error,
                        _ => TurnFinishReason::Unknown,
                    };
                    self.stop_reason = Some(reason);
                }
            }
        }

        if let Some(usage_obj) = obj.get("usage").and_then(Value::as_object) {
            let usage = parse_openai_usage(usage_obj);
            if !usage.is_empty() {
                events.push(AgentEvent::Usage { usage });
            }
        }
    }
}

fn parse_openai_usage(usage: &Map<String, Value>) -> TokenUsage {
    let input_tokens = value_as_u64(
        usage
            .get("input_tokens")
            .or_else(|| usage.get("prompt_tokens")),
    );
    let output_tokens = value_as_u64(
        usage
            .get("output_tokens")
            .or_else(|| usage.get("completion_tokens")),
    );
    let cache_read_tokens = value_as_u64(
        usage
            .get("input_tokens_details")
            .or_else(|| usage.get("prompt_tokens_details"))
            .and_then(Value::as_object)
            .and_then(|details| details.get("cached_tokens")),
    );
    let reasoning_tokens = value_as_u64(
        usage
            .get("output_tokens_details")
            .or_else(|| usage.get("completion_tokens_details"))
            .and_then(Value::as_object)
            .and_then(|details| details.get("reasoning_tokens")),
    );
    let cost_usd = usage.get("cost").and_then(Value::as_f64);
    TokenUsage {
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens: 0,
        reasoning_tokens,
        cost_usd,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_anthropic_messages_sse_across_arbitrary_chunk_splits() {
        let stream = concat!(
            "event: message_start\r\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_a1\",\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":80,\"cache_read_input_tokens\":20}}}\r\n\r\n",
            ": keep-alive comment\r\n",
            "event: content_block_delta\r\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Plan...\"}}\r\n\r\n",
            "event: content_block_delta\r\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello!\"}}\r\n\r\n",
            "event: content_block_start\r\n",
            "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"read\"}}\r\n\r\n",
            "event: content_block_delta\r\n",
            "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"p\\\":1}\"}}\r\n\r\n",
            "event: message_delta\r\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":33}}\r\n\r\n",
            "event: message_stop\r\n",
            "data: {\"type\":\"message_stop\"}\r\n\r\n",
        );

        let mut parser = DirectSseParser::new(DirectApiProvider::Anthropic);
        let mut events = Vec::new();
        // Feed 17 bytes at a time to exercise mid-line and mid-frame chunk boundaries.
        for chunk in stream.as_bytes().chunks(17) {
            events.extend(parser.feed_bytes(chunk).unwrap());
        }
        events.extend(parser.finish().unwrap());

        assert!(matches!(
            &events[0],
            AgentEvent::TurnStarted { turn_id: Some(id), .. } if id == "msg_a1"
        ));
        assert_eq!(
            events[1],
            AgentEvent::ThinkingDelta {
                text: "Plan...".to_owned(),
                block_index: Some(0),
            }
        );
        assert_eq!(
            events[2],
            AgentEvent::TextDelta {
                text: "Hello!".to_owned(),
                block_index: Some(1),
            }
        );
        assert_eq!(
            events[3],
            AgentEvent::ToolCallStarted {
                call_id: "tu_1".to_owned(),
                name: "read".to_owned(),
                arguments: None,
            }
        );
        assert_eq!(
            events[4],
            AgentEvent::ToolCallDelta {
                call_id: "tu_1".to_owned(),
                arguments_delta: Some("{\"p\":1}".to_owned()),
                output_delta: None,
            }
        );
        assert_eq!(
            events[5],
            AgentEvent::Usage {
                usage: TokenUsage {
                    input_tokens: 80,
                    output_tokens: 33,
                    cache_read_tokens: 20,
                    cache_write_tokens: 0,
                    reasoning_tokens: 0,
                    cost_usd: None,
                },
            }
        );
        assert!(matches!(
            &events[6],
            AgentEvent::TurnFinished {
                reason: TurnFinishReason::ToolUse,
                ..
            }
        ));
    }

    #[test]
    fn parses_openai_responses_sse_text_reasoning_tool_and_usage() {
        let stream = concat!(
            "event: response.created\n",
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_9\",\"model\":\"gpt-5.4\"}}\n\n",
            "event: response.reasoning_summary_text.delta\n",
            "data: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"delta\":\"Thinking\"}\n\n",
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"output_index\":1,\"delta\":\"Done\"}\n\n",
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"item_fc\",\"call_id\":\"call_77\",\"type\":\"function_call\",\"name\":\"run_cmd\"}}\n\n",
            "event: response.function_call_arguments.delta\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"item_fc\",\"delta\":\"{\\\"cmd\\\":\\\"ls\\\"}\"}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_9\",\"usage\":{\"input_tokens\":210,\"output_tokens\":60,\"input_tokens_details\":{\"cached_tokens\":50},\"output_tokens_details\":{\"reasoning_tokens\":15}}}}\n\n",
        );

        let mut parser = DirectSseParser::new(DirectApiProvider::OpenAi);
        let events = parser.feed_str(stream).unwrap();

        assert!(matches!(
            &events[0],
            AgentEvent::TurnStarted { turn_id: Some(id), .. } if id == "resp_9"
        ));
        assert_eq!(
            events[1],
            AgentEvent::ThinkingDelta {
                text: "Thinking".to_owned(),
                block_index: Some(0),
            }
        );
        assert_eq!(
            events[2],
            AgentEvent::TextDelta {
                text: "Done".to_owned(),
                block_index: Some(1),
            }
        );
        assert_eq!(
            events[3],
            AgentEvent::ToolCallStarted {
                call_id: "call_77".to_owned(),
                name: "run_cmd".to_owned(),
                arguments: None,
            }
        );
        assert_eq!(
            events[4],
            AgentEvent::ToolCallDelta {
                call_id: "call_77".to_owned(),
                arguments_delta: Some("{\"cmd\":\"ls\"}".to_owned()),
                output_delta: None,
            }
        );
        assert_eq!(
            events[5],
            AgentEvent::Usage {
                usage: TokenUsage {
                    input_tokens: 210,
                    output_tokens: 60,
                    cache_read_tokens: 50,
                    cache_write_tokens: 0,
                    reasoning_tokens: 15,
                    cost_usd: None,
                },
            }
        );
        assert!(matches!(
            &events[6],
            AgentEvent::TurnFinished {
                reason: TurnFinishReason::ToolUse,
                ..
            }
        ));
    }

    #[test]
    fn parses_openrouter_chat_completions_sse_with_done_sentinel() {
        let stream = concat!(
            "data: {\"id\":\"chatcmpl-1\",\"model\":\"anthropic/claude-sonnet-4.6\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"Hmm\",\"content\":\"Hi\"}}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_or1\",\"function\":{\"name\":\"search\",\"arguments\":\"{\\\"q\\\":\"}}]}}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"rust\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":40,\"completion_tokens\":12,\"cost\":0.001}}\n\n",
            "data: [DONE]\n\n",
        );

        let mut parser = DirectSseParser::new(DirectApiProvider::OpenRouter);
        let events = parser.feed_str(stream).unwrap();

        assert!(matches!(
            &events[0],
            AgentEvent::TurnStarted { turn_id: Some(id), .. } if id == "chatcmpl-1"
        ));
        assert_eq!(
            events[1],
            AgentEvent::ThinkingDelta {
                text: "Hmm".to_owned(),
                block_index: Some(0),
            }
        );
        assert_eq!(
            events[2],
            AgentEvent::TextDelta {
                text: "Hi".to_owned(),
                block_index: Some(0),
            }
        );
        assert_eq!(
            events[3],
            AgentEvent::ToolCallStarted {
                call_id: "call_or1".to_owned(),
                name: "search".to_owned(),
                arguments: None,
            }
        );
        assert_eq!(
            events[4],
            AgentEvent::ToolCallDelta {
                call_id: "call_or1".to_owned(),
                arguments_delta: Some("{\"q\":".to_owned()),
                output_delta: None,
            }
        );
        assert_eq!(
            events[5],
            AgentEvent::ToolCallDelta {
                call_id: "call_or1".to_owned(),
                arguments_delta: Some("\"rust\"}".to_owned()),
                output_delta: None,
            }
        );
        assert!(matches!(
            &events[6],
            AgentEvent::Usage { usage } if usage.input_tokens == 40 && usage.cost_usd == Some(0.001)
        ));
        assert!(matches!(
            &events[7],
            AgentEvent::TurnFinished {
                reason: TurnFinishReason::ToolUse,
                ..
            }
        ));
    }
}
