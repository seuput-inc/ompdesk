//! Backend registry, installed-provider discovery model, and capability fallback rules.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use super::adapter::AgentAdapter;
use super::backends::{
    ClaudeCliAdapter, CodexCliAdapter, DirectApiAdapter, NoopToolExecutor, ToolExecutor,
};
use super::omp_contract::OmpAdapterContract;
use super::types::{
    AgentError, BackendId, BackendKind, CapabilityRequirements, DirectApiProvider, DiscoverySource,
    InstallStatus, InstalledBackend, ProviderCliKind,
};

/// Default resolution precedence when no explicit backend is requested.
///
/// Structured Provider CLIs come first, followed by OMP, native Direct API providers, and finally
/// the universal Generic PTY fallback.
pub const DEFAULT_PREFERENCE_ORDER: &[BackendId] = &[
    BackendId::ProviderCli(ProviderCliKind::ClaudeCode),
    BackendId::ProviderCli(ProviderCliKind::Codex),
    BackendId::Omp,
    BackendId::ProviderCli(ProviderCliKind::Antigravity),
    BackendId::DirectApi(DirectApiProvider::Anthropic),
    BackendId::DirectApi(DirectApiProvider::OpenAi),
    BackendId::DirectApi(DirectApiProvider::OpenRouter),
    BackendId::DirectApi(DirectApiProvider::OpenAiCompatible),
    BackendId::ProviderCli(ProviderCliKind::GenericPty),
];

/// Caller constraints passed to [`AdapterRegistry::resolve`] or [`AdapterRegistry::resolve_with_snapshot`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolutionRequest {
    pub preferred: Option<BackendId>,
    pub preferred_kind: Option<BackendKind>,
    pub required: CapabilityRequirements,
    pub allow_fallback: bool,
    pub require_installed: bool,
}

impl Default for ResolutionRequest {
    fn default() -> Self {
        Self {
            preferred: None,
            preferred_kind: None,
            required: CapabilityRequirements::default(),
            allow_fallback: true,
            require_installed: true,
        }
    }
}

impl ResolutionRequest {
    pub fn for_backend(backend: BackendId) -> Self {
        Self {
            preferred: Some(backend),
            ..Self::default()
        }
    }

    pub fn for_kind(kind: BackendKind) -> Self {
        Self {
            preferred_kind: Some(kind),
            ..Self::default()
        }
    }

    pub fn requiring(mut self, required: CapabilityRequirements) -> Self {
        self.required = required;
        self
    }

    pub fn strict(mut self) -> Self {
        self.allow_fallback = false;
        self
    }

    pub fn skip_install_check(mut self) -> Self {
        self.require_installed = false;
        self
    }
}

/// Diagnostic reason why a candidate backend was passed over during resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    NotRegistered,
    KindMismatch,
    NotInstalled(InstallStatus),
    MissingCapabilities(Vec<&'static str>),
}

/// One candidate evaluated and skipped before resolution succeeded or failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedCandidate {
    pub backend: BackendId,
    pub reason: SkipReason,
}

/// Successful backend selection returned by [`AdapterRegistry`].
pub struct ResolutionOutcome {
    pub adapter: Arc<dyn AgentAdapter>,
    pub backend: BackendId,
    pub fallback_used: bool,
    pub skipped: Vec<SkippedCandidate>,
}

impl fmt::Debug for ResolutionOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResolutionOutcome")
            .field("backend", &self.backend)
            .field("fallback_used", &self.fallback_used)
            .field("skipped", &self.skipped)
            .finish()
    }
}

/// Selects the highest-precedence available discovery record for `backend`.
///
/// Mirrors the user-install-first rule: `UserInstall` beats `ManagedCopy`, which beats
/// `EnvironmentCredentials` and `Builtin`.
pub fn select_preferred_install(
    candidates: &[InstalledBackend],
    backend: BackendId,
) -> Option<&InstalledBackend> {
    candidates
        .iter()
        .filter(|entry| entry.backend == backend && entry.is_available())
        .max_by_key(|entry| entry.source.map_or(0, DiscoverySource::priority))
}

