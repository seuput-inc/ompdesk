use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Update {
    Navigation {
        frame_id: String,
        url: String,
        main_frame: Option<bool>,
        same_document: bool,
        /// The root document came back from the back/forward cache. Only fully loaded pages are cached and a restore
        /// fires no lifecycle `load`, so this event is the document's completion.
        restored: bool,
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

pub(super) fn target_title<'a>(event: &'a shell_preview::Event, target: &str) -> Option<&'a str> {
    if event.method != "Target.targetInfoChanged" || event.session_id.is_some() {
        return None;
    }
    let info = event.params.get("targetInfo")?;
    if info["targetId"].as_str()? != target || info["type"].as_str()? != "page" {
        return None;
    }
    info["title"].as_str()
}

pub fn decode(event: &shell_preview::Event) -> Option<Update> {
    let params = &event.params;
    let string = |value: &Value, key: &str| value.get(key)?.as_str().map(str::to_owned);
    match event.method.as_str() {
        "Page.frameNavigated" => {
            let frame = params.get("frame")?;
            let main_frame = frame.get("parentId").is_none();
            Some(Update::Navigation {
                frame_id: string(frame, "id")?,
                url: string(frame, "url")?,
                main_frame: Some(main_frame),
                same_document: false,
                restored: main_frame
                    && params.get("type").and_then(Value::as_str)
                        == Some("BackForwardCacheRestore"),
            })
        }
        "Page.navigatedWithinDocument" => Some(Update::Navigation {
            frame_id: string(params, "frameId")?,
            url: string(params, "url")?,
            main_frame: None,
            same_document: true,
            restored: false,
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
    fn only_the_actual_browser_page_target_can_update_its_title() {
        let mut changed = event(
            "Target.targetInfoChanged",
            json!({
                "targetInfo":{"targetId":"owned","type":"page","title":"w=459"}
            }),
        );
        assert_eq!(target_title(&changed, "owned"), Some("w=459"));
        assert_eq!(target_title(&changed, "other"), None);
        changed.params =
            Arc::new(json!({"targetInfo":{"targetId":"owned","type":"iframe","title":"child"}}));
        assert_eq!(target_title(&changed, "owned"), None);
        changed.params =
            Arc::new(json!({"targetInfo":{"targetId":"owned","type":"page","title":7}}));
        assert_eq!(target_title(&changed, "owned"), None);
        changed.params =
            Arc::new(json!({"targetInfo":{"targetId":"owned","type":"page","title":""}}));
        assert_eq!(target_title(&changed, "owned"), Some(""));
        changed.session_id = Some("debugger-or-child".into());
        assert_eq!(target_title(&changed, "owned"), None);
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
                same_document: false,
                restored: false
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
                same_document: true,
                restored: false
            })
        );
    }

    fn root_navigation(restored: bool) -> Option<Update> {
        Some(Update::Navigation {
            frame_id: "root".into(),
            url: "https://site/".into(),
            main_frame: Some(true),
            same_document: false,
            restored,
        })
    }

    #[test]
    fn only_a_root_back_forward_cache_restore_is_a_restored_document() {
        let root = json!({"id":"root","loaderId":"loader","url":"https://site/"});
        let child =
            json!({"id":"child","parentId":"root","loaderId":"loader","url":"https://child/"});
        let navigated = |frame: &Value, kind: Option<&str>| {
            let mut params = json!({"frame": frame});
            if let Some(kind) = kind {
                params["type"] = json!(kind);
            }
            decode(&event("Page.frameNavigated", params))
        };

        assert_eq!(
            navigated(&root, Some("BackForwardCacheRestore")),
            root_navigation(true)
        );
        assert_eq!(navigated(&root, Some("Navigation")), root_navigation(false));
        assert_eq!(navigated(&root, None), root_navigation(false));
        assert_eq!(navigated(&root, Some("Prerender")), root_navigation(false));

        let restored_child = navigated(&child, Some("BackForwardCacheRestore"));
        assert_eq!(restored_child, navigated(&child, Some("Navigation")));
        assert_eq!(
            restored_child,
            Some(Update::Navigation {
                frame_id: "child".into(),
                url: "https://child/".into(),
                main_frame: Some(false),
                same_document: false,
                restored: false
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
