//! Normalized domain types for the agent-neutral Rust runtime.

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Top-level execution backend family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    ProviderCli,
    Omp,
    DirectApi,
}

impl fmt::Display for BackendKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProviderCli => f.write_str("provider_cli"),
            Self::Omp => f.write_str("omp"),
            Self::DirectApi => f.write_str("direct_api"),
        }
    }
}

/// Supported external provider CLIs under [`BackendKind::ProviderCli`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCliKind {
    ClaudeCode,
    Codex,
    Antigravity,
    GenericPty,
}

impl fmt::Display for ProviderCliKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ClaudeCode => f.write_str("claude_code"),
            Self::Codex => f.write_str("codex"),
            Self::Antigravity => f.write_str("antigravity"),
            Self::GenericPty => f.write_str("generic_pty"),
        }
    }
}

/// Supported HTTP API providers under [`BackendKind::DirectApi`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectApiProvider {
    Anthropic,
    OpenAi,
    OpenRouter,
    OpenAiCompatible,
}

impl fmt::Display for DirectApiProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Anthropic => f.write_str("anthropic"),
            Self::OpenAi => f.write_str("openai"),
            Self::OpenRouter => f.write_str("openrouter"),
            Self::OpenAiCompatible => f.write_str("openai_compatible"),
        }
    }
}

/// Exact concrete backend identifier combining [`BackendKind`] with its provider discriminator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "provider", rename_all = "snake_case")]
pub enum BackendId {
    ProviderCli(ProviderCliKind),
    Omp,
    DirectApi(DirectApiProvider),
}

impl BackendId {
    /// Returns the coarse backend family.
    pub const fn kind(self) -> BackendKind {
        match self {
            Self::ProviderCli(_) => BackendKind::ProviderCli,
            Self::Omp => BackendKind::Omp,
            Self::DirectApi(_) => BackendKind::DirectApi,
        }
    }

    /// Canonical lowercase identifier suitable for logs, persistence keys, and diagnostics.
    pub const fn canonical_name(self) -> &'static str {
        match self {
            Self::ProviderCli(ProviderCliKind::ClaudeCode) => "claude_code",
            Self::ProviderCli(ProviderCliKind::Codex) => "codex",
            Self::ProviderCli(ProviderCliKind::Antigravity) => "antigravity",
            Self::ProviderCli(ProviderCliKind::GenericPty) => "generic_pty",
            Self::Omp => "omp",
            Self::DirectApi(DirectApiProvider::Anthropic) => "anthropic",
            Self::DirectApi(DirectApiProvider::OpenAi) => "openai",
            Self::DirectApi(DirectApiProvider::OpenRouter) => "openrouter",
            Self::DirectApi(DirectApiProvider::OpenAiCompatible) => "openai_compatible",
        }
    }
}

impl fmt::Display for BackendId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_name())
    }
}

/// Explicit feature surface advertised by an [`crate::agent::AgentAdapter`].
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub streaming_text: bool,
    pub streaming_thinking: bool,
    pub structured_tool_calls: bool,
    pub tool_approvals: bool,
    pub mid_turn_steer: bool,
    pub interrupt: bool,
    pub resume: bool,
    pub idle_hibernation: bool,
    pub mcp_bridge: bool,
    pub built_in_tool_loop: bool,
    pub requires_external_cli: bool,
}

impl AgentCapabilities {
    /// Baseline capabilities for each Provider CLI backend.
    pub const fn provider_cli(cli: ProviderCliKind) -> Self {
        match cli {
            ProviderCliKind::ClaudeCode | ProviderCliKind::Codex | ProviderCliKind::Antigravity => {
                Self {
                    streaming_text: true,
                    streaming_thinking: true,
                    structured_tool_calls: true,
                    tool_approvals: true,
                    mid_turn_steer: true,
                    interrupt: true,
                    resume: true,
                    idle_hibernation: true,
                    mcp_bridge: true,
                    built_in_tool_loop: false,
                    requires_external_cli: true,
                }
            }
            ProviderCliKind::GenericPty => Self {
                streaming_text: true,
                streaming_thinking: false,
                structured_tool_calls: false,
                tool_approvals: false,
                mid_turn_steer: false,
                interrupt: true,
                resume: false,
                idle_hibernation: false,
                mcp_bridge: false,
                built_in_tool_loop: false,
                requires_external_cli: true,
            },
        }
    }