/// Summarizes the effective [`InstallStatus`] of `backend` from a discovery snapshot.
pub fn discovery_status_for(candidates: &[InstalledBackend], backend: BackendId) -> InstallStatus {
    if select_preferred_install(candidates, backend).is_some() {
        return InstallStatus::Available;
    }
    candidates
        .iter()
        .find(|entry| entry.backend == backend)
        .map_or(InstallStatus::Missing, |entry| entry.status)
}

/// Central registry owning registered [`AgentAdapter`] instances and deterministic selection rules.
pub struct AdapterRegistry {
    adapters: BTreeMap<BackendId, Arc<dyn AgentAdapter>>,
    preference_order: Vec<BackendId>,
}

impl Default for AdapterRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl AdapterRegistry {
    pub fn new() -> Self {
        Self {
            adapters: BTreeMap::new(),
            preference_order: DEFAULT_PREFERENCE_ORDER.to_vec(),
        }
    }

    /// Builds a registry pre-populated with every concrete Stage 2A backend adapter
    /// (`ClaudeCliAdapter`, `CodexCliAdapter`, all four `DirectApiAdapter` providers backed by
    /// [`NoopToolExecutor`], and the [`OmpAdapterContract`] slot).
    pub fn with_default_backends() -> Self {
        Self::with_default_backends_and_tools(Arc::new(NoopToolExecutor))
    }

    /// Builds a default backend registry wired with a custom [`ToolExecutor`] for Direct LLM API
    /// sessions (Stage 2B local/MCP tool execution hook).
    pub fn with_default_backends_and_tools(tool_executor: Arc<dyn ToolExecutor>) -> Self {
        let mut registry = Self::new();
        registry.register(Arc::new(ClaudeCliAdapter::new()));
        registry.register(Arc::new(CodexCliAdapter::new()));
        registry.register(Arc::new(OmpAdapterContract::new()));
        for provider in [
            DirectApiProvider::Anthropic,
            DirectApiProvider::OpenAi,
            DirectApiProvider::OpenRouter,
            DirectApiProvider::OpenAiCompatible,
        ] {
            registry.register(Arc::new(DirectApiAdapter::new(
                provider,
                Arc::clone(&tool_executor),
            )));
        }
        registry
    }

    /// Registers an adapter under its [`AgentAdapter::id`], returning any replaced adapter.
    pub fn register(&mut self, adapter: Arc<dyn AgentAdapter>) -> Option<Arc<dyn AgentAdapter>> {
        self.adapters.insert(adapter.id(), adapter)
    }

    pub fn unregister(&mut self, id: BackendId) -> Option<Arc<dyn AgentAdapter>> {
        self.adapters.remove(&id)
    }

    pub fn get(&self, id: BackendId) -> Option<Arc<dyn AgentAdapter>> {
        self.adapters.get(&id).cloned()
    }

    pub fn contains(&self, id: BackendId) -> bool {
        self.adapters.contains_key(&id)
    }

    pub fn len(&self) -> usize {
        self.adapters.len()
    }

    pub fn is_empty(&self) -> bool {
        self.adapters.is_empty()
    }

    /// Returns registered backend IDs in deterministic sorted order.
    pub fn list_ids(&self) -> Vec<BackendId> {
        self.adapters.keys().copied().collect()
    }

    /// Returns all registered adapters belonging to `kind`.
    pub fn adapters_of_kind(&self, kind: BackendKind) -> Vec<Arc<dyn AgentAdapter>> {
        self.adapters
            .iter()
            .filter(|(id, _)| id.kind() == kind)
            .map(|(_, adapter)| Arc::clone(adapter))
            .collect()
    }

    pub fn preference_order(&self) -> &[BackendId] {
        &self.preference_order
    }

    pub fn set_preference_order(&mut self, order: Vec<BackendId>) {
        self.preference_order = order;
    }

