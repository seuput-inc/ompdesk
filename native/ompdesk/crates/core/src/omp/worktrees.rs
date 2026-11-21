//! Stock decides which agent worktrees are orphaned. The only mutating invocation is `worktree clear --json`.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::io::AsyncReadExt;

use crate::fs::error::uv_code;
use crate::fs::order::js_trim;
use crate::run::{KILL_GRACE, terminate};
use crate::server::{Call, Fault, Reply, Scope};
use crate::sidecar::omp_command;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    List,
    Clear,
}

impl Action {
    fn name(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Clear => "clear",
        }
    }

    fn timeout(self) -> Duration {
        Duration::from_secs(match self {
            Self::List => 60,
            Self::Clear => 300,
        })
    }
}

#[derive(Deserialize)]
struct Params {
    action: Action,
    bin: String,
    env: BTreeMap<String, String>,
    cwd: String,
}

pub(super) async fn run(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let timeout = params.action.timeout();
    execute(params, call.scope, timeout).await
}

async fn execute(params: Params, scope: Scope, timeout: Duration) -> Result<Reply, Fault> {
    let Params {
        action,
        bin,
        env,
        cwd,
    } = params;
    if scope.cancelled() {
        return Err(Fault::cancelled());
    }
    let args = ["worktree", action.name(), "--json"];
    #[cfg(windows)]
    let shell = std::path::Path::new(&bin)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
    #[cfg(not(windows))]
    let shell = false;
    let mut cmd = if shell {
        let quoted = args.map(|arg| format!("\"{arg}\""));
        omp_command(&format!("\"{bin}\""), &quoted, true, &cwd, &env)
    } else {
        omp_command(&bin, &args, false, &cwd, &env)
    };
    cmd.env("NO_COLOR", "1").env("FORCE_COLOR", "0");
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| Fault::new("spawn_failed", format!("spawn {bin} {}", uv_code(&e))))?;
    drop(child.stdin.take());
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut out = Vec::new();
    let mut err = Vec::new();
    // Node waited for close, not just exit: a child of stock can still hold an output pipe.
    let finished = async {
        tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
        child.wait().await
    };
    let fault = tokio::select! {
        status = finished => match status {
            Ok(status) => return report(action, status.code().unwrap_or(1), &out, &err),
            Err(e) => Fault::new("io_error", e.to_string()),
        },
        () = scope.on_cancel() => Fault::cancelled(),
        () = tokio::time::sleep(timeout) => Fault::new("omp_timeout", format!("omp worktree timed out after {}ms", timeout.as_millis())),
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
        // A shim may ignore TERM or leave a descendant holding a pipe. Neither delays the timeout reply.
        tokio::spawn(cleanup);
    } else {
        cleanup.await;
    }
    Err(fault)
}

fn report(action: Action, code: i32, stdout: &[u8], stderr: &[u8]) -> Result<Reply, Fault> {
    if code == 0
        && let Ok(data) = serde_json::from_str(&String::from_utf8_lossy(stdout))
        && let Some(result) = project(action, data)
    {
        return Reply::json(&result);
    }
    let bytes = if stderr.is_empty() { stdout } else { stderr };
    let text = String::from_utf8_lossy(bytes);
    let detail = js_trim(&text);
    let message = if detail.is_empty() {
        format!("omp worktree {} exited with code {code}", action.name())
    } else {
        let start = detail.rmatch_indices('\n').nth(5).map_or(0, |(i, _)| i + 1);
        detail[start..].replace("\r\n", "\n")
    };
    Err(Fault::new("worktree_cli_failed", message))
}

