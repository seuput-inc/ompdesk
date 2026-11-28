//! Cross-platform installed-CLI and Direct-API discovery for macOS, Windows, and Linux.
//!
//! Resolves `claude`, `codex`, `agy` (Antigravity), and `omp` without Windows bare-name gotchas:
//! - On Windows, never matches extensionless POSIX shim scripts and never falls back to a bare
//!   command name that `CreateProcess` would search in `cwd` or `System32`.
//! - On Unix, verifies the file execute bit (`0o111`) before reporting a binary available.
//! - Follows the user-install-first rule: user `PATH` and well-known user directories always take
//!   precedence over managed copies.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::agent::types::{
    BackendId, DirectApiProvider, DiscoverySource, InstallStatus, InstalledBackend, ProviderCliKind,
};

/// Safe runnable Windows extensions checked when `PATHEXT` is absent or overly broad.
const DEFAULT_WINDOWS_EXTS: &[&str] = &[".exe", ".cmd", ".bat", ".com"];

/// Descriptor mapping one CLI backend to its canonical executable stem and version probe flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CliDescriptor {
    pub backend: BackendId,
    pub binary_name: &'static str,
    pub version_args: &'static [&'static str],
}

/// Resolved executable + argv specification ready to spawn on macOS, Windows, or Linux.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCommandSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// True on Windows when `program` is a `.cmd` / `.bat` shim that must run via `%ComSpec%`.
    #[serde(default)]
    pub use_cmd_shim: bool,
}

impl CliCommandSpec {
    pub fn new(program: PathBuf, args: Vec<String>, is_windows: bool) -> Self {
        let use_cmd_shim = is_windows && is_windows_cmd_shim(&program);
        Self {
            program,
            args,
            use_cmd_shim,
        }
    }
}

/// Structured discovery report for one backend, including its resolved path and version probe spec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledBackendInfo {
    pub backend: BackendId,
    pub binary_name: String,
    pub status: InstallStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<DiscoverySource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_probe: Option<CliCommandSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl InstalledBackendInfo {
    pub fn is_available(&self) -> bool {
        self.status == InstallStatus::Available
    }

    /// Projects this detailed discovery report into the registry's [`InstalledBackend`] summary.
    pub fn to_installed_backend(&self) -> InstalledBackend {
        InstalledBackend {
            backend: self.backend,
            status: self.status,
            source: self.source,
            executable_path: self.binary_path.clone(),
            version: self.version.clone(),
            detail: self.detail.clone(),
        }
    }
}

/// Injectable filesystem/environment snapshot for deterministic cross-platform discovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryEnv {
    pub path_dirs: Vec<PathBuf>,
    pub extra_dirs: Vec<PathBuf>,
    pub managed_dirs: Vec<PathBuf>,
    pub pathext: Vec<String>,
    pub is_windows: bool,
}

impl DiscoveryEnv {
    /// Captures the live host environment (`PATH`, `PATHEXT`, and well-known user bin locations).
    pub fn from_host() -> Self {
        let is_windows = cfg!(windows);
        let path_dirs = std::env::var_os("PATH")
            .map(|raw| std::env::split_paths(&raw).collect())
            .unwrap_or_default();
        let extra_dirs = default_extra_dirs(
            is_windows,
            std::env::var_os("HOME").map(PathBuf::from).as_deref(),
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .as_deref(),
            std::env::var_os("APPDATA").map(PathBuf::from).as_deref(),
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .as_deref(),
        );
        let pathext = if is_windows {
            parse_windows_pathext(std::env::var_os("PATHEXT").as_deref())
        } else {
            Vec::new()
        };
        Self {
            path_dirs,
            extra_dirs,
            managed_dirs: Vec::new(),
            pathext,
            is_windows,
        }
    }
}

