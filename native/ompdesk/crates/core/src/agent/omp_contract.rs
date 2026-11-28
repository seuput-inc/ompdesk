//! Contract mapping existing stock `omp` sidecar frames (`crates/core/src/sidecar/frames.rs`)
//! onto the agent-neutral [`AgentEvent`] model.
//!
//! Stage 1 keeps `crates/core/src/sidecar/` completely untouched to avoid merge conflicts with
//! active branch `#12`. In Stage 2, `sidecar::Lane` and `OmpAdapter` feed each decoded
//! `(frame.ty.as_deref(), &frame.raw)` pair into [`translate_omp_raw_line`] or
//! [`translate_omp_frame`] and route [`OmpFrameTranslation::Passthrough`] variants to OMP-only
//! bridge/UI channels.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{Map, Value};

use super::adapter::{AgentAdapter, AgentSession, BoxFuture};
use super::parsers::{extract_text_content, non_empty_str, value_as_u32, value_as_u64};
use super::types::{
    AgentCapabilities, AgentError, AgentEvent, ApprovalKind, BackendId, InstalledBackend,
    ResumeHandle, SessionLifecycleState, SessionSpec, TokenUsage, TurnFinishReason, TurnInput,
};

/// OMP-specific outbound frame categories that do not map 1:1 onto normalized [`AgentEvent`]s
/// and remain on the OMP passthrough channel during Stage 2 cutover.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OmpPassthroughKind {
    /// Transport/RPC control frames (`ready`, `response`, `rpc_chunk`, `session_settled`, `command_output`).
    ProtocolControl,
    /// Nested subagent frame envelopes (`subagent_event`).
    Subagent,
    /// Context compaction lifecycle (`auto_compaction_*`, `manual_compaction_*`).
    Compaction,
    /// Automatic retry & fallback announcements (`auto_retry_*`, `retry_fallback_*`).
    Retry,
    /// Authoritative steering/follow-up queue snapshot (`queue_update`).
    Queue,
    /// OMPdesk mode/coordination frames (`autopilot_update`, `desktop_slot_update`, `checkout_peers`, `goal_*`, `todo_*`, `ttsr_triggered`, `next_prompt_*`).
    ModeState,
    /// Non-blocking metadata/live/btw frames (`session_info_update`, `available_commands_update`, `token_rate`, `live_*`, `btw_*`, etc.).
    Metadata,
    /// Host-executed tool and URI requests (`host_tool_call`, `host_tool_cancel`, `host_uri_*`).
    HostToolCall,
    /// Non-blocking `extension_ui_request` updates (`setStatus`, `setWidget`, `setTitle`, `open_url`, `cancel`, non-error `notify`).
    ExtensionUi,
}

/// Outcome of translating one stock OMP stdout frame.
#[derive(Debug, Clone, PartialEq)]
pub enum OmpFrameTranslation {
    /// One or more backend-neutral events to forward on the `AgentSession` channel.
    Events(Vec<AgentEvent>),
    /// OMP-only frame to forward on the optional OMP extension channel.
    Passthrough(OmpPassthroughKind),
    /// Recognized boundary/no-op or unknown forward-compatible frame.
    Ignored,
}

/// Declarative mapping row documenting how each stock OMP outbound frame maps in Stage 2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OmpFrameMappingSpec {
    pub omp_frame_type: &'static str,
    pub target: &'static str,
    pub notes: &'static str,
}

