//! Read-only discovery. A tools result is not authorization to launch a session or run project code.
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::server::{Call, Fault, Registry, Reply, Scope};

const PROBE: &str = include_str!("../../../../../../resources/gui-bridge/wsl/probe-tools.sh");
const MINIMUM: &str = include_str!("../../../../../../src/shared/omp-minimum.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Distribution {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) version: u32,
    pub(crate) is_default: bool,
}

#[cfg(any(windows, test))]
impl Distribution {
    pub(crate) fn registered(
        mut id: String,
        name: String,
        version: u32,
        default: Option<&str>,
    ) -> std::io::Result<Self> {
        if !guid(&id)
            || name.trim().is_empty()
            || name.chars().any(char::is_control)
            || !matches!(version, 1 | 2)
        {
            return Err(std::io::Error::other("Invalid WSL registration"));
        }
        id.make_ascii_lowercase();
        Ok(Self {
            is_default: default.is_some_and(|d| d.eq_ignore_ascii_case(&id)),
            id,
            name,
            version,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Inventory {
    pub(crate) app_version: Option<String>,
    pub(crate) distributions: Vec<Distribution>,
}

pub(crate) fn guid(id: &str) -> bool {
    id.len() == 38
        && id.bytes().enumerate().all(|(i, byte)| match i {
            0 => byte == b'{',
            37 => byte == b'}',
            9 | 14 | 19 | 24 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn number(part: &str) -> Option<u32> {
    if part.is_empty()
        || !part.bytes().all(|b| b.is_ascii_digit())
        || (part.len() > 1 && part.starts_with('0'))
    {
        return None;
    }
    part.parse().ok()
}

fn triplet(version: &str) -> Option<[u32; 3]> {
    let mut p = version.split('.');
    let core = [number(p.next()?)?, number(p.next()?)?, number(p.next()?)?];
    p.next().is_none().then_some(core)
}

#[cfg(any(windows, test))]
pub(crate) fn package_version(s: &str) -> Option<[u32; 4]> {
    let (core, revision) = if s.bytes().filter(|b| *b == b'.').count() == 3 {
        let (core, rev) = s.rsplit_once('.')?;
        (core, number(rev)?)
    } else {
        (s, 0)
    };
    let [a, b, c] = triplet(core)?;
    Some([a, b, c, revision])
}

fn unavailable() -> Fault {
    Fault::new("wsl_unavailable", "Cannot inspect Windows WSL registration")
}

async fn inventory(scope: &Scope) -> Result<Inventory, Fault> {
    #[cfg(windows)]
    {
        tokio::select! {
            result = tokio::task::spawn_blocking(crate::sys::wsl::inventory) => result.ok().and_then(Result::ok).ok_or_else(unavailable),
            () = scope.on_cancel() => Err(Fault::cancelled()),
            () = tokio::time::sleep(Duration::from_secs(5)) => Err(unavailable()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = scope;
        Err(unavailable())
    }
}

impl Inventory {
    fn registered_v2(&self, id: &str) -> Result<&str, Fault> {
        match self
            .distributions
            .iter()
            .find(|d| d.id.eq_ignore_ascii_case(id))
        {
            Some(d) if d.version == 2 => Ok(&d.id),
            Some(_) => Err(Fault::new("wsl_not_v2", "The registration is not WSL 2")),
            None => Err(Fault::new("wsl_not_registered", "No such WSL registration")),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tools {
    // All fields must be present. Null is a measured absence, not a malformed/missing reply.
    #[serde(deserialize_with = "Option::deserialize")]
    git: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    bun: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    omp: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    engines_bun: Option<String>,
    launchable: bool,
}

#[derive(Serialize)]
struct Preflight {
    #[serde(flatten)]
    tools: Tools,
    ready: bool,
}

fn failed() -> Fault {
    Fault::new("wsl_probe", "No valid guest tool report")
}

fn version_token(s: &str) -> bool {
    s.len() <= 128
        && s.split_once('.').is_some_and(|(major, rest)| {
            !major.is_empty()
                && major.bytes().all(|b| b.is_ascii_digit())
                && rest.as_bytes().first().is_some_and(u8::is_ascii_digit)
        })
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
}

fn parse_tools(bytes: &[u8]) -> Result<Preflight, Fault> {
    let line = bytes.strip_suffix(b"\n").ok_or_else(failed)?;
    if bytes.len() > 4096
        || line.first() != Some(&b'{')
        || line.contains(&b'\n')
        || line.contains(&b'\r')
    {
        return Err(failed());
    }
    let mut tools: Tools = serde_json::from_slice(line).map_err(|_| failed())?;
    if tools
        .git
        .iter()
        .chain(&tools.bun)
        .any(|s| !version_token(s))
    {
        return Err(failed());
    }
    let omp = tools
        .omp
        .as_deref()
        .map(|s| triplet(s).ok_or_else(failed))
        .transpose()?;
    let mut bun_floor = None;
    if let Some(engine) = &mut tools.engines_bun {
        let v = engine
            .trim()
            .strip_prefix(">=")
            .ok_or_else(failed)?
            .trim_start();
        let v = v.strip_prefix('v').unwrap_or(v);
        bun_floor = Some(triplet(v).ok_or_else(failed)?);
        if omp.is_none() {
            return Err(failed());
        }
        *engine = format!(">={v}");
    }
    let minimum = serde_json::from_str::<&str>(MINIMUM)
        .ok()
        .and_then(triplet)
        .ok_or_else(|| Fault::new("internal", "Invalid bundled omp minimum"))?;
    // A plain >= range excludes prereleases. Build identifiers, if present, must be valid.
    let bun = tools.bun.as_deref().and_then(|s| match s.split_once('+') {
        Some((core, build))
            if build.split('.').all(|part| {
                !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            }) =>
        {
            triplet(core)
        }
        Some(_) => None,
        None => triplet(s),
    });
    let ready = tools.launchable
        && tools.git.is_some()
        && omp.is_some_and(|v| v >= minimum)
        && bun.zip(bun_floor).is_some_and(|(v, min)| v >= min);
    Ok(Preflight { tools, ready })
}

async fn probe(id: &str, scope: &Scope, system: &std::path::Path) -> Result<Preflight, Fault> {
    if scope.cancelled() {
        return Err(Fault::cancelled());
    }
    let mut cmd = Command::new(system.join("wsl.exe"));
    cmd.args([
        "--distribution-id",
        id,
        "--cd",
        "/",
        "--exec",
        "/usr/bin/env",
        "-i",
        "/usr/bin/timeout",
        "--kill-after=1s",
        "10s",
        "/bin/sh",
        "-s",
    ])
    .current_dir(system)
    .env_clear()
    .env("SystemRoot", system.parent().ok_or_else(unavailable)?)
    .env("WSLENV", "")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|_| failed())?;
    let mut stdin = child.stdin.take().ok_or_else(failed)?;
    let stdout = child.stdout.take().ok_or_else(failed)?;
    let run = async {
        tokio::try_join!(
            child.wait(),
            super::runtime::read_pipe(stdout, 4096),
            async move { stdin.write_all(PROBE.as_bytes()).await }
        )
    };
    let answer = tokio::select! {
        result = run => result.map_err(|_| failed()),
        () = scope.on_cancel() => Err(Fault::cancelled()),
        () = tokio::time::sleep(Duration::from_secs(15)) => Err(failed()),
    };
    match answer {
        Ok((status, out, ())) if status.success() => parse_tools(&out),
        Ok(_) => Err(failed()),
        Err(e) => {
            let _ = child.kill().await;
            Err(e)
        }
    }
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("setup.wslInventory", |call| {
        Box::pin(async move {
            let _: Empty = call.params()?;
            no_input(&call)?;
            Reply::json(&inventory(&call.scope).await?)
        })
    });
    registry.add("setup.wslPreflight", |call| {
        Box::pin(async move {
            let Target { id } = call.params()?;
            no_input(&call)?;
            if !guid(&id) {
                return Err(Fault::new(
                    "invalid_params",
                    "Expected a braced WSL registration GUID",
                ));
            }
            let inv = inventory(&call.scope).await?;
            let id = inv.registered_v2(&id)?;
            let system = system_directory()?;
            Reply::json(&probe(id, &call.scope, &system).await?)
        })
    });
}

fn system_directory() -> Result<std::path::PathBuf, Fault> {
    #[cfg(windows)]
    {
        crate::sys::wsl::system_directory().map_err(|_| unavailable())
    }
    #[cfg(not(windows))]
    {
        Err(unavailable())
    }
}

fn no_input(call: &Call) -> Result<(), Fault> {
    if call.bin.is_some() || !call.params.get().trim_start().starts_with('{') {
        return Err(Fault::new(
            "invalid_params",
            "Expected WSL setup parameters and no binary input",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
