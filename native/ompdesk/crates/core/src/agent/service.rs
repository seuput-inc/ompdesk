//! Self-contained backend discovery, resolution, and health-check service for future
//! `Route::Core` RPC and UI wiring.
//!
//! Exposes typed, JSON-serializable request/response models over [`AdapterRegistry`] and
//! [`crate::agent::backends::detect`] while guaranteeing deterministic ordering and strict secret
//! redaction across every returned field.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::adapter::AgentAdapter;
use super::backends::detect::{
    DiscoveryEnv, InstalledBackendInfo, cli_descriptor, detect_cli_in, detect_direct_api_in,
    probe_cli_version,
};
use super::journal::now_unix_ms;
use super::registry::{
    AdapterRegistry, ResolutionRequest, SkipReason, SkippedCandidate, discovery_status_for,
};
use super::types::{
    AgentCapabilities, AgentError, BackendId, BackendKind, CapabilityRequirements,
    DirectApiProvider, DiscoverySource, InstallStatus, InstalledBackend, ProviderCliKind,
};

const DEFAULT_VERSION_PROBE_TIMEOUT_MS: u64 = 2_000;

/// Authentication readiness classification surfaced alongside install discovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthReadiness {
    Ready,
    MissingCredentials,
    ManagedByCli,
    NotRequired,
    Unknown,
}

/// Overall non-destructive health status returned by [`AgentBackendService::health_check`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Healthy,
    Degraded,
    Unauthenticated,
    Unavailable,
}

/// JSON-serializable summary of one registered agent backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendSummary {
    pub backend: BackendId,
    pub kind: BackendKind,
    pub name: String,
    pub display_name: String,
    pub status: InstallStatus,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<DiscoverySource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub auth_readiness: AuthReadiness,
    pub capabilities: AgentCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// RPC response model for `list_backends()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBackendsResponse {
    pub backends: Vec<BackendSummary>,
    pub available_count: usize,
    pub default_preference_order: Vec<BackendId>,
}

/// Optional RPC request model for `detect_backends_with(...)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectBackendsRequest {
    #[serde(default = "default_true")]
    pub probe_versions: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl Default for DetectBackendsRequest {
    fn default() -> Self {
        Self {
            probe_versions: true,
            timeout_ms: Some(DEFAULT_VERSION_PROBE_TIMEOUT_MS),
        }
    }
}

/// RPC response model for `detect_backends()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectBackendsResponse {
    pub backends: Vec<BackendSummary>,
    pub available_count: usize,
    pub scanned_at_ms: u64,
}

/// JSON-serializable RPC request model for `resolve_backend(request)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveBackendRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred: Option<BackendId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_kind: Option<BackendKind>,
    #[serde(default)]
    pub required: CapabilityRequirements,
    #[serde(default = "default_true")]
    pub allow_fallback: bool,
    #[serde(default = "default_true")]
    pub require_installed: bool,
}

impl Default for ResolveBackendRequest {
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

impl ResolveBackendRequest {
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

    pub fn to_resolution_request(&self) -> ResolutionRequest {
        ResolutionRequest {
            preferred: self.preferred,
            preferred_kind: self.preferred_kind,
            required: self.required.clone(),
            allow_fallback: self.allow_fallback,
            require_installed: self.require_installed,
        }
    }
}

/// JSON-serializable reason why a backend candidate was skipped during resolution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum SkipReasonDto {
    NotRegistered,
    KindMismatch,
    NotInstalled { status: InstallStatus },
    MissingCapabilities { missing: Vec<String> },
}

impl From<&SkipReason> for SkipReasonDto {
    fn from(reason: &SkipReason) -> Self {
        match reason {
            SkipReason::NotRegistered => Self::NotRegistered,
            SkipReason::KindMismatch => Self::KindMismatch,
            SkipReason::NotInstalled(status) => Self::NotInstalled { status: *status },
            SkipReason::MissingCapabilities(missing) => Self::MissingCapabilities {
                missing: missing.iter().map(|cap| (*cap).to_owned()).collect(),
            },
        }
    }
}

/// JSON-serializable diagnostic entry for a skipped candidate backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedBackendReport {
    pub backend: BackendId,
    #[serde(flatten)]
    pub reason: SkipReasonDto,
}

