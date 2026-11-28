//! Built-in local workspace tools for Direct LLM API sessions (Stage 2B).

pub mod local_executor;

pub use local_executor::{
    DEFAULT_COMMAND_TIMEOUT_SECS, DEFAULT_MAX_COMMAND_OUTPUT_BYTES, DEFAULT_MAX_LIST_ENTRIES,
    DEFAULT_MAX_READ_BYTES, DEFAULT_MAX_WRITE_BYTES, LocalToolExecutor, LocalToolPolicy,
    builtin_tool_schemas, resolve_confined_path,
};
