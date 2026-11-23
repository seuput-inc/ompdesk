use std::ffi::OsStr;
use std::path::Path;

use serde_json::{Value, json};

pub(super) fn fact(
    resources: &Path,
    renderer_root: &Path,
    packaged: bool,
    windows: bool,
    headless: Option<&OsStr>,
) -> Value {
    let path = if packaged {
        resources.join("app-icon.png")
    } else {
        // A pinned Node bundle may live outside app_dir. Its renderer is beside its main.
        let mut root = renderer_root.to_path_buf();
        root.pop();
        root.pop();
        root.extend(["resources", "brand", "app-icon.png"]);
        root
    };
    let notifications = if headless == Some(OsStr::new("1")) {
        "off"
    } else if windows {
        "appIcon"
    } else {
        "systemIcon"
    };
    json!({ "path": path.to_string_lossy(), "notifications": notifications })
}
