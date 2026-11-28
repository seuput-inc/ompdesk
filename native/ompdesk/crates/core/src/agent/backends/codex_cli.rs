//! Concrete [`AgentAdapter`] for Codex CLI (`codex exec --json`, `codex resume <id>`, and
//! `codex app-server` JSON-RPC 2.0).
//!
//! Spawns the user's installed `codex` CLI directly over `tokio::process` pipes, feeds stdout
//! JSONL lines through [`CodexStreamParser`], persists `thread_id` across turns and hibernation,
//! and cleanly cancels active processes on `interrupt`, `hibernate`, or `stop`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use super::detect::{CliCommandSpec, DiscoveryEnv, build_tokio_command, detect_cli, detect_cli_in};
use crate::agent::adapter::{AgentAdapter, AgentSession, BoxFuture};
use crate::agent::parsers::codex_stream::CodexStreamParser;
use crate::agent::types::{
    AgentCapabilities, AgentError, AgentEvent, ApprovalDecision, ApprovalMode, BackendId,
    DiscoverySource, InstalledBackend, ProviderCliKind, ResumeHandle, SessionLifecycleState,
    SessionSpec, TurnFinishReason, TurnInput,
};

const EVENT_CHANNEL_CAPACITY: usize = 256;

/// Transport strategy used by [`CodexCliAdapter`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexTransportMode {
    /// Per-turn non-interactive `codex exec --json` / `codex exec resume --json`.
    #[default]
    ExecJson,
    /// Persistent `codex app-server` JSON-RPC 2.0 session over NDJSON stdio.
    AppServer,
}

/// Maps OMPdesk [`ApprovalMode`] onto Codex CLI execution policy flags.
pub const fn codex_approval_args(mode: ApprovalMode) -> &'static [&'static str] {
    match mode {
        ApprovalMode::Ask => &["--ask-for-approval", "on-request"],
        ApprovalMode::AutoApprove => &["--full-auto"],
        ApprovalMode::ReadOnly => &["--sandbox", "read-only"],
        ApprovalMode::FullAccess => &["--dangerously-bypass-approvals-and-sandbox"],
    }
}

/// Builds the `codex exec --json` (or `codex exec resume --json <id>`) command spec for one turn.
///
/// Always appends `-` so the prompt is delivered safely over piped stdin without OS argv limits.
pub fn build_codex_exec_command(
    binary: PathBuf,
    spec: &SessionSpec,
    turn: &TurnInput,
    resume_id: Option<&str>,
    is_windows: bool,
) -> CliCommandSpec {
    let effective_resume = resume_id
        .filter(|id| !id.is_empty())
        .or_else(|| spec.resume.as_ref().map(|handle| handle.native_id.as_str()))
        .filter(|id| !id.is_empty());

    let mut args = vec!["exec".to_owned()];
    if effective_resume.is_some() {
        args.push("resume".to_owned());
    }
    args.push("--json".to_owned());

    let effective_model = turn
        .model_override
        .as_deref()
        .filter(|model| !model.is_empty())
        .or_else(|| spec.model.as_deref().filter(|model| !model.is_empty()));
    if let Some(model) = effective_model {
        args.push("--model".to_owned());
        args.push(model.to_owned());
    }

    args.extend(
        codex_approval_args(spec.approval_mode)
            .iter()
            .map(|s| (*s).to_owned()),
    );

    if effective_resume.is_none() {
        args.push("-C".to_owned());
        args.push(spec.cwd.to_string_lossy().into_owned());
    }

    args.extend(spec.extra_args.iter().cloned());

    if let Some(id) = effective_resume {
        args.push(id.to_owned());
    }
    args.push("-".to_owned());

    CliCommandSpec::new(binary, args, is_windows)
}

/// Builds a direct `codex resume <id>` invocation spec for interactive resume handoff.
pub fn build_codex_resume_command(
    binary: PathBuf,
    resume_id: &str,
    spec: &SessionSpec,
    is_windows: bool,
) -> CliCommandSpec {
    let mut args = vec!["resume".to_owned()];
    if let Some(model) = spec.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--model".to_owned());
        args.push(model.to_owned());
    }
    args.extend(
        codex_approval_args(spec.approval_mode)
            .iter()
            .map(|s| (*s).to_owned()),
    );
    args.extend(spec.extra_args.iter().cloned());
    args.push(resume_id.to_owned());
    CliCommandSpec::new(binary, args, is_windows)
}