/// Reference contract table linking `sidecar::frames` / `src/shared/rpc-types.ts` to `agent::AgentEvent`.
pub const OMP_FRAME_MAPPINGS: &[OmpFrameMappingSpec] = &[
    OmpFrameMappingSpec {
        omp_frame_type: "agent_start",
        target: "AgentEvent::TurnStarted",
        notes: "Captures sessionId into ResumeHandle(BackendId::Omp) and opens the turn",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "turn_start",
        target: "AgentEvent::SessionStateChanged(Running)",
        notes: "Opens turn if agent_start was absent; otherwise signals active turn step",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "message_update (text_delta)",
        target: "AgentEvent::TextDelta",
        notes: "Reads assistantMessageEvent.delta and contentIndex (pre- or post-slimmer)",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "message_update (thinking_delta)",
        target: "AgentEvent::ThinkingDelta",
        notes: "Reads assistantMessageEvent.delta and contentIndex",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "message_update (toolcall_delta)",
        target: "AgentEvent::ToolCallDelta",
        notes: "Maps contentIndex to toolCall id from partial.content when available",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "message_end",
        target: "AgentEvent::Usage",
        notes: "Emits TokenUsage when assistant message carries non-zero usage or cost",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "tool_execution_start",
        target: "AgentEvent::ToolCallStarted",
        notes: "Maps toolCallId, toolName, and args JSON object",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "tool_execution_update",
        target: "AgentEvent::ToolCallDelta",
        notes: "Extracts incremental text from partialResult into output_delta",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "tool_execution_end",
        target: "AgentEvent::ToolCallFinished",
        notes: "Maps toolCallId, toolName, result text, and isError",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "extension_ui_request (confirm|select|ask|form|input|editor)",
        target: "AgentEvent::ApprovalRequested + SessionStateChanged(WaitingForApproval)",
        notes: "Blocking prompts surface as normalized approval requests; non-blocking UI stays Passthrough(ExtensionUi)",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "prompt_result",
        target: "AgentEvent::Error / TurnFinished",
        notes: "Records aborted/error finish reason; emits TurnFinished immediately when agentInvoked=false",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "agent_end",
        target: "AgentEvent::TurnFinished",
        notes: "Closes the turn with the latest ResumeHandle and resets per-turn translator state",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "extension_error / notice(error)",
        target: "AgentEvent::Error",
        notes: "Non-fatal extension or session error surfaced uniformly",
    },
    OmpFrameMappingSpec {
        omp_frame_type: "host_tool_call / subagent_event / queue_update / ready / response",
        target: "OmpFrameTranslation::Passthrough",
        notes: "Retained on OMP-only control/UI channels in Stage 2 without polluting neutral events",
    },
];

/// Stateful translator context held per OMP session during frame normalization.
#[derive(Debug, Default)]
pub struct OmpContractState {
    session_id: Option<String>,
    session_path: Option<PathBuf>,
    turn_open: bool,
    last_prompt_reason: Option<TurnFinishReason>,
    tool_calls_by_index: HashMap<u32, String>,
}

impl OmpContractState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_session_path(&mut self, path: impl Into<PathBuf>) {
        self.session_path = Some(path.into());
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// Builds an OMP [`ResumeHandle`] preferring the durable JSONL session path over `session_id`.
    pub fn resume_handle(&self) -> Option<ResumeHandle> {
        let native_id = self
            .session_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
            .or_else(|| self.session_id.clone())?;
        let mut handle = ResumeHandle::new(BackendId::Omp, native_id);
        if let Some(id) = &self.session_id {
            handle
                .metadata
                .insert("ompSessionId".to_owned(), id.clone());
        }
        Some(handle)
    }

    pub fn reset_turn(&mut self) {
        self.turn_open = false;
        self.last_prompt_reason = None;
        self.tool_calls_by_index.clear();
    }
}

/// Maps existing `SidecarStatus` strings (`src/shared/rpc-types.ts`) onto [`SessionLifecycleState`].
pub fn map_sidecar_status(status: &str) -> SessionLifecycleState {
    match status {
        "asleep" => SessionLifecycleState::Hibernated,
        "starting" | "restarting" | "waiting" => SessionLifecycleState::Starting,
        "ready" => SessionLifecycleState::Ready,
        "exited" => SessionLifecycleState::Stopped,
        "error" => SessionLifecycleState::Error,
        _ => SessionLifecycleState::Starting,
    }
}

/// Decodes raw UTF-8 JSON bytes from `sidecar::frames::Frame::raw` and translates the frame.
pub fn translate_omp_raw_line(
    raw: &[u8],
    state: &mut OmpContractState,
) -> Result<OmpFrameTranslation, AgentError> {
    let text = std::str::from_utf8(raw).map_err(|error| AgentError::Protocol {
        message: format!("invalid UTF-8 in OMP frame: {error}"),
    })?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(OmpFrameTranslation::Ignored);
    }
    let value: Value = serde_json::from_str(trimmed)?;
    let Some(obj) = value.as_object() else {
        return Err(AgentError::Protocol {
            message: "expected JSON object in OMP frame".to_owned(),
        });
    };
    let ty = non_empty_str(obj, "type");
    Ok(translate_omp_frame(ty, &value, state))
}

