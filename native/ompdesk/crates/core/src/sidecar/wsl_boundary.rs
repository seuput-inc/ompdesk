//! Only values reconstructed here can leave the guest's stock/bridge connection.
use serde_json::{Value, json};

pub(super) fn token(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
    })
}

pub(super) fn command(v: &Value) -> Option<Value> {
    let ty = v["type"].as_str()?;
    Some(match ty {
        "get_state" => json!({"type":ty,"brief":v["brief"].as_bool().unwrap_or(false)}),
        "get_messages" | "abort" => json!({"type":ty}),
        "prompt" => {
            if !(v["images"].is_null() || v["images"].as_array().is_some_and(Vec::is_empty)) {
                return None;
            }
            let message = v["message"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 512 * 1024)?;
            let mut p = json!({"type":ty,"message":message});
            if !v["deliveryId"].is_null() {
                p["deliveryId"] = token(&v["deliveryId"])?.into();
            }
            p
        }
        _ => return None,
    })
}

pub(super) const HOST_TOOL: &str = "ompdesk_execution_host";

pub(super) fn host_tool(v: &Value) -> Option<Value> {
    let id = token(&v["id"])?;
    // The only grant on this connection reports its own execution host. No selector, path, or host action.
    let allowed = v["toolName"] == HOST_TOOL
        && v["arguments"]
            .as_object()
            .is_some_and(|args| args.is_empty());
    let text = if allowed {
        "WSL 2"
    } else {
        "This WSL session has no grant for that host tool."
    };
    Some(
        json!({"type":"host_tool_result","id":id,"isError":!allowed,"result":{"content":[{"type":"text","text":text}]}}),
    )
}

pub(super) fn message(v: &Value) -> Option<Value> {
    let role = v["role"]
        .as_str()
        .filter(|s| matches!(*s, "user" | "assistant"))?;
    let text = if let Some(text) = v["content"].as_str() {
        json!([{"type":"text","text":text}])
    } else {
        Value::Array(
            v["content"]
                .as_array()?
                .iter()
                .filter_map(|block| {
                    if block["type"] != "text" {
                        return None;
                    }
                    Some(json!({"type":"text","text":block["text"].as_str()?}))
                })
                .collect(),
        )
    };
    let mut m = json!({"role":role,"content":text});
    if let Some(time) = v["timestamp"].as_u64() {
        m["timestamp"] = time.into();
    }
    if let Some(id) = token(&v["entryId"]) {
        m["entryId"] = id.into();
    }
    Some(m)
}

pub(super) fn messages(v: &Value) -> Option<Value> {
    Some(Value::Array(
        v.as_array()?.iter().filter_map(message).collect(),
    ))
}

pub(super) fn event(v: &Value) -> Option<Value> {
    let ty = v["type"].as_str()?;
    Some(match ty {
        "agent_start" | "turn_start" => json!({"type":ty}),
        "message_start" | "message_end" => json!({"type":ty,"message":message(&v["message"])?}),
        "message_update" => {
            let m = message(&v["message"])?;
            let event = &v["assistantMessageEvent"];
            let kind = event["type"]
                .as_str()
                .filter(|s| matches!(*s, "text_start" | "text_delta" | "text_end"))?;
            let source = v["message"]["content"].as_array()?;
            let idx = usize::try_from(event["contentIndex"].as_u64()?).ok()?;
            let shown = |b: &Value| b["type"] == "text" && b["text"].is_string();
            if !shown(source.get(idx)?) {
                return None;
            }
            let idx = source[..idx].iter().filter(|b| shown(b)).count();
            let mut delta = json!({"type":kind,"contentIndex":idx,"partial":m});
            if let Some(s) = event["delta"].as_str() {
                delta["delta"] = s.into();
            }
            json!({"type":ty,"message":m,"assistantMessageEvent":delta})
        }
        "agent_end" => json!({"type":ty,"messages":messages(&v["messages"])?}),
        "session_settled" => json!({"type":ty}),
        "prompt_result" => {
            let mut frame = json!({"type":ty,"agentInvoked":v["agentInvoked"].as_bool()?});
            if let Some(s) = v["status"]
                .as_str()
                .filter(|s| matches!(*s, "completed" | "aborted" | "error"))
            {
                frame["status"] = s.into();
            }
            if let Some(b) = v["sessionSettled"].as_bool() {
                frame["sessionSettled"] = b.into();
            }
            frame
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_bound_host_fact_can_be_obtained() {
        let mut call =
            json!({"type":"host_tool_call","toolName":HOST_TOOL,"id":"id-1","arguments":{}});
        assert_eq!(host_tool(&call).unwrap()["isError"], false);
        call["arguments"] = json!({"path":"C:\\private"});
        assert_eq!(host_tool(&call).unwrap()["isError"], true);
        call["arguments"] = json!({});
        call["toolName"] = "ompdesk_session_send".into();
        assert_eq!(host_tool(&call).unwrap()["isError"], true);
        assert!(event(&call).is_none());
    }

    #[test]
    fn user_text_crosses_but_no_paths_images_commands_or_embedded_controls() {
        let v = json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"answer","path":"C:secret"},{"type":"image","path":"private"}],"cwd":"guest"},"tab":"other"});
        assert_eq!(
            event(&v),
            Some(
                json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}})
            )
        );
        assert!(event(&json!({"type":"desktop_slot_acquire"})).is_none());
        assert!(command(&json!({"type":"switch_session","sessionPath":"C:secret"})).is_none());
        assert!(
            command(&json!({"type":"prompt","message":"ok","images":[{"path":"C:secret"}]}))
                .is_none()
        );
        assert_eq!(
            command(&json!({"type":"prompt","message":"ok","images":[],"env":{"SECRET":"x"}})),
            Some(json!({"type":"prompt","message":"ok"}))
        );
    }
}