/// Returns the static CLI descriptor for each external CLI backend (`claude`, `codex`, `agy`, `omp`).
pub const fn cli_descriptor(backend: BackendId) -> Option<CliDescriptor> {
    match backend {
        BackendId::ProviderCli(ProviderCliKind::ClaudeCode) => Some(CliDescriptor {
            backend,
            binary_name: "claude",
            version_args: &["--version"],
        }),
        BackendId::ProviderCli(ProviderCliKind::Codex) => Some(CliDescriptor {
            backend,
            binary_name: "codex",
            version_args: &["--version"],
        }),
        BackendId::ProviderCli(ProviderCliKind::Antigravity) => Some(CliDescriptor {
            backend,
            binary_name: "agy",
            version_args: &["--version"],
        }),
        BackendId::Omp => Some(CliDescriptor {
            backend,
            binary_name: "omp",
            version_args: &["--version"],
        }),
        BackendId::ProviderCli(ProviderCliKind::GenericPty) | BackendId::DirectApi(_) => None,
    }
}

/// Returns `true` when `path` has a Windows `.cmd` or `.bat` batch shim extension.
pub fn is_windows_cmd_shim(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// Quotes one argument for Windows `cmd.exe /d /s /c "..."` invocation of `.cmd`/`.bat` shims.
pub fn quote_cmd_arg(arg: &str) -> String {
    if !arg.is_empty()
        && !arg.bytes().any(|b| {
            matches!(
                b,
                b' ' | b'\t' | b'"' | b'&' | b'|' | b'<' | b'>' | b'^' | b'%' | b'(' | b')'
            )
        })
    {
        return arg.to_owned();
    }
    let escaped = arg.replace('"', "\"\"").replace('%', "%%");
    format!("\"{escaped}\"")
}

/// Discovers a single external CLI backend against an explicit [`DiscoveryEnv`].
pub fn detect_cli_in(backend: BackendId, env: &DiscoveryEnv) -> InstalledBackendInfo {
    let Some(desc) = cli_descriptor(backend) else {
        return InstalledBackendInfo {
            backend,
            binary_name: backend.canonical_name().to_owned(),
            status: InstallStatus::Missing,
            source: None,
            binary_path: None,
            version_probe: None,
            version: None,
            detail: Some(format!("{backend} does not use a managed CLI binary")),
        };
    };

    let candidate_names = candidate_filenames(desc.binary_name, env);
    let user_hit = find_in_dirs(&env.path_dirs, &candidate_names, env.is_windows)
        .or_else(|| find_in_dirs(&env.extra_dirs, &candidate_names, env.is_windows));
    let found = user_hit
        .map(|path| (path, DiscoverySource::UserInstall))
        .or_else(|| {
            find_in_dirs(&env.managed_dirs, &candidate_names, env.is_windows)
                .map(|path| (path, DiscoverySource::ManagedCopy))
        });

    match found {
        Some((path, source)) => {
            let probe = CliCommandSpec::new(
                path.clone(),
                desc.version_args.iter().map(|s| (*s).to_owned()).collect(),
                env.is_windows,
            );
            InstalledBackendInfo {
                backend,
                binary_name: desc.binary_name.to_owned(),
                status: InstallStatus::Available,
                source: Some(source),
                binary_path: Some(path),
                version_probe: Some(probe),
                version: None,
                detail: None,
            }
        }
        None => InstalledBackendInfo {
            backend,
            binary_name: desc.binary_name.to_owned(),
            status: InstallStatus::Missing,
            source: None,
            binary_path: None,
            version_probe: None,
            version: None,
            detail: Some(format!("`{}` not found on PATH", desc.binary_name)),
        },
    }
}

/// Discovers a single external CLI backend on the live host.
pub fn detect_cli(backend: BackendId) -> InstalledBackendInfo {
    detect_cli_in(backend, &DiscoveryEnv::from_host())
}

/// Discovers all four supported external CLIs (`claude`, `codex`, `agy`, `omp`) in `env`.
pub fn detect_all_clis_in(env: &DiscoveryEnv) -> Vec<InstalledBackendInfo> {
    let backends = [
        BackendId::ProviderCli(ProviderCliKind::ClaudeCode),
        BackendId::ProviderCli(ProviderCliKind::Codex),
        BackendId::ProviderCli(ProviderCliKind::Antigravity),
        BackendId::Omp,
    ];
    backends
        .into_iter()
        .map(|backend| detect_cli_in(backend, env))
        .collect()
}

/// Discovers all four supported external CLIs on the live host.
pub fn detect_all_clis() -> Vec<InstalledBackendInfo> {
    detect_all_clis_in(&DiscoveryEnv::from_host())
}

/// Discovers whether a Direct LLM API provider has credentials or a local endpoint configured.
///
/// Never copies secret values into `detail` or logs.
pub fn detect_direct_api_in(
    provider: DirectApiProvider,
    get_env: impl Fn(&str) -> Option<String>,
) -> InstalledBackendInfo {
    let backend = BackendId::DirectApi(provider);
    let non_empty = |key: &str| get_env(key).is_some_and(|val| !val.trim().is_empty());

    let (ready, detail) = match provider {
        DirectApiProvider::Anthropic => (
            non_empty("ANTHROPIC_API_KEY"),
            "ANTHROPIC_API_KEY configured",
        ),
        DirectApiProvider::OpenAi => (non_empty("OPENAI_API_KEY"), "OPENAI_API_KEY configured"),
        DirectApiProvider::OpenRouter => (
            non_empty("OPENROUTER_API_KEY"),
            "OPENROUTER_API_KEY configured",
        ),
        DirectApiProvider::OpenAiCompatible => (
            non_empty("OPENAI_COMPATIBLE_API_KEY")
                || non_empty("OPENAI_BASE_URL")
                || non_empty("OLLAMA_HOST"),
            "OpenAI-compatible endpoint/key configured",
        ),
    };

    if ready {
        InstalledBackendInfo {
            backend,
            binary_name: provider.to_string(),
            status: InstallStatus::Available,
            source: Some(DiscoverySource::EnvironmentCredentials),
            binary_path: None,
            version_probe: None,
            version: None,
            detail: Some(detail.to_owned()),
        }
    } else {
        let missing_hint = match provider {
            DirectApiProvider::Anthropic => "ANTHROPIC_API_KEY not set",
            DirectApiProvider::OpenAi => "OPENAI_API_KEY not set",
            DirectApiProvider::OpenRouter => "OPENROUTER_API_KEY not set",
            DirectApiProvider::OpenAiCompatible => {
                "set OPENAI_BASE_URL, OLLAMA_HOST, or OPENAI_COMPATIBLE_API_KEY"
            }
        };
        InstalledBackendInfo {
            backend,
            binary_name: provider.to_string(),
            status: InstallStatus::Unauthenticated,
            source: None,
            binary_path: None,
            version_probe: None,
            version: None,
            detail: Some(missing_hint.to_owned()),
        }
    }
}

/// Discovers whether a Direct LLM API provider is configured in the live process environment.
pub fn detect_direct_api(provider: DirectApiProvider) -> InstalledBackendInfo {
    detect_direct_api_in(provider, |key| std::env::var(key).ok())
}

/// Builds a `tokio::process::Command` from a resolved [`CliCommandSpec`] with piped stdio and
/// `kill_on_drop(true)`.
pub(crate) fn build_tokio_command(
    spec: &CliCommandSpec,
    cwd: Option<&Path>,
    env: &BTreeMap<String, String>,
    env_remove: &[&str],
) -> Command {
    #[cfg(windows)]
    let mut cmd = if spec.use_cmd_shim {
        use std::os::windows::process::CommandExt as _;
        let comspec =
            std::env::var_os("ComSpec").unwrap_or_else(|| std::ffi::OsString::from("cmd.exe"));
        let mut command = Command::new(comspec);
        let mut line = quote_cmd_arg(&spec.program.to_string_lossy());
        for arg in &spec.args {
            line.push(' ');
            line.push_str(&quote_cmd_arg(arg));
        }
        command.as_std_mut().raw_arg(format!("/d /s /c \"{line}\""));
        command
    } else {
        let mut command = Command::new(&spec.program);
        command.args(&spec.args);
        command
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let mut command = Command::new(&spec.program);
        command.args(&spec.args);
        command
    };

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for key in env_remove {
        cmd.env_remove(key);
    }
    if !env.is_empty() {
        cmd.envs(env);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}

/// Runs the version probe on a discovered [`InstalledBackendInfo`] with a strict timeout.
pub async fn probe_cli_version(info: &mut InstalledBackendInfo, timeout: Duration) {
    let Some(spec) = info.version_probe.as_ref() else {
        return;
    };
    let mut cmd = build_tokio_command(spec, None, &BTreeMap::new(), &[]);
    cmd.stdin(Stdio::null());
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let line = stdout
                .lines()
                .chain(stderr.lines())
                .map(str::trim)
                .find(|line| !line.is_empty());
            if let Some(version) = line {
                info.version = Some(version.to_owned());
            }
        }
        Ok(Ok(output)) => {
            info.status = InstallStatus::Broken;
            info.detail = Some(format!(
                "version probe exited with status {:?}",
                output.status.code()
            ));
        }
        Ok(Err(error)) => {
            info.status = InstallStatus::Broken;
            info.detail = Some(format!("version probe spawn failed: {error}"));
        }
        Err(_) => {
            info.detail = Some("version probe timed out".to_owned());
        }
    }
}