/// Translates one parsed stock OMP outbound JSON frame into normalized [`AgentEvent`]s or a
/// classified [`OmpPassthroughKind`].
pub fn translate_omp_frame(
    frame_type: Option<&str>,
    payload: &Value,
    state: &mut OmpContractState,
) -> OmpFrameTranslation {
    let Some(obj) = payload.as_object() else {
        return OmpFrameTranslation::Ignored;
    };
    let ty = frame_type.or_else(|| non_empty_str(obj, "type"));

    match ty {
        Some("agent_start") => {
            if let Some(id) = non_empty_str(obj, "sessionId") {
                state.session_id = Some(id.to_owned());
            }
            state.turn_open = true;
            state.last_prompt_reason = None;
            OmpFrameTranslation::Events(vec![AgentEvent::TurnStarted {
                turn_id: None,
                model: None,
                resume_handle: state.resume_handle().map(Box::new),
            }])
        }
        Some("turn_start") => {
            if !state.turn_open {
                state.turn_open = true;
                OmpFrameTranslation::Events(vec![AgentEvent::TurnStarted {
                    turn_id: None,
                    model: None,
                    resume_handle: state.resume_handle().map(Box::new),
                }])
            } else {
                OmpFrameTranslation::Events(vec![AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Running,
                    detail: None,
                }])
            }
        }
        Some("message_update") => translate_message_update(obj, state),
        Some("message_end") => translate_message_end(obj),
        Some("tool_execution_start") => {
            let Some(call_id) = non_empty_str(obj, "toolCallId") else {
                return OmpFrameTranslation::Ignored;
            };
            let name = non_empty_str(obj, "toolName").unwrap_or("tool").to_owned();
            let arguments = obj.get("args").cloned().map(Box::new);
            OmpFrameTranslation::Events(vec![AgentEvent::ToolCallStarted {
                call_id: call_id.to_owned(),
                name,
                arguments,
            }])
        }
        Some("tool_execution_update") => {
            let Some(call_id) = non_empty_str(obj, "toolCallId") else {
                return OmpFrameTranslation::Ignored;
            };
            let output_delta = obj.get("partialResult").and_then(extract_omp_tool_output);
            match output_delta {
                Some(delta) => OmpFrameTranslation::Events(vec![AgentEvent::ToolCallDelta {
                    call_id: call_id.to_owned(),
                    arguments_delta: None,
                    output_delta: Some(delta),
                }]),
                None => OmpFrameTranslation::Ignored,
            }
        }
        Some("tool_execution_end") => {
            let Some(call_id) = non_empty_str(obj, "toolCallId") else {
                return OmpFrameTranslation::Ignored;
            };
            let name = non_empty_str(obj, "toolName").map(str::to_owned);
            let output = obj.get("result").and_then(extract_omp_tool_output);
            let is_error = obj.get("isError").and_then(Value::as_bool).unwrap_or(false);
            OmpFrameTranslation::Events(vec![AgentEvent::ToolCallFinished {
                call_id: call_id.to_owned(),
                name,
                output,
                is_error,
            }])
        }
        Some("extension_ui_request") => translate_extension_ui_request(obj),
        Some("prompt_result") => translate_prompt_result(obj, state),
        Some("agent_end") => {
            let reason = state
                .last_prompt_reason
                .take()
                .unwrap_or(TurnFinishReason::Completed);
            let resume_handle = state.resume_handle().map(Box::new);
            state.reset_turn();
            OmpFrameTranslation::Events(vec![AgentEvent::TurnFinished {
                turn_id: None,
                reason,
                resume_handle,
            }])
        }
        Some("extension_error") => {
            let message = non_empty_str(obj, "error")
                .unwrap_or("OMP extension error")
                .to_owned();
            OmpFrameTranslation::Events(vec![AgentEvent::Error {
                code: "extension_error".to_owned(),
                message,
                retryable: false,
            }])
        }
        Some("notice") => {
            if non_empty_str(obj, "level") == Some("error") {
                let message = non_empty_str(obj, "message")
                    .unwrap_or("OMP error notice")
                    .to_owned();
                OmpFrameTranslation::Events(vec![AgentEvent::Error {
                    code: "omp_notice".to_owned(),
                    message,
                    retryable: false,
                }])
            } else {
                OmpFrameTranslation::Passthrough(OmpPassthroughKind::Metadata)
            }
        }
        Some("ready" | "response" | "rpc_chunk" | "session_settled" | "command_output") => {
            OmpFrameTranslation::Passthrough(OmpPassthroughKind::ProtocolControl)
        }
        Some("subagent_event") => OmpFrameTranslation::Passthrough(OmpPassthroughKind::Subagent),
        Some(
            "auto_compaction_start"
            | "auto_compaction_end"
            | "manual_compaction_start"
            | "manual_compaction_end",
        ) => OmpFrameTranslation::Passthrough(OmpPassthroughKind::Compaction),
        Some(
            "auto_retry_start"
            | "auto_retry_end"
            | "retry_fallback_applied"
            | "retry_fallback_succeeded",
        ) => OmpFrameTranslation::Passthrough(OmpPassthroughKind::Retry),
        Some("queue_update") => OmpFrameTranslation::Passthrough(OmpPassthroughKind::Queue),
        Some(
            "autopilot_update"
            | "desktop_slot_update"
            | "checkout_peers"
            | "goal_updated"
            | "goal_time_limit_reached"
            | "todo_reminder"
            | "todo_auto_clear"
            | "todo_drift"
            | "ttsr_triggered"
            | "next_prompt_update"
            | "next_prompt_config",
        ) => OmpFrameTranslation::Passthrough(OmpPassthroughKind::ModeState),
        Some("host_tool_call" | "host_tool_cancel" | "host_uri_request" | "host_uri_cancel") => {
            OmpFrameTranslation::Passthrough(OmpPassthroughKind::HostToolCall)
        }
        Some(
            "session_info_update"
            | "available_commands_update"
            | "config_update"
            | "model_changed"
            | "thinking_level_changed"
            | "token_rate"
            | "read_group_metadata"
            | "model_request"
            | "model_catalog_update"
            | "live_phase"
            | "live_levels"
            | "live_transcript"
            | "live_end"
            | "btw_delta"
            | "btw_record",
        ) => OmpFrameTranslation::Passthrough(OmpPassthroughKind::Metadata),
        _ => OmpFrameTranslation::Ignored,
    }
}

