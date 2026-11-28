//! Agent-neutral Rust multi-agent runtime (Stage 1 + Stage 2A/2B/2C isolated core runtime).
//!
//! Defines a uniform contract across three first-class execution backend families:
//! - **Provider CLI** (`claude`, `codex`, `agy`, generic PTY)
//! - **OMP** (existing stock `omp` CLI behind an optional adapter)
//! - **Direct LLM API** (native Rust HTTP streaming + built-in tool loop)
//!
//! See `docs/architecture/multi-agent-runtime.md` for the 3-stage migration plan,
//! capability matrix, and Stage 2 wiring checklist.

pub mod adapter;
pub mod backends;
pub mod journal;
pub mod omp_contract;
pub mod parsers;
pub mod registry;
pub mod service;
pub mod tools;
pub mod types;

pub use adapter::{AgentAdapter, AgentSession, BoxFuture};
pub use backends::{
    AntigravityCliAdapter, AntigravityStreamParser, ClaudeCliAdapter, CliCommandSpec,
    CliDescriptor, CodexCliAdapter, CodexTransportMode, ConversationMessage, ConversationRole,
    DEFAULT_MAX_TOOL_ROUNDS, DirectApiAdapter, DirectApiHttpRequest, DiscoveryEnv,
    HyperSseTransport, InstalledBackendInfo, NoopToolExecutor, RecordedToolCall, RoundCollector,
    RoundOutcome, SecretHeader, SseTransport, ToolExecutionResult, ToolExecutor, ToolInvocation,
    ToolSchema, antigravity_approval_args, build_antigravity_command, detect_all_clis, detect_cli,
    detect_direct_api, pump_antigravity_stream,
};
pub use journal::{
    DIRECT_RESUME_PREFIX, JOURNAL_FORMAT_VERSION, JournalEntry, JournalHeader, JournalSnapshot,
    JournalStore, accumulate_usage, format_direct_resume_id, parse_direct_journal_id,
    sanitize_journal_id, validate_journal_id,
};
pub use omp_contract::{
    OMP_FRAME_MAPPINGS, OmpAdapterContract, OmpContractState, OmpFrameMappingSpec,
    OmpFrameTranslation, OmpPassthroughKind, map_sidecar_status, translate_omp_frame,
    translate_omp_raw_line,
};
pub use parsers::claude_stream::ClaudeStreamParser;
pub use parsers::codex_stream::CodexStreamParser;
pub use parsers::direct_sse::{DirectSseParser, SseFrame, SseFrameDecoder};
pub use registry::{
    AdapterRegistry, DEFAULT_PREFERENCE_ORDER, ResolutionOutcome, ResolutionRequest, SkipReason,
    SkippedCandidate, discovery_status_for, select_preferred_install,
};
pub use service::{
    AgentBackendService, AuthReadiness, BackendSummary, DetectBackendsRequest,
    DetectBackendsResponse, HealthCheckResponse, HealthStatus, ListBackendsResponse,
    ResolveBackendRequest, ResolveBackendResponse, SkipReasonDto, SkippedBackendReport,
    backend_display_name, redact_secrets,
};
pub use tools::{LocalToolExecutor, LocalToolPolicy, builtin_tool_schemas, resolve_confined_path};
pub use types::{
    AgentCapabilities, AgentError, AgentEvent, ApprovalDecision, ApprovalKind, ApprovalMode,
    BackendId, BackendKind, CapabilityRequirements, DirectApiConfig, DirectApiProvider,
    DiscoverySource, InstallStatus, InstalledBackend, McpEndpointSpec, ProviderCliKind,
    ResumeHandle, SessionLifecycleState, SessionSpec, TokenUsage, TurnAttachment, TurnFinishReason,
    TurnInput,
};
