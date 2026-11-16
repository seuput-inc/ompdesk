use shell_core::wire::WireError;

const ORIGINAL: &str = "omp-media://stream/";
const WINDOWS: &str = "http://omp-media.localhost/stream/";

pub(crate) fn for_webview(original: &str) -> Result<String, WireError> {
    let token = original
        .strip_prefix(ORIGINAL)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| WireError::new("invalid", "native media result has an unexpected origin"))?;
    Ok(format!("{WINDOWS}{token}"))
}
pub(crate) fn original(mapped: &str) -> Result<String, WireError> {
    let token = mapped
        .strip_prefix(WINDOWS)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            WireError::new(
                "invalid",
                "native media URL is outside its registered Windows origin",
            )
        })?;
    Ok(format!("{ORIGINAL}{token}"))
}
pub(super) fn from_request(uri: &tauri::http::Uri) -> Result<String, WireError> {
    if uri.scheme_str() == Some("omp-media")
        && uri
            .authority()
            .is_some_and(|host| host.as_str() == "stream")
    {
        return Ok(uri.to_string());
    }
    if uri.scheme_str() == Some("http")
        && uri
            .authority()
            .is_some_and(|host| host.as_str() == "omp-media.localhost")
    {
        return original(&uri.to_string());
    }
    Err(WireError::new(
        "denied",
        "media request is outside the registered native origin",
    ))
}

#[cfg(windows)]
pub(crate) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    use tauri::Manager;
    builder.register_asynchronous_uri_scheme_protocol("omp-media", |context, request, responder| {
        let label = context.webview_label().to_owned();
        tauri::async_runtime::spawn(async move {
            let result = async {
                if !matches!(
                    *request.method(),
                    tauri::http::Method::GET | tauri::http::Method::HEAD
                ) {
                    return Err(WireError::new(
                        "invalid",
                        "native media accepts only GET or HEAD",
                    ));
                }
                let original = from_request(request.uri())?;
                let webview = crate::runtime()
                    .app
                    .get_webview(&label)
                    .ok_or_else(|| WireError::new("denied", "native media caller ended"))?;
                if !webview
                    .url()
                    .is_ok_and(|url| crate::trusted_url(url.as_str()))
                {
                    return Err(WireError::new(
                        "denied",
                        "native media caller is not an app page",
                    ));
                }
                let identity = crate::runtime()
                    .registry
                    .lock()
                    .expect("registry")
                    .by_label(&label)
                    .filter(|page| crate::trusted_url(&page.url))
                    .map(|page| page.identity)
                    .ok_or_else(|| {
                        WireError::new("denied", "native media caller is not registered")
                    })?;
                let destination = crate::runtime()
                    .gateway
                    .app_media_url("app", &original)
                    .await
                    .map_err(|error| WireError::new("denied", error))?;
                if !crate::runtime()
                    .registry
                    .lock()
                    .expect("registry")
                    .current(identity)
                    || !webview
                        .url()
                        .is_ok_and(|url| crate::trusted_url(url.as_str()))
                {
                    return Err(WireError::new("gone", "original native media caller ended"));
                }
                tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::FOUND)
                    .header(tauri::http::header::LOCATION, destination)
                    .header(tauri::http::header::CONTENT_LENGTH, "0")
                    .header(tauri::http::header::CACHE_CONTROL, "no-store")
                    .body(Vec::<u8>::new())
                    .map_err(crate::failed)
            }
            .await;
            responder.respond(result.unwrap_or_else(|error| {
                crate::log::log(
                    "media.native.denied",
                    serde_json::json!({"code":error.code}),
                );
                tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::FORBIDDEN)
                    .header(tauri::http::header::CACHE_CONTROL, "no-store")
                    .body(Vec::<u8>::new())
                    .expect("valid denied response")
            }));
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_player_and_release_preserve_the_original_capability() {
        let source = "omp-media://stream/actual_registered_token?range=original#t=4";
        let mapped = for_webview(source).unwrap();
        assert_eq!(original(&mapped).unwrap(), source);
        let request = from_request(
            &"http://omp-media.localhost/stream/actual_registered_token?range=original"
                .parse()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            request,
            "omp-media://stream/actual_registered_token?range=original"
        );
    }
    #[test]
    fn media_translation_does_not_accept_origin_lookalikes() {
        for uri in [
            "http://omp-media.localhost.attacker/stream/token",
            "http://omp-media.localhost:8080/stream/token",
            "omp-media://attacker/token",
            "file:///stream/token",
        ] {
            assert!(from_request(&uri.parse().unwrap()).is_err());
        }
    }
}