fn project(action: Action, mut data: Value) -> Option<Value> {
    match action {
        Action::List => {
            data.as_array_mut()?.retain_mut(|row| {
                let Some(fields) = row.as_object_mut() else {
                    return false;
                };
                if !fields.get("path").is_some_and(Value::is_string)
                    || !matches!(
                        fields.get("kind").and_then(Value::as_str),
                        Some("pr-checkout" | "task-isolation" | "empty" | "stray")
                    )
                {
                    return false;
                }
                fields.retain(|key, value| match key.as_str() {
                    "path" | "kind" => true,
                    "parentRepo" | "branch" | "orphanReason" => nonempty(value),
                    _ => false,
                });
                true
            });
            Some(Value::Object(Map::from_iter([("entries".into(), data)])))
        }
        Action::Clear => {
            let fields = data.as_object_mut()?;
            if !fields.get("removed").is_some_and(Value::is_number) {
                return None;
            }
            fields.retain(|key, _| matches!(key.as_str(), "removed" | "failed" | "results"));
            if !fields.get("failed").is_some_and(Value::is_number) {
                fields.insert("failed".into(), 0.into());
            }
            if let Some(rows) = fields.get_mut("results").and_then(Value::as_array_mut) {
                rows.retain_mut(|row| {
                    let Some(fields) = row.as_object_mut() else {
                        return false;
                    };
                    if !fields.get("path").is_some_and(Value::is_string)
                        || !fields.get("ok").is_some_and(Value::is_boolean)
                    {
                        return false;
                    }
                    fields.retain(|key, value| match key.as_str() {
                        "path" | "ok" => true,
                        "error" => nonempty(value),
                        _ => false,
                    });
                    true
                });
            } else {
                fields.insert("results".into(), Value::Array(Vec::new()));
            }
            Some(data)
        }
    }
}

fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reports_only_stock_fields_and_well_formed_rows() {
        let listed = project(
            Action::List,
            json!([null, {"kind":"new","path":"x"},
            {"path":"","kind":"pr-checkout","parentRepo":"repo","branch":"","orphanReason":4,"id":2} ]),
        );
        assert_eq!(
            listed,
            Some(json!({"entries":[{"kind":"pr-checkout","path":"","parentRepo":"repo"}]}))
        );
        let cleared = project(
            Action::Clear,
            json!({"removed":1.5,"failed":false,"results":[
            {"path":"x","ok":false,"error":"why","other":4}, {"ok":true}, {"path":"","ok":true,"error":""}]}),
        );
        assert_eq!(
            cleared,
            Some(json!({"removed":1.5,"failed":0,"results":[
            {"path":"x","ok":false,"error":"why"},{"path":"","ok":true}]}))
        );
        assert_eq!(
            project(Action::Clear, json!({"removed":0,"kept":5})),
            Some(json!({"removed":0,"failed":0,"results":[]}))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn deadline_does_not_wait_for_a_descendant_that_keeps_the_pipes_open() {
        let mut nonce = [0; 8];
        crate::sys::random(&mut nonce).unwrap();
        let dir = std::env::temp_dir().join(format!("ompdesk-worktrees-{}", crate::hex(&nonce)));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(
            dir.join("worktree"),
            "(while test -d \"$PWD\"; do /bin/sleep 0.1; done) &\necho ready > started\nexit 0\n",
        )
        .unwrap();
        let params = Params {
            action: Action::List,
            bin: "/bin/sh".into(),
            env: BTreeMap::new(),
            cwd: dir.to_string_lossy().into_owned(),
        };
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            execute(params, Scope::detached(), Duration::from_millis(500)),
        )
        .await;
        let started = dir.join("started").exists();
        std::fs::remove_dir_all(dir).unwrap();
        assert!(started);
        let fault = result.expect("reaping delayed timeout").err().unwrap();
        assert_eq!(
            fault,
            Fault::new("omp_timeout", "omp worktree timed out after 500ms")
        );
    }

    #[test]
    fn failure_uses_last_six_lines_of_the_first_nonempty_stream_before_trimming() {
        for (action, code, out, err, message) in [
            (
                Action::List,
                1,
                "[]",
                "   ",
                "omp worktree list exited with code 1",
            ),
            (Action::List, 1, "[]", "", "[]"),
            (Action::List, 0, "{}", "", "{}"),
            (
                Action::Clear,
                0,
                "{\"removed\":false}",
                "warning",
                "warning",
            ),
            (
                Action::Clear,
                0,
                "bad",
                "0\r\n1\r\n2\n\n4\n5\n6\n",
                "1\n2\n\n4\n5\n6",
            ),
        ] {
            let fault = report(action, code, out.as_bytes(), err.as_bytes())
                .err()
                .unwrap();
            assert_eq!(fault, Fault::new("worktree_cli_failed", message));
        }
    }
}
