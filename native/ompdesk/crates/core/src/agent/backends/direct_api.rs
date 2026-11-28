//! Concrete [`AgentAdapter`] for Direct LLM API streaming over native Rust HTTP/1.1 + TLS.
//!
//! Uses `ompdesk-core`'s existing `hyper` + `hyper-util` + `http-body-util` + `tokio-rustls` +
//! `crate::http::machine_tls()` stack (zero external CLI, zero `Cargo.lock` additions), streams
//! response chunks incrementally through [`DirectSseParser`], redacts secrets from all `Debug`
//! surfaces, and exposes a [`ToolExecutor`] hook for Stage 2B local/MCP tool execution.

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

/// Default zero-tool [`ToolExecutor`] used until Stage 2B binds workspace and `mcp_hub` tools.
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
}

/// One persisted conversation message sent on subsequent Direct API turns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub role: ConversationRole,
    pub content: String,
}

impl ConversationMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: ConversationRole::User,
            content: content.into(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: ConversationRole::Assistant,
            content: content.into(),
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
    let msg_values: Vec<Value> = messages
        .iter()
        .map(|msg| {
            json!({
                "role": match msg.role {
                    ConversationRole::User => "user",
                    ConversationRole::Assistant => "assistant",
                },
                "content": msg.content,
            })
        })
        .collect();
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
    let input_values: Vec<Value> = messages
        .iter()
        .map(|msg| {
            json!({
                "role": match msg.role {
                    ConversationRole::User => "user",
                    ConversationRole::Assistant => "assistant",
                },
                "content": msg.content,
            })
        })
        .collect();
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
        msg_values.push(json!({
            "role": match msg.role {
                ConversationRole::User => "user",
                ConversationRole::Assistant => "assistant",
            },
            "content": msg.content,
        }));
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
    tx: &mpsc::Sender<AgentEvent>,
) -> Result<String, AgentError> {
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

    let mut assistant_text = String::new();
    while let Some(frame_result) = body.frame().await {
        let frame = frame_result.map_err(|error| AgentError::Transport {
            message: format!("SSE stream read failed: {error}"),
        })?;
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
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
/// OpenAI-compatible SSE endpoints natively from Rust with zero external CLI dependency.
pub struct DirectApiAdapter {
    provider: DirectApiProvider,
    api_key_override: Option<String>,
    tool_executor: Arc<dyn ToolExecutor>,
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
            sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// Injects an explicit API key (for secret-store lookup or tests; never printed by `Debug`).
    pub fn with_api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key_override = Some(api_key.into());
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
        let tools = self.tool_executor.list_tools();
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

            let http_req = build_http_request(
                provider,
                &runtime.spec,
                &messages,
                &tools,
                api_key.as_deref(),
                input.model_override.as_deref(),
            )?;

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
                let mut parser = DirectSseParser::new(provider);
                let tx = runtime_bg.event_tx.clone();
                tokio::select! {
                    result = stream_http_sse(&http_req, &mut parser, &tx) => {
                        match result {
                            Ok(reply_text) => {
                                if !reply_text.is_empty() {
                                    runtime_bg
                                        .history
                                        .lock()
                                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                                        .push(ConversationMessage::assistant(reply_text));
                                }
                            }
                            Err(error) => {
                                let _ = tx
                                    .send(AgentEvent::Error {
                                        code: error.code().to_owned(),
                                        message: error.to_string(),
                                        retryable: error.is_retryable(),
                                    })
                                    .await;
                                let _ = tx
                                    .send(AgentEvent::TurnFinished {
                                        turn_id: input.turn_id,
                                        reason: TurnFinishReason::Error,
                                        resume_handle: Some(Box::new(
                                            runtime_bg.snapshot_resume_handle(),
                                        )),
                                    })
                                    .await;
                            }
                        }
                    }
                    _ = &mut cancel_rx => {
                        let _ = tx
                            .send(AgentEvent::TurnFinished {
                                turn_id: input.turn_id,
                                reason: TurnFinishReason::Interrupted,
                                resume_handle: Some(Box::new(runtime_bg.snapshot_resume_handle())),
                            })
                            .await;
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

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn builds_provider_payloads_and_redacts_secret_auth_headers_in_debug() {
        let tools = MockEchoTool.list_tools();
        let messages = [ConversationMessage::user("Explain Cargo.toml")];
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
        assert_eq!(anth.body["stream"], true);
        assert_eq!(anth.body["system"], "Be terse.");
        assert_eq!(anth.body["tools"][0]["name"], "read_file");
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
        assert_eq!(openai.body["instructions"], "Be terse.");
        assert_eq!(openai.body["tools"][0]["type"], "function");
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
        assert_eq!(local.body["max_tokens"], 1024);

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
    fn drives_mock_sse_chunks_through_parser_and_verifies_tool_executor_and_hibernation() {
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
        let exec_res = executor
            .execute(ToolInvocation {
                call_id: "c1".to_owned(),
                name: "read_file".to_owned(),
                arguments: json!({ "path": "Cargo.toml" }),
                cwd: PathBuf::from("/repo"),
            })
            .await
            .unwrap();
        assert!(!exec_res.is_error);
        assert_eq!(exec_res.output, "executed read_file:c1");

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
