//! Concrete backend adapters for Momo's agent-neutral Rust runtime (Stage 2A).

pub mod claude_cli;
pub mod detect;

pub use claude_cli::{
    ClaudeCliAdapter, build_claude_command, claude_permission_mode, pump_claude_stream,
};
pub use detect::{
    CliCommandSpec, CliDescriptor, DiscoveryEnv, InstalledBackendInfo, cli_descriptor,
    detect_all_clis, detect_all_clis_in, detect_cli, detect_cli_in, detect_direct_api,
    detect_direct_api_in, is_windows_cmd_shim, probe_cli_version, quote_cmd_arg,
};
