//! Concrete [`AgentAdapter`] for Direct LLM API streaming over native Rust HTTP/1.1 + TLS.
//!
//! Uses `ompdesk-core`'s existing `hyper` + `hyper-util` + `http-body-util` + `tokio-rustls` +
//! `crate::http::machine_tls()` stack (zero external CLI, zero `Cargo.lock` additions), streams
//! response chunks incrementally through [`DirectSseParser`], redacts secrets from all `Debug`
//! surfaces, and executes a bounded multi-round [`ToolExecutor`] loop appending provider-native
//! tool calls and tool results across Anthropic Messages, OpenAI Responses, and OpenRouter /
//! OpenAI-compatible Chat Completions.

use std::collections::HashMap;
use std::fmt;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use rustls::pki_types::ServerName;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_rustls::TlsConnector;
use url::{Host, Position, Url};

use super::detect::detect_direct_api_in;
use crate::agent::adapter::{AgentAdapter, AgentSession, BoxFuture};
use crate::agent::parsers::direct_sse::DirectSseParser;
use crate::agent::types::{
    AgentCapabilities, AgentError, AgentEvent, BackendId, DirectApiProvider, InstalledBackend,
    ResumeHandle, SessionLifecycleState, SessionSpec, TurnFinishReason, TurnInput,
};
use crate::http::machine_tls;

const EVENT_CHANNEL_CAPACITY: usize = 256;
const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;
const ANTHROPIC_API_VERSION: &str = "2023-06-01";
const DEFAULT_ANTHROPIC_MAX_TOKENS: u32 = 4096;

/// Default maximum model-to-tool execution rounds per turn when `DirectApiConfig::max_tool_rounds`
/// is omitted.
pub const DEFAULT_MAX_TOOL_ROUNDS: u32 = 16;

/// JSON Schema description of one local or MCP tool exposed to a Direct LLM API turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Request handed to a [`ToolExecutor`] when the model emits a tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInvocation {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
    pub cwd: PathBuf,
}

/// Result returned by a [`ToolExecutor`] and fed back into the next model round.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionResult {
    pub output: String,
    #[serde(default)]
    pub is_error: bool,
}

/// Plug-in hook for local filesystem, shell, and `mcp_hub` tools in the Direct API loop.
pub trait ToolExecutor: Send + Sync {
    fn list_tools(&self) -> Vec<ToolSchema>;

    fn execute(
        &self,
        invocation: ToolInvocation,
    ) -> BoxFuture<'_, Result<ToolExecutionResult, AgentError>>;
}

/// Default zero-tool [`ToolExecutor`] for sessions without local/MCP tools enabled.
#[derive(Debug, Default)]
pub struct NoopToolExecutor;

impl ToolExecutor for NoopToolExecutor {
    fn list_tools(&self) -> Vec<ToolSchema> {
        Vec::new()
    }

    fn execute(
        &self,
        invocation: ToolInvocation,
    ) -> BoxFuture<'_, Result<ToolExecutionResult, AgentError>> {
        Box::pin(async move {
            Ok(ToolExecutionResult {
                output: format!(
                    "tool `{}` is not registered in this runtime",
                    invocation.name
                ),
                is_error: true,
            })
        })
    }
}

/// Role inside the in-memory Direct API conversation history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationRole {
    User,
    Assistant,
    Tool,
}

/// One tool call recorded on an assistant turn in conversation history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedToolCall {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
}

/// One persisted conversation message sent on subsequent Direct API turns and tool rounds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub role: ConversationRole,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<RecordedToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub is_error: bool,
}

impl ConversationMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: ConversationRole::User,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            tool_name: None,
            is_error: false,
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: ConversationRole::Assistant,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            tool_name: None,
            is_error: false,
        }
    }

    pub fn assistant_with_tools(
        content: impl Into<String>,
        tool_calls: Vec<RecordedToolCall>,
    ) -> Self {
        Self {
            role: ConversationRole::Assistant,
            content: content.into(),
            tool_calls,
            tool_call_id: None,
            tool_name: None,
            is_error: false,
        }
    }

    pub fn tool_result(
        call_id: impl Into<String>,
        name: impl Into<String>,
        output: impl Into<String>,
        is_error: bool,
    ) -> Self {
        Self {
            role: ConversationRole::Tool,
            content: output.into(),
            tool_calls: Vec::new(),
            tool_call_id: Some(call_id.into()),
            tool_name: Some(name.into()),
            is_error,
        }
    }
}

/// Secret HTTP header whose value is always redacted in [`fmt::Debug`] output.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretHeader {
    name: String,
    value: String,
}

impl SecretHeader {
    fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

impl fmt::Debug for SecretHeader {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretHeader")
            .field("name", &self.name)
            .field("value", &"[REDACTED]")
            .finish()
    }
}

/// Prepared Direct LLM API SSE request (secret auth values are redacted in `Debug`).
#[derive(Debug, Clone, PartialEq)]
pub struct DirectApiHttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    auth_headers: Vec<SecretHeader>,
    pub body: Value,
}

impl DirectApiHttpRequest {
    /// Lists the names of attached authentication headers without revealing their values.
    pub fn auth_header_names(&self) -> Vec<&str> {
        self.auth_headers.iter().map(SecretHeader::name).collect()
    }

    /// Returns `true` when an authentication header matching `name` (ASCII case-insensitive) is set.
    pub fn has_auth_header(&self, name: &str) -> bool {
        self.auth_headers
            .iter()
            .any(|header| header.name.eq_ignore_ascii_case(name))
    }

    /// Serializes the JSON request body into UTF-8 bytes.
    pub fn body_bytes(&self) -> Result<Vec<u8>, AgentError> {
        serde_json::to_vec(&self.body).map_err(AgentError::from)
    }

    fn all_header_pairs(&self) -> Vec<(&str, &str)> {
        let mut pairs = Vec::with_capacity(self.headers.len() + self.auth_headers.len());
        for (name, value) in &self.headers {
            pairs.push((name.as_str(), value.as_str()));
        }
        for secret in &self.auth_headers {
            pairs.push((secret.name.as_str(), secret.value.as_str()));
        }
        pairs
    }
}

/// Default environment variable holding the API key for each [`DirectApiProvider`].
pub const fn default_api_key_env(provider: DirectApiProvider) -> &'static str {
    match provider {
        DirectApiProvider::Anthropic => "ANTHROPIC_API_KEY",
        DirectApiProvider::OpenAi => "OPENAI_API_KEY",
        DirectApiProvider::OpenRouter => "OPENROUTER_API_KEY",
        DirectApiProvider::OpenAiCompatible => "OPENAI_COMPATIBLE_API_KEY",
    }
}