    /// Baseline capabilities for the stock `omp` adapter (`omp --mode rpc-ui` + `gui-bridge`).
    pub const fn omp() -> Self {
        Self {
            streaming_text: true,
            streaming_thinking: true,
            structured_tool_calls: true,
            tool_approvals: true,
            mid_turn_steer: true,
            interrupt: true,
            resume: true,
            idle_hibernation: true,
            mcp_bridge: true,
            built_in_tool_loop: false,
            requires_external_cli: true,
        }
    }

    /// Baseline capabilities for the native Rust Direct LLM API backend.
    pub const fn direct_api() -> Self {
        Self {
            streaming_text: true,
            streaming_thinking: true,
            structured_tool_calls: true,
            tool_approvals: true,
            mid_turn_steer: true,
            interrupt: true,
            resume: true,
            idle_hibernation: true,
            mcp_bridge: true,
            built_in_tool_loop: true,
            requires_external_cli: false,
        }
    }

    /// Returns `true` when every flag requested in `required` is satisfied.
    pub fn satisfies(&self, required: &CapabilityRequirements) -> bool {
        self.missing_for(required).is_empty()
    }

    /// Names every capability requested in `required` that this backend does not provide.
    pub fn missing_for(&self, required: &CapabilityRequirements) -> Vec<&'static str> {
        let checks = [
            (
                required.streaming_text,
                self.streaming_text,
                "streaming_text",
            ),
            (
                required.streaming_thinking,
                self.streaming_thinking,
                "streaming_thinking",
            ),
            (
                required.structured_tool_calls,
                self.structured_tool_calls,
                "structured_tool_calls",
            ),
            (
                required.tool_approvals,
                self.tool_approvals,
                "tool_approvals",
            ),
            (
                required.mid_turn_steer,
                self.mid_turn_steer,
                "mid_turn_steer",
            ),
            (required.interrupt, self.interrupt, "interrupt"),
            (required.resume, self.resume, "resume"),
            (
                required.idle_hibernation,
                self.idle_hibernation,
                "idle_hibernation",
            ),
            (required.mcp_bridge, self.mcp_bridge, "mcp_bridge"),
            (
                required.no_external_cli,
                !self.requires_external_cli,
                "no_external_cli",
            ),
        ];
        checks
            .into_iter()
            .filter_map(|(need, have, name)| (need && !have).then_some(name))
            .collect()
    }
}

/// Capabilities a caller requires when resolving a backend from [`crate::agent::AdapterRegistry`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CapabilityRequirements {
    pub streaming_text: bool,
    pub streaming_thinking: bool,
    pub structured_tool_calls: bool,
    pub tool_approvals: bool,
    pub mid_turn_steer: bool,
    pub interrupt: bool,
    pub resume: bool,
    pub idle_hibernation: bool,
    pub mcp_bridge: bool,
    pub no_external_cli: bool,
}

impl CapabilityRequirements {
    pub const fn with_streaming_text(mut self) -> Self {
        self.streaming_text = true;
        self
    }

    pub const fn with_streaming_thinking(mut self) -> Self {
        self.streaming_thinking = true;
        self
    }

    pub const fn with_structured_tool_calls(mut self) -> Self {
        self.structured_tool_calls = true;
        self
    }

    pub const fn with_tool_approvals(mut self) -> Self {
        self.tool_approvals = true;
        self
    }

    pub const fn with_mid_turn_steer(mut self) -> Self {
        self.mid_turn_steer = true;
        self
    }

    pub const fn with_interrupt(mut self) -> Self {
        self.interrupt = true;
        self
    }

    pub const fn with_resume(mut self) -> Self {
        self.resume = true;
        self
    }

    pub const fn with_idle_hibernation(mut self) -> Self {
        self.idle_hibernation = true;
        self
    }

    pub const fn with_mcp_bridge(mut self) -> Self {
        self.mcp_bridge = true;
        self
    }

    pub const fn with_no_external_cli(mut self) -> Self {
        self.no_external_cli = true;
        self
    }
}

/// Session-level approval policy applied consistently across backends.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    #[default]
    Ask,
    AutoApprove,
    ReadOnly,
    FullAccess,
}

/// Loopback or external MCP server passed into an agent session (such as core `mcp_hub`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEndpointSpec {
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearer_token: Option<String>,
}

/// Endpoint configuration used when launching a [`BackendKind::DirectApi`] session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectApiConfig {
    pub provider: DirectApiProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_rounds: Option<u32>,
}

/// Opaque backend-native handle persisted across restarts and idle hibernation.
///
/// Examples:
/// - Claude Code: `session_id` UUID passed to `--resume`
/// - Codex CLI: `thread_id` passed to `thread/resume` or `codex exec resume`
/// - OMP: session JSONL path (plus optional leaf entry ID cursor)
/// - Direct API: local journal identifier (plus optional message index cursor)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeHandle {
    pub backend: BackendId,
    pub native_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, String>,
}

