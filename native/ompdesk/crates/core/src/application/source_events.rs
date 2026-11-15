use std::sync::{Arc, Mutex, Weak};

use ompdesk_app_contract::Owner;
use tokio::sync::{oneshot, watch};

use super::frames::Frames;
use super::source::Source;
use crate::pool::application::Sidecar;
use crate::pool::application::native::{CapturedEvent, Host, Service as Pool};
use crate::remote::events::{decoder::Decoder, slim::without_frame_bookkeeping};
use crate::sidecar::LaneEvent;
use crate::sidecar::application::EffectFuture;
use crate::sidecar::native::Sink;

use super::exits::Receipt;
use crate::autopilot::approval::is_approval_select;
use crate::server::Fault;
use crate::sidecar::native::Held;

use serde_json::{Map, Value, json};

#[derive(Default)]
struct Pending {
    tail: Option<Receipt>,
    closed: bool,
}

impl Pending {
    fn submit(&mut self, work: impl FnOnce() -> Held + Send + 'static) -> Result<(), Fault> {
        if self.closed {
            return Err(Fault::new(
                "source_events_closed",
                "The captured event stream is closed",
            ));
        }
        let previous = self.tail.clone();
        self.tail = Some(Receipt::join(Box::pin(async move {
            let prior = match previous {
                Some(receipt) => receipt.wait().await,
                None => Ok(()),
            };
            // A preceding fault remains visible, but must not strand later captured work.
            let current = work().await;
            prior.and(current)
        })));
        Ok(())
    }

    fn barrier(&self) -> Held {
        match &self.tail {
            Some(receipt) => receipt.wait(),
            None => Box::pin(async { Ok(()) }),
        }
    }

    fn close(&mut self) -> Held {
        self.closed = true;
        self.barrier()
    }
}

pub(crate) struct Config<P: Host<Sidecar = Source>> {
    pub owner: Owner,
    pub tab: String,
    pub pool: Weak<Pool<P>>,
    pub frames: Arc<Frames>,
    /// The actual native domain actor enqueue, not a placeholder or a page callback.
    pub downstream: Arc<dyn Sink>,
}

struct State {
    pending: Pending,
    closed: Option<Receipt>,
}

#[derive(Clone)]
enum Binding {
    Waiting,
    Bound(Weak<Source>),
    Closed,
}

fn original_source(
    mut binding: watch::Receiver<Binding>,
) -> EffectFuture<'static, Result<Arc<Source>, Fault>> {
    Box::pin(async move {
        loop {
            let observed = binding.borrow_and_update().clone();
            match observed {
                Binding::Bound(source) => return source.upgrade().ok_or_else(missing_source),
                Binding::Closed => {
                    return Err(Fault::new(
                        "source_events_closed",
                        "The source closed before binding",
                    ));
                }
                Binding::Waiting => {}
            }
            binding.changed().await.map_err(|_| missing_source())?;
        }
    })
}

struct RunDecoder {
    generation: Option<u64>,
    decoder: Decoder,
}

pub(crate) struct SourceEvents<P: Host<Sidecar = Source>> {
    owner: Owner,
    tab: Arc<str>,
    pool: Weak<Pool<P>>,
    binding: watch::Sender<Binding>,
    frames: Arc<Frames>,
    downstream: Arc<dyn Sink>,
    state: Mutex<State>,
    decoder: Arc<Mutex<RunDecoder>>,
}

fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|error| error.into_inner())
}

fn missing_source() -> Fault {
    Fault::new(
        "source_events_unbound",
        "The original local event source is unavailable",
    )
}

/// Capture the downstream prefix at a marker in our FIFO, before any later event is enqueued there.
/// Waiting happens outside both the event pump and the source-effect admission segment.
fn checkpoint(pending: &mut Pending, downstream: Arc<dyn Sink>, closing: bool) -> Held {
    let (captured, answer) = oneshot::channel();
    if let Err(error) = pending.submit(move || {
        Box::pin(async move {
            if closing {
                downstream.remove_listeners();
            }
            let _ = captured.send(downstream.reply_barrier());
            Ok(())
        })
    }) {
        return Box::pin(async move { Err(error) });
    }
    let own = pending.barrier();
    Box::pin(async move {
        let own_result = own.await;
        let domain_result = match answer.await {
            Ok(receipt) => receipt.await,
            Err(_) => Err(Fault::new(
                "source_events_barrier",
                "The original downstream barrier was lost",
            )),
        };
        own_result.and(domain_result)
    })
}