impl From<&SkippedCandidate> for SkippedBackendReport {
    fn from(candidate: &SkippedCandidate) -> Self {
        Self {
            backend: candidate.backend,
            reason: SkipReasonDto::from(&candidate.reason),
        }
    }
}

/// RPC response model for `resolve_backend(request)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveBackendResponse {
    pub backend: BackendId,
    pub kind: BackendKind,
    pub fallback_used: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    pub capabilities: AgentCapabilities,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<SkippedBackendReport>,
}

/// RPC response model for `health_check(backend_id)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckResponse {
    pub backend: BackendId,
    pub kind: BackendKind,
    pub healthy: bool,
    pub status: HealthStatus,
    pub install_status: InstallStatus,
    pub auth_readiness: AuthReadiness,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub checked_at_ms: u64,
}

/// Human-friendly display label for each concrete [`BackendId`].
pub const fn backend_display_name(backend: BackendId) -> &'static str {
    match backend {
        BackendId::ProviderCli(ProviderCliKind::ClaudeCode) => "Claude Code",
        BackendId::ProviderCli(ProviderCliKind::Codex) => "Codex CLI",
        BackendId::ProviderCli(ProviderCliKind::Antigravity) => "Antigravity CLI",
        BackendId::ProviderCli(ProviderCliKind::GenericPty) => "Generic PTY",
        BackendId::Omp => "OMP",
        BackendId::DirectApi(DirectApiProvider::Anthropic) => "Anthropic API",
        BackendId::DirectApi(DirectApiProvider::OpenAi) => "OpenAI API",
        BackendId::DirectApi(DirectApiProvider::OpenRouter) => "OpenRouter API",
        BackendId::DirectApi(DirectApiProvider::OpenAiCompatible) => "OpenAI-Compatible API",
    }
}

/// Scrubs secret tokens and credential assignments from diagnostic strings before serialization.
pub fn redact_secrets(input: &str) -> String {
    let mut out = redact_key_value_secrets(input);
    out = redact_prefixed_tokens(&out);
    out
}

type EnvLookupFn = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Self-contained backend discovery, resolution, and health-check service ready for `Route::Core`.
pub struct AgentBackendService {
    registry: Arc<AdapterRegistry>,
    discovery_env: Option<DiscoveryEnv>,
    env_lookup: Option<EnvLookupFn>,
    probe_versions: bool,
    probe_timeout: Duration,
    cached_discovery: StdMutex<Option<BTreeMap<BackendId, InstalledBackend>>>,
}

impl AgentBackendService {
    /// Creates a service backed by `registry` using the live host environment for discovery.
    pub fn new(registry: Arc<AdapterRegistry>) -> Self {
        Self {
            registry,
            discovery_env: None,
            env_lookup: None,
            probe_versions: true,
            probe_timeout: Duration::from_millis(DEFAULT_VERSION_PROBE_TIMEOUT_MS),
            cached_discovery: StdMutex::new(None),
        }
    }

    /// Creates a service pre-populated with all default concrete backends.
    pub fn with_default_backends() -> Self {
        Self::new(Arc::new(AdapterRegistry::with_default_backends()))
    }

    /// Pins a deterministic [`DiscoveryEnv`] instead of reading host `PATH` / `PATHEXT`.
    pub fn with_discovery_env(mut self, env: DiscoveryEnv) -> Self {
        self.discovery_env = Some(env);
        self
    }

    /// Injects a deterministic environment-variable lookup for Direct API credential discovery.
    pub fn with_env_lookup<F>(mut self, lookup: F) -> Self
    where
        F: Fn(&str) -> Option<String> + Send + Sync + 'static,
    {
        self.env_lookup = Some(Arc::new(lookup));
        self
    }

    /// Controls whether CLI discovery and health checks execute `<cli> --version` probes.
    pub fn with_version_probing(mut self, enabled: bool) -> Self {
        self.probe_versions = enabled;
        self
    }

    /// Sets the timeout for non-destructive CLI version probes.
    pub fn with_probe_timeout(mut self, timeout: Duration) -> Self {
        self.probe_timeout = timeout;
        self
    }