fn default_extra_dirs(
    is_windows: bool,
    home: Option<&Path>,
    user_profile: Option<&Path>,
    app_data: Option<&Path>,
    local_app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if is_windows {
        if let Some(profile) = user_profile {
            dirs.push(profile.join(".bun").join("bin"));
            dirs.push(profile.join(".local").join("bin"));
        }
        if let Some(roaming) = app_data {
            dirs.push(roaming.join("npm"));
        }
        if let Some(local) = local_app_data {
            dirs.push(local.join("Programs"));
        }
    } else {
        if let Some(home_dir) = home {
            dirs.push(home_dir.join(".local").join("bin"));
            dirs.push(home_dir.join(".bun").join("bin"));
            dirs.push(home_dir.join(".npm-global").join("bin"));
        }
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

fn parse_windows_pathext(raw: Option<&std::ffi::OsStr>) -> Vec<String> {
    let mut exts = Vec::new();
    if let Some(text) = raw.and_then(|value| value.to_str()) {
        for part in text.split(';') {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            let normalized = if trimmed.starts_with('.') {
                trimmed.to_ascii_lowercase()
            } else {
                format!(".{}", trimmed.to_ascii_lowercase())
            };
            if DEFAULT_WINDOWS_EXTS.contains(&normalized.as_str()) && !exts.contains(&normalized) {
                exts.push(normalized);
            }
        }
    }
    if exts.is_empty() {
        DEFAULT_WINDOWS_EXTS
            .iter()
            .map(|ext| (*ext).to_owned())
            .collect()
    } else {
        exts
    }
}

fn candidate_filenames(stem: &str, env: &DiscoveryEnv) -> Vec<String> {
    if !env.is_windows {
        return vec![stem.to_owned()];
    }
    let exts = if env.pathext.is_empty() {
        DEFAULT_WINDOWS_EXTS
            .iter()
            .map(|ext| (*ext).to_owned())
            .collect()
    } else {
        env.pathext.clone()
    };
    // Never include the bare extensionless stem on Windows: npm installs a POSIX shell script
    // beside `.cmd` that fails under CreateProcess.
    exts.into_iter().map(|ext| format!("{stem}{ext}")).collect()
}

fn find_in_dirs(dirs: &[PathBuf], names: &[String], is_windows: bool) -> Option<PathBuf> {
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in names {
            let candidate = dir.join(name);
            if is_executable_file(&candidate, is_windows) {
                return Some(candidate);
            }
        }
    }
    None
}

fn is_executable_file(path: &Path, is_windows: bool) -> bool {
    if !path.is_file() {
        return false;
    }
    if is_windows {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn make_file(dir: &Path, name: &str, executable: bool) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"#!/bin/sh\necho 1.0.0\n").unwrap();
        #[cfg(unix)]
        if executable {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&path, perms).unwrap();
        }
        #[cfg(not(unix))]
        let _ = executable;
        path
    }

    #[test]
    fn windows_discovery_skips_extensionless_posix_shim_and_marks_cmd_shim() {
        let dir = tempfile::tempdir().unwrap();
        // npm writes an extensionless POSIX script next to claude.cmd
        make_file(dir.path(), "claude", false);
        let cmd_path = make_file(dir.path(), "claude.cmd", false);
        let exe_path = make_file(dir.path(), "codex.exe", false);
        make_file(dir.path(), "codex.cmd", false);

        let env = DiscoveryEnv {
            path_dirs: vec![dir.path().to_path_buf()],
            extra_dirs: Vec::new(),
            managed_dirs: Vec::new(),
            pathext: vec![".exe".to_owned(), ".cmd".to_owned()],
            is_windows: true,
        };

        let claude = detect_cli_in(BackendId::ProviderCli(ProviderCliKind::ClaudeCode), &env);
        assert!(claude.is_available());
        assert_eq!(claude.binary_path.as_deref(), Some(cmd_path.as_path()));
        assert_eq!(claude.source, Some(DiscoverySource::UserInstall));
        let probe = claude.version_probe.as_ref().unwrap();
        assert!(probe.use_cmd_shim);
        assert_eq!(probe.args, ["--version"]);

        let codex = detect_cli_in(BackendId::ProviderCli(ProviderCliKind::Codex), &env);
        assert!(codex.is_available());
        assert_eq!(codex.binary_path.as_deref(), Some(exe_path.as_path()));
        assert!(!codex.version_probe.as_ref().unwrap().use_cmd_shim);

        // Missing CLI never falls back to a bare executable name.
        let agy = detect_cli_in(BackendId::ProviderCli(ProviderCliKind::Antigravity), &env);
        assert_eq!(agy.status, InstallStatus::Missing);
        assert!(agy.binary_path.is_none());
        assert!(agy.version_probe.is_none());
    }

    #[test]
    fn user_path_wins_over_managed_copy_and_respects_unix_execute_bit() {
        let user_dir = tempfile::tempdir().unwrap();
        let managed_dir = tempfile::tempdir().unwrap();

        // Non-executable file in user dir should be ignored on Unix.
        make_file(user_dir.path(), "omp", false);
        let managed_omp = make_file(managed_dir.path(), "omp", true);
        let user_claude = make_file(user_dir.path(), "claude", true);
        make_file(managed_dir.path(), "claude", true);

        let env = DiscoveryEnv {
            path_dirs: vec![user_dir.path().to_path_buf()],
            extra_dirs: Vec::new(),
            managed_dirs: vec![managed_dir.path().to_path_buf()],
            pathext: Vec::new(),
            is_windows: false,
        };

        let claude = detect_cli_in(BackendId::ProviderCli(ProviderCliKind::ClaudeCode), &env);
        assert_eq!(claude.binary_path.as_deref(), Some(user_claude.as_path()));
        assert_eq!(claude.source, Some(DiscoverySource::UserInstall));

        let omp = detect_cli_in(BackendId::Omp, &env);
        #[cfg(unix)]
        {
            assert_eq!(omp.binary_path.as_deref(), Some(managed_omp.as_path()));
            assert_eq!(omp.source, Some(DiscoverySource::ManagedCopy));
        }
        #[cfg(not(unix))]
        {
            let _ = managed_omp;
            assert!(omp.is_available());
        }
    }

    #[test]
    fn direct_api_discovery_checks_env_without_exposing_secrets() {
        let secret = "sk-ant-super-secret-value";
        let info = detect_direct_api_in(DirectApiProvider::Anthropic, |key| {
            (key == "ANTHROPIC_API_KEY").then(|| secret.to_owned())
        });
        assert!(info.is_available());
        assert_eq!(info.source, Some(DiscoverySource::EnvironmentCredentials));
        assert!(!info.detail.as_deref().unwrap_or("").contains(secret));

        let missing = detect_direct_api_in(DirectApiProvider::OpenRouter, |_| None);
        assert_eq!(missing.status, InstallStatus::Unauthenticated);
    }

    #[test]
    fn windows_cmd_quoting_handles_spaces_quotes_and_percents() {
        assert_eq!(quote_cmd_arg("--version"), "--version");
        assert_eq!(
            quote_cmd_arg("C:\\Program Files\\claude.cmd"),
            "\"C:\\Program Files\\claude.cmd\""
        );
        assert_eq!(quote_cmd_arg("100% \"ok\""), "\"100%% \"\"ok\"\"\"");
    }
}
