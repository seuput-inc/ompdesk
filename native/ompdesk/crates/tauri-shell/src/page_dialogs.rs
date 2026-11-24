//! The page's file dialogs (`system:save-dialog`, `system:open-dialog`, `system:save-image`), over the calling page's
//! window, as main's handlers showed them. A caller without a window of the shell's (a paired page, an agent) gets
//! what main answered such a caller: nothing chosen.

use crate::ipc_router::Caller;
use crate::native_chrome::dialog::present;
use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde_json::{Value, json};
use shell_core::dialog_spec::FileDialogSpec;

#[cfg(windows)]
use shell_core::sys::dialogs as native;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::dialogs as native;

fn window(caller: &Caller) -> Option<u64> {
    match caller {
        Caller::Page(identity) => identity.win,
        Caller::Main { .. } => None,
    }
}

fn failed(message: String) -> Value {
    json!({"code":"failed","message":message})
}

/// Shows a dialog over `win` and waits for it on this (blocking-pool) thread.
fn shown(
    win: u64,
    method: &str,
    options: Value,
    show: impl FnOnce(isize, &Value) -> Result<Value, String> + Send + 'static,
) -> Result<Value, Value> {
    let (send, receive) = std::sync::mpsc::channel();
    present(Some(win), method.into(), options, show, move |result| {
        let _ = send.send(result);
    });
    receive
        .recv()
        .map_err(|_| failed("the dialog could not be shown".into()))?
        .map_err(failed)
}

#[cfg(any(windows, target_os = "macos"))]
fn save(win: u64, options: Value) -> Result<Option<String>, Value> {
    let path = shown(win, "dialog.saveDialog", options, |owner, options| {
        Ok(
            native::save_dialog(owner, &FileDialogSpec::from_json(options))?
                .map_or(Value::Null, Value::String),
        )
    })?;
    Ok(path
        .as_str()
        .filter(|path| !path.is_empty())
        .map(str::to_owned))
}

#[cfg(any(windows, target_os = "macos"))]
fn open(win: u64, options: Value) -> Result<Value, Value> {
    shown(win, "dialog.openDialog", options, |owner, options| {
        Ok(
            native::open_dialog(owner, &FileDialogSpec::from_json(options))?
                .map_or(Value::Null, |paths| json!(paths)),
        )
    })
}

#[cfg(not(any(windows, target_os = "macos")))]
fn save(_: u64, _: Value) -> Result<Option<String>, Value> {
    Err(failed("file dialogs need macOS or Windows".into()))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open(_: u64, _: Value) -> Result<Value, Value> {
    Err(failed("file dialogs need macOS or Windows".into()))
}

/// `system:save-dialog (defaultPath?, filters?)`: the chosen path, or null.
pub(crate) fn save_dialog(caller: &Caller, args: &Value) -> Result<Value, Value> {
    let Some(win) = window(caller) else {
        return Ok(Value::Null);
    };
    let default_path = args
        .get(0)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!("session.html"));
    let filters = args
        .get(1)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!([{"name":"HTML","extensions":["html"]}]));
    Ok(save(
        win,
        json!({"defaultPath": default_path, "filters": filters}),
    )?
    .map_or(Value::Null, Value::String))
}

/// `system:open-dialog (filters?, {directory, title, buttonLabel}?)`: the chosen paths, or null.
pub(crate) fn open_dialog(caller: &Caller, args: &Value) -> Result<Value, Value> {
    let Some(win) = window(caller) else {
        return Ok(Value::Null);
    };
    let options = &args[1];
    let properties = if options["directory"].as_bool() == Some(true) {
        json!(["openDirectory", "createDirectory"])
    } else {
        json!(["openFile", "multiSelections"])
    };
    let filters = args
        .get(0)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!([]));
    // macOS shows the title as the sheet's header (`message`); the panel's own "New Folder" creates the folder.
    let dialog = json!({
        "properties": properties,
        "filters": filters,
        "title": options["title"],
        "buttonLabel": options["buttonLabel"],
        "message": options["title"],
    });
    open(win, dialog)
}

