//! Pure-Rust streaming protocol parsers normalizing backend wire output into [`crate::agent::AgentEvent`].

pub mod claude_stream;
pub mod codex_stream;
pub mod direct_sse;

use serde_json::{Map, Value};

use super::types::{TokenUsage, TurnFinishReason};

/// Reads a non-empty string field from a JSON object.
pub(crate) fn non_empty_str<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// Reads an optional JSON unsigned integer, defaulting to `0`.
pub(crate) fn value_as_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

/// Reads an optional JSON unsigned integer that fits in `u32`.
pub(crate) fn value_as_u32(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
}

/// Extracts plain text from either a string value or an array of content blocks.
pub(crate) fn extract_text_content(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => (!text.is_empty()).then(|| text.clone()),
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                match item {
                    Value::String(text) if !text.is_empty() => parts.push(text.as_str()),
                    Value::Object(map) => {
                        if let Some(text) = non_empty_str(map, "text") {
                            parts.push(text);
                        }
                    }
                    _ => {}
                }
            }
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

/// Parses Anthropic Messages `usage` objects shared by Claude Code `stream-json` and Direct SSE.
pub(crate) fn parse_anthropic_usage(usage: &Map<String, Value>) -> TokenUsage {
    TokenUsage {
        input_tokens: value_as_u64(usage.get("input_tokens")),
        output_tokens: value_as_u64(usage.get("output_tokens")),
        cache_read_tokens: value_as_u64(usage.get("cache_read_input_tokens")),
        cache_write_tokens: value_as_u64(usage.get("cache_creation_input_tokens")),
        reasoning_tokens: 0,
        cost_usd: None,
    }
}

/// Maps Anthropic `stop_reason` strings onto [`TurnFinishReason`].
pub(crate) fn map_anthropic_stop_reason(reason: Option<&str>) -> TurnFinishReason {
    match reason {
        Some("end_turn" | "stop_sequence") => TurnFinishReason::Completed,
        Some("max_tokens") => TurnFinishReason::MaxTokens,
        Some("tool_use") => TurnFinishReason::ToolUse,
        Some("aborted" | "interrupted" | "cancelled") => TurnFinishReason::Interrupted,
        Some("refusal" | "error") => TurnFinishReason::Error,
        _ => TurnFinishReason::Unknown,
    }
}