/// Default model name used when a [`SessionSpec`] does not specify one.
pub const fn default_model(provider: DirectApiProvider) -> &'static str {
    match provider {
        DirectApiProvider::Anthropic => "claude-sonnet-4-6",
        DirectApiProvider::OpenAi => "gpt-5.4",
        DirectApiProvider::OpenRouter => "anthropic/claude-sonnet-4.6",
        DirectApiProvider::OpenAiCompatible => "default",
    }
}

/// Resolves the streaming endpoint URL for `provider` and optional custom `base_url`.
pub fn resolve_endpoint_url(provider: DirectApiProvider, base_url: Option<&str>) -> String {
    let suffix = match provider {
        DirectApiProvider::Anthropic => "/messages",
        DirectApiProvider::OpenAi => "/responses",
        DirectApiProvider::OpenRouter | DirectApiProvider::OpenAiCompatible => "/chat/completions",
    };
    if let Some(custom) = base_url.map(str::trim).filter(|url| !url.is_empty()) {
        let trimmed = custom.trim_end_matches('/');
        if trimmed.ends_with(suffix) {
            return trimmed.to_owned();
        }
        return format!("{trimmed}{suffix}");
    }
    match provider {
        DirectApiProvider::Anthropic => "https://api.anthropic.com/v1/messages".to_owned(),
        DirectApiProvider::OpenAi => "https://api.openai.com/v1/responses".to_owned(),
        DirectApiProvider::OpenRouter => "https://openrouter.ai/api/v1/chat/completions".to_owned(),
        DirectApiProvider::OpenAiCompatible => {
            "http://127.0.0.1:11434/v1/chat/completions".to_owned()
        }
    }
}

/// Builds a provider-specific SSE streaming HTTP request payload and redacted auth headers.
pub fn build_http_request(
    provider: DirectApiProvider,
    spec: &SessionSpec,
    messages: &[ConversationMessage],
    tools: &[ToolSchema],
    api_key: Option<&str>,
    model_override: Option<&str>,
) -> Result<DirectApiHttpRequest, AgentError> {
    let backend = BackendId::DirectApi(provider);
    let clean_key = api_key.map(str::trim).filter(|key| !key.is_empty());
    if clean_key.is_none() && provider != DirectApiProvider::OpenAiCompatible {
        let env_name = spec
            .api_config
            .as_ref()
            .and_then(|cfg| cfg.api_key_env.as_deref())
            .unwrap_or_else(|| default_api_key_env(provider));
        return Err(AgentError::NotInstalled {
            backend,
            detail: format!("missing credentials: set {env_name}"),
        });
    }

    let base_url = spec
        .api_config
        .as_ref()
        .and_then(|cfg| cfg.base_url.as_deref());
    let url = resolve_endpoint_url(provider, base_url);
    let model = model_override
        .filter(|m| !m.is_empty())
        .or_else(|| spec.model.as_deref().filter(|m| !m.is_empty()))
        .unwrap_or_else(|| default_model(provider));
    let max_tokens = spec
        .api_config
        .as_ref()
        .and_then(|cfg| cfg.max_output_tokens);

    let mut headers = vec![
        ("content-type".to_owned(), "application/json".to_owned()),
        ("accept".to_owned(), "text/event-stream".to_owned()),
    ];
    let mut auth_headers = Vec::new();

    let body = match provider {
        DirectApiProvider::Anthropic => {
            headers.push((
                "anthropic-version".to_owned(),
                ANTHROPIC_API_VERSION.to_owned(),
            ));
            if let Some(key) = clean_key {
                auth_headers.push(SecretHeader::new("x-api-key", key));
            }
            build_anthropic_body(
                model,
                spec.system_prompt.as_deref(),
                messages,
                tools,
                max_tokens.unwrap_or(DEFAULT_ANTHROPIC_MAX_TOKENS),
            )
        }
        DirectApiProvider::OpenAi => {
            if let Some(key) = clean_key {
                auth_headers.push(SecretHeader::new("authorization", format!("Bearer {key}")));
            }
            build_openai_responses_body(
                model,
                spec.system_prompt.as_deref(),
                messages,
                tools,
                max_tokens,
            )
        }
        DirectApiProvider::OpenRouter | DirectApiProvider::OpenAiCompatible => {
            if provider == DirectApiProvider::OpenRouter {
                headers.push((
                    "http-referer".to_owned(),
                    "https://github.com/seuput-inc/ompdesk".to_owned(),
                ));
                headers.push(("x-title".to_owned(), "OMPdesk".to_owned()));
            }
            if let Some(key) = clean_key {
                auth_headers.push(SecretHeader::new("authorization", format!("Bearer {key}")));
            }
            build_chat_completions_body(
                model,
                spec.system_prompt.as_deref(),
                messages,
                tools,
                max_tokens,
            )
        }
    };

    Ok(DirectApiHttpRequest {
        url,
        headers,
        auth_headers,
        body,
    })
}

fn build_anthropic_body(
    model: &str,
    system_prompt: Option<&str>,
    messages: &[ConversationMessage],
    tools: &[ToolSchema],
    max_tokens: u32,
) -> Value {
    let mut obj = Map::new();
    obj.insert("model".to_owned(), Value::String(model.to_owned()));
    obj.insert("max_tokens".to_owned(), Value::from(max_tokens));
    obj.insert("stream".to_owned(), Value::Bool(true));
    if let Some(system) = system_prompt.filter(|s| !s.is_empty()) {
        obj.insert("system".to_owned(), Value::String(system.to_owned()));
    }

    let mut msg_values: Vec<Value> = Vec::new();
    let mut pending_tool_results: Vec<Value> = Vec::new();

    let flush_tool_results = |pending: &mut Vec<Value>, out: &mut Vec<Value>| {
        if !pending.is_empty() {
            out.push(json!({
                "role": "user",
                "content": std::mem::take(pending),
            }));
        }
    };

    for msg in messages {
        match msg.role {
            ConversationRole::Tool => {
                let mut block = Map::new();
                block.insert("type".to_owned(), Value::String("tool_result".to_owned()));
                block.insert(
                    "tool_use_id".to_owned(),
                    Value::String(msg.tool_call_id.clone().unwrap_or_default()),
                );
                block.insert("content".to_owned(), Value::String(msg.content.clone()));
                if msg.is_error {
                    block.insert("is_error".to_owned(), Value::Bool(true));
                }
                pending_tool_results.push(Value::Object(block));
            }
            ConversationRole::User => {
                flush_tool_results(&mut pending_tool_results, &mut msg_values);
                msg_values.push(json!({
                    "role": "user",
                    "content": msg.content,
                }));
            }
            ConversationRole::Assistant => {
                flush_tool_results(&mut pending_tool_results, &mut msg_values);
                if msg.tool_calls.is_empty() {
                    msg_values.push(json!({
                        "role": "assistant",
                        "content": msg.content,
                    }));
                } else {
                    let mut blocks = Vec::new();
                    if !msg.content.is_empty() {
                        blocks.push(json!({ "type": "text", "text": msg.content }));
                    }
                    for tc in &msg.tool_calls {
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": tc.call_id,
                            "name": tc.name,
                            "input": tc.arguments,
                        }));
                    }
                    msg_values.push(json!({
                        "role": "assistant",
                        "content": blocks,
                    }));
                }
            }
        }
    }
    flush_tool_results(&mut pending_tool_results, &mut msg_values);

    obj.insert("messages".to_owned(), Value::Array(msg_values));
    if !tools.is_empty() {
        let tool_values: Vec<Value> = tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                })
            })
            .collect();
        obj.insert("tools".to_owned(), Value::Array(tool_values));
    }
    Value::Object(obj)
}