/// `system:save-image (defaultName, mimeType, base64)`: `{saved}`, with `error` when the file could not be written.
pub(crate) fn save_image(caller: &Caller, args: &Value) -> Result<Value, Value> {
    let Some(win) = window(caller) else {
        return Ok(json!({"saved": false}));
    };
    let invalid =
        |what: &str| json!({"code":"invalid","message":format!("save-image needs {what}")});
    let name = args[0].as_str().ok_or_else(|| invalid("a file name"))?;
    let mime = args[1].as_str().ok_or_else(|| invalid("a MIME type"))?;
    let data = args[2].as_str().ok_or_else(|| invalid("base64 data"))?;
    let extension = image_extension(mime);
    let default_path = match base_name(name) {
        "" => format!("image.{extension}"),
        base => base.to_owned(),
    };
    let options = json!({"defaultPath": default_path, "filters": [{"name":"Image","extensions":[extension]}]});
    let Some(path) = save(win, options)? else {
        return Ok(json!({"saved": false}));
    };
    Ok(match std::fs::write(&path, lenient_base64(data)) {
        Ok(()) => json!({"saved": true}),
        Err(error) => json!({"saved": false, "error": error.to_string()}),
    })
}

/// Main's rule: the subtype before any `+`/`;`, its first `jpeg` as `jpg`, letters and digits only; else `png`.
fn image_extension(mime: &str) -> String {
    let subtype = mime
        .split('/')
        .nth(1)
        .and_then(|s| s.split(['+', ';']).next());
    let ext: String = subtype
        .map(|s| s.replacen("jpeg", "jpg", 1))
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    if ext.is_empty() { "png".into() } else { ext }
}

/// Node's `path.basename` on this platform: the last segment, trailing separators ignored; Windows also takes `\` and
/// a leading drive (`C:`).
fn base_name(path: &str) -> &str {
    let separator = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let path = if cfg!(windows)
        && path.len() >= 2
        && path.as_bytes()[1] == b':'
        && path.as_bytes()[0].is_ascii_alphabetic()
    {
        &path[2..]
    } else {
        path
    };
    let trimmed = path.trim_end_matches(separator);
    trimmed.rsplit(separator).next().unwrap_or_default()
}

/// `Buffer.from(data, "base64")`: URL-safe letters read as standard ones, anything outside the alphabet skipped,
/// decoding stops at the first `=`, a lone trailing letter is dropped.
fn lenient_base64(data: &str) -> Vec<u8> {
    let mut letters: Vec<u8> = data
        .bytes()
        .take_while(|b| *b != b'=')
        .filter_map(|b| match b {
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(b),
            _ => None,
        })
        .collect();
    if letters.len() % 4 == 1 {
        letters.pop();
    }
    let engine = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::RequireNone),
    );
    engine.decode(letters).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::Identity;

    #[test]
    fn image_extension_follows_mains_rule() {
        for (mime, ext) in [
            ("image/png", "png"),
            ("image/jpeg", "jpg"),
            ("image/svg+xml", "svg"),
            ("image/webp; q=1", "webp"),
            ("image/x-icon", "xicon"),
            ("image/jpegjpeg", "jpgjpeg"),
            ("image", "png"),
            ("image/", "png"),
            ("", "png"),
        ] {
            assert_eq!(image_extension(mime), ext, "{mime}");
        }
    }

    #[test]
    fn base_name_matches_node_path_basename() {
        assert_eq!(base_name("shot.png"), "shot.png");
        assert_eq!(base_name("a/b/shot.png"), "shot.png");
        assert_eq!(base_name("a/b/"), "b");
        assert_eq!(base_name(""), "");
        assert_eq!(base_name("/"), "");
        assert_eq!(
            base_name(r"a\b.png"),
            if cfg!(windows) { "b.png" } else { r"a\b.png" }
        );
        assert_eq!(
            base_name("C:x.png"),
            if cfg!(windows) { "x.png" } else { "C:x.png" }
        );
    }

    #[test]
    fn base64_reads_what_buffer_from_reads() {
        assert_eq!(lenient_base64("aGVsbG8="), b"hello");
        assert_eq!(lenient_base64("aGVsbG8"), b"hello");
        assert_eq!(lenient_base64("aGVs\nbG8="), b"hello");
        assert_eq!(lenient_base64("aGVsbG8=junk"), b"hello");
        assert_eq!(lenient_base64("-_-_"), [0xfb, 0xff, 0xbf]);
        assert_eq!(lenient_base64("aGVsbG8hA"), b"hello!");
        assert_eq!(lenient_base64(""), b"");
    }

    #[test]
    fn a_caller_without_a_window_chooses_nothing() {
        let main = Caller::Main {
            key: "c1".into(),
            window: Some(-1),
            conn_id: Some("1".into()),
        };
        let page = Caller::Page(Identity {
            win: None,
            wc: 3,
            generation: 1,
        });
        for caller in [&main, &page] {
            assert_eq!(save_dialog(caller, &json!([])), Ok(Value::Null));
            assert_eq!(open_dialog(caller, &json!([])), Ok(Value::Null));
            assert_eq!(save_image(caller, &json!([])), Ok(json!({"saved": false})));
        }
    }
}
