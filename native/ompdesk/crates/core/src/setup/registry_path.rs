use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::runtime::{EXEC_FILE_MAX_BUFFER, read_pipe};
use crate::fs::order::{is_js_space, js_trim};
use crate::run::Runner;
use crate::server::{Call, Fault, Registry, Reply, Scope};

const MACHINE: &str = r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment";
const USER: &str = r"HKCU\Environment";

#[derive(Deserialize)]
struct Launch {
    cwd: String,
    env: BTreeMap<String, String>,
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("setup.registryPath", |call| Box::pin(registry_path(call)));
}

async fn registry_path(call: Call) -> Result<Reply, Fault> {
    let launch: Launch = call.params()?;
    let mut parts = Vec::new();
    #[cfg(windows)]
    let resolved = {
        let env = |key: &str| {
            launch
                .env
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v.as_str())
        };
        let Some(bin) = crate::windows_executable::find(
            Path::new(&launch.cwd),
            env("PATH").unwrap_or(""),
            env("NoDefaultCurrentDirectoryInExePath").is_none(),
            &["reg.exe", "reg.exe.com", "reg.exe.exe"],
        ) else {
            return Reply::json(&parts);
        };
        bin
    };
    #[cfg(windows)]
    let bin = resolved.as_path();
    #[cfg(not(windows))]
    let bin = Path::new("reg.exe");
    let (machine, user) = tokio::join!(
        query(bin, MACHINE, &launch, &call.scope),
        query(bin, USER, &launch, &call.scope)
    );
    for output in [machine.as_deref(), user.as_deref()].into_iter().flatten() {
        if let Some(value) = path_value(output) {
            if !parts.is_empty() {
                parts.push(Part::Text(";"));
            }
            path_parts(value, &mut parts);
        }
    }
    Reply::json(&parts)
}

async fn query(bin: &Path, key: &str, launch: &Launch, scope: &Scope) -> Option<String> {
    if scope.cancelled() {
        return None;
    }
    let mut cmd = Command::new(bin);
    cmd.args(["query", key, "/v", "Path"])
        .current_dir(&launch.cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Runner::apply_environment(&launch.env, &mut cmd);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let stderr = child.stderr.take()?;
    let read = async {
        tokio::try_join!(
            child.wait(),
            read_pipe(stdout, EXEC_FILE_MAX_BUFFER),
            read_pipe(stderr, EXEC_FILE_MAX_BUFFER)
        )
    };
    let result = tokio::select! {
        result = read => result.ok(),
        () = tokio::time::sleep(Duration::from_secs(10)) => None,
        () = scope.on_cancel() => None,
    };
    match result {
        Some((status, out, _)) if status.success() => Some(match String::from_utf8(out) {
            Ok(text) => text,
            Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
        }),
        Some(_) => None,
        None => {
            let _ = child.kill().await;
            None
        }
    }
}

fn path_value(output: &str) -> Option<&str> {
    output.lines().find_map(|line| {
        if !line.starts_with(is_js_space) {
            return None;
        }
        let (name, rest) = line
            .trim_start_matches(is_js_space)
            .split_once(is_js_space)?;
        let (kind, value) = rest
            .trim_start_matches(is_js_space)
            .split_once(is_js_space)?;
        let value = value.trim_start_matches(is_js_space);
        (name.eq_ignore_ascii_case("Path")
            && matches!(kind, "REG_SZ" | "REG_EXPAND_SZ")
            && !value.contains(['\r', '\u{2028}', '\u{2029}']))
        .then(|| js_trim(value))
    })
}

// Bind these names in main after both queries finish, not in the core's startup environment.
#[derive(Serialize)]
#[serde(untagged)]
enum Part<'a> {
    Text(&'a str),
    Variable { name: &'a str },
}

fn path_parts<'a>(value: &'a str, parts: &mut Vec<Part<'a>>) {
    let mut text = value;
    let mut scan = value;
    while let Some((_, name)) = scan.split_once('%') {
        let Some(end) = name.find(['%', ';']) else {
            break;
        };
        let tail = &name[end..];
        if let Some(rest) = tail.strip_prefix(';') {
            scan = rest;
            continue;
        }
        if end == 0 {
            scan = tail;
            continue;
        }
        let literal = &text[..text.len() - name.len() - 1];
        if !literal.is_empty() {
            parts.push(Part::Text(literal));
        }
        parts.push(Part::Variable { name: &name[..end] });
        text = &tail[1..];
        scan = text;
    }
    if !text.is_empty() {
        parts.push(Part::Text(text));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_values_captured_from_parse_reg_query_value() {
        for (output, value) in [
            (
                "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.bun\\bin;C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps;\r\n",
                Some(r"%USERPROFILE%\.bun\bin;C:\Users\a\AppData\Local\Microsoft\WindowsApps;"),
            ),
            (
                "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_SZ    C:\\Windows\\system32;C:\\Program Files\\Git\\cmd\r\n",
                Some(r"C:\Windows\system32;C:\Program Files\Git\cmd"),
            ),
            (
                "\r\n\tpaTH\tREG_EXPAND_SZ\t  %rOoT%\\a b;%empty%;%missing%  \r\n",
                Some("%rOoT%\\a b;%empty%;%missing%"),
            ),
            (
                "ERROR: The system was unable to find the specified registry key or value.",
                None,
            ),
            (" Path REG_SZ   ", Some("")),
            ("Path REG_SZ x", None),
            (" Path reg_sz x", None),
            (
                " Path REG_DWORD number\n path REG_SZ first\n PATH REG_SZ second",
                Some("first"),
            ),
            (" Path REG_SZ", None),
            (" Path REG_SZ X\rY", None),
            ("\u{feff}pAth\u{a0}REG_SZ\u{a0}A \u{feff}", Some("A")),
            (" Path REG_SZ one\u{2028}two", None),
        ] {
            assert_eq!(path_value(output), value);
        }
    }

    #[test]
    fn percent_references_captured_from_expand_windows_env() {
        for (value, expanded) in [
            ("%ROOT%/%inner%;%Empty%;%absent%", "%inner%;X/Y;;%absent%"),
            ("%with space%;%%A%%;%A%%ROOT%", "S;%α%;α%inner%;X"),
            ("%a;b%/x", "%a;b%/x"),
            ("end%;%unfinished", "end%;%unfinished"),
            ("", ""),
            (" %unknown% ", " %unknown% "),
        ] {
            let mut parts = Vec::new();
            path_parts(value, &mut parts);
            let mut actual = String::new();
            for part in parts {
                match part {
                    Part::Text(text) => actual.push_str(text),
                    Part::Variable { name } => match name.to_lowercase().as_str() {
                        "root" => actual.push_str("%inner%;X"),
                        "inner" => actual.push('Y'),
                        "empty" => (),
                        "a" => actual.push('α'),
                        "with space" => actual.push('S'),
                        _ => actual.push_str(&format!("%{name}%")),
                    },
                }
            }
            assert_eq!(actual, expanded);
        }
    }
}