    pub fn registry(&self) -> &Arc<AdapterRegistry> {
        &self.registry
    }

    /// Lists every registered backend with its capabilities, availability, detected path/version,
    /// and auth readiness. Uses the cached discovery snapshot if `detect_backends()` has run;
    /// otherwise probes registered adapters directly.
    pub async fn list_backends(&self) -> ListBackendsResponse {
        let cached = self
            .cached_discovery
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();

        let ids = self.registry.list_ids();
        let mut backends = Vec::with_capacity(ids.len());
        for id in ids {
            let Some(adapter) = self.registry.get(id) else {
                continue;
            };
            let installed = match cached.as_ref().and_then(|map| map.get(&id)) {
                Some(entry) => entry.clone(),
                None => adapter.detect_installed().await,
            };
            backends.push(build_backend_summary(&*adapter, &installed));
        }

        let available_count = backends.iter().filter(|b| b.available).count();
        ListBackendsResponse {
            backends,
            available_count,
            default_preference_order: self.registry.preference_order().to_vec(),
        }
    }

    /// Re-scans `PATH`, well-known user install folders, managed folders, and environment
    /// credentials via [`crate::agent::backends::detect`], refreshes the cached discovery snapshot,
    /// and returns the full backend report.
    pub async fn detect_backends(&self) -> DetectBackendsResponse {
        let req = DetectBackendsRequest {
            probe_versions: self.probe_versions,
            timeout_ms: Some(
                u64::try_from(self.probe_timeout.as_millis())
                    .unwrap_or(DEFAULT_VERSION_PROBE_TIMEOUT_MS),
            ),
        };
        self.detect_backends_with(&req).await
    }

    /// Re-scans all registered backends with explicit version-probe options.
    pub async fn detect_backends_with(
        &self,
        request: &DetectBackendsRequest,
    ) -> DetectBackendsResponse {
        let env = self
            .discovery_env
            .clone()
            .unwrap_or_else(DiscoveryEnv::from_host);
        let timeout = Duration::from_millis(
            request
                .timeout_ms
                .unwrap_or(DEFAULT_VERSION_PROBE_TIMEOUT_MS),
        );

        let ids = self.registry.list_ids();
        let mut cache_map = BTreeMap::new();
        let mut backends = Vec::with_capacity(ids.len());

        for id in ids {
            let Some(adapter) = self.registry.get(id) else {
                continue;
            };
            let installed = self
                .scan_one_backend(&*adapter, &env, request.probe_versions, timeout)
                .await;
            cache_map.insert(id, installed.clone());
            backends.push(build_backend_summary(&*adapter, &installed));
        }

        *self
            .cached_discovery
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(cache_map);

        let available_count = backends.iter().filter(|b| b.available).count();
        DetectBackendsResponse {
            backends,
            available_count,
            scanned_at_ms: now_unix_ms(),
        }
    }

    /// Deterministically resolves the best matching backend for `request` along with any fallback
    /// explanation and skipped-candidate diagnostics.
    pub async fn resolve_backend(
        &self,
        request: &ResolveBackendRequest,
    ) -> Result<ResolveBackendResponse, AgentError> {
        let resolution_req = request.to_resolution_request();
        let snapshot = if request.require_installed {
            self.current_discovery_snapshot().await
        } else {
            Vec::new()
        };
        let outcome = self
            .registry
            .resolve_with_snapshot(&resolution_req, &snapshot)?;

        let fallback_reason = if outcome.fallback_used {
            request.preferred.map(|pref| {
                describe_fallback_reason(pref, outcome.backend, &outcome.skipped, &snapshot)
            })
        } else {
            None
        };

        Ok(ResolveBackendResponse {
            backend: outcome.backend,
            kind: outcome.adapter.kind(),
            fallback_used: outcome.fallback_used,
            fallback_reason,
            capabilities: outcome.adapter.capabilities(),
            skipped: outcome
                .skipped
                .iter()
                .map(SkippedBackendReport::from)
                .collect(),
        })
    }