fn build_openai_responses_body(
    model: &str,
    system_prompt: Option<&str>,
    messages: &[ConversationMessage],
    tools: &[ToolSchema],
    max_output_tokens: Option<u32>,
) -> Value {
    let mut obj = Map::new();
    obj.insert("model".to_owned(), Value::String(model.to_owned()));
    obj.insert("stream".to_owned(), Value::Bool(true));
    if let Some(system) = system_prompt.filter(|s| !s.is_empty()) {
        obj.insert("instructions".to_owned(), Value::String(system.to_owned()));
    }
    if let Some(max) = max_output_tokens {
        obj.insert("max_output_tokens".to_owned(), Value::from(max));
    }
    let mut input_values = Vec::new();
    for msg in messages {
        match msg.role {
            ConversationRole::User => {
                input_values.push(json!({
                    "role": "user",
                    "content": msg.content,
                }));
            }
            ConversationRole::Assistant => {
                if !msg.content.is_empty() || msg.tool_calls.is_empty() {
                    input_values.push(json!({
                        "role": "assistant",
                        "content": msg.content,
                    }));
                }
                for tc in &msg.tool_calls {
                    let args_str =
                        serde_json::to_string(&tc.arguments).unwrap_or_else(|_| "{}".to_owned());
                    input_values.push(json!({
                        "type": "function_call",
                        "call_id": tc.call_id,
                        "name": tc.name,
                        "arguments": args_str,
                    }));
                }
            }
            ConversationRole::Tool => {
                input_values.push(json!({
                    "type": "function_call_output",
                    "call_id": msg.tool_call_id.clone().unwrap_or_default(),
                    "output": msg.content,
                }));
            }
        }
    }
    obj.insert("input".to_owned(), Value::Array(input_values));
    if !tools.is_empty() {
        let tool_values: Vec<Value> = tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                })
            })
            .collect();
        obj.insert("tools".to_owned(), Value::Array(tool_values));
    }
    Value::Object(obj)
}

fn build_chat_completions_body(
    model: &str,
    system_prompt: Option<&str>,
    messages: &[ConversationMessage],
    tools: &[ToolSchema],
    max_tokens: Option<u32>,
) -> Value {
    let mut obj = Map::new();
    obj.insert("model".to_owned(), Value::String(model.to_owned()));
    obj.insert("stream".to_owned(), Value::Bool(true));
    obj.insert(
        "stream_options".to_owned(),
        json!({ "include_usage": true }),
    );
    if let Some(max) = max_tokens {
        obj.insert("max_tokens".to_owned(), Value::from(max));
    }
    let mut msg_values = Vec::with_capacity(messages.len() + 1);
    if let Some(system) = system_prompt.filter(|s| !s.is_empty()) {
        msg_values.push(json!({ "role": "system", "content": system }));
    }
    for msg in messages {
        match msg.role {
            ConversationRole::User => {
                msg_values.push(json!({
                    "role": "user",
                    "content": msg.content,
                }));
            }
            ConversationRole::Assistant => {
                if msg.tool_calls.is_empty() {
                    msg_values.push(json!({
                        "role": "assistant",
                        "content": msg.content,
                    }));
                } else {
                    let content_val = if msg.content.is_empty() {
                        Value::Null
                    } else {
                        Value::String(msg.content.clone())
                    };
                    let tool_calls: Vec<Value> = msg
                        .tool_calls
                        .iter()
                        .map(|tc| {
                            let args_str = serde_json::to_string(&tc.arguments)
                                .unwrap_or_else(|_| "{}".to_owned());
                            json!({
                                "id": tc.call_id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": args_str,
                                }
                            })
                        })
                        .collect();
                    msg_values.push(json!({
                        "role": "assistant",
                        "content": content_val,
                        "tool_calls": tool_calls,
                    }));
                }
            }
            ConversationRole::Tool => {
                let mut item = Map::new();
                item.insert("role".to_owned(), Value::String("tool".to_owned()));
                item.insert(
                    "tool_call_id".to_owned(),
                    Value::String(msg.tool_call_id.clone().unwrap_or_default()),
                );
                if let Some(name) = &msg.tool_name {
                    item.insert("name".to_owned(), Value::String(name.clone()));
                }
                item.insert("content".to_owned(), Value::String(msg.content.clone()));
                msg_values.push(Value::Object(item));
            }
        }
    }
    obj.insert("messages".to_owned(), Value::Array(msg_values));
    if !tools.is_empty() {
        let tool_values: Vec<Value> = tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    }
                })
            })
            .collect();
        obj.insert("tools".to_owned(), Value::Array(tool_values));
    }
    Value::Object(obj)
}

/// Summary of one streamed LLM round returned by [`SseTransport::stream_round`].
#[derive(Debug, Clone, PartialEq)]
pub struct RoundOutcome {
    pub assistant_text: String,
    pub tool_calls: Vec<RecordedToolCall>,
    pub finish_reason: TurnFinishReason,
    pub terminal_event: Option<AgentEvent>,
}

struct PendingToolCall {
    name: String,
    raw_args: String,
    initial_args: Option<Value>,
    already_executed: bool,
}

/// Accumulates normalized events for one streaming model round, collecting tool call arguments and
/// holding back `TurnFinished` until the outer tool loop knows whether another round will run.
pub struct RoundCollector {
    round: u32,
    assistant_text: String,
    tool_order: Vec<String>,
    pending_tools: HashMap<String, PendingToolCall>,
    finish_reason: TurnFinishReason,
    terminal_event: Option<AgentEvent>,
}

