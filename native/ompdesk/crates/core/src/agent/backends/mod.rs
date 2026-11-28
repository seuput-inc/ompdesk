//! Concrete backend adapters for Momo's agent-neutral Rust runtime (Stage 2A + 2C).

pub mod antigravity;
pub mod claude_cli;
pub mod codex_cli;
pub mod detect;
pub mod direct_api;

pub use antigravity::{
    AntigravityCliAdapter, AntigravityStreamParser, antigravity_approval_args,
    build_antigravity_command, pump_antigravity_stream,
};
pub use claude_cli::{
    ClaudeCliAdapter, build_claude_command, claude_permission_mode, pump_claude_stream,
};
pub use codex_cli::{
    CodexCliAdapter, CodexTransportMode, app_server_approval_response_frame,
    app_server_initialize_frame, app_server_thread_resume_frame, app_server_thread_start_frame,
    app_server_turn_interrupt_frame, app_server_turn_start_frame, build_codex_app_server_command,
    build_codex_exec_command, build_codex_resume_command, codex_approval_args, pump_codex_stream,
};
pub use detect::{
    CliCommandSpec, CliDescriptor, DiscoveryEnv, InstalledBackendInfo, cli_descriptor,
    detect_all_clis, detect_all_clis_in, detect_cli, detect_cli_in, detect_direct_api,
    detect_direct_api_in, is_windows_cmd_shim, probe_cli_version, quote_cmd_arg,
};
pub use direct_api::{
    ConversationMessage, ConversationRole, DEFAULT_MAX_TOOL_ROUNDS, DirectApiAdapter,
    DirectApiHttpRequest, HyperSseTransport, NoopToolExecutor, RecordedToolCall, RoundCollector,
    RoundOutcome, SecretHeader, SseTransport, ToolExecutionResult, ToolExecutor, ToolInvocation,
    ToolSchema, build_http_request, default_api_key_env, default_model, drive_sse_byte_chunks,
    drive_sse_round, resolve_endpoint_url,
};