    /// Performs a non-destructive readiness check for `backend_id` without executing prompts or
    /// leaking any secrets.
    pub async fn health_check(
        &self,
        backend_id: BackendId,
    ) -> Result<HealthCheckResponse, AgentError> {
        let Some(adapter) = self.registry.get(backend_id) else {
            return Err(AgentError::NoMatchingBackend {
                reason: format!("backend {backend_id} is not registered"),
            });
        };

        let mut installed = if self.discovery_env.is_some() || self.env_lookup.is_some() {
            let env = self
                .discovery_env
                .clone()
                .unwrap_or_else(DiscoveryEnv::from_host);
            self.scan_one_backend(&*adapter, &env, self.probe_versions, self.probe_timeout)
                .await
        } else {
            adapter.detect_installed().await
        };

        // For CLI backends with an explicit binary override, optionally verify the version if
        // probing is enabled and the executable exists on disk.
        if self.probe_versions
            && installed.status == InstallStatus::Available
            && installed.version.is_none()
            && let Some(path) = installed.executable_path.clone()
            && let Some(desc) = cli_descriptor(backend_id)
            && path.is_file()
        {
            let is_windows = self
                .discovery_env
                .as_ref()
                .map_or(cfg!(windows), |env| env.is_windows);
            let mut info = InstalledBackendInfo {
                backend: backend_id,
                binary_name: desc.binary_name.to_owned(),
                status: installed.status,
                source: installed.source,
                binary_path: Some(path),
                version_probe: Some(super::backends::detect::CliCommandSpec::new(
                    installed.executable_path.clone().unwrap_or_default(),
                    desc.version_args.iter().map(|s| (*s).to_owned()).collect(),
                    is_windows,
                )),
                version: installed.version.clone(),
                detail: installed.detail.clone(),
            };
            probe_cli_version(&mut info, self.probe_timeout).await;
            installed = info.to_installed_backend();
        }

        let auth_readiness = infer_auth_readiness(backend_id, &installed);
        let status = match installed.status {
            InstallStatus::Available => HealthStatus::Healthy,
            InstallStatus::VersionTooOld => HealthStatus::Degraded,
            InstallStatus::Unauthenticated => HealthStatus::Unauthenticated,
            InstallStatus::Missing | InstallStatus::Broken => HealthStatus::Unavailable,
        };

        Ok(HealthCheckResponse {
            backend: backend_id,
            kind: adapter.kind(),
            healthy: status == HealthStatus::Healthy,
            status,
            install_status: installed.status,
            auth_readiness,
            executable_path: installed.executable_path,
            version: installed.version.map(|v| redact_secrets(&v)),
            detail: installed.detail.map(|d| redact_secrets(&d)),
            checked_at_ms: now_unix_ms(),
        })
    }

    async fn current_discovery_snapshot(&self) -> Vec<InstalledBackend> {
        let cached = self
            .cached_discovery
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(map) = cached {
            return map.into_values().collect();
        }
        self.registry.detect_all().await
    }

    async fn scan_one_backend(
        &self,
        adapter: &dyn AgentAdapter,
        env: &DiscoveryEnv,
        probe_versions: bool,
        timeout: Duration,
    ) -> InstalledBackend {
        let id = adapter.id();
        match id {
            BackendId::DirectApi(provider) => {
                let info = match &self.env_lookup {
                    Some(lookup) => detect_direct_api_in(provider, |key| lookup(key)),
                    None => detect_direct_api_in(provider, |key| std::env::var(key).ok()),
                };
                if info.is_available() {
                    return info.to_installed_backend();
                }
                // Fall back to adapter's own probe in case an explicit key override was wired.
                let adapter_probe = adapter.detect_installed().await;
                if adapter_probe.is_available() {
                    adapter_probe
                } else {
                    info.to_installed_backend()
                }
            }
            BackendId::ProviderCli(ProviderCliKind::GenericPty) => adapter.detect_installed().await,
            _ if cli_descriptor(id).is_some() => {
                let mut info = detect_cli_in(id, env);
                if probe_versions && info.is_available() {
                    probe_cli_version(&mut info, timeout).await;
                }
                info.to_installed_backend()
            }
            _ => adapter.detect_installed().await,
        }
    }
}

fn default_true() -> bool {
    true
}