impl RoundCollector {
    pub fn new(round: u32) -> Self {
        Self {
            round,
            assistant_text: String::new(),
            tool_order: Vec::new(),
            pending_tools: HashMap::new(),
            finish_reason: TurnFinishReason::Completed,
            terminal_event: None,
        }
    }

    /// Processes one event from [`DirectSseParser`], forwarding streaming deltas to `tx` and
    /// returning `false` if the receiver has closed.
    pub async fn accept(&mut self, event: AgentEvent, tx: &mpsc::Sender<AgentEvent>) -> bool {
        match &event {
            AgentEvent::TurnStarted { .. } => {
                if self.round > 0 {
                    return true;
                }
            }
            AgentEvent::TextDelta { text, .. } => {
                self.assistant_text.push_str(text);
            }
            AgentEvent::ToolCallStarted {
                call_id,
                name,
                arguments,
            } => {
                if !self.pending_tools.contains_key(call_id) {
                    self.tool_order.push(call_id.clone());
                }
                self.pending_tools.insert(
                    call_id.clone(),
                    PendingToolCall {
                        name: name.clone(),
                        raw_args: String::new(),
                        initial_args: arguments.as_deref().cloned(),
                        already_executed: false,
                    },
                );
            }
            AgentEvent::ToolCallDelta {
                call_id,
                arguments_delta: Some(delta),
                ..
            } => {
                if let Some(pending) = self.pending_tools.get_mut(call_id) {
                    pending.raw_args.push_str(delta);
                }
            }
            AgentEvent::ToolCallFinished {
                call_id, output, ..
            } => {
                if let Some(pending) = self.pending_tools.get_mut(call_id) {
                    if output.is_some() {
                        pending.already_executed = true;
                    } else {
                        // Tool call argument assembly finished without local execution output yet:
                        // defer emitting ToolCallFinished until ToolExecutor runs.
                        return true;
                    }
                }
            }
            AgentEvent::TurnFinished { reason, .. } => {
                self.finish_reason = *reason;
                self.terminal_event = Some(event);
                return true;
            }
            _ => {}
        }
        tx.send(event).await.is_ok()
    }

    pub fn into_outcome(mut self) -> RoundOutcome {
        let mut tool_calls = Vec::new();
        for call_id in self.tool_order {
            let Some(pending) = self.pending_tools.remove(&call_id) else {
                continue;
            };
            if pending.already_executed {
                continue;
            }
            let arguments = if !pending.raw_args.trim().is_empty() {
                serde_json::from_str::<Value>(&pending.raw_args)
                    .unwrap_or_else(|_| json!({ "_raw": pending.raw_args }))
            } else {
                pending.initial_args.unwrap_or_else(|| json!({}))
            };
            tool_calls.push(RecordedToolCall {
                call_id,
                name: pending.name,
                arguments,
            });
        }
        RoundOutcome {
            assistant_text: self.assistant_text,
            tool_calls,
            finish_reason: self.finish_reason,
            terminal_event: self.terminal_event,
        }
    }
}

/// Pluggable SSE round transport used by [`DirectApiAdapter`] (defaults to [`HyperSseTransport`]).
pub trait SseTransport: Send + Sync {
    fn stream_round<'a>(
        &'a self,
        provider: DirectApiProvider,
        request: &'a DirectApiHttpRequest,
        round: u32,
        tx: &'a mpsc::Sender<AgentEvent>,
    ) -> BoxFuture<'a, Result<RoundOutcome, AgentError>>;
}

/// Production [`SseTransport`] backed by `ompdesk-core`'s `hyper` 1 + `tokio-rustls` client.
#[derive(Debug, Default)]
pub struct HyperSseTransport;

impl SseTransport for HyperSseTransport {
    fn stream_round<'a>(
        &'a self,
        provider: DirectApiProvider,
        request: &'a DirectApiHttpRequest,
        round: u32,
        tx: &'a mpsc::Sender<AgentEvent>,
    ) -> BoxFuture<'a, Result<RoundOutcome, AgentError>> {
        Box::pin(async move {
            let mut parser = DirectSseParser::new(provider);
            stream_http_sse(request, &mut parser, round, tx).await
        })
    }
}

/// Drives raw SSE byte chunks through [`DirectSseParser`] and [`RoundCollector`], returning the
/// full [`RoundOutcome`] including assembled tool calls.
pub async fn drive_sse_round<I>(
    chunks: I,
    parser: &mut DirectSseParser,
    round: u32,
    tx: &mpsc::Sender<AgentEvent>,
) -> Result<RoundOutcome, AgentError>
where
    I: IntoIterator<Item = Vec<u8>>,
{
    let mut collector = RoundCollector::new(round);
    for chunk in chunks {
        for event in parser.feed_bytes(&chunk)? {
            if !collector.accept(event, tx).await {
                return Ok(collector.into_outcome());
            }
        }
    }
    for event in parser.finish()? {
        if !collector.accept(event, tx).await {
            break;
        }
    }
    Ok(collector.into_outcome())
}

/// Feeds an iterator of raw SSE byte chunks through [`DirectSseParser`] into `tx`, returning the
/// concatenated assistant text emitted during the turn.
pub async fn drive_sse_byte_chunks<I>(
    chunks: I,
    parser: &mut DirectSseParser,
    tx: &mpsc::Sender<AgentEvent>,
) -> Result<String, AgentError>
where
    I: IntoIterator<Item = Vec<u8>>,
{
    let mut assistant_text = String::new();
    for chunk in chunks {
        let events = parser.feed_bytes(&chunk)?;
        for event in events {
            if let AgentEvent::TextDelta { text, .. } = &event {
                assistant_text.push_str(text);
            }
            if tx.send(event).await.is_err() {
                return Ok(assistant_text);
            }
        }
    }
    for event in parser.finish()? {
        if let AgentEvent::TextDelta { text, .. } = &event {
            assistant_text.push_str(text);
        }
        if tx.send(event).await.is_err() {
            break;
        }
    }
    Ok(assistant_text)
}

trait StreamIo: AsyncRead + AsyncWrite + Send + Unpin + 'static {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> StreamIo for T {}

