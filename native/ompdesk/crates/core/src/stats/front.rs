use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::time::Duration;

use http_body_util::{BodyExt, Empty, Full, Limited, combinators::UnsyncBoxBody};
use hyper::body::{Body, Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use url::form_urlencoded;

use super::page::{Query, page};
use crate::server::Fault;

pub(super) type HttpError = (u16, &'static str);
type Out = UnsyncBoxBody<Bytes, hyper::Error>;

async fn send<B>(port: u16, request: Request<B>) -> Result<Response<Incoming>, HttpError>
where
    B: Body<Data = Bytes> + Send + Unpin + 'static,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let bad = (502, "Stats server is not answering");
    let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|_| bad)?;
    let (mut client, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| bad)?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client.send_request(request).await.map_err(|_| bad)
}

fn json_response(status: u16, value: &Value) -> Response<Out> {
    let mut response = Response::new(
        Full::new(Bytes::from(value.to_string()))
            .map_err(|never| match never {})
            .boxed_unsync(),
    );
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert(
        "content-type",
        hyper::header::HeaderValue::from_static("application/json"),
    );
    response
}

fn local_origin(headers: &hyper::HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some((name, p)) = host.rsplit_once(':') else {
        return false;
    };
    matches!(name, "localhost" | "127.0.0.1")
        && p.parse() == Ok(port)
        && headers.get("origin").is_none_or(|origin| {
            origin.to_str().ok().and_then(|s| s.strip_prefix("http://")) == Some(host)
        })
}

async fn route(
    port: u16,
    upstream: u16,
    db: mpsc::Sender<Query>,
    req: Request<Incoming>,
) -> Result<Response<Out>, Infallible> {
    let answer = if !local_origin(req.headers(), port) {
        Err((403, "Local dashboard requests only"))
    } else if req.uri().authority().is_some()
        || req.uri().scheme().is_some()
        || req.method() == Method::CONNECT
    {
        Err((400, "Invalid request target"))
    } else if req.method() == Method::GET && req.uri().path() == "/api/stats/requests" {
        page(req.uri().query().unwrap_or_default(), &db)
            .await
            .map(|value| json_response(200, &value))
    } else {
        send(upstream, req)
            .await
            .map(|res| res.map(BodyExt::boxed_unsync))
    };
    Ok(
        answer
            .unwrap_or_else(|(status, message)| json_response(status, &json!({"error": message}))),
    )
}

pub(super) async fn serve(
    listener: std::sync::Arc<TcpListener>,
    upstream: u16,
    db: mpsc::Sender<Query>,
) -> std::io::Result<()> {
    let port = listener.local_addr()?.port();
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let db = db.clone();
                connections.spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new().serve_connection(
                        TokioIo::new(stream), service_fn(move |req| route(port, upstream, db.clone(), req)),
                    ).await;
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

fn method(path: &str) -> Option<Method> {
    match path {
        "/api/sync" => Some(Method::POST),
        "/api/status"
        | "/api/stats/overview"
        | "/api/stats/model-dashboard"
        | "/api/stats/costs"
        | "/api/stats/frustration"
        | "/api/stats/tools"
        | "/api/stats/providers"
        | "/api/stats/provider-windows"
        | "/api/stats/requests"
        | "/api/stats/errors"
        | "/api/stats/models"
        | "/api/stats/folders"
        | "/api/stats/gain" => Some(Method::GET),
        _ if path
            .strip_prefix("/api/request/")
            .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())) =>
        {
            Some(Method::GET)
        }
        _ => None,
    }
}

#[derive(Deserialize)]
pub(super) struct Fetch {
    pub id: u64,
    path: String,
    #[serde(default)]
    params: std::collections::BTreeMap<String, String>,
}

pub(super) async fn fetch(port: u16, p: Fetch) -> Result<Box<serde_json::value::RawValue>, Fault> {
    let verb = method(&p.path).ok_or_else(|| {
        Fault::new(
            "invalid_stats_path",
            format!("Invalid stats path: {}", p.path),
        )
    })?;
    let mut path = p.path;
    if !p.params.is_empty() {
        path.push('?');
        let offset = path.len();
        path = form_urlencoded::Serializer::for_suffix(path, offset)
            .extend_pairs(p.params)
            .finish();
    }
    let request = Request::builder()
        .method(verb)
        .uri(path)
        .header("host", format!("127.0.0.1:{port}"))
        .body(Empty::<Bytes>::new())
        .map_err(|_| Fault::new("invalid_stats_path", "Invalid stats path"))?;
    tokio::time::timeout(Duration::from_secs(15), async {
        let res = send(port, request)
            .await
            .map_err(|(_, msg)| Fault::new("stats_api_error", msg))?;
        let status = res.status();
        if !status.is_success() {
            let reason = res
                .extensions()
                .get::<hyper::ext::ReasonPhrase>()
                .and_then(|reason| std::str::from_utf8(reason.as_bytes()).ok())
                .or_else(|| status.canonical_reason())
                .unwrap_or_default();
            return Err(Fault::new(
                "stats_api_error",
                format!("Stats API error: {} {reason}", status.as_u16()),
            ));
        }
        let body = Limited::new(res.into_body(), crate::http::BODY_MAX)
            .collect()
            .await
            .map_err(|_| Fault::new("stats_api_error", "Could not read stats response"))?
            .to_bytes();
        serde_json::from_slice(&body).map_err(|e| Fault::new("stats_api_error", e.to_string()))
    })
    .await
    .map_err(|_| Fault::new("stats_api_error", "Stats API request timed out"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_browser_cannot_rebind_the_listener_or_post_from_another_origin() {
        let mut request = Request::builder()
            .header("host", "127.0.0.1:1234")
            .body(())
            .unwrap();
        assert!(local_origin(request.headers(), 1234));
        request
            .headers_mut()
            .insert("origin", "http://example.invalid".parse().unwrap());
        assert!(!local_origin(request.headers(), 1234));
        request.headers_mut().remove("origin");
        request
            .headers_mut()
            .insert("host", "example.invalid:1234".parse().unwrap());
        assert!(!local_origin(request.headers(), 1234));
    }

    #[test]
    fn only_sync_posts_and_only_numeric_ids_are_dynamic() {
        assert_eq!(method("/api/sync"), Some(Method::POST));
        assert_eq!(method("/api/request/003"), Some(Method::GET));
        for path in [
            "/api/request/",
            "/api/request/-1",
            "/api/request/1?x",
            "//other/api/sync",
            "constructor",
            "__proto__",
        ] {
            assert!(method(path).is_none());
        }
    }
}
