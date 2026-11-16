use std::path::Path;

fn port(
    requested: Option<&str>,
    inspect: Option<&str>,
    test_profile: Option<&Path>,
    user_data: &Path,
) -> Result<Option<u16>, String> {
    let Some(requested) = requested else {
        return Ok(None);
    };
    if inspect != Some("1") {
        return Err("Native WebDriver requires the explicit Node test inspector".into());
    }
    let profile = test_profile
        .ok_or("Native WebDriver requires an explicit private test profile")?
        .canonicalize()
        .map_err(|_| "Native WebDriver test profile does not exist")?;
    if profile
        != user_data
            .canonicalize()
            .map_err(|_| "Native WebDriver user data does not exist")?
    {
        return Err("Native WebDriver test profile does not match this app's user data".into());
    }
    let port = requested
        .parse::<u16>()
        .ok()
        .filter(|port| *port >= 1024)
        .ok_or("Native WebDriver requires an explicit unprivileged TCP port")?;
    Ok(Some(port))
}

const DEBUG_PORT_ENV: &str = "OMP_GUI_TEST_WEBVIEW2_DEBUG_PORT";

fn debug_port(requested: Option<&str>) -> Result<Option<u16>, String> {
    let Some(requested) = requested else {
        return Ok(None);
    };
    if !cfg!(windows) {
        return Err("The WebView2 debugging port exists on Windows only".into());
    }
    requested
        .parse::<u16>()
        .ok()
        .filter(|port| *port >= 1024)
        .map(Some)
        .ok_or_else(|| format!("{DEBUG_PORT_ENV} requires an explicit unprivileged TCP port"))
}

/// The Chromium switches a spec starts the app with that its WebView2 must honour too: fake media devices, which
/// dictation needs on a runner with no microphone. The GPU switch reaches WebView2 as `app.init`'s
/// `disableHardwareAcceleration`.
const FORWARDED_SWITCHES: [&str; 2] = [
    "use-fake-device-for-media-stream",
    "use-fake-ui-for-media-stream",
];

static SWITCHES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn forwarded(init: &serde_json::Value) -> Vec<String> {
    init["switches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|pair| {
            let name = pair.get(0)?.as_str()?;
            (pair.get(1).is_none_or(serde_json::Value::is_null)
                && FORWARDED_SWITCHES.contains(&name))
            .then(|| format!("--{name}"))
        })
        .collect()
}

/// Keeps the forwarded switches of `app.init` for the windows created after it.
pub fn remember_switches(init: &serde_json::Value) {
    *SWITCHES.lock().expect("switches") = forwarded(init);
}

/// The browser arguments a test build adds to the app's webviews: the DevTools port Playwright attaches to, when the
/// test asked for one, and the forwarded switches.
#[cfg(windows)]
pub fn browser_args() -> Result<Vec<String>, String> {
    let requested = std::env::var(DEBUG_PORT_ENV).ok();
    let mut args = Vec::new();
    if let Some(port) = debug_port(requested.as_deref())? {
        static ANNOUNCED: std::sync::Once = std::sync::Once::new();
        ANNOUNCED.call_once(|| eprintln!("[tauri-shell] test WebView2 debugging port {port}"));
        args.push(format!("--remote-debugging-port={port}"));
    }
    args.extend(SWITCHES.lock().expect("switches").iter().cloned());
    Ok(args)
}

pub fn install(
    builder: tauri::Builder<tauri::Wry>,
    user_data: &Path,
) -> Result<tauri::Builder<tauri::Wry>, String> {
    debug_port(std::env::var(DEBUG_PORT_ENV).ok().as_deref())?;
    let requested = std::env::var("OMP_GUI_TEST_WEBDRIVER_PORT").ok();
    let inspect = std::env::var("OMP_GUI_TEST_NODE_INSPECT").ok();
    let profile = std::env::var_os("OMP_GUI_TEST_USER_DATA_DIR");
    match port(
        requested.as_deref(),
        inspect.as_deref(),
        profile.as_deref().map(Path::new),
        user_data,
    )? {
        Some(port) => Ok(builder.plugin(tauri_plugin_wdio_webdriver::init_with_port(port))),
        None => Ok(builder),
    }
}

#[cfg(test)]
mod tests {
    use super::{debug_port, forwarded, port};

    #[test]
    fn only_the_fake_media_switches_without_a_value_reach_webview2() {
        let init = serde_json::json!({"switches": [
            ["disable-gpu", null],
            ["use-fake-device-for-media-stream", null],
            ["use-fake-ui-for-media-stream", null],
            ["use-fake-ui-for-media-stream-x", null],
            ["remote-debugging-port", "1"],
            ["use-fake-device-for-media-stream", "path"],
        ]});
        assert_eq!(
            forwarded(&init),
            [
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream"
            ]
        );
        assert!(forwarded(&serde_json::json!({})).is_empty());
    }
    use std::path::Path;

    #[test]
    fn debugging_port_is_an_explicit_unprivileged_port_on_windows_only() {
        assert_eq!(debug_port(None).unwrap(), None);
        if cfg!(windows) {
            assert_eq!(debug_port(Some("9333")).unwrap(), Some(9333));
            for invalid in ["0", "80", "65536", "localhost:9333", ""] {
                assert!(debug_port(Some(invalid)).is_err());
            }
        } else {
            assert!(debug_port(Some("9333")).is_err());
        }
    }

    #[test]
    fn ordinary_launch_does_not_open_a_driver_even_without_a_profile() {
        assert_eq!(port(None, None, None, Path::new("missing")).unwrap(), None);
    }

    #[test]
    fn driver_requires_test_inspector_and_the_exact_existing_profile() {
        let profile = std::env::temp_dir().canonicalize().unwrap();
        assert!(port(Some("4445"), None, Some(&profile), &profile).is_err());
        assert!(port(Some("4445"), Some("1"), None, &profile).is_err());
        assert!(
            port(
                Some("4445"),
                Some("1"),
                Some(&profile),
                &profile.join("missing-native-test-profile")
            )
            .is_err()
        );
        assert_eq!(
            port(Some("4445"), Some("1"), Some(&profile), &profile).unwrap(),
            Some(4445)
        );
        for invalid in ["0", "80", "65536", "localhost:4445"] {
            assert!(port(Some(invalid), Some("1"), Some(&profile), &profile).is_err());
        }
    }
}
