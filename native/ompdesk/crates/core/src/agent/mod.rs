//! Agent-neutral Rust multi-agent runtime (Stage 1 foundation).
//!
//! Defines a uniform contract across three first-class execution backend families:
//! - **Provider CLI** (`claude`, `codex`, `agy`, generic PTY)
//! - **OMP** (existing stock `omp` CLI behind an optional adapter)
//! - **Direct LLM API** (native Rust HTTP streaming + built-in tool loop)
//!
//! See `docs/architecture/multi-agent-runtime.md` for the 3-stage migration plan,
//! capability matrix, and Stage 2 wiring checklist.

pub mod adapter;
pub mod parsers;
pub mod registry;
pub mod types;

pub use adapter::{AgentAdapter, AgentSession, BoxFuture};
pub use parsers::claude_stream::ClaudeStreamParser;
pub use parsers::codex_stream::CodexStreamParser;
pub use parsers::direct_sse::{DirectSseParser, SseFrame, SseFrameDecoder};
pub use registry::{
    AdapterRegistry, DEFAULT_PREFERENCE_ORDER, ResolutionOutcome, ResolutionRequest, SkipReason,
    SkippedCandidate, discovery_status_for, select_preferred_install,
};
pub use types::{
    AgentCapabilities, AgentError, AgentEvent, ApprovalDecision, ApprovalKind, ApprovalMode,
    BackendId, BackendKind, CapabilityRequirements, DirectApiConfig, DirectApiProvider,
    DiscoverySource, InstallStatus, InstalledBackend, McpEndpointSpec, ProviderCliKind,
    ResumeHandle, SessionLifecycleState, SessionSpec, TokenUsage, TurnAttachment, TurnFinishReason,
    TurnInput,
};