fn translate_message_update(
    obj: &Map<String, Value>,
    state: &mut OmpContractState,
) -> OmpFrameTranslation {
    let Some(ev) = obj.get("assistantMessageEvent").and_then(Value::as_object) else {
        return OmpFrameTranslation::Ignored;
    };
    let index = value_as_u32(ev.get("contentIndex"));
    match non_empty_str(ev, "type") {
        Some("text_delta") => match non_empty_str(ev, "delta") {
            Some(delta) => OmpFrameTranslation::Events(vec![AgentEvent::TextDelta {
                text: delta.to_owned(),
                block_index: index,
            }]),
            None => OmpFrameTranslation::Ignored,
        },
        Some("thinking_delta") => match non_empty_str(ev, "delta") {
            Some(delta) => OmpFrameTranslation::Events(vec![AgentEvent::ThinkingDelta {
                text: delta.to_owned(),
                block_index: index,
            }]),
            None => OmpFrameTranslation::Ignored,
        },
        Some("toolcall_delta") => {
            let Some(delta) = non_empty_str(ev, "delta") else {
                return OmpFrameTranslation::Ignored;
            };
            let call_id = resolve_omp_toolcall_id(ev, index, state);
            OmpFrameTranslation::Events(vec![AgentEvent::ToolCallDelta {
                call_id,
                arguments_delta: Some(delta.to_owned()),
                output_delta: None,
            }])
        }
        _ => OmpFrameTranslation::Ignored,
    }
}

fn resolve_omp_toolcall_id(
    ev: &Map<String, Value>,
    index: Option<u32>,
    state: &mut OmpContractState,
) -> String {
    if let Some(idx) = index {
        if let Some(id) = ev
            .get("partial")
            .and_then(Value::as_object)
            .and_then(|partial| partial.get("content"))
            .and_then(Value::as_array)
            .and_then(|blocks| blocks.get(idx as usize))
            .and_then(Value::as_object)
            .and_then(|block| non_empty_str(block, "id"))
        {
            state.tool_calls_by_index.insert(idx, id.to_owned());
            return id.to_owned();
        }
        if let Some(existing) = state.tool_calls_by_index.get(&idx) {
            return existing.clone();
        }
        return format!("omp-tool-{idx}");
    }
    "omp-tool".to_owned()
}

