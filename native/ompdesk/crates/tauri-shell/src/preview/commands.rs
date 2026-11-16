use serde_json::{Value, json};
use shell_core::wire::WireError;
use shell_preview::Page;

fn invalid(message: impl Into<String>) -> WireError {
    WireError::new("invalid", message)
}

fn unsupported(message: impl Into<String>) -> WireError {
    WireError::new("unsupported", message)
}

fn history_entry(history: &Value, offset: i64) -> Result<Option<i64>, WireError> {
    let index = history
        .get("currentIndex")
        .and_then(Value::as_i64)
        .ok_or_else(|| WireError::new("cdp", "Chromium returned no navigation history index"))?;
    let entries = history
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| WireError::new("cdp", "Chromium returned no navigation history entries"))?;
    let target = index
        .checked_add(offset)
        .and_then(|i| usize::try_from(i).ok());
    match target.and_then(|i| entries.get(i)) {
        None => Ok(None),
        Some(entry) => entry
            .get("id")
            .and_then(Value::as_i64)
            .map(Some)
            .ok_or_else(|| {
                WireError::new("cdp", "Chromium returned a navigation entry without an id")
            }),
    }
}

fn load_url(args: &Value) -> Result<&str, WireError> {
    for key in ["httpReferrer", "userAgent", "extraHeaders"] {
        if let Some(value) = args.get(key) {
            if !value.is_string() {
                return Err(invalid(format!("{key} must be a string")));
            }
            return Err(unsupported(format!("loadURL {key} is not supported")));
        }
    }
    args.get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("loadURL requires a URL"))
}

pub async fn operation(page: &Page, op: &str, args: &Value) -> Result<Value, WireError> {
    if !args.is_object() {
        return Err(invalid("Preview operation arguments must be an object"));
    }
    let result = match op {
        "loadURL" => {
            page.navigate(load_url(args)?)
                .await
                .map_err(|e| WireError::new(e.code, e.message))?;
            Value::Null
        }
        "goBack" | "goForward" => {
            let history = page
                .command("Page.getNavigationHistory", json!({}))
                .await
                .map_err(|e| WireError::new(e.code, e.message))?;
            if let Some(id) = history_entry(&history, if op == "goBack" { -1 } else { 1 })? {
                page.command("Page.navigateToHistoryEntry", json!({"entryId": id}))
                    .await
                    .map_err(|e| WireError::new(e.code, e.message))?;
            }
            Value::Null
        }
        "reload" | "reloadIgnoringCache" => {
            page.command(
                "Page.reload",
                json!({"ignoreCache": op == "reloadIgnoringCache"}),
            )
            .await
            .map_err(|e| WireError::new(e.code, e.message))?;
            Value::Null
        }
        "stop" => {
            page.command("Page.stopLoading", json!({}))
                .await
                .map_err(|e| WireError::new(e.code, e.message))?;
            Value::Null
        }
        "focus" => {
            page.command(
                "Emulation.setFocusEmulationEnabled",
                json!({"enabled":true}),
            )
            .await
            .map_err(|e| WireError::new(e.code, e.message))?;
            page.command("Page.bringToFront", json!({}))
                .await
                .map_err(|e| WireError::new(e.code, e.message))?;
            Value::Null
        }
        "undo" | "redo" | "cut" | "copy" | "paste" | "pasteAndMatchStyle" | "selectAll"
        | "delete" => {
            if !cfg!(target_os = "macos") {
                return Err(unsupported(
                    "Chromium editing commands are only available on macOS",
                ));
            }
            let command = match op {
                "undo" => "Undo",
                "redo" => "Redo",
                "cut" => "Cut",
                "copy" => "Copy",
                "paste" => "Paste",
                "pasteAndMatchStyle" => "PasteAndMatchStyle",
                "selectAll" => "SelectAll",
                _ => "Delete",
            };
            page.command(
                "Input.dispatchKeyEvent",
                json!({"type":"rawKeyDown", "key":"Unidentified", "commands":[command]}),
            )
            .await
            .map_err(|e| WireError::new(e.code, e.message))?;
            Value::Null
        }
        _ => {
            return Err(unsupported(format!(
                "Preview operation {op} is not supported"
            )));
        }
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_uses_adjacent_entry_ids_and_handles_edges() {
        let history = json!({"currentIndex": 1, "entries": [{"id": 41}, {"id": 7}, {"id": 90}]});
        assert_eq!(history_entry(&history, -1).unwrap(), Some(41));
        assert_eq!(history_entry(&history, 1).unwrap(), Some(90));
        assert_eq!(
            history_entry(&json!({"currentIndex":0,"entries":[{"id":41}]}), -1).unwrap(),
            None
        );
        assert_eq!(
            history_entry(&json!({"currentIndex":0,"entries":[{"id":41}]}), 1).unwrap(),
            None
        );
    }

    #[test]
    fn load_options_are_not_silently_ignored() {
        assert_eq!(
            load_url(&json!({"url":"https://example.com"})).unwrap(),
            "https://example.com"
        );
        assert_eq!(
            load_url(&json!({"url":"https://example.com","extraHeaders":"X-Test: a"}))
                .unwrap_err()
                .code,
            "unsupported"
        );
        assert_eq!(
            load_url(&json!({"url":"https://example.com","userAgent":42}))
                .unwrap_err()
                .code,
            "invalid"
        );
    }
}