impl ResumeHandle {
    pub fn new(backend: BackendId, native_id: impl Into<String>) -> Self {
        Self {
            backend,
            native_id: native_id.into(),
            cwd: None,
            checkpoint_cursor: None,
            metadata: BTreeMap::new(),
        }
    }
}

/// Backend-neutral parameters required to launch or resume an agent session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpec {
    pub session_id: String,
    pub cwd: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<BackendId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<ResumeHandle>,
    #[serde(default)]
    pub approval_mode: ApprovalMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_endpoints: Vec<McpEndpointSpec>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_config: Option<DirectApiConfig>,
}

impl SessionSpec {
    pub fn new(session_id: impl Into<String>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            session_id: session_id.into(),
            cwd: cwd.into(),
            backend: None,
            model: None,
            system_prompt: None,
            resume: None,
            approval_mode: ApprovalMode::Ask,
            mcp_endpoints: Vec::new(),
            env: BTreeMap::new(),
            extra_args: Vec::new(),
            api_config: None,
        }
    }
}

/// Optional attachment bundled with a user turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAttachment {
    pub name: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
}

/// Input payload submitted for a new turn or mid-turn steer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<TurnAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_override: Option<String>,
}

impl TurnInput {
    pub fn text(prompt: impl Into<String>) -> Self {
        Self {
            turn_id: None,
            prompt: prompt.into(),
            attachments: Vec::new(),
            model_override: None,
        }
    }
}

/// Coarse lifecycle state of a live or hibernated agent session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionLifecycleState {
    Starting,
    Ready,
    Running,
    WaitingForApproval,
    Hibernating,
    Hibernated,
    Stopping,
    Stopped,
    Error,
}

/// Normalized completion reason for an agent turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnFinishReason {
    Completed,
    Interrupted,
    MaxTokens,
    ToolUse,
    Error,
    Unknown,
}

/// Category of interactive approval or prompt requested by a backend.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalKind {
    ToolExecution,
    CommandExecution,
    FileEdit,
    UserQuestion,
    #[default]
    Generic,
}

/// User or policy decision answering an [`AgentEvent::ApprovalRequested`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum ApprovalDecision {
    AllowOnce,
    AllowSession,
    Deny {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

/// Token accounting and optional cost reported for a turn or step.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    #[serde(default)]
    pub reasoning_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

impl TokenUsage {
    /// Returns `true` when no token counts or cost were populated.
    pub fn is_empty(&self) -> bool {
        self.input_tokens == 0
            && self.output_tokens == 0
            && self.cache_read_tokens == 0
            && self.cache_write_tokens == 0
            && self.reasoning_tokens == 0
            && self.cost_usd.is_none()
    }
}

/// Normalized event stream emitted by every backend adapter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    TurnStarted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_handle: Option<Box<ResumeHandle>>,
    },
    TextDelta {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_index: Option<u32>,
    },
    ThinkingDelta {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_index: Option<u32>,
    },
    ToolCallStarted {
        call_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arguments: Option<Box<Value>>,
    },
    ToolCallDelta {
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arguments_delta: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_delta: Option<String>,
    },
    ToolCallFinished {
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        #[serde(default)]
        is_error: bool,
    },
    ApprovalRequested {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_name: Option<String>,
        summary: String,
        #[serde(default)]
        kind: ApprovalKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<Box<Value>>,
    },
    Usage {
        usage: TokenUsage,
    },
    TurnFinished {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        reason: TurnFinishReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_handle: Option<Box<ResumeHandle>>,
    },
    SessionStateChanged {
        state: SessionLifecycleState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    Error {
        code: String,
        message: String,
        #[serde(default)]
        retryable: bool,
    },
}

/// Origin of a discovered backend binary or credential set.
///
/// Precedence follows the user-install-first invariant:
/// `UserInstall` > `ManagedCopy` > `EnvironmentCredentials` > `Builtin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoverySource {
    UserInstall,
    ManagedCopy,
    EnvironmentCredentials,
    Builtin,
}

impl DiscoverySource {
    /// Higher value wins when multiple installations are discovered for the same backend.
    pub const fn priority(self) -> u8 {
        match self {
            Self::UserInstall => 4,
            Self::ManagedCopy => 3,
            Self::EnvironmentCredentials => 2,
            Self::Builtin => 1,
        }
    }
}

/// Health classification returned by [`crate::agent::AgentAdapter::detect_installed`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallStatus {
    Available,
    VersionTooOld,
    Missing,
    Unauthenticated,
    Broken,
}