/// Builds the persistent `codex app-server` command spec.
pub fn build_codex_app_server_command(
    binary: PathBuf,
    spec: &SessionSpec,
    is_windows: bool,
) -> CliCommandSpec {
    let mut args = vec!["app-server".to_owned()];
    args.extend(spec.extra_args.iter().cloned());
    CliCommandSpec::new(binary, args, is_windows)
}

/// JSON-RPC 2.0 `initialize` frame sent upon connecting to `codex app-server`.
pub fn app_server_initialize_frame(request_id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "ompdesk",
                "version": env!("CARGO_PKG_VERSION"),
            }
        }
    })
}

/// JSON-RPC 2.0 `thread/start` frame for opening a new Codex `app-server` thread.
pub fn app_server_thread_start_frame(request_id: u64, cwd: &Path, model: Option<&str>) -> Value {
    let mut params = serde_json::Map::new();
    params.insert(
        "cwd".to_owned(),
        Value::String(cwd.to_string_lossy().into_owned()),
    );
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        params.insert("model".to_owned(), Value::String(model.to_owned()));
    }
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "thread/start",
        "params": Value::Object(params),
    })
}

/// JSON-RPC 2.0 `thread/resume` frame for reattaching to an existing Codex `threadId`.
pub fn app_server_thread_resume_frame(request_id: u64, thread_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "thread/resume",
        "params": {
            "threadId": thread_id,
        }
    })
}

/// JSON-RPC 2.0 `turn/start` frame submitting one user prompt to an open `app-server` thread.
pub fn app_server_turn_start_frame(request_id: u64, thread_id: &str, prompt: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "turn/start",
        "params": {
            "threadId": thread_id,
            "input": [{ "type": "text", "text": prompt }],
        }
    })
}

/// JSON-RPC 2.0 `turn/interrupt` frame requesting cooperative turn cancellation.
pub fn app_server_turn_interrupt_frame(
    request_id: u64,
    thread_id: &str,
    turn_id: Option<&str>,
) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("threadId".to_owned(), Value::String(thread_id.to_owned()));
    if let Some(id) = turn_id.filter(|id| !id.is_empty()) {
        params.insert("turnId".to_owned(), Value::String(id.to_owned()));
    }
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "turn/interrupt",
        "params": Value::Object(params),
    })
}

/// JSON-RPC 2.0 response frame replying to a Codex `app-server` approval request.
pub fn app_server_approval_response_frame(request_id: Value, decision: &ApprovalDecision) -> Value {
    let result = match decision {
        ApprovalDecision::AllowOnce => json!({ "decision": "accept" }),
        ApprovalDecision::AllowSession => json!({ "decision": "acceptForSession" }),
        ApprovalDecision::Deny { reason } => json!({
            "decision": "decline",
            "reason": reason,
        }),
    };
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result,
    })
}

/// Pumps JSONL lines from `reader` through [`CodexStreamParser`] into `tx`, returning the
/// observed [`ResumeHandle`] (if Codex emitted a `thread_id` / `threadId`).
pub async fn pump_codex_stream<R: AsyncBufRead + Unpin>(
    mut reader: R,
    parser: &mut CodexStreamParser,
    tx: &mpsc::Sender<AgentEvent>,
) -> Result<Option<ResumeHandle>, AgentError> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            break;
        }
        match parser.parse_line(&line) {
            Ok(events) => {
                for event in events {
                    if tx.send(event).await.is_err() {
                        return Ok(parser.resume_handle());
                    }
                }
            }
            Err(error) => {
                let _ = tx
                    .send(AgentEvent::Error {
                        code: error.code().to_owned(),
                        message: error.to_string(),
                        retryable: false,
                    })
                    .await;
            }
        }
    }
    Ok(parser.resume_handle())
}

