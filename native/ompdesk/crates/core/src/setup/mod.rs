//! Machine setup's downloads, release lookups and compiled omp launcher repair.
//!
//! Methods:
//! - `setup.download` `{id, url, sha256, file, accept?, mirror?}` answers `{}` once `file` holds bytes that match
//!   `sha256`; the failures are `download` and `checksum` (code), and `cancelled` when its `{cancel}` frame came.
//!   Progress is the event `setup.downloadProgress` `{id, received, total}` while it runs.
//! - `setup.resolveArchive` `{item, arch, mirror?, githubToken?}`, `setup.resolveAgentDesktop`
//!   `{platform, arch, …}` and `setup.resolveTailscale` `{platform, msiArch, …}` answer the release; a lookup that
//!   cannot say fails `setup_lookup` with a readable reason.
//! - `setup.probeOmp` checks the Bun that would run a package launcher, then its installed manifest or `--version`.
//! - `mirror` is a test's server on 127.0.0.1 standing in for every host (`net::routed`).

pub(crate) mod archives;
pub(crate) mod compat;
pub(crate) mod desktop;
pub(crate) mod download;
pub(crate) mod launcher;
pub(crate) mod net;
mod registry_path;
pub(crate) mod runtime;
#[cfg(test)]
mod tests;

use serde::Deserialize;
use std::collections::BTreeMap;

use archives::{Platform, resolve_agent_desktop, resolve_archive, resolve_tailscale};
use net::Http;

use crate::server::{Call, Fault, Registry, Reply};

pub fn register(registry: &mut Registry) {
    compat::register(registry);
    launcher::register(registry);
    registry.add("setup.pickAgentDesktop", |call| {
        Box::pin(desktop::select(call))
    });
    registry.add("setup.probeOmp", |call| Box::pin(runtime::probe(call)));
    registry.add("setup.toolVersion", |call| {
        Box::pin(runtime::tool_version(call))
    });
    registry.add("setup.appleDeveloperDir", |call| {
        Box::pin(apple_developer_dir(call))
    });
    registry.add("setup.download", |call| Box::pin(download::handle(call)));
    registry.add("setup.resolveArchive", |call| {
        Box::pin(async move { resolve_archive_method(call).await })
    });
    registry.add("setup.resolveAgentDesktop", |call| {
        Box::pin(async move { resolve_agent_desktop_method(call).await })
    });
    registry.add("setup.resolveTailscale", |call| {
        Box::pin(async move { resolve_tailscale_method(call).await })
    });
    registry_path::register(registry);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleDeveloperDir {
    cwd: String,
    env: BTreeMap<String, String>,
    timeout_ms: u64,
}

async fn apple_developer_dir(call: Call) -> Result<Reply, Fault> {
    let p: AppleDeveloperDir = call.params()?;
    if !matches!(p.timeout_ms, 5_000 | 15_000) {
        return Err(Fault::new(
            "invalid_params",
            "Unknown developer directory probe timeout",
        ));
    }
    Reply::json(&developer_dir(&p.cwd, p.env, p.timeout_ms, call.scope).await?)
}

/// `xcode-select -p` within `timeout_ms` on macOS: the selected developer directory; none elsewhere or when it fails.
pub(crate) async fn developer_dir(
    cwd: &str,
    env: BTreeMap<String, String>,
    timeout_ms: u64,
    scope: crate::server::Scope,
) -> Result<Option<String>, Fault> {
    use crate::run::{Exec, Opts, Runner};

    let mut dir = None;
    if cfg!(target_os = "macos") {
        let runner = Runner {
            bin: "/usr/bin/xcode-select".into(),
            args: Vec::new(),
            env,
            timeout_ms,
            max_bytes: runtime::EXEC_FILE_MAX_BUFFER as usize,
        };
        let exec = Exec::new(runner, scope, "xcode_select");
        match exec.run(cwd, &["-p"], Opts::default()).await {
            Ok(out) if out.code == 0 && !out.truncated => dir = Some(out.text()),
            Err(fault) if fault.code == "cancelled" => return Err(fault),
            _ => {}
        }
    }
    Ok(dir)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    mirror: Option<String>,
    github_token: Option<String>,
    /// The proxy `proxy.resolve` picked, which every non-loopback request goes through.
    proxy: Option<String>,
}

impl Source {
    fn pages(&self) -> Http<'_> {
        Http {
            mirror: self.mirror.as_deref(),
            token: self.github_token.as_deref(),
            proxy: self.proxy.as_deref(),
        }
    }
}

fn lookup_failed(message: String) -> Fault {
    Fault::new("setup_lookup", message)
}

#[derive(Deserialize)]
struct ArchiveParams {
    item: String,
    arch: String,
    #[serde(flatten)]
    source: Source,
}

async fn resolve_archive_method(call: Call) -> Result<Reply, Fault> {
    let params: ArchiveParams = call.params()?;
    if params.item != "gh" && params.item != "node" {
        return Err(Fault::new("invalid_params", "item is gh or node"));
    }
    let release = resolve_archive(&params.source.pages(), &params.item, &params.arch)
        .await
        .map_err(lookup_failed)?;
    Reply::json(&release)
}

#[derive(Deserialize)]
struct AgentDesktopParams {
    platform: Platform,
    arch: String,
    #[serde(flatten)]
    source: Source,
}

async fn resolve_agent_desktop_method(call: Call) -> Result<Reply, Fault> {
    let params: AgentDesktopParams = call.params()?;
    let release = resolve_agent_desktop(&params.source.pages(), params.platform, &params.arch)
        .await
        .map_err(lookup_failed)?;
    Reply::json(&release)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TailscaleParams {
    platform: Platform,
    msi_arch: Option<String>,
    #[serde(flatten)]
    source: Source,
}

async fn resolve_tailscale_method(call: Call) -> Result<Reply, Fault> {
    let params: TailscaleParams = call.params()?;
    let release = resolve_tailscale(
        &params.source.pages(),
        params.platform,
        params.msi_arch.as_deref(),
    )
    .await
    .map_err(lookup_failed)?;
    Reply::json(&release)
}