async fn stream_http_sse(
    request: &DirectApiHttpRequest,
    parser: &mut DirectSseParser,
    round: u32,
    tx: &mpsc::Sender<AgentEvent>,
) -> Result<RoundOutcome, AgentError> {
    let url = Url::parse(&request.url).map_err(|error| AgentError::InvalidSpec {
        message: format!("invalid Direct API URL: {error}"),
    })?;
    let tls = match url.scheme() {
        "http" => false,
        "https" => true,
        scheme => {
            return Err(AgentError::InvalidSpec {
                message: format!("unsupported Direct API URL scheme: {scheme}"),
            });
        }
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AgentError::InvalidSpec {
            message: "Direct API URL must not embed credentials".to_owned(),
        });
    }
    let host = url
        .host()
        .ok_or_else(|| AgentError::InvalidSpec {
            message: "Direct API URL is missing host".to_owned(),
        })?
        .to_owned();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| AgentError::InvalidSpec {
            message: "Direct API URL is missing port".to_owned(),
        })?;
    let authority = url[Position::BeforeHost..Position::AfterPort].to_owned();
    let path = url[Position::BeforePath..Position::AfterQuery].to_owned();

    let mut builder = hyper::Request::builder()
        .method("POST")
        .uri(path.as_str())
        .header("host", authority.as_str())
        .header("connection", "close");

    for (name, value) in request.all_header_pairs() {
        if !value
            .bytes()
            .all(|byte| byte == b'\t' || (0x20..0x7f).contains(&byte))
        {
            return Err(AgentError::InvalidSpec {
                message: format!("header `{name}` contains invalid HTTP characters"),
            });
        }
        builder = builder.header(name, value);
    }

    let body_bytes = request.body_bytes()?;
    let http_req = builder
        .body(Full::new(Bytes::from(body_bytes)))
        .map_err(|error| AgentError::InvalidSpec {
            message: format!("failed to build HTTP request: {error}"),
        })?;

    let tcp = match &host {
        Host::Domain(name) => TcpStream::connect((name.as_str(), port)).await,
        Host::Ipv4(addr) => TcpStream::connect((*addr, port)).await,
        Host::Ipv6(addr) => TcpStream::connect((*addr, port)).await,
    }
    .map_err(|error| AgentError::Transport {
        message: format!("failed to connect to {authority}: {error}"),
    })?;
    let _ = tcp.set_nodelay(true);

    let stream: Box<dyn StreamIo> = if tls {
        let tls_cfg = machine_tls().map_err(|failure| AgentError::Transport {
            message: format!("TLS setup failed: {failure:?}"),
        })?;
        let server_name = match &host {
            Host::Domain(name) => {
                ServerName::try_from(name.clone()).map_err(|_| AgentError::InvalidSpec {
                    message: format!("invalid TLS server name: {name}"),
                })?
            }
            Host::Ipv4(addr) => ServerName::from(IpAddr::V4(*addr)),
            Host::Ipv6(addr) => ServerName::from(IpAddr::V6(*addr)),
        };
        let tls_stream = TlsConnector::from(tls_cfg)
            .connect(server_name, tcp)
            .await
            .map_err(|error| AgentError::Transport {
                message: format!("TLS handshake failed: {error}"),
            })?;
        Box::new(tls_stream)
    } else {
        Box::new(tcp)
    };

    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|error| AgentError::Transport {
            message: format!("HTTP/1.1 handshake failed: {error}"),
        })?;
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let response = sender
        .send_request(http_req)
        .await
        .map_err(|error| AgentError::Transport {
            message: format!("HTTP request failed: {error}"),
        })?;

    let status = response.status();
    let mut body = response.into_body();
    if !status.is_success() {
        let mut raw_err = Vec::new();
        while let Some(frame_result) = body.frame().await {
            let Ok(frame) = frame_result else {
                break;
            };
            if let Ok(chunk) = frame.into_data() {
                let remaining = MAX_ERROR_BODY_BYTES.saturating_sub(raw_err.len());
                if remaining == 0 {
                    break;
                }
                let take = chunk.len().min(remaining);
                raw_err.extend_from_slice(&chunk[..take]);
            }
        }
        let detail = String::from_utf8_lossy(&raw_err).trim().to_owned();
        let message = if detail.is_empty() {
            format!("HTTP {}", status.as_u16())
        } else {
            detail
        };
        let code = status.as_u16();
        return Err(AgentError::Provider {
            status: Some(code),
            message,
            retryable: code == 429 || code >= 500,
        });
    }

    let mut collector = RoundCollector::new(round);
    while let Some(frame_result) = body.frame().await {
        let frame = frame_result.map_err(|error| AgentError::Transport {
            message: format!("SSE stream read failed: {error}"),
        })?;
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
        for event in parser.feed_bytes(&chunk)? {
            if !collector.accept(event, tx).await {
                return Ok(collector.into_outcome());
            }
        }
    }
    for event in parser.finish()? {
        if !collector.accept(event, tx).await {
            break;
        }
    }
    Ok(collector.into_outcome())
}

struct DirectSessionRuntime {
    spec: SessionSpec,
    event_tx: mpsc::Sender<AgentEvent>,
    history: StdMutex<Vec<ConversationMessage>>,
    resume_handle: StdMutex<ResumeHandle>,
    active_cancel: StdMutex<Option<oneshot::Sender<()>>>,
}

impl DirectSessionRuntime {
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

    fn snapshot_resume_handle(&self) -> ResumeHandle {
        let count = self
            .history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len();
        let mut handle = self
            .resume_handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        handle.checkpoint_cursor = Some(count.to_string());
        handle
    }
}

/// Concrete [`AgentAdapter`] speaking Anthropic Messages, OpenAI Responses, OpenRouter, and
/// OpenAI-compatible SSE endpoints natively from Rust with zero external CLI dependency and a
/// bounded multi-round [`ToolExecutor`] loop.
pub struct DirectApiAdapter {
    provider: DirectApiProvider,
    api_key_override: Option<String>,
    tool_executor: Arc<dyn ToolExecutor>,
    transport: Arc<dyn SseTransport>,
    sessions: Arc<StdMutex<HashMap<String, Arc<DirectSessionRuntime>>>>,
}

impl fmt::Debug for DirectApiAdapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DirectApiAdapter")
            .field("provider", &self.provider)
            .field("has_api_key_override", &self.api_key_override.is_some())
            .finish()
    }
}