struct CodexSessionRuntime {
    spec: SessionSpec,
    binary: PathBuf,
    is_windows: bool,
    mode: CodexTransportMode,
    event_tx: mpsc::Sender<AgentEvent>,
    resume_handle: StdMutex<Option<ResumeHandle>>,
    active_cancel: StdMutex<Option<oneshot::Sender<()>>>,
    app_server_stdin: StdMutex<Option<mpsc::UnboundedSender<String>>>,
    next_rpc_id: AtomicU64,
}

impl CodexSessionRuntime {
    fn next_id(&self) -> u64 {
        self.next_rpc_id.fetch_add(1, Ordering::Relaxed)
    }

    fn cancel_active_process(&self) -> bool {
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

    fn close_app_server_stdin(&self) {
        let _ = self
            .app_server_stdin
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
    }

    fn send_app_server_frame(&self, frame: &Value) -> Result<(), AgentError> {
        let tx = self
            .app_server_stdin
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or(AgentError::SessionNotReady {
                state: SessionLifecycleState::Stopped,
            })?;
        let mut line = serde_json::to_string(frame)?;
        line.push('\n');
        tx.send(line).map_err(|_| AgentError::Transport {
            message: "codex app-server stdin channel closed".to_owned(),
        })
    }

    fn current_resume_handle(&self) -> Option<ResumeHandle> {
        self.resume_handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_resume_handle(&self, handle: ResumeHandle) {
        *self
            .resume_handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(handle);
    }
}

/// Concrete [`AgentAdapter`] driving Codex CLI in either `exec --json` or `app-server` mode.
pub struct CodexCliAdapter {
    mode: CodexTransportMode,
    binary_override: Option<PathBuf>,
    discovery_env: Option<DiscoveryEnv>,
    sessions: Arc<StdMutex<HashMap<String, Arc<CodexSessionRuntime>>>>,
}

impl Default for CodexCliAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexCliAdapter {
    pub fn new() -> Self {
        Self {
            mode: CodexTransportMode::ExecJson,
            binary_override: None,
            discovery_env: None,
            sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    pub fn with_mode(mut self, mode: CodexTransportMode) -> Self {
        self.mode = mode;
        self
    }

    pub fn with_binary(binary: impl Into<PathBuf>) -> Self {
        Self {
            mode: CodexTransportMode::ExecJson,
            binary_override: Some(binary.into()),
            discovery_env: None,
            sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    pub fn with_discovery_env(env: DiscoveryEnv) -> Self {
        Self {
            mode: CodexTransportMode::ExecJson,
            binary_override: None,
            discovery_env: Some(env),
            sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    pub fn mode(&self) -> CodexTransportMode {
        self.mode
    }

    fn resolve_binary(&self) -> Result<(PathBuf, bool), AgentError> {
        let is_windows = self
            .discovery_env
            .as_ref()
            .map_or(cfg!(windows), |env| env.is_windows);
        if let Some(path) = &self.binary_override {
            return Ok((path.clone(), is_windows));
        }
        let info = match &self.discovery_env {
            Some(env) => detect_cli_in(self.id(), env),
            None => detect_cli(self.id()),
        };
        info.binary_path
            .map(|path| (path, is_windows))
            .ok_or_else(|| AgentError::NotInstalled {
                backend: self.id(),
                detail: info
                    .detail
                    .unwrap_or_else(|| "codex CLI binary not found on PATH".to_owned()),
            })
    }

    fn lookup_session(&self, session_id: &str) -> Result<Arc<CodexSessionRuntime>, AgentError> {
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

impl AgentAdapter for CodexCliAdapter {
    fn id(&self) -> BackendId {
        BackendId::ProviderCli(ProviderCliKind::Codex)
    }

    fn capabilities(&self) -> AgentCapabilities {
        let mut caps = AgentCapabilities::provider_cli(ProviderCliKind::Codex);
        if self.mode == CodexTransportMode::ExecJson {
            caps.mid_turn_steer = false;
        }
        caps
    }

    fn detect_installed(&self) -> BoxFuture<'_, InstalledBackend> {
        let report = if let Some(path) = &self.binary_override {
            let mut installed =
                InstalledBackend::available(self.id(), DiscoverySource::UserInstall);
            installed.executable_path = Some(path.clone());
            installed
        } else {
            let info = match &self.discovery_env {
                Some(env) => detect_cli_in(self.id(), env),
                None => detect_cli(self.id()),
            };
            info.to_installed_backend()
        };
        Box::pin(async move { report })
    }

    fn start(&self, spec: SessionSpec) -> BoxFuture<'_, Result<AgentSession, AgentError>> {
        let resolved = self.resolve_binary();
        let backend = self.id();
        let caps = self.capabilities();
        let mode = self.mode;
        let sessions = Arc::clone(&self.sessions);
        Box::pin(async move {
            let (binary, is_windows) = resolved?;
            if let Some(resume) = &spec.resume
                && resume.backend != backend
            {
                return Err(AgentError::InvalidResumeHandle {
                    expected: backend,
                    found: resume.backend,
                });
            }
            let (tx, rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
            let initial_resume = spec.resume.clone();
            let session_id = spec.session_id.clone();

            let runtime = Arc::new(CodexSessionRuntime {
                spec,
                binary,
                is_windows,
                mode,
                event_tx: tx.clone(),
                resume_handle: StdMutex::new(initial_resume.clone()),
                active_cancel: StdMutex::new(None),
                app_server_stdin: StdMutex::new(None),
                next_rpc_id: AtomicU64::new(1),
            });

            let mut pid = None;
            if mode == CodexTransportMode::AppServer {
                let cmd_spec = build_codex_app_server_command(
                    runtime.binary.clone(),
                    &runtime.spec,
                    runtime.is_windows,
                );
                let mut cmd =
                    build_tokio_command(&cmd_spec, Some(&runtime.spec.cwd), &runtime.spec.env, &[]);
                let mut child = cmd.spawn().map_err(|error| AgentError::SpawnFailed {
                    message: format!("failed to spawn codex app-server: {error}"),
                })?;
                pid = child.id();

                let mut stdin = child.stdin.take().ok_or_else(|| AgentError::SpawnFailed {
                    message: "codex app-server stdin pipe unavailable".to_owned(),
                })?;
                let stdout = child.stdout.take().ok_or_else(|| AgentError::SpawnFailed {
                    message: "codex app-server stdout pipe unavailable".to_owned(),
                })?;

                let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
                *runtime
                    .app_server_stdin
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(stdin_tx);

                tokio::spawn(async move {
                    while let Some(line) = stdin_rx.recv().await {
                        if stdin.write_all(line.as_bytes()).await.is_err()
                            || stdin.flush().await.is_err()
                        {
                            break;
                        }
                    }
                    let _ = stdin.shutdown().await;
                });

                let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
                *runtime
                    .active_cancel
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(cancel_tx);

                let runtime_bg = Arc::clone(&runtime);
                tokio::spawn(async move {
                    let mut parser = CodexStreamParser::new();
                    let reader = BufReader::new(stdout);
                    let tx_bg = runtime_bg.event_tx.clone();
                    tokio::select! {
                        result = pump_codex_stream(reader, &mut parser, &tx_bg) => {
                            if let Ok(Some(handle)) = result {
                                runtime_bg.set_resume_handle(handle);
                            }
                            let _ = child.wait().await;
                        }
                        _ = &mut cancel_rx => {
                            let _ = child.kill().await;
                            let _ = child.wait().await;
                        }
                    }
                    if let Some(handle) = parser.resume_handle() {
                        runtime_bg.set_resume_handle(handle);
                    }
                });

                runtime.send_app_server_frame(&app_server_initialize_frame(runtime.next_id()))?;
                if let Some(handle) = &initial_resume {
                    runtime.send_app_server_frame(&app_server_thread_resume_frame(
                        runtime.next_id(),
                        &handle.native_id,
                    ))?;
                } else {
                    runtime.send_app_server_frame(&app_server_thread_start_frame(
                        runtime.next_id(),
                        &runtime.spec.cwd,
                        runtime.spec.model.as_deref(),
                    ))?;
                }
            }

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

            let mut session = AgentSession::new(session_id, backend, caps, rx);
            if let Some(child_pid) = pid {
                session = session.with_pid(child_pid);
            }
            if let Some(handle) = initial_resume {
                session.set_resume_handle(handle);
            }
            Ok(session)
        })
    }

    fn send_turn<'a>(
        &'a self,
        session: &'a AgentSession,
        input: TurnInput,
    ) -> BoxFuture<'a, Result<(), AgentError>> {
        let runtime = self.lookup_session(session.id());
        Box::pin(async move {
            let runtime = runtime?;
            if runtime.mode == CodexTransportMode::AppServer {
                let thread_id = runtime
                    .current_resume_handle()
                    .map(|handle| handle.native_id)
                    .unwrap_or_else(|| runtime.spec.session_id.clone());
                let frame =
                    app_server_turn_start_frame(runtime.next_id(), &thread_id, &input.prompt);
                return runtime.send_app_server_frame(&frame);
            }

            let resume_id = runtime
                .current_resume_handle()
                .map(|handle| handle.native_id);
            let cmd_spec = build_codex_exec_command(
                runtime.binary.clone(),
                &runtime.spec,
                &input,
                resume_id.as_deref(),
                runtime.is_windows,
            );
            let mut cmd =
                build_tokio_command(&cmd_spec, Some(&runtime.spec.cwd), &runtime.spec.env, &[]);

            let mut child = cmd.spawn().map_err(|error| AgentError::SpawnFailed {
                message: format!("failed to spawn codex CLI: {error}"),
            })?;

            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(input.prompt.as_bytes()).await?;
                if !input.prompt.ends_with('\n') {
                    stdin.write_all(b"\n").await?;
                }
                stdin.shutdown().await?;
            }

            let stdout = child.stdout.take().ok_or_else(|| AgentError::SpawnFailed {
                message: "codex CLI child stdout pipe unavailable".to_owned(),
            })?;

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
                let mut parser = CodexStreamParser::new();
                let reader = BufReader::new(stdout);
                let tx = runtime_bg.event_tx.clone();
                let mut interrupted = false;

                tokio::select! {
                    result = pump_codex_stream(reader, &mut parser, &tx) => {
                        match result {
                            Ok(Some(handle)) => runtime_bg.set_resume_handle(handle),
                            Ok(None) => {}
                            Err(error) => {
                                let _ = tx
                                    .send(AgentEvent::Error {
                                        code: error.code().to_owned(),
                                        message: error.to_string(),
                                        retryable: error.is_retryable(),
                                    })
                                    .await;
                            }
                        }
                        let _ = child.wait().await;
                    }
                    _ = &mut cancel_rx => {
                        interrupted = true;
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                    }
                }

                if let Some(handle) = parser.resume_handle() {
                    runtime_bg.set_resume_handle(handle);
                }
                if interrupted {
                    let _ = tx
                        .send(AgentEvent::TurnFinished {
                            turn_id: input.turn_id,
                            reason: TurnFinishReason::Interrupted,
                            resume_handle: runtime_bg.current_resume_handle().map(Box::new),
                        })
                        .await;
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

    fn interrupt<'a>(&'a self, session: &'a AgentSession) -> BoxFuture<'a, Result<(), AgentError>> {
        let runtime = self.lookup_session(session.id());
        Box::pin(async move {
            let runtime = runtime?;
            if runtime.mode == CodexTransportMode::AppServer {
                if let Some(handle) = runtime.current_resume_handle() {
                    let frame =
                        app_server_turn_interrupt_frame(runtime.next_id(), &handle.native_id, None);
                    let _ = runtime.send_app_server_frame(&frame);
                }
                return Ok(());
            }
            let _ = runtime.cancel_active_process();
            Ok(())
        })
    }

    fn hibernate<'a>(
        &'a self,
        session: &'a mut AgentSession,
    ) -> BoxFuture<'a, Result<ResumeHandle, AgentError>> {
        let session_id = session.id().to_owned();
        let runtime = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&session_id);
        Box::pin(async move {
            let handle = if let Some(rt) = runtime {
                rt.close_app_server_stdin();
                let _ = rt.cancel_active_process();
                let _ = rt.event_tx.try_send(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Hibernated,
                    detail: None,
                });
                rt.current_resume_handle()
                    .or_else(|| session.resume_handle().cloned())
                    .or_else(|| rt.spec.resume.clone())
            } else {
                session.resume_handle().cloned()
            };

            session.set_pid(None);
            session.set_state(SessionLifecycleState::Hibernated);

            let Some(handle) = handle else {
                return Err(AgentError::InvalidSpec {
                    message: "Codex session has no observed thread_id to hibernate with".to_owned(),
                });
            };
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
                rt.close_app_server_stdin();
                let _ = rt.cancel_active_process();
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
    use std::io::Cursor;

    use super::*;

    #[test]
    fn builds_codex_exec_fresh_and_resume_argv_and_app_server_frames() {
        let mut spec = SessionSpec::new("tab-codex", "/repo/project");
        spec.model = Some("gpt-5.3-codex".to_owned());
        spec.approval_mode = ApprovalMode::ReadOnly;
        let turn = TurnInput::text("Audit module boundaries");

        let fresh = build_codex_exec_command(
            PathBuf::from("/usr/local/bin/codex"),
            &spec,
            &turn,
            None,
            false,
        );
        assert_eq!(
            fresh.args,
            [
                "exec",
                "--json",
                "--model",
                "gpt-5.3-codex",
                "--sandbox",
                "read-only",
                "-C",
                "/repo/project",
                "-",
            ]
        );

        let resumed = build_codex_exec_command(
            PathBuf::from("/usr/local/bin/codex"),
            &spec,
            &turn,
            Some("thr-55"),
            false,
        );
        assert_eq!(
            resumed.args,
            [
                "exec",
                "resume",
                "--json",
                "--model",
                "gpt-5.3-codex",
                "--sandbox",
                "read-only",
                "thr-55",
                "-",
            ]
        );

        let interactive = build_codex_resume_command(
            PathBuf::from("C:\\tools\\codex.cmd"),
            "thr-55",
            &spec,
            true,
        );
        assert!(interactive.use_cmd_shim);
        assert_eq!(
            interactive.args,
            [
                "resume",
                "--model",
                "gpt-5.3-codex",
                "--sandbox",
                "read-only",
                "thr-55",
            ]
        );

        let init = app_server_initialize_frame(1);
        assert_eq!(init["method"], "initialize");
        let start = app_server_thread_start_frame(2, Path::new("/repo"), Some("gpt-5.3-codex"));
        assert_eq!(start["params"]["cwd"], "/repo");
        let reply = app_server_approval_response_frame(json!(9), &ApprovalDecision::AllowSession);
        assert_eq!(reply["result"]["decision"], "acceptForSession");
    }

    #[tokio::test]
    async fn pumps_mock_codex_jsonl_stream_and_handles_hibernate_resume() {
        let jsonl = concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"thr-404\"}\n",
            "{\"type\":\"turn.started\",\"turn_id\":\"t1\",\"model\":\"gpt-5.3-codex\"}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"m1\",\"type\":\"agent_message\",\"text\":\"Ready.\"}}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}\n",
        );

        let (tx, mut rx) = mpsc::channel(16);
        let mut parser = CodexStreamParser::new();
        let handle = pump_codex_stream(BufReader::new(Cursor::new(jsonl)), &mut parser, &tx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            handle,
            ResumeHandle::new(BackendId::ProviderCli(ProviderCliKind::Codex), "thr-404")
        );
        drop(tx);

        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::TextDelta { text, .. } if text == "Ready."
        )));

        let adapter = CodexCliAdapter::with_binary("/usr/local/bin/codex");
        assert!(!adapter.capabilities().mid_turn_steer);
        assert!(
            CodexCliAdapter::new()
                .with_mode(CodexTransportMode::AppServer)
                .capabilities()
                .mid_turn_steer
        );

        let mut spec = SessionSpec::new("tab-codex-1", "/tmp");
        spec.resume = Some(handle.clone());
        let mut session = adapter.start(spec).await.unwrap();
        let hibernated = adapter.hibernate(&mut session).await.unwrap();
        assert_eq!(hibernated, handle);
        assert_eq!(session.state(), SessionLifecycleState::Hibernated);

        let resumed = adapter
            .resume(hibernated.clone(), SessionSpec::new("tab-codex-1", "/tmp"))
            .await
            .unwrap();
        assert_eq!(resumed.resume_handle(), Some(&hibernated));
    }
}
