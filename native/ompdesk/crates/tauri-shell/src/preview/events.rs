use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Update {
    Navigation {
        frame_id: String,
        url: String,
        main_frame: Option<bool>,
        same_document: bool,
    },
    Loading {
        frame_id: Option<String>,
        loading: bool,
    },
    Console {
        level: String,
        message: String,
        line: u64,
        source: String,
    },
    Crashed {
        reason: String,
    },
    WindowOpen {
        url: String,
        frame_name: String,
        user_gesture: bool,
    },
    Detached {
        session_id: String,
    },
}

pub fn decode(event: &shell_preview::Event) -> Option<Update> {
    let params = &event.params;
    let string = |value: &Value, key: &str| value.get(key)?.as_str().map(str::to_owned);
    match event.method.as_str() {
        "Page.frameNavigated" => {
            let frame = params.get("frame")?;
            Some(Update::Navigation {
                frame_id: string(frame, "id")?,
                url: string(frame, "url")?,
                main_frame: Some(frame.get("parentId").is_none()),
                same_document: false,
            })
        }
        "Page.navigatedWithinDocument" => Some(Update::Navigation {
            frame_id: string(params, "frameId")?,
            url: string(params, "url")?,
            main_frame: None,
            same_document: true,
        }),
        "Page.frameStartedLoading" | "Page.frameStoppedLoading" => Some(Update::Loading {
            frame_id: Some(string(params, "frameId")?),
            loading: event.method == "Page.frameStartedLoading",
        }),
        "Runtime.consoleAPICalled" => {
            let args = params.get("args")?.as_array()?;
            let message = args
                .iter()
                .map(console_argument)
                .collect::<Vec<_>>()
                .join(" ");
            let frame = params.pointer("/stackTrace/callFrames/0");
            Some(Update::Console {
                level: string(params, "type")?,
                message,
                line: frame
                    .and_then(|f| f.get("lineNumber"))
                    .and_then(Value::as_u64)
                    .map_or(0, |n| n.saturating_add(1)),
                source: frame
                    .and_then(|f| f.get("url"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            })
        }
        "Inspector.targetCrashed" => Some(Update::Crashed {
            reason: "crashed".into(),
        }),
        "Target.targetCrashed" => Some(Update::Crashed {
            reason: string(params, "status")?,
        }),
        "Page.windowOpen" => Some(Update::WindowOpen {
            url: string(params, "url")?,
            frame_name: string(params, "windowName")?,
            user_gesture: params.get("userGesture")?.as_bool()?,
        }),
        "Target.detachedFromTarget" => Some(Update::Detached {
            session_id: string(params, "sessionId")?,
        }),
        _ => None,
    }
}

fn console_argument(arg: &Value) -> String {
    if let Some(value) = arg.get("value") {
        return match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
    }
    arg.get("unserializableValue")
        .and_then(Value::as_str)
        .or_else(|| arg.get("description").and_then(Value::as_str))
        .or_else(|| arg.get("type").and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn event(method: &str, params: Value) -> shell_preview::Event {
        shell_preview::Event {
            method: method.into(),
            params: Arc::new(params),
            session_id: None,
        }
    }

    #[test]
    fn child_navigation_is_not_main_frame() {
        assert_eq!(
            decode(&event(
                "Page.frameNavigated",
                json!({"frame":{"id":"child","parentId":"root","url":"https://child/"}})
            )),
            Some(Update::Navigation {
                frame_id: "child".into(),
                url: "https://child/".into(),
                main_frame: Some(false),
                same_document: false
            })
        );
        assert_eq!(
            decode(&event(
                "Page.navigatedWithinDocument",
                json!({"frameId":"child","url":"https://child/#x"})
            )),
            Some(Update::Navigation {
                frame_id: "child".into(),
                url: "https://child/#x".into(),
                main_frame: None,
                same_document: true
            })
        );
    }

    #[test]
    fn canceled_resource_is_not_navigation_failure() {
        assert_eq!(
            decode(&event(
                "Network.loadingFailed",
                json!({"requestId":"resource","type":"Image","errorText":"net::ERR_ABORTED","canceled":true})
            )),
            None
        );
    }

    #[test]
    fn console_values_and_descriptions_are_formatted() {
        assert_eq!(
            decode(&event(
                "Runtime.consoleAPICalled",
                json!({
                    "type":"log", "args":[{"type":"string","value":"hello"},{"type":"number","value":42},{"type":"object","description":"Object"},{"type":"number","unserializableValue":"NaN"},{"type":"object","value":null}],
                    "stackTrace":{"callFrames":[{"url":"https://example/a.js","lineNumber":9}]}
                })
            )),
            Some(Update::Console {
                level: "log".into(),
                message: "hello 42 Object NaN null".into(),
                line: 10,
                source: "https://example/a.js".into()
            })
        );
    }
}