impl<P: Host<Sidecar = Source>> SourceEvents<P> {
    pub fn new(config: Config<P>) -> Arc<Self> {
        Arc::new(Self {
            owner: config.owner,
            tab: Arc::from(config.tab),
            pool: config.pool,
            binding: watch::channel(Binding::Waiting).0,
            frames: config.frames,
            downstream: config.downstream,
            state: Mutex::new(State {
                pending: Pending::default(),
                closed: None,
            }),
            decoder: Arc::new(Mutex::new(RunDecoder {
                generation: None,
                decoder: Decoder::new(),
            })),
        })
    }

    /// Bind after the original Pool entry/handle exists. Root drains the initial prefix before its existing start gate.
    pub fn bind(&self, source: &Arc<Source>) -> Result<(), Fault> {
        let state = lock(&self.state);
        if state.closed.is_some() || source.local().is_none() {
            return Err(missing_source());
        }
        if !matches!(*self.binding.borrow(), Binding::Waiting) {
            return Err(Fault::new(
                "source_events_bound",
                "The original event source is already bound",
            ));
        }
        self.binding
            .send_replace(Binding::Bound(Arc::downgrade(source)));
        Ok(())
    }

    pub fn close(&self) -> Held {
        let mut state = lock(&self.state);
        if let Some(receipt) = &state.closed {
            return receipt.wait();
        }
        let unbound = matches!(*self.binding.borrow(), Binding::Waiting);
        if unbound {
            self.binding.send_replace(Binding::Closed);
        }
        let prefix = checkpoint(&mut state.pending, Arc::clone(&self.downstream), true);
        state.pending.closed = true;
        let frames = Arc::clone(&self.frames);
        let tab = Arc::clone(&self.tab);
        let receipt = Receipt::join(Box::pin(async move {
            let result = prefix.await;
            frames.release(&tab);
            result
        }));
        let waiting = receipt.wait();
        state.closed = Some(receipt);
        waiting
    }
}

impl<P: Host<Sidecar = Source>> Sink for SourceEvents<P> {
    fn event(&self, event: LaneEvent) {
        let mut state = lock(&self.state);
        if state.closed.is_some() {
            return;
        }
        let binding = self.binding.subscribe();
        let pool = self.pool.upgrade();
        let owner = self.owner.clone();
        let tab = Arc::clone(&self.tab);
        let frames = Arc::clone(&self.frames);
        let downstream = Arc::clone(&self.downstream);
        let decoder = Arc::clone(&self.decoder);
        let _ = state.pending.submit(move || {
            Box::pin(async move {
                let source = original_source(binding).await?;
                let pool = pool.ok_or_else(missing_source)?;
                let generation = event.generation;
                let observation = event.observation.clone();
                let projection_tab = Arc::clone(&tab);
                let project = move |source: &Arc<Source>| {
                    let projected =
                        project_output(source, &projection_tab, &frames, &decoder, &event);
                    // This required actor only enqueues; it must not await or re-enter Callers here.
                    downstream.event(event);
                    projected
                };
                let (feed, side_channel) = match &observation {
                    Some(observation) => {
                        pool.source_observation_captured(
                            &owner,
                            &tab,
                            Arc::clone(&source),
                            observation.clone(),
                            project,
                        )
                        .await?
                    }
                    None => {
                        pool.source_effect_captured(
                            &owner,
                            &tab,
                            Arc::clone(&source),
                            generation,
                            project,
                        )
                        .await?
                    }
                };
                let feed_result = match feed {
                    Some((name, payload)) => {
                        let event = CapturedEvent {
                            generation,
                            name: name.into(),
                            payload,
                            from_link: false,
                        };
                        match observation {
                            Some(observation) => {
                                pool.feed_observed(&owner, &tab, source, event, observation)
                                    .await
                            }
                            None => pool.feed_captured(&owner, &tab, source, event).await,
                        }
                    }
                    None => Ok(()),
                };
                let side_result = match side_channel {
                    Some(work) => work.await,
                    None => Ok(()),
                };
                feed_result.and(side_result)
            })
        });
    }