/// Discovery record for one backend on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledBackend {
    pub backend: BackendId,
    pub status: InstallStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<DiscoverySource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl InstalledBackend {
    pub fn available(backend: BackendId, source: DiscoverySource) -> Self {
        Self {
            backend,
            status: InstallStatus::Available,
            source: Some(source),
            executable_path: None,
            version: None,
            detail: None,
        }
    }

    pub fn missing(backend: BackendId, detail: impl Into<String>) -> Self {
        Self {
            backend,
            status: InstallStatus::Missing,
            source: None,
            executable_path: None,
            version: None,
            detail: Some(detail.into()),
        }
    }

    pub fn is_available(&self) -> bool {
        self.status == InstallStatus::Available
    }
}

/// Structured error type shared across adapters, parsers, and registry resolution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum AgentError {
    NotInstalled {
        backend: BackendId,
        detail: String,
    },
    UnsupportedCapability {
        backend: BackendId,
        capability: String,
    },
    NoMatchingBackend {
        reason: String,
    },
    InvalidSpec {
        message: String,
    },
    InvalidResumeHandle {
        expected: BackendId,
        found: BackendId,
    },
    SessionNotReady {
        state: SessionLifecycleState,
    },
    SpawnFailed {
        message: String,
    },
    Transport {
        message: String,
    },
    Protocol {
        message: String,
    },
    Timeout {
        operation: String,
    },
    Cancelled,
    Provider {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        message: String,
        #[serde(default)]
        retryable: bool,
    },
}

impl AgentError {
    /// Stable machine-readable error code matching the serde discriminator.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::NotInstalled { .. } => "not_installed",
            Self::UnsupportedCapability { .. } => "unsupported_capability",
            Self::NoMatchingBackend { .. } => "no_matching_backend",
            Self::InvalidSpec { .. } => "invalid_spec",
            Self::InvalidResumeHandle { .. } => "invalid_resume_handle",
            Self::SessionNotReady { .. } => "session_not_ready",
            Self::SpawnFailed { .. } => "spawn_failed",
            Self::Transport { .. } => "transport",
            Self::Protocol { .. } => "protocol",
            Self::Timeout { .. } => "timeout",
            Self::Cancelled => "cancelled",
            Self::Provider { .. } => "provider",
        }
    }

    /// Whether a caller may safely retry the failed operation without user intervention.
    pub const fn is_retryable(&self) -> bool {
        match self {
            Self::Transport { .. } | Self::Timeout { .. } => true,
            Self::Provider { retryable, .. } => *retryable,
            _ => false,
        }
    }
}

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotInstalled { backend, detail } => {
                write!(f, "backend {backend} is not installed: {detail}")
            }
            Self::UnsupportedCapability {
                backend,
                capability,
            } => write!(f, "backend {backend} does not support {capability}"),
            Self::NoMatchingBackend { reason } => write!(f, "no matching backend: {reason}"),
            Self::InvalidSpec { message } => write!(f, "invalid session spec: {message}"),
            Self::InvalidResumeHandle { expected, found } => write!(
                f,
                "resume handle backend mismatch: expected {expected}, found {found}"
            ),
            Self::SessionNotReady { state } => write!(f, "session is not ready ({state:?})"),
            Self::SpawnFailed { message } => write!(f, "failed to spawn backend: {message}"),
            Self::Transport { message } => write!(f, "transport error: {message}"),
            Self::Protocol { message } => write!(f, "protocol parse error: {message}"),
            Self::Timeout { operation } => write!(f, "operation timed out: {operation}"),
            Self::Cancelled => f.write_str("operation cancelled"),
            Self::Provider {
                status: Some(code),
                message,
                ..
            } => write!(f, "provider error ({code}): {message}"),
            Self::Provider {
                status: None,
                message,
                ..
            } => write!(f, "provider error: {message}"),
        }
    }
}

impl std::error::Error for AgentError {}

impl From<std::io::Error> for AgentError {
    fn from(error: std::io::Error) -> Self {
        Self::Transport {
            message: error.to_string(),
        }
    }
}

