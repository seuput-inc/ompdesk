//! Stock decides which agent worktrees are orphaned. The only mutating invocation is `worktree clear --json`.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value};

use super::cli::{self, Launch, Output};
use crate::server::{Call, Fault, Reply, Scope};

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
    #[serde(flatten)]
    launch: Launch,
}

pub(super) async fn run(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let timeout = params.action.timeout();
    execute(params, call.scope, timeout).await
}

async fn execute(params: Params, scope: Scope, timeout: Duration) -> Result<Reply, Fault> {
    let action = params.action;
    let output = cli::run(
        &params.launch,
        ["worktree", action.name(), "--json"],
        scope,
        timeout,
    )
    .await?;
    report(action, &output)
}

fn report(action: Action, output: &Output) -> Result<Reply, Fault> {
    if output.code == 0
        && let Ok(data) = serde_json::from_str(&String::from_utf8_lossy(&output.stdout))
        && let Some(result) = project(action, data)
    {
        return Reply::json(&result);
    }
    Err(output.failure(
        "worktree_cli_failed",
        format_args!("worktree {}", action.name()),
    ))
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
            launch: Launch {
                bin: "/bin/sh".into(),
                env: Default::default(),
                cwd: dir.to_string_lossy().into_owned(),
            },
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
            let output = Output {
                code,
                stdout: out.as_bytes().to_vec(),
                stderr: err.as_bytes().to_vec(),
            };
            let fault = report(action, &output).err().unwrap();
            assert_eq!(fault, Fault::new("worktree_cli_failed", message));
        }
    }
}