    fn before_response(&self) {
        self.frames.flush(&self.tab);
        self.downstream.before_response();
    }

    fn reply_barrier(&self) -> Held {
        let mut state = lock(&self.state);
        if let Some(receipt) = &state.closed {
            return receipt.wait();
        }
        checkpoint(&mut state.pending, Arc::clone(&self.downstream), false)
    }

    fn remove_listeners(&self) {
        drop(self.close());
    }

    fn sync_settings(&self) -> EffectFuture<'_, ()> {
        let binding = self.binding.subscribe();
        let pool = self.pool.upgrade();
        let owner = self.owner.clone();
        let tab = Arc::clone(&self.tab);
        let mut state = lock(&self.state);
        if let Some(receipt) = &state.closed {
            let waiting = receipt.wait();
            return Box::pin(async move {
                let _ = waiting.await;
            });
        }
        let _ = state.pending.submit(move || {
            Box::pin(async move {
                let source = original_source(binding).await?;
                let pool = pool.ok_or_else(missing_source)?;
                let generation = source.generation();
                let application = pool
                    .source_effect_captured(&owner, &tab, source, generation, |source| {
                        source
                            .local_application()
                            .cloned()
                            .ok_or_else(missing_source)
                    })
                    .await?;
                application.sync_settings().await;
                Ok(())
            })
        });
        let waiting = state.pending.barrier();
        // Sink's settings callback has no error slot; the same fault remains in reply_barrier/close.
        Box::pin(async move {
            let _ = waiting.await;
        })
    }
}

