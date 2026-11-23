//! The read-only Windows laptop probe. A failed probe must not enable a lid hold.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::fs::error::uv_code;
use crate::fs::order::is_js_space;
use crate::run::Runner;
use crate::server::{Call, Fault, Reply};

const QUERY: [&str; 4] = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "(Get-CimInstance -ClassName Win32_Battery | Measure-Object).Count",
];

#[derive(Deserialize)]
struct Probe {
    file: String,
    prefix: Vec<String>,
    env: BTreeMap<String, String>,
    cwd: String,
}

// `Number.parseInt(stdout.trim(), 10) > 0`, including a decimal prefix past integer range.
fn has_battery(report: &str) -> bool {
    let count = report.trim_start_matches(is_js_space);
    let positive = count
        .strip_prefix('+')
        .unwrap_or(count)
        .trim_start_matches('0');
    matches!(positive.as_bytes().first(), Some(b'1'..=b'9'))
}

// execFile rejects if *either* pipe exceeds 1 MiB. The git runner truncates stderr instead.
async fn capture(
    pipe: impl AsyncRead + Unpin,
    bytes: &mut Vec<u8>,
    name: &str,
) -> Result<(), Fault> {
    const MAX: usize = 1024 * 1024;
    pipe.take(MAX as u64 + 1)
        .read_to_end(bytes)
        .await
        .map_err(|e| Fault::new("battery_probe", e.to_string()))?;
    if bytes.len() > MAX {
        return Err(Fault::new(
            "battery_probe",
            format!("{name} maxBuffer length exceeded"),
        ));
    }
    Ok(())
}

pub(super) async fn query(call: Call) -> Result<Reply, Fault> {
    let probe: Probe = call.params()?;
    if call.scope.cancelled() {
        return Err(Fault::cancelled());
    }
    let mut command = Command::new(&probe.file);
    command
        .args(&probe.prefix)
        .args(QUERY)
        .env_clear()
        .current_dir(probe.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Runner::apply_environment(&probe.env, &mut command);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|e| {
        Fault::new(
            "spawn_failed",
            format!("spawn {} {}", probe.file, uv_code(&e)),
        )
    })?;
    let (Some(out), Some(err)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(Fault::new(
            "internal",
            "the battery probe's pipes were not open",
        ));
    };
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let result = tokio::select! {
        () = call.scope.on_cancel() => Err(Fault::cancelled()),
        () = tokio::time::sleep(Duration::from_secs(30)) => Ok(None),
        result = async {
            tokio::try_join!(capture(out, &mut stdout, "stdout"), capture(err, &mut stderr, "stderr"), async {
                child.wait().await.map_err(|e| Fault::new("battery_probe", e.to_string()))
            })
        } => result.map(|((), (), status)| Some(status)),
    };
    if !matches!(result, Ok(Some(_))) {
        let _ = child.kill().await;
    }
    if !result?.is_some_and(|status| status.success()) {
        let mut message = format!("Command failed: {}", probe.file);
        for arg in probe.prefix.iter().map(String::as_str).chain(QUERY) {
            message.push(' ');
            message.push_str(arg);
        }
        message.push('\n');
        message.push_str(&String::from_utf8_lossy(&stderr));
        return Err(Fault::new("battery_probe", message));
    }
    Reply::json(&has_battery(&String::from_utf8_lossy(&stdout)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_positive_decimal_prefix_like_parse_int() {
        for (report, expected) in [
            ("1\r\n", true),
            ("\u{feff} +0002 batteries", true),
            ("99999999999999999999999999999999999999", true),
            ("", false),
            ("0x1", false),
            ("0.2", false),
            ("-2", false),
            ("+ 1", false),
            ("count: 1", false),
        ] {
            assert_eq!(has_battery(report), expected, "{report:?}");
        }
    }
}