impl DirectApiAdapter {
    pub fn new(provider: DirectApiProvider, tool_executor: Arc<dyn ToolExecutor>) -> Self {
        Self {
            provider,
            api_key_override: None,
            tool_executor,
            transport: Arc::new(HyperSseTransport),
            sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// Injects an explicit API key (for secret-store lookup or tests; never printed by `Debug`).
    pub fn with_api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key_override = Some(api_key.into());
        self
    }

    /// Overrides the HTTP SSE transport (used by deterministic multi-round unit tests).
    pub fn with_transport(mut self, transport: Arc<dyn SseTransport>) -> Self {
        self.transport = transport;
        self
    }

    pub fn provider(&self) -> DirectApiProvider {
        self.provider
    }

    pub fn tool_executor(&self) -> &Arc<dyn ToolExecutor> {
        &self.tool_executor
    }

    fn resolve_api_key(&self, spec: &SessionSpec) -> Option<String> {
        if let Some(key) = &self.api_key_override {
            return Some(key.clone());
        }
        let env_name = spec
            .api_config
            .as_ref()
            .and_then(|cfg| cfg.api_key_env.as_deref())
            .unwrap_or_else(|| default_api_key_env(self.provider));
        spec.env
            .get(env_name)
            .cloned()
            .or_else(|| std::env::var(env_name).ok())
            .or_else(|| {
                if self.provider == DirectApiProvider::OpenAiCompatible {
                    std::env::var("OPENAI_API_KEY").ok()
                } else {
                    None
                }
            })
    }

    fn lookup_session(&self, session_id: &str) -> Result<Arc<DirectSessionRuntime>, AgentError> {
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

impl AgentAdapter for DirectApiAdapter {
    fn id(&self) -> BackendId {
        BackendId::DirectApi(self.provider)
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::direct_api()
    }

    fn detect_installed(&self) -> BoxFuture<'_, InstalledBackend> {
        let provider = self.provider;
        let has_override = self
            .api_key_override
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty());
        let report = if has_override {
            InstalledBackend::available(
                self.id(),
                crate::agent::types::DiscoverySource::EnvironmentCredentials,
            )
        } else {
            detect_direct_api_in(provider, |key| std::env::var(key).ok()).to_installed_backend()
        };
        Box::pin(async move { report })
    }

    fn start(&self, spec: SessionSpec) -> BoxFuture<'_, Result<AgentSession, AgentError>> {
        let backend = self.id();
        let caps = self.capabilities();
        let sessions = Arc::clone(&self.sessions);
        Box::pin(async move {
            if let Some(resume) = &spec.resume
                && resume.backend != backend
            {
                return Err(AgentError::InvalidResumeHandle {
                    expected: backend,
                    found: resume.backend,
                });
            }
            let (tx, rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
            let session_id = spec.session_id.clone();
            let handle = spec
                .resume
                .clone()
                .unwrap_or_else(|| ResumeHandle::new(backend, session_id.clone()));

            let runtime = Arc::new(DirectSessionRuntime {
                spec,
                event_tx: tx.clone(),
                history: StdMutex::new(Vec::new()),
                resume_handle: StdMutex::new(handle.clone()),
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

            Ok(AgentSession::new(session_id, backend, caps, rx).with_resume_handle(handle))
        })
    }

    fn send_turn<'a>(
        &'a self,
        session: &'a AgentSession,
        input: TurnInput,
    ) -> BoxFuture<'a, Result<(), AgentError>> {
        let runtime = self.lookup_session(session.id());
        let provider = self.provider;
        let tool_executor = Arc::clone(&self.tool_executor);
        let transport = Arc::clone(&self.transport);
        let tools = tool_executor.list_tools();
        let api_key = runtime
            .as_ref()
            .ok()
            .and_then(|rt| self.resolve_api_key(&rt.spec));
        Box::pin(async move {
            let runtime = runtime?;
            let messages = {
                let mut history = runtime
                    .history
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                history.push(ConversationMessage::user(input.prompt.clone()));
                history.clone()
            };

            let initial_req = build_http_request(
                provider,
                &runtime.spec,
                &messages,
                &tools,
                api_key.as_deref(),
                input.model_override.as_deref(),
            )?;
            let max_rounds = runtime
                .spec
                .api_config
                .as_ref()
                .and_then(|cfg| cfg.max_tool_rounds)
                .unwrap_or(DEFAULT_MAX_TOOL_ROUNDS)
                .max(1);

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
                let tx = runtime_bg.event_tx.clone();
                let mut next_req = Some(initial_req);

                for round in 0..max_rounds {
                    let http_req = match next_req.take() {
                        Some(req) => req,
                        None => {
                            let snapshot = runtime_bg
                                .history
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .clone();
                            match build_http_request(
                                provider,
                                &runtime_bg.spec,
                                &snapshot,
                                &tools,
                                api_key.as_deref(),
                                input.model_override.as_deref(),
                            ) {
                                Ok(req) => req,
                                Err(error) => {
                                    emit_turn_error(
                                        &tx,
                                        &error,
                                        input.turn_id.clone(),
                                        &runtime_bg,
                                    )
                                    .await;
                                    break;
                                }
                            }
                        }
                    };

                    let round_result = tokio::select! {
                        result = transport.stream_round(provider, &http_req, round, &tx) => Some(result),
                        _ = &mut cancel_rx => None,
                    };

                    let Some(round_result) = round_result else {
                        let _ = tx
                            .send(AgentEvent::TurnFinished {
                                turn_id: input.turn_id.clone(),
                                reason: TurnFinishReason::Interrupted,
                                resume_handle: Some(Box::new(runtime_bg.snapshot_resume_handle())),
                            })
                            .await;
                        break;
                    };

                    let outcome = match round_result {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            emit_turn_error(&tx, &error, input.turn_id.clone(), &runtime_bg).await;
                            break;
                        }
                    };

                    if !outcome.tool_calls.is_empty() {
                        runtime_bg
                            .history
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .push(ConversationMessage::assistant_with_tools(
                                outcome.assistant_text,
                                outcome.tool_calls.clone(),
                            ));
                    } else if !outcome.assistant_text.is_empty() {
                        runtime_bg
                            .history
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .push(ConversationMessage::assistant(outcome.assistant_text));
                    }

                    if outcome.tool_calls.is_empty() || tools.is_empty() {
                        let final_event =
                            outcome
                                .terminal_event
                                .unwrap_or_else(|| AgentEvent::TurnFinished {
                                    turn_id: input.turn_id.clone(),
                                    reason: outcome.finish_reason,
                                    resume_handle: Some(Box::new(
                                        runtime_bg.snapshot_resume_handle(),
                                    )),
                                });
                        let _ = tx.send(final_event).await;
                        break;
                    }

                    if round + 1 >= max_rounds {
                        let _ = tx
                            .send(AgentEvent::Error {
                                code: "max_tool_rounds".to_owned(),
                                message: format!("reached maximum tool rounds ({max_rounds})"),
                                retryable: false,
                            })
                            .await;
                        let _ = tx
                            .send(AgentEvent::TurnFinished {
                                turn_id: input.turn_id.clone(),
                                reason: TurnFinishReason::MaxTokens,
                                resume_handle: Some(Box::new(runtime_bg.snapshot_resume_handle())),
                            })
                            .await;
                        break;
                    }

                    let mut cancelled = false;
                    for call in outcome.tool_calls {
                        let invocation = ToolInvocation {
                            call_id: call.call_id.clone(),
                            name: call.name.clone(),
                            arguments: call.arguments,
                            cwd: runtime_bg.spec.cwd.clone(),
                        };
                        let exec_result = tokio::select! {
                            res = tool_executor.execute(invocation) => Some(res),
                            _ = &mut cancel_rx => None,
                        };
                        let Some(exec_result) = exec_result else {
                            let _ = tx
                                .send(AgentEvent::TurnFinished {
                                    turn_id: input.turn_id.clone(),
                                    reason: TurnFinishReason::Interrupted,
                                    resume_handle: Some(Box::new(
                                        runtime_bg.snapshot_resume_handle(),
                                    )),
                                })
                                .await;
                            cancelled = true;
                            break;
                        };
                        let (output, is_error) = match exec_result {
                            Ok(result) => (result.output, result.is_error),
                            Err(error) => (error.to_string(), true),
                        };
                        let _ = tx
                            .send(AgentEvent::ToolCallFinished {
                                call_id: call.call_id.clone(),
                                name: Some(call.name.clone()),
                                output: Some(output.clone()),
                                is_error,
                            })
                            .await;
                        runtime_bg
                            .history
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .push(ConversationMessage::tool_result(
                                call.call_id,
                                call.name,
                                output,
                                is_error,
                            ));
                    }
                    if cancelled {
                        break;
                    }
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

    fn steer<'a>(
        &'a self,
        session: &'a AgentSession,
        input: TurnInput,
    ) -> BoxFuture<'a, Result<(), AgentError>> {
        let runtime = self.lookup_session(session.id());
        Box::pin(async move {
            let runtime = runtime?;
            runtime
                .history
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(ConversationMessage::user(input.prompt));
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
        let backend = self.id();
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
                rt.snapshot_resume_handle()
            } else {
                session
                    .resume_handle()
                    .cloned()
                    .unwrap_or_else(|| ResumeHandle::new(backend, session_id))
            };
            session.set_pid(None);
            session.set_state(SessionLifecycleState::Hibernated);
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

async fn emit_turn_error(
    tx: &mpsc::Sender<AgentEvent>,
    error: &AgentError,
    turn_id: Option<String>,
    runtime: &DirectSessionRuntime,
) {
    let _ = tx
        .send(AgentEvent::Error {
            code: error.code().to_owned(),
            message: error.to_string(),
            retryable: error.is_retryable(),
        })
        .await;
    let _ = tx
        .send(AgentEvent::TurnFinished {
            turn_id,
            reason: TurnFinishReason::Error,
            resume_handle: Some(Box::new(runtime.snapshot_resume_handle())),
        })
        .await;
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::fs;

    use super::*;
    use crate::agent::tools::LocalToolExecutor;
    use crate::agent::types::DirectApiConfig;

    struct MockEchoTool;

    impl ToolExecutor for MockEchoTool {
        fn list_tools(&self) -> Vec<ToolSchema> {
            vec![ToolSchema {
                name: "read_file".to_owned(),
                description: "Read a workspace file".to_owned(),
                input_schema: json!({
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"],
                }),
            }]
        }

        fn execute(
            &self,
            invocation: ToolInvocation,
        ) -> BoxFuture<'_, Result<ToolExecutionResult, AgentError>> {
            Box::pin(async move {
                Ok(ToolExecutionResult {
                    output: format!("executed {}:{}", invocation.name, invocation.call_id),
                    is_error: false,
                })
            })
        }
    }

    struct ScriptedSseTransport {
        rounds: StdMutex<VecDeque<String>>,
        captured_requests: StdMutex<Vec<DirectApiHttpRequest>>,
    }

    impl ScriptedSseTransport {
        fn new(rounds: Vec<String>) -> Self {
            Self {
                rounds: StdMutex::new(rounds.into()),
                captured_requests: StdMutex::new(Vec::new()),
            }
        }

        fn captured(&self) -> Vec<DirectApiHttpRequest> {
            self.captured_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }
    }

    impl SseTransport for ScriptedSseTransport {
        fn stream_round<'a>(
            &'a self,
            provider: DirectApiProvider,
            request: &'a DirectApiHttpRequest,
            round: u32,
            tx: &'a mpsc::Sender<AgentEvent>,
        ) -> BoxFuture<'a, Result<RoundOutcome, AgentError>> {
            self.captured_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(request.clone());
            let sse = self
                .rounds
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pop_front()
                .unwrap_or_default();
            Box::pin(async move {
                let mut parser = DirectSseParser::new(provider);
                let chunks: Vec<Vec<u8>> = sse.as_bytes().chunks(31).map(<[u8]>::to_vec).collect();
                drive_sse_round(chunks, &mut parser, round, tx).await
            })
        }
    }

    #[test]
    fn builds_provider_payloads_including_tool_results_and_redacts_secrets() {
        let tools = MockEchoTool.list_tools();
        let messages = [
            ConversationMessage::user("Read Cargo.toml"),
            ConversationMessage::assistant_with_tools(
                "Reading now.",
                vec![RecordedToolCall {
                    call_id: "tc_1".to_owned(),
                    name: "read_file".to_owned(),
                    arguments: json!({ "path": "Cargo.toml" }),
                }],
            ),
            ConversationMessage::tool_result("tc_1", "read_file", "[workspace]", false),
        ];
        let mut spec = SessionSpec::new("tab-api", "/repo");
        spec.system_prompt = Some("Be terse.".to_owned());

        let secret = "sk-ant-never-log-this-secret";
        let anth = build_http_request(
            DirectApiProvider::Anthropic,
            &spec,
            &messages,
            &tools,
            Some(secret),
            None,
        )
        .unwrap();
        assert_eq!(anth.url, "https://api.anthropic.com/v1/messages");
        assert!(anth.has_auth_header("x-api-key"));
        assert_eq!(anth.auth_header_names(), ["x-api-key"]);
        assert_eq!(anth.body["messages"][1]["content"][1]["type"], "tool_use");
        assert_eq!(anth.body["messages"][2]["role"], "user");
        assert_eq!(
            anth.body["messages"][2]["content"][0]["type"],
            "tool_result"
        );
        assert_eq!(
            anth.body["messages"][2]["content"][0]["tool_use_id"],
            "tc_1"
        );
        let debug_text = format!("{anth:?}");
        assert!(!debug_text.contains(secret));
        assert!(debug_text.contains("[REDACTED]"));

        let openai = build_http_request(
            DirectApiProvider::OpenAi,
            &spec,
            &messages,
            &tools,
            Some("sk-openai-secret"),
            Some("gpt-5.4"),
        )
        .unwrap();
        assert_eq!(openai.url, "https://api.openai.com/v1/responses");
        assert!(openai.has_auth_header("authorization"));
        assert_eq!(openai.body["input"][2]["type"], "function_call");
        assert_eq!(openai.body["input"][3]["type"], "function_call_output");
        assert_eq!(openai.body["input"][3]["call_id"], "tc_1");
        assert!(!format!("{openai:?}").contains("sk-openai-secret"));

        let mut compat_spec = SessionSpec::new("tab-local", "/repo");
        compat_spec.api_config = Some(DirectApiConfig {
            provider: DirectApiProvider::OpenAiCompatible,
            base_url: Some("http://127.0.0.1:11434/v1".to_owned()),
            api_key_env: None,
            max_output_tokens: Some(1024),
            max_tool_rounds: Some(4),
        });
        let local = build_http_request(
            DirectApiProvider::OpenAiCompatible,
            &compat_spec,
            &messages,
            &tools,
            None,
            Some("qwen2.5-coder"),
        )
        .unwrap();
        assert_eq!(local.url, "http://127.0.0.1:11434/v1/chat/completions");
        assert!(local.auth_header_names().is_empty());
        assert_eq!(local.body["messages"][1]["tool_calls"][0]["id"], "tc_1");
        assert_eq!(local.body["messages"][2]["role"], "tool");
        assert_eq!(local.body["messages"][2]["tool_call_id"], "tc_1");

        // Cloud provider without API key fails with NotInstalled.
        let missing = build_http_request(
            DirectApiProvider::OpenRouter,
            &spec,
            &messages,
            &[],
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(missing.code(), "not_installed");
    }

    #[tokio::test]
    async fn executes_two_round_tool_loop_end_to_end_with_local_tool_executor() {
        let ws = tempfile::tempdir().unwrap();
        fs::write(ws.path().join("hello.txt"), "hello from momo workspace\n").unwrap();

        let round1 = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_r1\",\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":20}}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_read_1\",\"name\":\"read_file\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"hello.txt\\\"}\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":10}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        )
        .to_owned();