type Projection = (Option<(&'static str, Value)>, Option<Held>);

fn project_output(
    source: &Arc<Source>,
    tab: &str,
    frames: &Frames,
    decoder: &Mutex<RunDecoder>,
    event: &LaneEvent,
) -> Result<Projection, Fault> {
    match event.name.as_str() {
        "sidecar.status" => {
            let payload = event.data.get("payload").ok_or_else(|| {
                Fault::new("source_event_invalid", "Status has no original payload")
            })?;
            frames.forward(tab, "SIDECAR_STATUS", payload.clone());
            let mut light = selected(
                payload,
                &[
                    "status",
                    "sessionHeld",
                    "slow",
                    "queued",
                    "message",
                    "sessionEnded",
                ],
            );
            let failure = if matches!(
                payload.get("status").and_then(Value::as_str),
                Some("error" | "exited" | "restarting")
            ) {
                Value::Object(selected(payload, &["message", "restart"]))
            } else {
                Value::Null
            };
            light.insert("failure".into(), failure);
            Ok((Some(("status", Value::Object(light))), None))
        }
        "sidecar.session" => Ok((
            event
                .data
                .get("identity")
                .filter(|identity| !identity.is_null())
                .map(|identity| {
                    (
                        "session",
                        Value::Object(selected(
                            identity,
                            &["sessionId", "sessionFile", "sessionName"],
                        )),
                    )
                }),
            None,
        )),
        "sidecar.frame" => {
            let bytes = event
                .bin
                .as_deref()
                .ok_or_else(|| Fault::new("source_event_invalid", "Frame has no original bytes"))?;
            let frame: Value = serde_json::from_slice(bytes)
                .map_err(|error| Fault::new("source_event_invalid", error.to_string()))?;
            let frame = without_frame_bookkeeping(&frame).unwrap_or(frame);
            project_frame(source, tab, frames, decoder, event.generation, frame)
        }
        _ => Ok((None, None)),
    }
}

fn agent_event(kind: &str) -> bool {
    matches!(
        kind,
        "agent_start"
            | "agent_end"
            | "turn_start"
            | "turn_end"
            | "message_start"
            | "message_update"
            | "message_end"
            | "tool_execution_start"
            | "tool_execution_update"
            | "tool_execution_end"
            | "auto_compaction_start"
            | "auto_compaction_end"
            | "auto_retry_start"
            | "auto_retry_end"
            | "retry_fallback_applied"
            | "retry_fallback_succeeded"
            | "model_changed"
            | "ttsr_triggered"
            | "todo_reminder"
            | "todo_auto_clear"
            | "irc_message"
            | "notice"
            | "thinking_level_changed"
            | "goal_updated"
            | "goal_time_limit_reached"
            | "autopilot_update"
            | "next_prompt_update"
            | "next_prompt_config"
            | "plan_proposal"
            | "plan_proposal_resolved"
            | "checkout_peers"
            | "queue_update"
            | "token_rate"
            | "model_request"
            | "read_group_metadata"
    )
}

fn project_frame(
    source: &Arc<Source>,
    tab: &str,
    frames: &Frames,
    decoder: &Mutex<RunDecoder>,
    generation: u64,
    frame: Value,
) -> Result<Projection, Fault> {
    let kind = frame.get("type").and_then(Value::as_str).unwrap_or("");
    if agent_event(kind) {
        let mut run = lock(decoder);
        if run.generation != Some(generation) {
            run.generation = Some(generation);
            run.decoder = Decoder::new();
        }
        let mut batch = [frame];
        let decoded = run.decoder.events(&batch);
        drop(run);
        let commands = source.local_commands().ok_or_else(missing_source)?;
        let project = |events: &mut [Value]| {
            let mut projected = Vec::new();
            for event in events {
                commands.project_frame(event);
                if let Some(light) = project_event(event) {
                    projected.push(light);
                }
            }
            projected
        };
        let projected = match decoded {
            std::borrow::Cow::Borrowed(_) => {
                let projected = project(&mut batch);
                frames.events(tab, Arc::from(batch));
                projected
            }
            std::borrow::Cow::Owned(mut events) => {
                let projected = project(&mut events);
                frames.events(tab, Arc::from(events));
                projected
            }
        };
        return Ok((
            (!projected.is_empty()).then(|| ("events", Value::Array(projected))),
            None,
        ));
    }
    match kind {
        "extension_ui_request" => {
            let kinds = request_kinds(&frame);
            Ok((
                Some(("extensionUi", json!({"request": frame, "kinds": kinds}))),
                None,
            ))
        }
        "host_uri_request" => {
            let id = frame
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| Fault::new("source_event_invalid", "Host URI request has no id"))?;
            let url = frame
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| Fault::new("source_event_invalid", "Host URI request has no URL"))?;
            let response = json!({
                "type": "host_uri_result", "id": id, "isError": true,
                "error": format!("OMPdesk serves no host URI for {url}"),
            });
            Ok((None, Some(source.send_for_generation(generation, response))))
        }
        "subagent_lifecycle" | "subagent_progress" | "subagent_event" => {
            let mut run = lock(decoder);
            if run.generation != Some(generation) {
                run.generation = Some(generation);
                run.decoder = Decoder::new();
            }
            let rebuilt = run.decoder.subagent_frame(&frame);
            drop(run);
            match rebuilt {
                Some(std::borrow::Cow::Borrowed(_)) => frames.subagent(tab, frame),
                Some(std::borrow::Cow::Owned(rebuilt)) => frames.subagent(tab, rebuilt),
                None => {}
            }
            Ok((None, None))
        }
        "available_commands_update" => {
            frames.forward(
                tab,
                "COMMANDS_UPDATE",
                frame.get("commands").cloned().unwrap_or(Value::Null),
            );
            Ok((None, None))
        }
        "session_settled" => Ok((
            Some((
                "settle",
                json!({"settled": true, "frame": "session_settled"}),
            )),
            None,
        )),
        _ => {
            let channel = match kind {
                "model_catalog_update" => Some("MODEL_CATALOG_UPDATE"),
                "config_update" => Some("CONFIG_UPDATE"),
                "prompt_result" => Some("PROMPT_RESULT"),
                "command_output" => Some("COMMAND_OUTPUT"),
                "session_info_update" => Some("SESSION_INFO_UPDATE"),
                "extension_error" => Some("EXTENSION_ERROR"),
                "live_phase" | "live_levels" | "live_transcript" | "live_end" => Some("LIVE_FRAME"),
                "btw_delta" | "btw_record" => Some("BTW_FRAME"),
                _ => None,
            };
            let light = match kind {
                "prompt_result" => {
                    frame
                        .get("sessionSettled")
                        .and_then(Value::as_bool)
                        .map(|settled| {
                            (
                                "settle",
                                json!({"settled": settled, "frame": "prompt_result"}),
                            )
                        })
                }
                "session_info_update" => Some((
                    "sessionInfoUpdate",
                    Value::Object(selected(&frame, &["title", "sessionId", "autoTitle"])),
                )),
                _ => None,
            };
            if let Some(channel) = channel {
                frames.forward(tab, channel, frame);
            }
            Ok((light, None))
        }
    }
}

