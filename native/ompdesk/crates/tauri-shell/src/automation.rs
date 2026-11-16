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

pub fn install(
    builder: tauri::Builder<tauri::Wry>,
    user_data: &Path,
) -> Result<tauri::Builder<tauri::Wry>, String> {
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
    use super::port;
    use std::path::Path;

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
