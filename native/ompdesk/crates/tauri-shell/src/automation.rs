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

/// wry 0.57.1 (src/webview2/mod.rs, `additional_browser_args` default): the flags it passes when none are given, which
/// setting any replaces. The app's webviews set no proxy, and wry's `autoplay` defaults to true.
#[cfg(windows)]
const WRY_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

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

/// The browser arguments the app's webviews get when the test asked for a WebView2 DevTools port, else none.
#[cfg(windows)]
pub fn app_browser_args() -> Result<Option<String>, String> {
    let requested = std::env::var(DEBUG_PORT_ENV).ok();
    let Some(port) = debug_port(requested.as_deref())? else {
        return Ok(None);
    };
    static ANNOUNCED: std::sync::Once = std::sync::Once::new();
    ANNOUNCED.call_once(|| eprintln!("[tauri-shell] test WebView2 debugging port {port}"));
    Ok(Some(format!(
        "{WRY_DEFAULT_ARGS} --remote-debugging-port={port}"
    )))
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
    use super::{debug_port, port};
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
