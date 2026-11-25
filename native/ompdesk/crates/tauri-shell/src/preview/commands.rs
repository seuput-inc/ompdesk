use super::{frame_scope, target::Target};
use crate::preview_surface::SurfaceKey;
use serde_json::{Value, json};
use shell_core::wire::WireError;
use shell_preview::{Browser, CommandReply, Page};

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

/// Queues the page's navigation in order and returns its unawaited reply.
pub(super) fn submit_load(page: &Page, args: &Value) -> Result<CommandReply, WireError> {
    page.submit_navigation(load_url(args)?)
        .map_err(|e| WireError::new(e.code, e.message))
}

pub async fn operation(page: &Page, op: &str, args: &Value) -> Result<Value, WireError> {
    if !args.is_object() {
        return Err(invalid("Preview operation arguments must be an object"));
    }
    let result = match op {
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
        _ => {
            return Err(unsupported(format!(
                "Preview operation {op} is not supported"
            )));
        }
    };
    Ok(result)
}

const EDIT_COMMANDS: [(&str, &str); 8] = [
    ("undo", "Undo"),
    ("redo", "Redo"),
    ("cut", "Cut"),
    ("copy", "Copy"),
    ("paste", "Paste"),
    ("pasteAndMatchStyle", "PasteAndMatchStyle"),
    ("selectAll", "SelectAll"),
    ("delete", "Delete"),
];

fn edit_command(op: &str) -> Option<&'static str> {
    EDIT_COMMANDS
        .iter()
        .find(|(name, _)| *name == op)
        .map(|(_, command)| *command)
}

pub(super) fn is_edit(op: &str) -> bool {
    edit_command(op).is_some()
}

/// Runs an Electron edit role (`webContents.selectAll()`, …) as Chromium's own editing command on the frame that holds
/// the page's focus, the way a menu role acts on the focused frame: the command rides a key event to that frame's
/// widget, so Blink executes it in the focused frame, in a cross-process iframe too. A page without a focused frame
/// gets the command on its root frame, as Electron's menu roles do.
pub(super) async fn edit(
    browser: &Browser,
    session: &str,
    iframe_sessions: &[String],
    key: Option<SurfaceKey>,
    op: &str,
) -> Result<(), WireError> {
    let command = edit_command(op)
        .ok_or_else(|| unsupported(format!("Preview operation {op} is not supported")))?;
    let event = json!({"type":"rawKeyDown", "key":"Unidentified", "commands":[command]});
    let Some(key) = key else {
        Target::new(browser, session)
            .mutation("Input.dispatchKeyEvent", event)
            .await?;
        return Ok(());
    };
    match frame_scope::focused_target(browser, session, iframe_sessions, key).await {
        Ok(focus) => {
            Target::focused(browser, &focus, key)
                .mutation("Input.dispatchKeyEvent", event)
                .await?;
        }
        Err(error) if error.code == "focus-unavailable" => {
            Target::guarded(browser, session, key)
                .mutation("Input.dispatchKeyEvent", event)
                .await?;
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_roles_map_to_chromium_commands_and_nothing_else() {
        assert_eq!(edit_command("selectAll"), Some("SelectAll"));
        assert_eq!(
            edit_command("pasteAndMatchStyle"),
            Some("PasteAndMatchStyle")
        );
        assert_eq!(edit_command("delete"), Some("Delete"));
        assert!(!is_edit("reload"));
        assert!(!is_edit("SelectAll"));
    }

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