fn build_backend_summary(
    adapter: &dyn AgentAdapter,
    installed: &InstalledBackend,
) -> BackendSummary {
    let id = adapter.id();
    let auth_readiness = infer_auth_readiness(id, installed);
    BackendSummary {
        backend: id,
        kind: adapter.kind(),
        name: id.canonical_name().to_owned(),
        display_name: backend_display_name(id).to_owned(),
        status: installed.status,
        available: installed.is_available(),
        source: installed.source,
        executable_path: installed.executable_path.clone(),
        version: installed.version.as_deref().map(redact_secrets),
        auth_readiness,
        capabilities: adapter.capabilities(),
        detail: installed.detail.as_deref().map(redact_secrets),
    }
}

fn infer_auth_readiness(backend: BackendId, installed: &InstalledBackend) -> AuthReadiness {
    match backend {
        BackendId::DirectApi(DirectApiProvider::OpenAiCompatible) => {
            if installed.is_available() {
                AuthReadiness::Ready
            } else {
                AuthReadiness::NotRequired
            }
        }
        BackendId::DirectApi(_) => match installed.status {
            InstallStatus::Available => AuthReadiness::Ready,
            InstallStatus::Unauthenticated => AuthReadiness::MissingCredentials,
            _ => AuthReadiness::Unknown,
        },
        BackendId::ProviderCli(ProviderCliKind::GenericPty) => AuthReadiness::NotRequired,
        BackendId::ProviderCli(_) | BackendId::Omp => match installed.status {
            InstallStatus::Available => AuthReadiness::ManagedByCli,
            InstallStatus::Unauthenticated => AuthReadiness::MissingCredentials,
            _ => AuthReadiness::Unknown,
        },
    }
}

fn describe_fallback_reason(
    preferred: BackendId,
    chosen: BackendId,
    skipped: &[SkippedCandidate],
    snapshot: &[InstalledBackend],
) -> String {
    if let Some(entry) = skipped.iter().find(|c| c.backend == preferred) {
        let why = match &entry.reason {
            SkipReason::NotRegistered => "not registered".to_owned(),
            SkipReason::KindMismatch => "did not match requested backend kind".to_owned(),
            SkipReason::NotInstalled(status) => {
                let effective = discovery_status_for(snapshot, preferred);
                let label = format!("{status:?}").to_ascii_lowercase();
                if effective == *status {
                    format!("not installed ({label})")
                } else {
                    format!("unavailable ({label})")
                }
            }
            SkipReason::MissingCapabilities(caps) => {
                format!("missing required capabilities: {}", caps.join(", "))
            }
        };
        format!("preferred backend `{preferred}` unavailable ({why}); fell back to `{chosen}`")
    } else {
        format!("preferred backend `{preferred}` unavailable; fell back to `{chosen}`")
    }
}

fn redact_key_value_secrets(input: &str) -> String {
    const MARKERS: &[&str] = &[
        "bearer ",
        "x-api-key:",
        "x-api-key=",
        "authorization:",
        "anthropic_api_key=",
        "openai_api_key=",
        "openrouter_api_key=",
        "openai_compatible_api_key=",
        "api_key=",
        "api-key=",
        "token=",
        "secret=",
    ];

    let mut result = String::with_capacity(input.len());
    let mut cursor = 0;
    let bytes = input.as_bytes();

    while cursor < input.len() {
        let rest = &input[cursor..];
        let matched = MARKERS.iter().find(|marker| {
            rest.len() >= marker.len()
                && rest.is_char_boundary(marker.len())
                && rest[..marker.len()].eq_ignore_ascii_case(marker)
        });

        if let Some(marker) = matched {
            let prefix_end = cursor + marker.len();
            result.push_str(&input[cursor..prefix_end]);

            // Preserve whitespace immediately following `:` or `=` markers.
            let mut val_start = prefix_end;
            while val_start < bytes.len() && bytes[val_start] == b' ' {
                result.push(' ');
                val_start += 1;
            }
            // If `authorization:` is followed by `Bearer `, preserve `Bearer ` too.
            if marker.eq_ignore_ascii_case("authorization:") {
                let after = &input[val_start..];
                if after.len() >= 7
                    && after.is_char_boundary(7)
                    && after[..7].eq_ignore_ascii_case("bearer ")
                {
                    result.push_str(&input[val_start..val_start + 7]);
                    val_start += 7;
                }
            }
            let mut val_end = val_start;
            while val_end < bytes.len()
                && !matches!(
                    bytes[val_end],
                    b' ' | b'\t' | b'\r' | b'\n' | b',' | b';' | b'"' | b'\'' | b')' | b']' | b'}'
                )
            {
                val_end += 1;
            }
            if val_end > val_start {
                result.push_str("[REDACTED]");
                cursor = val_end;
            } else {
                cursor = val_start;
            }
        } else {
            let ch = rest.chars().next().unwrap();
            result.push(ch);
            cursor += ch.len_utf8();
        }
    }
    result
}