impl From<serde_json::Error> for AgentError {
    fn from(error: serde_json::Error) -> Self {
        Self::Protocol {
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn backend_id_round_trips_and_maps_to_expected_family() {
        let cases = [
            (
                BackendId::ProviderCli(ProviderCliKind::ClaudeCode),
                BackendKind::ProviderCli,
                "claude_code",
            ),
            (
                BackendId::ProviderCli(ProviderCliKind::Codex),
                BackendKind::ProviderCli,
                "codex",
            ),
            (
                BackendId::ProviderCli(ProviderCliKind::Antigravity),
                BackendKind::ProviderCli,
                "antigravity",
            ),
            (
                BackendId::ProviderCli(ProviderCliKind::GenericPty),
                BackendKind::ProviderCli,
                "generic_pty",
            ),
            (BackendId::Omp, BackendKind::Omp, "omp"),
            (
                BackendId::DirectApi(DirectApiProvider::Anthropic),
                BackendKind::DirectApi,
                "anthropic",
            ),
            (
                BackendId::DirectApi(DirectApiProvider::OpenAi),
                BackendKind::DirectApi,
                "openai",
            ),
            (
                BackendId::DirectApi(DirectApiProvider::OpenRouter),
                BackendKind::DirectApi,
                "openrouter",
            ),
            (
                BackendId::DirectApi(DirectApiProvider::OpenAiCompatible),
                BackendKind::DirectApi,
                "openai_compatible",
            ),
        ];

        for (id, expected_kind, expected_name) in cases {
            assert_eq!(id.kind(), expected_kind);
            assert_eq!(id.canonical_name(), expected_name);
            let encoded = serde_json::to_string(&id).unwrap();
            let decoded: BackendId = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded, id);
        }
    }

    #[test]
    fn capability_negotiation_reports_exact_missing_requirements() {
        let pty = AgentCapabilities::provider_cli(ProviderCliKind::GenericPty);
        let strict = CapabilityRequirements::default()
            .with_streaming_text()
            .with_structured_tool_calls()
            .with_resume()
            .with_idle_hibernation();
        assert!(!pty.satisfies(&strict));
        assert_eq!(
            pty.missing_for(&strict),
            vec!["structured_tool_calls", "resume", "idle_hibernation"]
        );

        let direct = AgentCapabilities::direct_api();
        let zero_cli = strict.with_no_external_cli().with_mcp_bridge();
        assert!(direct.satisfies(&zero_cli));

        let omp = AgentCapabilities::omp();
        assert!(!omp.satisfies(&zero_cli));
        assert_eq!(omp.missing_for(&zero_cli), vec!["no_external_cli"]);
    }

    #[test]
    fn agent_event_serializes_and_deserializes_with_type_tag() {
        let events = [
            AgentEvent::TurnStarted {
                turn_id: Some("turn-1".to_owned()),
                model: Some("claude-sonnet-4-6".to_owned()),
                resume_handle: Some(Box::new(ResumeHandle::new(
                    BackendId::ProviderCli(ProviderCliKind::ClaudeCode),
                    "sess-abc",
                ))),
            },
            AgentEvent::TextDelta {
                text: "hello".to_owned(),
                block_index: Some(0),
            },
            AgentEvent::ThinkingDelta {
                text: "pondering".to_owned(),
                block_index: Some(0),
            },
            AgentEvent::ToolCallStarted {
                call_id: "call-1".to_owned(),
                name: "read_file".to_owned(),
                arguments: Some(Box::new(json!({ "path": "Cargo.toml" }))),
            },
            AgentEvent::ToolCallDelta {
                call_id: "call-1".to_owned(),
                arguments_delta: Some("{\"path\":".to_owned()),
                output_delta: None,
            },
            AgentEvent::ToolCallFinished {
                call_id: "call-1".to_owned(),
                name: Some("read_file".to_owned()),
                output: Some("ok".to_owned()),
                is_error: false,
            },
            AgentEvent::ApprovalRequested {
                request_id: "req-1".to_owned(),
                tool_name: Some("bash".to_owned()),
                summary: "Run git status".to_owned(),
                kind: ApprovalKind::CommandExecution,
                payload: Some(Box::new(json!({ "command": "git status" }))),
            },
            AgentEvent::Usage {
                usage: TokenUsage {
                    input_tokens: 100,
                    output_tokens: 42,
                    cache_read_tokens: 10,
                    cache_write_tokens: 5,
                    reasoning_tokens: 12,
                    cost_usd: Some(0.0025),
                },
            },
            AgentEvent::TurnFinished {
                turn_id: Some("turn-1".to_owned()),
                reason: TurnFinishReason::Completed,
                resume_handle: None,
            },
            AgentEvent::SessionStateChanged {
                state: SessionLifecycleState::Ready,
                detail: Some("initialized".to_owned()),
            },
            AgentEvent::Error {
                code: "rate_limit".to_owned(),
                message: "slow down".to_owned(),
                retryable: true,
            },
        ];

        for event in events {
            let value = serde_json::to_value(&event).unwrap();
            assert!(value.get("type").and_then(Value::as_str).is_some());
            let decoded: AgentEvent = serde_json::from_value(value).unwrap();
            assert_eq!(decoded, event);
        }
    }
}