        let round2 = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_r2\",\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":50}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"The file says: hello from momo workspace.\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":14}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        )
        .to_owned();

        let transport = Arc::new(ScriptedSseTransport::new(vec![round1, round2]));
        let executor = Arc::new(LocalToolExecutor::with_root(ws.path()));
        let adapter = DirectApiAdapter::new(DirectApiProvider::Anthropic, executor)
            .with_api_key("sk-ant-loop-test")
            .with_transport(Arc::clone(&transport) as Arc<dyn SseTransport>);

        let mut session = adapter
            .start(SessionSpec::new("tab-loop", ws.path()))
            .await
            .unwrap();
        let mut rx = session.take_events().unwrap();

        adapter
            .send_turn(&session, TurnInput::text("Read hello.txt"))
            .await
            .unwrap();

        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            let done = matches!(ev, AgentEvent::TurnFinished { .. });
            events.push(ev);
            if done {
                break;
            }
        }

        // Exactly one TurnStarted and one final TurnFinished(Completed) across the 2 rounds.
        let started_count = events
            .iter()
            .filter(|ev| matches!(ev, AgentEvent::TurnStarted { .. }))
            .count();
        assert_eq!(started_count, 1);

        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::ToolCallStarted { call_id, name, .. }
                if call_id == "tu_read_1" && name == "read_file"
        )));
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::ToolCallFinished {
                call_id,
                output: Some(out),
                is_error: false,
                ..
            } if call_id == "tu_read_1" && out.contains("hello from momo workspace")
        )));
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::TextDelta { text, .. } if text.contains("hello from momo workspace")
        )));
        assert!(matches!(
            events.last(),
            Some(AgentEvent::TurnFinished {
                reason: TurnFinishReason::Completed,
                ..
            })
        ));

        // Round 2 request must contain the assistant tool_use and Anthropic user tool_result block.
        let requests = transport.captured();
        assert_eq!(requests.len(), 2);
        let round2_msgs = &requests[1].body["messages"];
        assert_eq!(round2_msgs[1]["role"], "assistant");
        assert_eq!(round2_msgs[1]["content"][0]["type"], "tool_use");
        assert_eq!(round2_msgs[2]["role"], "user");
        assert_eq!(round2_msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(round2_msgs[2]["content"][0]["tool_use_id"], "tu_read_1");
        assert!(
            round2_msgs[2]["content"][0]["content"]
                .as_str()
                .unwrap()
                .contains("hello from momo workspace")
        );
    }

    #[tokio::test]
    async fn drives_mock_sse_chunks_and_preserves_hibernation_cursor() {
        let sse = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m_sse\",\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":12}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello \"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Rust!\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let chunks: Vec<Vec<u8>> = sse.as_bytes().chunks(23).map(<[u8]>::to_vec).collect();
        let (tx, mut rx) = mpsc::channel(16);
        let mut parser = DirectSseParser::new(DirectApiProvider::Anthropic);
        let reply = drive_sse_byte_chunks(chunks, &mut parser, &tx)
            .await
            .unwrap();
        assert_eq!(reply, "Hello Rust!");
        drop(tx);

        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::TurnFinished {
                reason: TurnFinishReason::Completed,
                ..
            }
        )));

        let executor = Arc::new(MockEchoTool);
        let adapter = DirectApiAdapter::new(DirectApiProvider::Anthropic, executor)
            .with_api_key("sk-ant-test-key");
        assert!(!format!("{adapter:?}").contains("sk-ant-test-key"));
        assert!(adapter.detect_installed().await.is_available());

        let mut session = adapter
            .start(SessionSpec::new("tab-direct-1", "/repo"))
            .await
            .unwrap();
        assert!(session.pid().is_none());
        adapter
            .steer(&session, TurnInput::text("focus on tests"))
            .await
            .unwrap();
        let handle = adapter.hibernate(&mut session).await.unwrap();
        assert_eq!(handle.checkpoint_cursor.as_deref(), Some("1"));
        assert_eq!(session.state(), SessionLifecycleState::Hibernated);

        let resumed = adapter
            .resume(handle.clone(), SessionSpec::new("tab-direct-1", "/repo"))
            .await
            .unwrap();
        assert_eq!(resumed.resume_handle(), Some(&handle));
    }
}