// This runs without the TypeScript host. Preserve sidecar-pool.ts's projectEvents/kindsOf;
// approval syntax uses the canonical native parser without invoking its approval effects.
fn selected(source: &Value, fields: &[&str]) -> Map<String, Value> {
    fields
        .iter()
        .filter_map(|key| source.get(*key).map(|value| ((*key).into(), value.clone())))
        .collect()
}

fn project_event(event: &Value) -> Option<Value> {
    let kind = event.get("type")?.as_str()?;
    match kind {
        "agent_start"
        | "tool_execution_start"
        | "tool_execution_end"
        | "auto_compaction_start"
        | "auto_compaction_end" => Some(json!({"type": kind})),
        "agent_end" => {
            let mut projected = selected(event, &["type", "isTerminal"]);
            let last = event
                .get("messages")
                .and_then(Value::as_array)
                .and_then(|messages| {
                    messages.iter().rev().find(|message| {
                        message.get("role").and_then(Value::as_str) == Some("assistant")
                    })
                });
            let mut messages = Vec::with_capacity(usize::from(last.is_some()));
            if let Some(last) = last {
                let mut message = selected(last, &["role", "stopReason", "errorMessage"]);
                match last.get("content") {
                    Some(Value::String(text)) => {
                        message.insert("content".into(), Value::String(text.clone()));
                    }
                    Some(Value::Array(parts)) => {
                        let text = parts
                            .iter()
                            .filter_map(|part| {
                                (part.get("type").and_then(Value::as_str) == Some("text"))
                                    .then(|| Value::Object(selected(part, &["type", "text"])))
                            })
                            .collect();
                        message.insert("content".into(), Value::Array(text));
                    }
                    _ => {}
                }
                messages.push(Value::Object(message));
            }
            projected.insert("messages".into(), Value::Array(messages));
            Some(Value::Object(projected))
        }
        "auto_retry_start" => Some(Value::Object(selected(
            event,
            &["type", "attempt", "maxAttempts", "delayMs", "errorMessage"],
        ))),
        "auto_retry_end" => Some(Value::Object(selected(
            event,
            &["type", "success", "attempt", "finalError"],
        ))),
        "plan_proposal" | "plan_proposal_resolved" => Some(event.clone()),
        "message_end" => {
            let original = event.get("message")?;
            let mut message = selected(original, &["role"]);
            if original.get("role").and_then(Value::as_str) == Some("user") {
                let text = match original.get("content") {
                    Some(Value::String(text)) => text.clone(),
                    Some(Value::Array(parts)) => parts
                        .iter()
                        .filter_map(|part| {
                            (part.get("type").and_then(Value::as_str) == Some("text"))
                                .then(|| part.get("text").and_then(Value::as_str))
                                .flatten()
                        })
                        .collect(),
                    _ => String::new(),
                };
                message.insert("text".into(), Value::String(text));
            }
            Some(json!({"type": kind, "message": message}))
        }
        _ => None,
    }
}

fn request_kinds(request: &Value) -> Value {
    let method = request.get("method").and_then(Value::as_str);
    let sign_in = match method {
        Some("notify") => match request.get("notifyType") {
            None | Some(Value::Null) => true,
            Some(value) => value.as_str() == Some("info"),
        },
        Some("open_url" | "input") => true,
        _ => false,
    };
    json!({
        "blocking": matches!(method, Some("select" | "confirm" | "ask" | "input" | "editor" | "open_url")),
        "signIn": sign_in,
        "approval": is_approval_select(request),
    })
}

#[cfg(test)]
#[path = "source_events_tests.rs"]
mod tests;
