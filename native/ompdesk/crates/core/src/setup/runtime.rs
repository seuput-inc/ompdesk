use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::fs::error::uv_code;
use crate::fs::order::js_trim;
use crate::json::whole_surrogates;
use crate::run::{KILL_GRACE, terminate};
use crate::server::{Call, Fault, Reply, Scope};
use crate::sidecar::omp_command;
use crate::tailscale::{compare_versions, version_in};

const TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const EXEC_FILE_MAX_BUFFER: u64 = 1024 * 1024;

#[derive(Clone, Copy)]
pub(super) enum VersionMode {
    ExecFile,
    Omp,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    bin: String,
    minimum: String,
    bun: Option<Bun>,
    cwd: String,
    env: BTreeMap<String, String>,
    omp_env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct Bun {
    bin: String,
    minimum: String,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Probe {
    Usable {
        version: String,
    },
    TooOld {
        version: String,
    },
    BunTooOld {
        bun: String,
        bun_version: String,
        minimum: String,
    },
    CannotRun {
        detail: String,
    },
    FailedVersion {
        detail: String,
    },
}

/// A neighboring Bun/npm layout can supply the engine floor but not this executable's version.
async fn installed_version(cwd: &Path, bin: &str) -> Option<String> {
    let target = tokio::fs::canonicalize(cwd.join(bin)).await.ok()?;
    let dir = target.parent().unwrap_or(&target);
    let file = dir.parent().unwrap_or(dir).join("package.json");
    let bytes = tokio::fs::read(file).await.ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let manifest: Value = serde_json::from_str(&whole_surrogates(&text)).ok()?;
    if manifest.get("name")?.as_str()? != "@oh-my-pi/pi-coding-agent" {
        return None;
    }
    version_in(manifest.get("version")?.as_str()?).map(str::to_owned)
}

pub(super) async fn read_pipe(pipe: impl AsyncRead + Unpin, max: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    read_stream(pipe, max, &mut bytes, "output").await?;
    Ok(bytes)
}

async fn read_stream(
    pipe: impl AsyncRead + Unpin,
    max: u64,
    bytes: &mut Vec<u8>,
    stream: &str,
) -> io::Result<()> {
    pipe.take(max.saturating_add(1)).read_to_end(bytes).await?;
    if bytes.len() as u64 > max {
        bytes.pop();
        return Err(io::Error::other(format!(
            "{stream} maxBuffer length exceeded"
        )));
    }
    Ok(())
}

// A located file is literal. Do not let cmd expand it or change the quoted command.
fn safe_shim_path(bin: &str) -> bool {
    !bin.contains(['"', '!'])
        && !bin.chars().any(char::is_control)
        && !bin
            .split_once('%')
            .is_some_and(|(_, rest)| rest.contains('%'))
}

pub(super) async fn version_output(
    bin: &str,
    cwd: &str,
    env: &BTreeMap<String, String>,
    scope: &Scope,
    mode: VersionMode,
) -> Result<(bool, Vec<u8>, Vec<u8>), Fault> {
    if scope.cancelled() {
        return Err(Fault::cancelled());
    }
    let max = match mode {
        VersionMode::ExecFile => EXEC_FILE_MAX_BUFFER,
        VersionMode::Omp => u64::MAX,
    };
    let shim = cfg!(windows)
        && bin.as_bytes().last_chunk::<4>().is_some_and(|ext| {
            ext.eq_ignore_ascii_case(b".cmd") || ext.eq_ignore_ascii_case(b".bat")
        });
    let mut cmd = if shim {
        if matches!(mode, VersionMode::ExecFile) {
            return Err(Fault::new("spawn_failed", format!("spawn {bin} EINVAL")));
        }
        if !safe_shim_path(bin) {
            return Err(Fault::new("spawn_failed", "Invalid Windows launcher path"));
        }
        omp_command(&format!("\"{bin}\""), &["\"--version\""], true, cwd, env)
    } else {
        omp_command(bin, &["--version"], false, cwd, env)
    };
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| Fault::new("spawn_failed", format!("spawn {bin} {}", uv_code(&e))))?;
    drop(child.stdin.take());
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let read = async {
        tokio::try_join!(
            child.wait(),
            read_stream(stdout, max, &mut out, "stdout"),
            read_stream(stderr, max, &mut err, "stderr")
        )
    };
    let mut fault = tokio::select! {
        result = read => match result {
            Ok((status, (), ())) => return Ok((status.success(), out, err)),
            Err(e) => Fault::new("io_error", e.to_string()),
        },
        () = scope.on_cancel() => Fault::cancelled(),
        () = tokio::time::sleep(TIMEOUT) => Fault::new("omp_timeout", "omp --version timed out after 15000ms"),
    };
    terminate(&mut child);
    let cleanup = async move {
        if tokio::time::timeout(KILL_GRACE, child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    };
    if fault.code == "omp_timeout" {
        tokio::spawn(cleanup);
    } else {
        cleanup.await;
    }
    if matches!(mode, VersionMode::ExecFile) && fault.code != "cancelled" {
        if !err.is_empty() {
            fault.message = js_trim(&String::from_utf8_lossy(&err))
                .split('\n')
                .next()
                .unwrap_or("")
                .to_owned();
        } else if fault.code == "omp_timeout" {
            fault.message = format!("Command failed: {bin} --version");
        }
    }
    Err(fault)
}

#[derive(Deserialize)]
struct Tool {
    bin: String,
    cwd: String,
    env: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ToolVersion<'a> {
    Present { version: Option<&'a str> },
    Broken { detail: &'a str },
}

pub(super) async fn tool_version(call: Call) -> Result<Reply, Fault> {
    let Tool { bin, cwd, env } = call.params()?;
    let name = Path::new(&bin).file_name().and_then(|n| n.to_str());
    let tools: &[&str] = if cfg!(windows) {
        &[
            "bun.exe",
            "git.exe",
            "gh.exe",
            "node.exe",
            "agent-desktop.exe",
        ]
    } else {
        &["bun", "git", "gh", "node", "agent-desktop"]
    };
    if !name.is_some_and(|n| {
        tools.iter().any(|&t| {
            if cfg!(windows) {
                n.eq_ignore_ascii_case(t)
            } else {
                n == t
            }
        })
    }) {
        return Err(Fault::new(
            "invalid_params",
            "Not a machine setup version probe",
        ));
    }
    let detail = match version_output(&bin, &cwd, &env, &call.scope, VersionMode::ExecFile).await {
        Ok((true, out, _)) => {
            let text = String::from_utf8_lossy(&out);
            return Reply::json(&ToolVersion::Present {
                version: version_in(&text),
            });
        }
        Ok((false, _, err)) if !err.is_empty() => {
            return Reply::json(&ToolVersion::Broken {
                detail: js_trim(&String::from_utf8_lossy(&err))
                    .split('\n')
                    .next()
                    .unwrap_or(""),
            });
        }
        Err(e) if e.code == "cancelled" => return Err(e),
        Err(e) => e.message,
        Ok(_) => format!("Command failed: {bin} --version"),
    };
    Reply::json(&ToolVersion::Broken { detail: &detail })
}

pub(super) async fn probe(call: Call) -> Result<Reply, Fault> {
    let p: Params = call.params()?;
    Reply::json(&examine(p, &call.scope).await?)
}

async fn examine(mut p: Params, scope: &Scope) -> Result<Probe, Fault> {
    if let Some(bun) = p.bun
        && let Ok((true, stdout, _)) =
            version_output(&bun.bin, &p.cwd, &p.env, scope, VersionMode::ExecFile).await
        && let Some(version) = version_in(&String::from_utf8_lossy(&stdout))
        && compare_versions(&bun.minimum, version).is_some_and(|o| o.is_gt())
    {
        return Ok(Probe::BunTooOld {
            bun: bun.bin,
            minimum: bun.minimum,
            bun_version: version.to_owned(),
        });
    }
    if scope.cancelled() {
        return Err(Fault::cancelled());
    }
    let version = match installed_version(Path::new(&p.cwd), &p.bin).await {
        Some(version) => version,
        None => {
            p.env.extend(p.omp_env);
            let (ok, out, err) =
                match version_output(&p.bin, &p.cwd, &p.env, scope, VersionMode::Omp).await {
                    Ok(output) => output,
                    Err(fault) if fault.code == "cancelled" => return Err(fault),
                    Err(fault) => {
                        return Ok(Probe::CannotRun {
                            detail: fault.message,
                        });
                    }
                };
            let stdout = String::from_utf8_lossy(&out);
            if let Some(version) = ok.then(|| version_in(&stdout)).flatten() {
                version.to_owned()
            } else {
                let detail = if err.is_empty() {
                    stdout
                } else {
                    String::from_utf8_lossy(&err)
                };
                return Ok(Probe::FailedVersion {
                    detail: js_trim(&detail).split('\n').next().unwrap_or("").to_owned(),
                });
            }
        }
    };
    Ok(
        if compare_versions(&p.minimum, &version).is_some_and(|o| o.is_gt()) {
            Probe::TooOld { version }
        } else {
            Probe::Usable { version }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn cmd_must_receive_the_literal_launcher() {
        assert!(safe_shim_path(r"C:\tools & helpers 100%\omp.cmd"));
        for path in [
            r"C:\%tool%\omp.cmd",
            r"C:\!tool!\omp.cmd",
            "quoted\".cmd",
            "line\nbreak.cmd",
        ] {
            assert!(!safe_shim_path(path));
        }
    }

    #[tokio::test]
    async fn resolves_the_package_and_launcher_as_typescript_did() {
        let dir = crate::fs::disk::make_temp_dir("omp runtime ").unwrap();
        let dist = dir.join("dist");
        fs::create_dir(&dist).unwrap();
        let file = dist.join(if cfg!(windows) { "omp.cmd" } else { "omp" });
        let package = "@oh-my-pi/pi-coding-agent";
        let manifest = dir.join("package.json");
        // Captured from installedVersion and examineOmp on this layout before the cutover.
        for (name, version, output, code, installed, expected) in [
            (
                package,
                json!("v19.1.2-tag"),
                "bad",
                1,
                Some("19.1.2"),
                json!({"kind":"usable","version":"19.1.2"}),
            ),
            (
                "foreign",
                json!("99.0.0"),
                "omp/18.18.9",
                0,
                None,
                json!({"kind":"usable","version":"18.18.9"}),
            ),
            (
                package,
                json!(18),
                "warn\nomp/20.0.1",
                0,
                None,
                json!({"kind":"usable","version":"20.0.1"}),
            ),
            (
                package,
                json!("bad"),
                "no version",
                0,
                None,
                json!({"kind":"failed-version","detail":"no version"}),
            ),
            (
                package,
                json!("00018.018.008-tag"),
                "other",
                0,
                Some("00018.018.008"),
                json!({"kind":"too-old","version":"00018.018.008"}),
            ),
            (
                package,
                Value::Null,
                "omp/20.0.1",
                4,
                None,
                json!({"kind":"failed-version","detail":"omp/20.0.1"}),
            ),
        ] {
            fs::write(
                &manifest,
                json!({"name":name,"version":version}).to_string(),
            )
            .unwrap();
            let lines = output
                .lines()
                .map(|line| format!("echo {line}\n"))
                .collect::<String>();
            let script = if cfg!(windows) {
                format!("@echo off\n{lines}exit /b {code}\n").replace('\n', "\r\n")
            } else {
                format!("#!/bin/sh\n{lines}exit {code}\n")
            };
            fs::write(&file, script).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).unwrap();
            }
            let cwd = dir.to_str().unwrap();
            let bin = file.to_str().unwrap();
            assert_eq!(installed_version(&dir, bin).await.as_deref(), installed);
            let p = Params {
                bin: bin.to_owned(),
                minimum: "18.18.9".into(),
                bun: None,
                cwd: cwd.to_owned(),
                env: std::env::var("SystemRoot")
                    .ok()
                    .map(|v| ("SystemRoot".into(), v))
                    .into_iter()
                    .collect(),
                omp_env: BTreeMap::new(),
            };
            let probe = examine(p, &Scope::detached()).await.unwrap();
            assert_eq!(serde_json::to_value(probe).unwrap(), expected);
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