    /// Probes every registered adapter in deterministic order to build a discovery snapshot.
    pub async fn detect_all(&self) -> Vec<InstalledBackend> {
        let mut results = Vec::with_capacity(self.adapters.len());
        for adapter in self.adapters.values() {
            results.push(adapter.detect_installed().await);
        }
        results
    }

    /// Resolves a backend synchronously against a caller-supplied discovery snapshot.
    pub fn resolve_with_snapshot(
        &self,
        request: &ResolutionRequest,
        discovered: &[InstalledBackend],
    ) -> Result<ResolutionOutcome, AgentError> {
        let mut skipped = Vec::new();

        if let Some(preferred) = request.preferred {
            match self.evaluate_candidate(preferred, request, discovered) {
                Ok(adapter) => {
                    return Ok(ResolutionOutcome {
                        adapter,
                        backend: preferred,
                        fallback_used: false,
                        skipped,
                    });
                }
                Err(reason) => {
                    if !request.allow_fallback {
                        return Err(strict_error(preferred, reason));
                    }
                    skipped.push(SkippedCandidate {
                        backend: preferred,
                        reason,
                    });
                }
            }
        }

        let mut ordered = Vec::with_capacity(self.adapters.len());
        for &candidate in &self.preference_order {
            if Some(candidate) != request.preferred && self.adapters.contains_key(&candidate) {
                ordered.push(candidate);
            }
        }
        for &candidate in self.adapters.keys() {
            if Some(candidate) != request.preferred && !ordered.contains(&candidate) {
                ordered.push(candidate);
            }
        }

        for candidate in ordered {
            match self.evaluate_candidate(candidate, request, discovered) {
                Ok(adapter) => {
                    return Ok(ResolutionOutcome {
                        adapter,
                        backend: candidate,
                        fallback_used: request.preferred.is_some(),
                        skipped,
                    });
                }
                Err(reason) => skipped.push(SkippedCandidate {
                    backend: candidate,
                    reason,
                }),
            }
        }

        let summary = if skipped.is_empty() {
            "no adapters registered".to_owned()
        } else {
            skipped
                .iter()
                .map(|entry| format!("{} ({:?})", entry.backend, entry.reason))
                .collect::<Vec<_>>()
                .join(", ")
        };
        Err(AgentError::NoMatchingBackend { reason: summary })
    }

    /// Probes registered adapters (when `require_installed` is true) and resolves a backend.
    pub async fn resolve(
        &self,
        request: &ResolutionRequest,
    ) -> Result<ResolutionOutcome, AgentError> {
        let snapshot = if request.require_installed {
            self.detect_all().await
        } else {
            Vec::new()
        };
        self.resolve_with_snapshot(request, &snapshot)
    }

    fn evaluate_candidate(
        &self,
        backend: BackendId,
        request: &ResolutionRequest,
        discovered: &[InstalledBackend],
    ) -> Result<Arc<dyn AgentAdapter>, SkipReason> {
        let Some(adapter) = self.adapters.get(&backend) else {
            return Err(SkipReason::NotRegistered);
        };
        if let Some(kind) = request.preferred_kind
            && adapter.kind() != kind
        {
            return Err(SkipReason::KindMismatch);
        }
        if request.require_installed {
            let status = discovery_status_for(discovered, backend);
            if status != InstallStatus::Available {
                return Err(SkipReason::NotInstalled(status));
            }
        }
        let missing = adapter.capabilities().missing_for(&request.required);
        if !missing.is_empty() {
            return Err(SkipReason::MissingCapabilities(missing));
        }
        Ok(Arc::clone(adapter))
    }
}

