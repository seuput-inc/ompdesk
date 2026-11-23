//! The running rule for an MCP server's own package. npm and Bun replace the whole package dir (new directory inode;
//! a later `require` reads the new version's file, files only the old version had are gone), Homebrew removes the old
//! keg, and pipx, `uv tool` and pip rewrite site-packages in place: a script (shebang, an interpreter loading its
//! modules lazily) that runs while that happens can load a file of the other version or find it missing, so its
//! update waits. Only the boolean result of the bounded macOS process scan leaves core.

use serde::Deserialize;

use super::mcp::command_name;
use crate::fs::order::{is_js_space, js_trim};

/// An update by `method` of a file of this kind must wait while the server runs: the owners whose update replaces
/// files a running script loads lazily.
pub fn defers(method: Option<&str>, script: bool) -> bool {
    script
        && matches!(
            method,
            Some("npm" | "bun" | "brew" | "brew-cask" | "pipx" | "uv" | "pip")
        )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliPolicy {
    method: String,
    lazy_loads: bool,
}

pub fn cli_defers(policy: CliPolicy) -> bool {
    match policy.method.as_str() {
        "npm" | "bun" => true,
        "brew" | "brew-cask" => policy.lazy_loads,
        _ => false,
    }
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Cli,
    Mcp,
}

#[derive(Deserialize)]
pub struct Params {
    kind: Kind,
    command: String,
    binary: Binary,
    // Deterministic parity inputs. Production never transports command lines.
    commands: Option<String>,
}

/// What main found of the command's binary (`McpBinary`): where it is and who owns it.
#[derive(Deserialize)]
struct Binary {
    path: String,
    real: String,
    owner: Option<Owner>,
}

#[derive(Deserialize)]
struct Owner {
    method: String,
    name: Option<String>,
    root: Option<String>,
    venv: Option<String>,
    dir: Option<String>,
}

/// `needle` appears in `text` as a whole path: not the tail of a longer one, not the head of a longer name.
fn mentions(text: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(found) = text[from..].find(needle) {
        let at = from + found;
        let before = text[..at].chars().next_back();
        let after = text[at + needle.len()..].chars().next();
        if before.is_none_or(|c| is_js_space(c) || matches!(c, '=' | '"' | '\'' | ':'))
            && after.is_none_or(|c| is_js_space(c) || matches!(c, '/' | '"' | '\''))
        {
            return true;
        }
        from = at + text[at..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

fn matches_process(commands: &str, params: &Params) -> bool {
    let Params {
        kind,
        command,
        binary,
        ..
    } = params;
    let cli = matches!(kind, Kind::Cli);
    let name = (!cli).then(|| command_name(command));
    // The directory, or the keg, an update of this owner replaces.
    let (dir, fragment) = match &binary.owner {
        Some(owner) => match owner.method.as_str() {
            "npm" | "bun" => (owner.root.as_deref(), None),
            "pipx" => (owner.venv.as_deref(), None),
            "uv" => (owner.dir.as_deref(), None),
            "brew" => (
                None,
                owner.name.as_ref().map(|name| format!("/Cellar/{name}/")),
            ),
            "brew-cask" => (
                None,
                owner.name.as_ref().map(|name| format!("/Caskroom/{name}/")),
            ),
            _ => (None, None),
        },
        None => (None, None),
    };
    let paths = [Some(binary.real.as_str()), Some(binary.path.as_str()), dir];
    commands.split('\n').any(|line| {
        let text = js_trim(line);
        let Some(first) = text
            .split(is_js_space)
            .next()
            .filter(|first| !first.is_empty())
        else {
            return false;
        };
        first == command
            || if cli {
                first.rsplit('/').next() == Some(command.as_str())
                    || paths.iter().flatten().any(|p| text.contains(*p))
            } else {
                Some(command_name(first)) == name
                    || paths
                        .iter()
                        .flatten()
                        .any(|p| !p.is_empty() && mentions(text, p))
            }
            || fragment
                .as_ref()
                .is_some_and(|fragment| text.contains(fragment.as_str()))
    })
}

#[cfg(any(target_os = "macos", test))]
async fn read_output(
    reader: impl tokio::io::AsyncRead + Unpin,
    status: impl Future<Output = std::io::Result<std::process::ExitStatus>>,
    limit: u64,
    deadline: std::time::Duration,
) -> Option<Vec<u8>> {
    use tokio::io::AsyncReadExt;

    tokio::time::timeout(deadline, async {
        let mut bytes = Vec::new();
        reader.take(limit + 1).read_to_end(&mut bytes).await.ok()?;
        if bytes.len() as u64 > limit || !status.await.ok()?.success() {
            return None;
        }
        Some(bytes)
    })
    .await
    .ok()
    .flatten()
}

pub async fn update_running(params: Params) -> bool {
    if let Some(commands) = &params.commands {
        return matches_process(commands, &params);
    }
    #[cfg(target_os = "macos")]
    {
        use std::{process::Stdio, time::Duration};
        use tokio::process::Command;

        let Ok(mut child) = Command::new("/bin/ps")
            .args(["-axww", "-o", "command="])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
        else {
            return false;
        };
        let stdout = child.stdout.take().expect("ps stdout was piped");
        read_output(
            stdout,
            child.wait(),
            16 * 1024 * 1024,
            Duration::from_secs(10),
        )
        .await
        .is_some_and(|bytes| matches_process(&String::from_utf8_lossy(&bytes), &params))
    }
    #[cfg(not(target_os = "macos"))]
    false
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::captured;
    use super::*;

    #[test]
    fn defers_as_the_typescript_did() {
        for row in captured("defers") {
            assert_eq!(
                defers(row[0].as_str(), row[1].as_bool().unwrap()),
                row[2].as_bool().unwrap(),
                "{row}"
            );
        }
    }

    #[test]
    fn finds_a_running_server_as_the_typescript_did() {
        for row in captured("running") {
            let params: Params = serde_json::from_value(
                json!({ "kind": "mcp", "command": row[1], "binary": row[2] }),
            )
            .unwrap();
            assert_eq!(
                matches_process(row[0].as_str().unwrap(), &params),
                row[3].as_bool().unwrap(),
                "{row}"
            );
        }
    }

    #[tokio::test]
    async fn only_complete_successful_output_can_match() {
        use std::{future::ready, process::ExitStatus, time::Duration};
        use tokio::io::{AsyncWriteExt, duplex};

        let ok = || ready(Ok(ExitStatus::default()));
        let bound = Duration::from_secs(1);
        assert_eq!(
            read_output(&b"tool"[..], ok(), 4, bound).await.as_deref(),
            Some(&b"tool"[..])
        );
        assert!(read_output(&b"tool+"[..], ok(), 4, bound).await.is_none());
        assert!(
            read_output(
                &b"tool"[..],
                ready(Err(std::io::Error::other("failed"))),
                4,
                bound
            )
            .await
            .is_none()
        );
        let (mut writer, reader) = duplex(16);
        writer.write_all(b"tool").await.unwrap();
        assert!(
            read_output(reader, ok(), 4, Duration::from_millis(1))
                .await
                .is_none()
        );
    }
}