fn redact_prefixed_tokens(input: &str) -> String {
    const PREFIXES: &[&str] = &[
        "sk-ant-", "sk-proj-", "sk-or-", "sk-", "ghp_", "gho_", "AIza",
    ];
    const MIN_SUFFIX_LEN: usize = 8;

    let mut result = String::with_capacity(input.len());
    let mut cursor = 0;
    let bytes = input.as_bytes();

    while cursor < input.len() {
        let rest = &input[cursor..];
        let at_word_boundary =
            cursor == 0 || !bytes[cursor - 1].is_ascii_alphanumeric() && bytes[cursor - 1] != b'_';

        let matched = if at_word_boundary {
            PREFIXES.iter().find(|prefix| rest.starts_with(**prefix))
        } else {
            None
        };

        if let Some(prefix) = matched {
            let mut end = cursor + prefix.len();
            while end < bytes.len()
                && (bytes[end].is_ascii_alphanumeric() || matches!(bytes[end], b'-' | b'_' | b'.'))
            {
                end += 1;
            }
            if end - (cursor + prefix.len()) >= MIN_SUFFIX_LEN {
                result.push_str("[REDACTED]");
                cursor = end;
                continue;
            }
        }

        let ch = rest.chars().next().unwrap();
        result.push(ch);
        cursor += ch.len_utf8();
    }
    result
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use serde_json::Value;
    use tokio::sync::mpsc;

    use super::*;
    use crate::agent::adapter::{AgentSession, BoxFuture};
    use crate::agent::types::{SessionSpec, TurnInput};

    struct FakeAdapter {
        id: BackendId,
        caps: AgentCapabilities,
        installed: InstalledBackend,
    }

    impl FakeAdapter {
        fn new(id: BackendId, caps: AgentCapabilities, installed: InstalledBackend) -> Arc<Self> {
            Arc::new(Self {
                id,
                caps,
                installed,
            })
        }
    }

    impl AgentAdapter for FakeAdapter {
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

    fn make_fake_bin(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"#!/bin/sh\necho 1.2.3\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&path, perms).unwrap();
        }
        path
    }

    #[tokio::test]
    async fn resolves_backends_deterministically_with_fallback_reasons_and_strict_errors() {
        let mut reg = AdapterRegistry::new();
        let claude = BackendId::ProviderCli(ProviderCliKind::ClaudeCode);
        let agy = BackendId::ProviderCli(ProviderCliKind::Antigravity);
        let anthropic = BackendId::DirectApi(DirectApiProvider::Anthropic);

        reg.register(FakeAdapter::new(
            claude,
            AgentCapabilities::provider_cli(ProviderCliKind::ClaudeCode),
            InstalledBackend::missing(claude, "claude not found"),
        ));
        reg.register(FakeAdapter::new(
            agy,
            AgentCapabilities::provider_cli(ProviderCliKind::Antigravity),
            InstalledBackend::available(agy, DiscoverySource::UserInstall),
        ));
        reg.register(FakeAdapter::new(
            anthropic,
            AgentCapabilities::direct_api(),
            InstalledBackend::available(anthropic, DiscoverySource::EnvironmentCredentials),
        ));

        let service = AgentBackendService::new(Arc::new(reg)).with_version_probing(false);

        let list = service.list_backends().await;
        assert_eq!(list.backends.len(), 3);
        assert_eq!(list.available_count, 2);

        // Preferred Claude is missing -> deterministic fallback to Antigravity in preference order.
        let resolved = service
            .resolve_backend(&ResolveBackendRequest::for_backend(claude))
            .await
            .unwrap();
        assert_eq!(resolved.backend, agy);
        assert!(resolved.fallback_used);
        let reason = resolved.fallback_reason.as_deref().unwrap();
        assert!(reason.contains("claude_code"));
        assert!(reason.contains("antigravity"));
        assert_eq!(resolved.skipped.len(), 1);
        assert_eq!(resolved.skipped[0].backend, claude);

        // Zero-CLI capability requirement selects DirectApi(Anthropic) without fallback flag when
        // no preferred backend was specified.
        let zero_cli = service
            .resolve_backend(
                &ResolveBackendRequest::default()
                    .requiring(CapabilityRequirements::default().with_no_external_cli()),
            )
            .await
            .unwrap();
        assert_eq!(zero_cli.backend, anthropic);
        assert!(!zero_cli.fallback_used);
        assert!(zero_cli.fallback_reason.is_none());

        // Strict request for missing backend returns NotInstalled.
        let strict_err = service
            .resolve_backend(&ResolveBackendRequest::for_backend(claude).strict())
            .await
            .unwrap_err();
        assert_eq!(strict_err.code(), "not_installed");
    }

    #[tokio::test]
    async fn detects_path_and_env_via_detect_rs_and_redacts_secrets_in_health_checks() {
        let user_dir = tempfile::tempdir().unwrap();
        let managed_dir = tempfile::tempdir().unwrap();

        let (agy_name, claude_name) = if cfg!(windows) {
            ("agy.cmd", "claude.exe")
        } else {
            ("agy", "claude")
        };
        let user_agy = make_fake_bin(user_dir.path(), agy_name);
        make_fake_bin(managed_dir.path(), agy_name);
        let managed_claude = make_fake_bin(managed_dir.path(), claude_name);

        let env = DiscoveryEnv {
            path_dirs: vec![user_dir.path().to_path_buf()],
            extra_dirs: Vec::new(),
            managed_dirs: vec![managed_dir.path().to_path_buf()],
            pathext: vec![".exe".to_owned(), ".cmd".to_owned()],
            is_windows: cfg!(windows),
        };

        let secret = "sk-ant-api03-super-secret-token-value-12345";
        let service = AgentBackendService::with_default_backends()
            .with_discovery_env(env)
            .with_env_lookup(move |key| (key == "ANTHROPIC_API_KEY").then(|| secret.to_owned()))
            .with_version_probing(false);

        let detected = service.detect_backends().await;
        let json_blob = serde_json::to_string(&detected).unwrap();
        assert!(
            !json_blob.contains(secret),
            "detect_backends leaked raw secret"
        );

        let agy_summary = detected
            .backends
            .iter()
            .find(|b| b.backend == BackendId::ProviderCli(ProviderCliKind::Antigravity))
            .unwrap();
        assert!(agy_summary.available);
        assert_eq!(agy_summary.source, Some(DiscoverySource::UserInstall));
        assert_eq!(
            agy_summary.executable_path.as_deref(),
            Some(user_agy.as_path())
        );
        assert_eq!(agy_summary.auth_readiness, AuthReadiness::ManagedByCli);

        let claude_summary = detected
            .backends
            .iter()
            .find(|b| b.backend == BackendId::ProviderCli(ProviderCliKind::ClaudeCode))
            .unwrap();
        assert!(claude_summary.available);
        assert_eq!(claude_summary.source, Some(DiscoverySource::ManagedCopy));
        assert_eq!(
            claude_summary.executable_path.as_deref(),
            Some(managed_claude.as_path())
        );

        let anth_health = service
            .health_check(BackendId::DirectApi(DirectApiProvider::Anthropic))
            .await
            .unwrap();
        assert!(anth_health.healthy);
        assert_eq!(anth_health.status, HealthStatus::Healthy);
        assert_eq!(anth_health.auth_readiness, AuthReadiness::Ready);
        assert!(
            !serde_json::to_string(&anth_health)
                .unwrap()
                .contains(secret)
        );

        let openai_health = service
            .health_check(BackendId::DirectApi(DirectApiProvider::OpenAi))
            .await
            .unwrap();
        assert!(!openai_health.healthy);
        assert_eq!(openai_health.status, HealthStatus::Unauthenticated);
        assert_eq!(
            openai_health.auth_readiness,
            AuthReadiness::MissingCredentials
        );

        // Unregistered backend fails cleanly.
        let unreg = service
            .health_check(BackendId::ProviderCli(ProviderCliKind::GenericPty))
            .await
            .unwrap_err();
        assert_eq!(unreg.code(), "no_matching_backend");

        // Secret redaction helper scrubs every sensitive pattern while keeping safe text intact.
        let dirty = "auth failed: Authorization: Bearer sk-proj-abcd1234567890, x-api-key: sk-ant-xyz987654321, OPENAI_API_KEY=mysecretvalue123, ANTHROPIC_API_KEY not set";
        let clean = redact_secrets(dirty);
        assert!(!clean.contains("sk-proj-"));
        assert!(!clean.contains("sk-ant-"));
        assert!(!clean.contains("mysecretvalue123"));
        assert!(clean.contains("[REDACTED]"));
        assert!(clean.contains("ANTHROPIC_API_KEY not set"));
    }

    #[tokio::test]
    async fn serialization_snapshots_match_stable_rpc_wire_contract() {
        let mut reg = AdapterRegistry::new();
        let claude = BackendId::ProviderCli(ProviderCliKind::ClaudeCode);
        let mut installed = InstalledBackend::available(claude, DiscoverySource::UserInstall);
        installed.version = Some("2.1.0".to_owned());
        installed.detail = Some("Bearer sk-ant-never-leak-this-secret".to_owned());
        reg.register(FakeAdapter::new(
            claude,
            AgentCapabilities::provider_cli(ProviderCliKind::ClaudeCode),
            installed,
        ));

        let service = AgentBackendService::new(Arc::new(reg)).with_version_probing(false);

        let list_resp = service.list_backends().await;
        let list_val: Value = serde_json::to_value(&list_resp).unwrap();
        assert_eq!(list_val["availableCount"], 1);
        assert_eq!(list_val["backends"][0]["name"], "claude_code");
        assert_eq!(list_val["backends"][0]["displayName"], "Claude Code");
        assert_eq!(list_val["backends"][0]["kind"], "provider_cli");
        assert_eq!(list_val["backends"][0]["status"], "available");
        assert_eq!(list_val["backends"][0]["authReadiness"], "managed_by_cli");
        assert_eq!(list_val["backends"][0]["version"], "2.1.0");
        assert_eq!(list_val["backends"][0]["detail"], "Bearer [REDACTED]");
        let decoded_list: ListBackendsResponse = serde_json::from_value(list_val).unwrap();
        assert_eq!(decoded_list, list_resp);

        let req_json = serde_json::json!({
            "preferred": { "kind": "provider_cli", "provider": "claude_code" },
            "required": { "streamingText": true, "structuredToolCalls": true },
            "allowFallback": true,
            "requireInstalled": true
        });
        let req: ResolveBackendRequest = serde_json::from_value(req_json).unwrap();
        let resolve_resp = service.resolve_backend(&req).await.unwrap();
        let resolve_val: Value = serde_json::to_value(&resolve_resp).unwrap();
        assert_eq!(resolve_val["backend"]["kind"], "provider_cli");
        assert_eq!(resolve_val["backend"]["provider"], "claude_code");
        assert_eq!(resolve_val["fallbackUsed"], false);
        assert!(resolve_val.get("fallbackReason").is_none());
        let decoded_resolve: ResolveBackendResponse = serde_json::from_value(resolve_val).unwrap();
        assert_eq!(decoded_resolve, resolve_resp);

        let health_resp = service.health_check(claude).await.unwrap();
        let health_val: Value = serde_json::to_value(&health_resp).unwrap();
        assert_eq!(health_val["healthy"], true);
        assert_eq!(health_val["status"], "healthy");
        assert_eq!(health_val["installStatus"], "available");
        assert_eq!(health_val["detail"], "Bearer [REDACTED]");
        let decoded_health: HealthCheckResponse = serde_json::from_value(health_val).unwrap();
        assert_eq!(decoded_health, health_resp);
    }
}