fn translate_message_end(obj: &Map<String, Value>) -> OmpFrameTranslation {
    let Some(usage_obj) = obj
        .get("message")
        .and_then(Value::as_object)
        .and_then(|message| message.get("usage"))
        .and_then(Value::as_object)
    else {
        return OmpFrameTranslation::Ignored;
    };
    let cost_usd = usage_obj.get("cost").and_then(|cost| match cost {
        Value::Number(num) => num.as_f64(),
        Value::Object(map) => map.get("total").and_then(Value::as_f64),
        _ => None,
    });
    let usage = TokenUsage {
        input_tokens: value_as_u64(usage_obj.get("input")),
        output_tokens: value_as_u64(usage_obj.get("output")),
        cache_read_tokens: value_as_u64(usage_obj.get("cacheRead")),
        cache_write_tokens: value_as_u64(usage_obj.get("cacheWrite")),
        reasoning_tokens: value_as_u64(usage_obj.get("reasoning")),
        cost_usd,
    };
    if usage.is_empty() {
        OmpFrameTranslation::Ignored
    } else {
        OmpFrameTranslation::Events(vec![AgentEvent::Usage { usage }])
    }
}

fn translate_extension_ui_request(obj: &Map<String, Value>) -> OmpFrameTranslation {
    let method = non_empty_str(obj, "method");
    match method {
        Some("confirm" | "select" | "ask" | "form" | "input" | "editor") => {
            let request_id = non_empty_str(obj, "id").unwrap_or("omp-ui").to_owned();
            let summary = non_empty_str(obj, "title")
                .or_else(|| non_empty_str(obj, "message"))
                .unwrap_or("OMP extension input requested")
                .to_owned();
            let kind = match method {
                Some("ask" | "select" | "input" | "editor" | "form") => ApprovalKind::UserQuestion,
                _ => ApprovalKind::Generic,
            };
            OmpFrameTranslation::Events(vec![
                AgentEvent::ApprovalRequested {
                    request_id,
                    tool_name: None,
                    summary,
                    kind,
                    payload: Some(Box::new(Value::Object(obj.clone()))),
                },
                AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::WaitingForApproval,
                    detail: method.map(str::to_owned),
                },
            ])
        }
        Some("notify") if non_empty_str(obj, "notifyType") == Some("error") => {
            let message = non_empty_str(obj, "message")
                .unwrap_or("OMP notification error")
                .to_owned();
            OmpFrameTranslation::Events(vec![AgentEvent::Error {
                code: "extension_notify".to_owned(),
                message,
                retryable: false,
            }])
        }
        _ => OmpFrameTranslation::Passthrough(OmpPassthroughKind::ExtensionUi),
    }
}

fn translate_prompt_result(
    obj: &Map<String, Value>,
    state: &mut OmpContractState,
) -> OmpFrameTranslation {
    let mut events = Vec::new();
    let status = non_empty_str(obj, "status");
    let reason = match status {
        Some("aborted") => TurnFinishReason::Interrupted,
        Some("error") => TurnFinishReason::Error,
        _ => TurnFinishReason::Completed,
    };
    state.last_prompt_reason = Some(reason);

    if status == Some("error")
        && let Some(err_obj) = obj.get("error").and_then(Value::as_object)
    {
        let message = non_empty_str(err_obj, "message")
            .unwrap_or("OMP prompt failed")
            .to_owned();
        let retryable = err_obj
            .get("retryable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        events.push(AgentEvent::Error {
            code: "prompt_error".to_owned(),
            message,
            retryable,
        });
    }

    let agent_invoked = obj
        .get("agentInvoked")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !agent_invoked {
        let resume_handle = state.resume_handle().map(Box::new);
        state.reset_turn();
        events.push(AgentEvent::TurnFinished {
            turn_id: None,
            reason,
            resume_handle,
        });
    }

    if events.is_empty() {
        OmpFrameTranslation::Ignored
    } else {
        OmpFrameTranslation::Events(events)
    }
}

fn extract_omp_tool_output(value: &Value) -> Option<String> {
    if let Some(text) = extract_text_content(value) {
        return Some(text);
    }
    value
        .as_object()
        .and_then(|map| map.get("content"))
        .and_then(extract_text_content)
}

/// Stage 1 contract stub representing the future `OmpAdapter` wired onto `sidecar::Lane` in Stage 2.
///
/// Keeping this stub behind [`AgentAdapter`] lets callers register [`BackendId::Omp`] and verify
/// capability negotiation immediately without touching `crates/core/src/sidecar/`.
#[derive(Debug, Default)]
pub struct OmpAdapterContract;

