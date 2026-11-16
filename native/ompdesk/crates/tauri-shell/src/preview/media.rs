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
/// Points a page's `fs:media-stream` answer at the origin WebView2 serves the scheme from. `ipc.invoke` answers
/// `{"value": <handler result>}`; a result other than `{ok: true, url}` passes unchanged.
#[cfg(any(windows, test))]
pub(crate) fn map_stream_answer(answer: &mut serde_json::Value) -> Result<(), WireError> {
    let Some(result) = answer
        .get_mut("value")
        .filter(|result| result["ok"] == true)
    else {
        return Ok(());
    };
    let original = result["url"]
        .as_str()
        .ok_or_else(|| WireError::new("invalid", "native media result has no URL"))?;
    result["url"] = serde_json::Value::String(for_webview(original)?);
    Ok(())
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
    // wry hands a WebView2 handler `http://omp-media.localhost/<path>` rewritten as `omp-media://localhost/<path>`.
    if uri.scheme_str() == Some("omp-media")
        && uri
            .authority()
            .is_some_and(|host| host.as_str() == "localhost")
        && let Some(token) = uri
            .path_and_query()
            .and_then(|path| path.as_str().strip_prefix("/stream/"))
            .filter(|token| !token.is_empty())
    {
        return Ok(format!("{ORIGINAL}{token}"));
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
                // Which check refused it, and the request's scheme and host (the path holds a capability token).
                crate::log::log(
                    "media.native.denied",
                    serde_json::json!({
                        "code": error.code,
                        "message": error.message,
                        "scheme": request.uri().scheme_str(),
                        "host": request.uri().authority().map(|authority| authority.as_str()),
                        "webview": label,
                    }),
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
    fn a_stream_answer_in_its_invoke_envelope_gets_the_windows_origin() {
        let mut answer = serde_json::json!({"value": {"ok": true, "url": "omp-media://stream/tok", "mime": "video/webm"}});
        map_stream_answer(&mut answer).unwrap();
        assert_eq!(
            answer,
            serde_json::json!({"value": {"ok": true, "url": "http://omp-media.localhost/stream/tok", "mime": "video/webm"}})
        );
        let mut refused =
            serde_json::json!({"value": {"ok": false, "error": "missing", "code": "not_found"}});
        let before = refused.clone();
        map_stream_answer(&mut refused).unwrap();
        assert_eq!(refused, before);
        let mut without_url = serde_json::json!({"value": {"ok": true}});
        assert_eq!(
            map_stream_answer(&mut without_url).unwrap_err().code,
            "invalid"
        );
    }
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
        let wry_form = from_request(
            &"omp-media://localhost/stream/actual_registered_token?range=original"
                .parse()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            wry_form,
            "omp-media://stream/actual_registered_token?range=original"
        );
    }
    #[test]
    fn media_translation_does_not_accept_origin_lookalikes() {
        for uri in [
            "http://omp-media.localhost.attacker/stream/token",
            "http://omp-media.localhost:8080/stream/token",
            "omp-media://attacker/token",
            "omp-media://localhost/other/token",
            "omp-media://localhost/stream/",
            "omp-media://localhost:8080/stream/token",
            "file://omp-media.localhost/stream/token",
        ] {
            assert!(from_request(&uri.parse().unwrap()).is_err());
        }
    }
}