fn strict_error(backend: BackendId, reason: SkipReason) -> AgentError {
    match reason {
        SkipReason::NotRegistered => AgentError::NoMatchingBackend {
            reason: format!("requested backend {backend} is not registered"),
        },
        SkipReason::KindMismatch => AgentError::NoMatchingBackend {
            reason: format!("requested backend {backend} does not match required family"),
        },
        SkipReason::NotInstalled(status) => AgentError::NotInstalled {
            backend,
            detail: format!("install status is {status:?}"),
        },
        SkipReason::MissingCapabilities(missing) => AgentError::UnsupportedCapability {
            backend,
            capability: missing.join(", "),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tokio::sync::mpsc;

    use super::*;
    use crate::agent::adapter::{AgentSession, BoxFuture};
    use crate::agent::types::{AgentCapabilities, SessionSpec, TurnInput};

    struct StubAdapter {
        id: BackendId,
        caps: AgentCapabilities,
        installed: InstalledBackend,
    }

    impl StubAdapter {
        fn new(id: BackendId, caps: AgentCapabilities, installed: InstalledBackend) -> Arc<Self> {
            Arc::new(Self {
                id,
                caps,
                installed,
            })
        }
    }

    impl AgentAdapter for StubAdapter {
        fn id(&self) -> BackendId {
            self.id
        }

        fn capabilities(&self) -> AgentCapabilities {
            self.caps.clone()
        }

        fn detect_installed(&self) -> BoxFuture<'_, InstalledBackend> {
            let report = self.installed.clone();
            Box::pin(async move { report })
        }

        fn start(&self, spec: SessionSpec) -> BoxFuture<'_, Result<AgentSession, AgentError>> {
            let id = self.id;
            let caps = self.caps.clone();
            Box::pin(async move {
                let (_tx, rx) = mpsc::channel(4);
                Ok(AgentSession::new(spec.session_id, id, caps, rx))
            })
        }

        fn send_turn<'a>(
            &'a self,
            _session: &'a AgentSession,
            _input: TurnInput,
        ) -> BoxFuture<'a, Result<(), AgentError>> {
            Box::pin(async { Ok(()) })
        }

        fn interrupt<'a>(
            &'a self,
            _session: &'a AgentSession,
        ) -> BoxFuture<'a, Result<(), AgentError>> {
            Box::pin(async { Ok(()) })
        }

        fn stop<'a>(
            &'a self,
            _session: &'a mut AgentSession,
        ) -> BoxFuture<'a, Result<(), AgentError>> {
            Box::pin(async { Ok(()) })
        }
    }

    fn sample_registry() -> AdapterRegistry {
        let mut reg = AdapterRegistry::new();
        let claude = BackendId::ProviderCli(ProviderCliKind::ClaudeCode);
        let pty = BackendId::ProviderCli(ProviderCliKind::GenericPty);
        let anthropic = BackendId::DirectApi(DirectApiProvider::Anthropic);

        reg.register(StubAdapter::new(
            claude,
            AgentCapabilities::provider_cli(ProviderCliKind::ClaudeCode),
            InstalledBackend::missing(claude, "claude binary not on PATH"),
        ));
        reg.register(StubAdapter::new(
            BackendId::Omp,
            AgentCapabilities::omp(),
            InstalledBackend::available(BackendId::Omp, DiscoverySource::UserInstall),
        ));
        reg.register(StubAdapter::new(
            anthropic,
            AgentCapabilities::direct_api(),
            InstalledBackend::available(anthropic, DiscoverySource::EnvironmentCredentials),
        ));
        reg.register(StubAdapter::new(
            pty,
            AgentCapabilities::provider_cli(ProviderCliKind::GenericPty),
            InstalledBackend::available(pty, DiscoverySource::UserInstall),
        ));
        reg
    }

    #[tokio::test]
    fn falls_back_from_missing_preferred_backend_in_preference_order() {
        let reg = sample_registry();
        let claude = BackendId::ProviderCli(ProviderCliKind::ClaudeCode);
        let req = ResolutionRequest::for_backend(claude)
            .requiring(CapabilityRequirements::default().with_structured_tool_calls());

        let outcome = reg.resolve(&req).await.unwrap();
        assert_eq!(outcome.backend, BackendId::Omp);
        assert!(outcome.fallback_used);
        assert_eq!(
            outcome.skipped,
            vec![SkippedCandidate {
                backend: claude,
                reason: SkipReason::NotInstalled(InstallStatus::Missing),
            }]
        );
    }

    #[tokio::test]
    fn strict_mode_returns_typed_error_instead_of_falling_back() {
        let reg = sample_registry();
        let claude = BackendId::ProviderCli(ProviderCliKind::ClaudeCode);
        let err = reg
            .resolve(&ResolutionRequest::for_backend(claude).strict())
            .await
            .unwrap_err();
        assert_eq!(err.code(), "not_installed");

        let pty = BackendId::ProviderCli(ProviderCliKind::GenericPty);
        let cap_err = reg
            .resolve(
                &ResolutionRequest::for_backend(pty)
                    .requiring(
                        CapabilityRequirements::default()
                            .with_structured_tool_calls()
                            .with_resume(),
                    )
                    .strict(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            cap_err,
            AgentError::UnsupportedCapability {
                backend: pty,
                capability: "structured_tool_calls, resume".to_owned(),
            }
        );
    }

    #[tokio::test]
    fn filters_by_zero_cli_requirement_and_backend_kind() {
        let reg = sample_registry();
        let req = ResolutionRequest::for_kind(BackendKind::DirectApi)
            .requiring(CapabilityRequirements::default().with_no_external_cli());

        let outcome = reg.resolve(&req).await.unwrap();
        assert_eq!(
            outcome.backend,
            BackendId::DirectApi(DirectApiProvider::Anthropic)
        );
        assert!(!outcome.fallback_used);
        assert_eq!(outcome.adapter.kind(), BackendKind::DirectApi);
    }

    #[test]
    fn user_install_beats_managed_copy_during_discovery_selection() {
        let codex = BackendId::ProviderCli(ProviderCliKind::Codex);
        let mut managed = InstalledBackend::available(codex, DiscoverySource::ManagedCopy);
        managed.executable_path = Some(PathBuf::from("/opt/ompdesk/managed/codex"));

        let mut user = InstalledBackend::available(codex, DiscoverySource::UserInstall);
        user.executable_path = Some(PathBuf::from("/usr/local/bin/codex"));

        let entries = [managed, user];
        let picked = select_preferred_install(&entries, codex).unwrap();
        assert_eq!(picked.source, Some(DiscoverySource::UserInstall));
        assert_eq!(
            picked.executable_path,
            Some(PathBuf::from("/usr/local/bin/codex"))
        );
    }

    #[test]
    fn default_backends_register_all_three_families_and_resolve_with_snapshot() {
        let reg = AdapterRegistry::with_default_backends();
        let claude = BackendId::ProviderCli(ProviderCliKind::ClaudeCode);
        let codex = BackendId::ProviderCli(ProviderCliKind::Codex);
        let anthropic = BackendId::DirectApi(DirectApiProvider::Anthropic);
        let openai = BackendId::DirectApi(DirectApiProvider::OpenAi);
        let openrouter = BackendId::DirectApi(DirectApiProvider::OpenRouter);
        let compat = BackendId::DirectApi(DirectApiProvider::OpenAiCompatible);

        assert_eq!(reg.len(), 7);
        for id in [
            claude,
            codex,
            BackendId::Omp,
            anthropic,
            openai,
            openrouter,
            compat,
        ] {
            assert!(reg.contains(id), "missing default backend {id}");
        }

        let snapshot = [
            InstalledBackend::missing(claude, "not installed"),
            InstalledBackend::missing(codex, "not installed"),
            InstalledBackend::missing(BackendId::Omp, "not installed"),
            InstalledBackend::available(anthropic, DiscoverySource::EnvironmentCredentials),
        ];
        let zero_cli_req = ResolutionRequest::default()
            .requiring(CapabilityRequirements::default().with_no_external_cli());
        let outcome = reg.resolve_with_snapshot(&zero_cli_req, &snapshot).unwrap();
        assert_eq!(outcome.backend, anthropic);
        assert_eq!(outcome.adapter.kind(), BackendKind::DirectApi);
    }
}