impl OmpAdapterContract {
    pub fn new() -> Self {
        Self
    }
}

impl AgentAdapter for OmpAdapterContract {
    fn id(&self) -> BackendId {
        BackendId::Omp
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::omp()
    }

    fn detect_installed(&self) -> BoxFuture<'_, InstalledBackend> {
        Box::pin(async {
            InstalledBackend::missing(
                BackendId::Omp,
                "Stage 2 wiring pending: bind setup::probeOmp and sidecar::Lane",
            )
        })
    }

    fn start(&self, _spec: SessionSpec) -> BoxFuture<'_, Result<AgentSession, AgentError>> {
        Box::pin(async {
            Err(AgentError::UnsupportedCapability {
                backend: BackendId::Omp,
                capability: "stage2_sidecar_lane_wiring".to_owned(),
            })
        })
    }

    fn send_turn<'a>(
        &'a self,
        _session: &'a AgentSession,
        _input: TurnInput,
    ) -> BoxFuture<'a, Result<(), AgentError>> {
        Box::pin(async {
            Err(AgentError::UnsupportedCapability {
                backend: BackendId::Omp,
                capability: "stage2_sidecar_lane_wiring".to_owned(),
            })
        })
    }

    fn interrupt<'a>(
        &'a self,
        _session: &'a AgentSession,
    ) -> BoxFuture<'a, Result<(), AgentError>> {
        Box::pin(async {
            Err(AgentError::UnsupportedCapability {
                backend: BackendId::Omp,
                capability: "stage2_sidecar_lane_wiring".to_owned(),
            })
        })
    }

    fn stop<'a>(&'a self, _session: &'a mut AgentSession) -> BoxFuture<'a, Result<(), AgentError>> {
        Box::pin(async {
            Err(AgentError::UnsupportedCapability {
                backend: BackendId::Omp,
                capability: "stage2_sidecar_lane_wiring".to_owned(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::agent::registry::{AdapterRegistry, ResolutionRequest};

    #[test]
    fn translates_full_omp_turn_sequence_into_normalized_agent_events() {
        let mut state = OmpContractState::new();
        state.set_session_path("/tmp/sessions/omp-1.jsonl");

        let start = translate_omp_frame(
            Some("agent_start"),
            &json!({ "type": "agent_start", "sessionId": "omp-sess-1" }),
            &mut state,
        );
        assert!(matches!(
            start,
            OmpFrameTranslation::Events(evs)
                if matches!(
                    &evs[0],
                    AgentEvent::TurnStarted { resume_handle: Some(h), .. }
                        if h.native_id == "/tmp/sessions/omp-1.jsonl"
                            && h.metadata.get("ompSessionId").map(String::as_str) == Some("omp-sess-1")
                )
        ));

        let thinking = translate_omp_frame(
            Some("message_update"),
            &json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "thinking_delta", "contentIndex": 0, "delta": "Checking" }
            }),
            &mut state,
        );
        assert_eq!(
            thinking,
            OmpFrameTranslation::Events(vec![AgentEvent::ThinkingDelta {
                text: "Checking".to_owned(),
                block_index: Some(0),
            }])
        );

        let text = translate_omp_raw_line(
            br#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"Hi"}}"#,
            &mut state,
        )
        .unwrap();
        assert_eq!(
            text,
            OmpFrameTranslation::Events(vec![AgentEvent::TextDelta {
                text: "Hi".to_owned(),
                block_index: Some(1),
            }])
        );

        let tool_delta = translate_omp_frame(
            Some("message_update"),
            &json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "toolcall_delta",
                    "contentIndex": 2,
                    "delta": "{\"cmd\":\"ls\"}",
                    "partial": { "content": [{}, {}, { "type": "toolCall", "id": "tc-9" }] }
                }
            }),
            &mut state,
        );
        assert_eq!(
            tool_delta,
            OmpFrameTranslation::Events(vec![AgentEvent::ToolCallDelta {
                call_id: "tc-9".to_owned(),
                arguments_delta: Some("{\"cmd\":\"ls\"}".to_owned()),
                output_delta: None,
            }])
        );

        let tool_start = translate_omp_frame(
            Some("tool_execution_start"),
            &json!({ "type": "tool_execution_start", "toolCallId": "tc-9", "toolName": "bash", "args": { "cmd": "ls" } }),
            &mut state,
        );
        assert!(matches!(
            tool_start,
            OmpFrameTranslation::Events(evs)
                if matches!(&evs[0], AgentEvent::ToolCallStarted { call_id, name, .. } if call_id == "tc-9" && name == "bash")
        ));

        let tool_end = translate_omp_frame(
            Some("tool_execution_end"),
            &json!({ "type": "tool_execution_end", "toolCallId": "tc-9", "toolName": "bash", "result": { "content": [{ "type": "text", "text": "Cargo.toml" }] }, "isError": false }),
            &mut state,
        );
        assert_eq!(
            tool_end,
            OmpFrameTranslation::Events(vec![AgentEvent::ToolCallFinished {
                call_id: "tc-9".to_owned(),
                name: Some("bash".to_owned()),
                output: Some("Cargo.toml".to_owned()),
                is_error: false,
            }])
        );

        let usage = translate_omp_frame(
            Some("message_end"),
            &json!({ "type": "message_end", "message": { "role": "assistant", "usage": { "input": 100, "output": 25, "cacheRead": 40, "cost": { "total": 0.004 } } } }),
            &mut state,
        );
        assert_eq!(
            usage,
            OmpFrameTranslation::Events(vec![AgentEvent::Usage {
                usage: TokenUsage {
                    input_tokens: 100,
                    output_tokens: 25,
                    cache_read_tokens: 40,
                    cache_write_tokens: 0,
                    reasoning_tokens: 0,
                    cost_usd: Some(0.004),
                },
            }])
        );

        let confirm = translate_omp_frame(
            Some("extension_ui_request"),
            &json!({ "type": "extension_ui_request", "id": "ui-7", "method": "confirm", "title": "Proceed?", "message": "Apply patch" }),
            &mut state,
        );
        assert!(matches!(
            confirm,
            OmpFrameTranslation::Events(evs)
                if evs.len() == 2
                    && matches!(&evs[0], AgentEvent::ApprovalRequested { request_id, .. } if request_id == "ui-7")
                    && matches!(&evs[1], AgentEvent::SessionStateChanged { state: SessionLifecycleState::WaitingForApproval, .. })
        ));

        let end = translate_omp_frame(
            Some("agent_end"),
            &json!({ "type": "agent_end", "messages": [] }),
            &mut state,
        );
        assert!(matches!(
            end,
            OmpFrameTranslation::Events(evs)
                if matches!(&evs[0], AgentEvent::TurnFinished { reason: TurnFinishReason::Completed, .. })
        ));
    }

    #[test]
    fn classifies_omp_passthrough_frames_and_sidecar_statuses() {
        let mut state = OmpContractState::new();
        let cases = [
            ("ready", OmpPassthroughKind::ProtocolControl),
            ("subagent_event", OmpPassthroughKind::Subagent),
            ("auto_compaction_start", OmpPassthroughKind::Compaction),
            ("auto_retry_start", OmpPassthroughKind::Retry),
            ("queue_update", OmpPassthroughKind::Queue),
            ("autopilot_update", OmpPassthroughKind::ModeState),
            ("host_tool_call", OmpPassthroughKind::HostToolCall),
            ("session_info_update", OmpPassthroughKind::Metadata),
        ];
        for (ty, expected) in cases {
            assert_eq!(
                translate_omp_frame(Some(ty), &json!({ "type": ty }), &mut state),
                OmpFrameTranslation::Passthrough(expected),
                "frame type {ty}"
            );
        }

        assert_eq!(
            map_sidecar_status("asleep"),
            SessionLifecycleState::Hibernated
        );
        assert_eq!(
            map_sidecar_status("starting"),
            SessionLifecycleState::Starting
        );
        assert_eq!(map_sidecar_status("ready"), SessionLifecycleState::Ready);
        assert_eq!(map_sidecar_status("exited"), SessionLifecycleState::Stopped);
        assert_eq!(map_sidecar_status("error"), SessionLifecycleState::Error);
        assert!(!OMP_FRAME_MAPPINGS.is_empty());
    }

    #[tokio::test]
    fn contract_stub_registers_with_adapter_registry() {
        let mut reg = AdapterRegistry::new();
        reg.register(Arc::new(OmpAdapterContract::new()));
        let outcome = reg
            .resolve(&ResolutionRequest::for_backend(BackendId::Omp).skip_install_check())
            .await
            .unwrap();
        assert_eq!(outcome.backend, BackendId::Omp);
        assert!(outcome.adapter.capabilities().idle_hibernation);
    }
}
