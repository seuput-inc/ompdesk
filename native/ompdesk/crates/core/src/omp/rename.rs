//! Stock persists the header, title entry and index. A closed session is renamed by one stock RPC frame.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::cli::{self, Launch};
use crate::fs::order::js_trim;
use crate::json::whole_surrogates;
use crate::server::{Call, Fault, Reply};

const ID: &str = "gui-rename";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    #[serde(flatten)]
    launch: Launch,
    session_path: String,
    name: String,
}

#[derive(Serialize)]
struct Frame<'a> {
    id: &'static str,
    r#type: &'static str,
    name: &'a str,
}

fn failure(message: impl Into<String>) -> Fault {
    Fault::new("session_rename_failed", message)
}

fn response(stdout: &[u8]) -> Option<Result<(), Fault>> {
    let text = String::from_utf8_lossy(stdout);
    for line in text.split('\n').filter(|line| line.contains(ID)) {
        let Ok(frame) = serde_json::from_str::<Value>(&whole_surrogates(line)) else {
            continue;
        };
        if frame.get("type").and_then(Value::as_str) == Some("response")
            && frame.get("id").and_then(Value::as_str) == Some(ID)
        {
            if frame.get("success").and_then(Value::as_bool) == Some(true) {
                return Some(Ok(()));
            }
            let error = frame
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Session rename failed");
            return Some(Err(failure(error)));
        }
    }
    None
}

/// The first actual selector in stock's diagnostic, as `shared/model-restore.ts` reads it for live sessions.
fn restore_failed(stderr: &str) -> bool {
    for (i, prefix) in stderr.match_indices("Could not restore model ") {
        let selector = stderr[i + prefix.len()..]
            .split(|c: char| !c.is_ascii_alphanumeric() && !"_.:@/+-".contains(c))
            .next()
            .unwrap_or("");
        if !selector.is_empty() {
            return !selector.trim_end_matches(['.', ':']).is_empty();
        }
    }
    false
}

pub(super) async fn run(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let name = js_trim(&params.name);
    if name.is_empty() {
        return Err(failure("Session name cannot be empty"));
    }
    if !params.session_path.ends_with(".jsonl") {
        return Err(failure("Invalid session path"));
    }
    // Stock runs in the temp directory. Check and pass the same file even for a relative path.
    let absolute;
    let path = if Path::new(&params.session_path).is_absolute() {
        params.session_path.as_str()
    } else {
        absolute = std::path::absolute(&params.session_path)
            .map_err(|_| failure("Session file not found"))?;
        absolute
            .to_str()
            .ok_or_else(|| failure("Invalid session path"))?
    };
    let mut input = serde_json::to_string(&Frame {
        id: ID,
        r#type: "set_session_name",
        name,
    })
    .map_err(|e| failure(e.to_string()))?;
    input.push('\n');
    let mut default_model = false;
    loop {
        // Starting stock with a missing path creates a session. Check again before the retry.
        tokio::fs::metadata(path)
            .await
            .map_err(|_| failure("Session file not found"))?;
        let output = cli::rename(
            &params.launch,
            path,
            &input,
            default_model,
            call.scope.clone(),
        )
        .await?;
        if let Some(answer) = response(&output.stdout) {
            answer?;
            return Reply::json(&());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !default_model && restore_failed(&stderr) {
            default_model = true;
            continue;
        }
        let detail = js_trim(&stderr).split('\n').next().unwrap_or("");
        return Err(failure(if detail.is_empty() {
            "omp could not open the session to rename it".to_owned()
        } else {
            format!("omp could not open the session to rename it: {detail}")
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_selector_matches_the_shared_model_restore_rule() {
        for (text, retries) in [
            (
                "Could not restore model ${id}\nerror: Could not restore model a/b:beta.",
                true,
            ),
            ("Could not restore model -+@_0", true),
            (
                "Could not restore model ...:\nCould not restore model a/b",
                false,
            ),
            ("Could not restore model ${id}", false),
            ("Could not restore model 模型", false),
            ("Could not restore model  a/b", false),
            ("session is locked", false),
        ] {
            assert_eq!(restore_failed(text), retries, "{text}");
        }
    }
}
