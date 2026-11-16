//! One Node custom-scheme relay. Consumers receive binary chunks, never a collected full response body.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::host;

#[path = "protocol_credit.rs"]
mod credit;

static DECLARED_SCHEMES: OnceLock<Vec<String>> = OnceLock::new();
static GATEWAY_INSTALLED: AtomicBool = AtomicBool::new(false);
static HOST_ENDED: AtomicBool = AtomicBool::new(false);
static HOST_END: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

pub fn declare_schemes(params: &Value) -> Result<(), String> {
    let mut schemes = Vec::new();
    if let Some(declared) = params["schemes"].as_array() {
        for declaration in declared {
            let name = declaration["scheme"]
                .as_str()
                .ok_or("custom scheme has no name")?
                .to_ascii_lowercase();
            let parsed = url::Url::parse(&format!("{name}://registration.invalid/"))
                .map_err(|_| "invalid custom scheme declaration")?;
            if parsed.scheme() != name
                || matches!(
                    name.as_str(),
                    "app"
                        | "http"
                        | "https"
                        | "file"
                        | "data"
                        | "javascript"
                        | "blob"
                        | "about"
                        | "ipc"
                )
            {
                return Err("custom scheme conflicts with an engine-owned scheme".into());
            }
            if schemes.contains(&name) {
                return Err("custom scheme was declared twice".into());
            }
            schemes.push(name);
        }
    }
    if let Some(existing) = DECLARED_SCHEMES.get() {
        return if existing == &schemes {
            Ok(())
        } else {
            Err("custom schemes are already frozen for app creation".into())
        };
    }
    DECLARED_SCHEMES
        .set(schemes)
        .map_err(|_| "custom schemes already initialized".into())
}

pub fn declared_schemes() -> Result<&'static [String], String> {
    DECLARED_SCHEMES
        .get()
        .map(Vec::as_slice)
        .ok_or_else(|| "app.init has not declared custom schemes".into())
}

/// Retained by the actual gateway only after its listener and route/mapper integration are installed.
pub struct GatewayConsumer {
    _private: (),
}

pub fn install_gateway_consumer() -> Result<GatewayConsumer, String> {
    GATEWAY_INSTALLED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "the protocol gateway consumer is already installed")?;
    Ok(GatewayConsumer { _private: () })
}

impl Drop for GatewayConsumer {
    fn drop(&mut self) {
        GATEWAY_INSTALLED.store(false, Ordering::Release);
    }
}

pub(super) fn can_handle(session: &super::policy::Session, scheme: &str) -> Result<bool, String> {
    if !declared_schemes()?
        .iter()
        .any(|name| name.eq_ignore_ascii_case(scheme))
    {
        return Ok(false);
    }
    let gateway = GATEWAY_INSTALLED.load(Ordering::Acquire);
    Ok(match &session.storage {
        super::policy::Storage::Memory => gateway,
        super::policy::Storage::App => gateway || session.native_stream,
        super::policy::Storage::Persistent(_) => session.native_stream,
    })
}

struct PendingRequest(u64);

impl Drop for PendingRequest {
    fn drop(&mut self) {
        if self.0 != 0 {
            host::cancel_request(self.0);
        }
    }
}

pub struct Request {
    pub partition: String,
    pub scheme: String,
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub struct Response {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: Body,
}

struct Sender {
    chunks: mpsc::Sender<Chunk>,
    credit: Arc<Mutex<credit::Credit>>,
    ended: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
}

static STREAMS: LazyLock<Mutex<HashMap<u64, Sender>>> = LazyLock::new(Mutex::default);

#[derive(Debug)]
pub struct Chunk {
    id: u64,
    bytes: Vec<u8>,
    credit: Arc<Mutex<credit::Credit>>,
    ended: Arc<AtomicBool>,
}

impl Chunk {
    pub fn as_slice(&self) -> &[u8] {
        &self.bytes
    }
    pub fn len(&self) -> usize {
        self.bytes.len()
    }
}

impl Drop for Chunk {
    fn drop(&mut self) {
        if self.ended.load(Ordering::Acquire) {
            return;
        }
        let bytes = self.bytes.len();
        self.credit
            .lock()
            .expect("protocol credit")
            .consumed(bytes, 1)
            .expect("each native chunk consumed once");
        host::event(
            "protocol.ack",
            json!({"streamId":self.id,"bytes":bytes,"chunks":1}),
        );
    }
}

pub struct Body {
    id: u64,
    chunks: mpsc::Receiver<Chunk>,
    ended: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
}

impl Body {
    pub async fn next(&mut self) -> Option<Result<Chunk, String>> {
        match self.chunks.recv().await {
            Some(chunk) => Some(Ok(chunk)),
            None => self.error.lock().expect("protocol error").take().map(Err),
        }
    }
}

impl Drop for Body {
    fn drop(&mut self) {
        let active = STREAMS.lock().expect("protocol streams").remove(&self.id);
        if active.is_some() && !self.ended.swap(true, Ordering::AcqRel) {
            host::event("protocol.cancel", json!({"streamId":self.id}));
        }
    }
}

fn head(value: Value) -> Result<Response, String> {
    let id = value["streamId"]
        .as_u64()
        .ok_or("protocol response has no streamId")?;
    let status = value["status"]
        .as_u64()
        .and_then(|v| u16::try_from(v).ok())
        .filter(|status| (100..=599).contains(status))
        .ok_or("invalid protocol response status")?;
    let status_text = value["statusText"].as_str().unwrap_or("").to_string();
    let headers = value["headers"]
        .as_array()
        .ok_or("invalid protocol response headers")?
        .iter()
        .map(|pair| {
            Ok((
                pair[0]
                    .as_str()
                    .ok_or("invalid protocol header name")?
                    .to_string(),
                pair[1]
                    .as_str()
                    .ok_or("invalid protocol header value")?
                    .to_string(),
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let (chunks, receiver) = mpsc::channel(credit::WINDOW_CHUNKS);
    let ended = Arc::new(AtomicBool::new(false));
    let credit = Arc::new(Mutex::new(credit::Credit::default()));
    let error = Arc::new(Mutex::new(None));
    let mut streams = STREAMS.lock().expect("protocol streams");
    if streams.contains_key(&id) {
        return Err("protocol streamId was reused while active".into());
    }
    streams.insert(
        id,
        Sender {
            chunks,
            ended: ended.clone(),
            credit,
            error: error.clone(),
        },
    );
    Ok(Response {
        status,
        status_text,
        headers,
        body: Body {
            id,
            chunks: receiver,
            ended,
            error,
        },
    })
}

pub async fn open(request: Request) -> Result<Response, String> {
    let host_end = HOST_END.notified();
    if HOST_ENDED.load(Ordering::Acquire) {
        return Err("Node protocol connection ended".into());
    }
    if !super::handles_scheme(&request.partition, &request.scheme) {
        return Err(format!(
            "No handler for {} in {}",
            request.scheme, request.partition
        ));
    }
    let has_body = !request.body.is_empty() && request.method != "GET" && request.method != "HEAD";
    let params = json!({"scheme":request.scheme,"partition":super::canonical(&request.partition),
        "url":request.url,"method":request.method,"headers":request.headers,"hasBody":has_body,
        "window":{"bytes":credit::WINDOW_BYTES,"chunks":credit::WINDOW_CHUNKS,"chunkBytes":credit::CHUNK_BYTES}});
    let (tx, rx) = oneshot::channel();
    let request_id = host::request(
        "protocol.request",
        params,
        has_body.then_some(request.body.as_slice()),
        move |answer, _| {
            let response = answer.map_err(|e| e.message).and_then(|value| {
                let stream_id = value["streamId"].as_u64();
                let response = head(value);
                if response.is_err() {
                    if let Some(stream_id) = stream_id {
                        if !STREAMS
                            .lock()
                            .expect("protocol streams")
                            .contains_key(&stream_id)
                        {
                            host::event("protocol.cancel", json!({"streamId":stream_id}));
                        }
                    }
                }
                response
            });
            // Register synchronously on the host reader before its next chunk frame is consumed.
            // If the consumer went away before the header, dropping the unsent Body cancels Node's stream.
            let _ = tx.send(response);
        },
    );
    let mut pending = PendingRequest(request_id);
    let response = tokio::select! {
        response = tokio::time::timeout(Duration::from_secs(30), rx) => {
            response.map_err(|_| "protocol response header timed out".to_string())?
                .map_err(|_| "protocol response ended before its header".to_string())??
        }
        _ = host_end => return Err("Node protocol connection ended".into()),
    };
    pending.0 = 0;
    Ok(response)
}

pub fn event(name: &str, params: &Value, bytes: Option<Vec<u8>>) -> bool {
    if !matches!(name, "protocol.chunk" | "protocol.end") {
        return false;
    }
    let Some(id) = params["streamId"].as_u64() else {
        return true;
    };
    let mut streams = STREAMS.lock().expect("protocol streams");
    if name == "protocol.end" {
        if let Some(stream) = streams.remove(&id) {
            stream.ended.store(true, Ordering::Release);
            *stream.error.lock().expect("protocol error") =
                params["error"].as_str().map(String::from);
        }
    } else if let (Some(stream), Some(bytes)) = (streams.get(&id), bytes) {
        let admitted = stream
            .credit
            .lock()
            .expect("protocol credit")
            .receive(bytes.len());
        let error = match admitted {
            Err(error) => Some(error),
            Ok(()) => {
                let chunk = Chunk {
                    id,
                    bytes,
                    credit: stream.credit.clone(),
                    ended: stream.ended.clone(),
                };
                if let Err(error) = stream.chunks.try_send(chunk) {
                    stream.ended.store(true, Ordering::Release);
                    drop(error);
                    Some("protocol consumer queue is unavailable")
                } else {
                    None
                }
            }
        };
        if let Some(error) = error {
            let stream = streams.remove(&id).expect("admitted protocol stream");
            stream.ended.store(true, Ordering::Release);
            *stream.error.lock().expect("protocol error") = Some(error.into());
            host::event("protocol.cancel", json!({"streamId":id}));
        }
    }
    true
}

pub fn disconnected() {
    HOST_ENDED.store(true, Ordering::Release);
    HOST_END.notify_waiters();
    for (_, stream) in STREAMS.lock().expect("protocol streams").drain() {
        stream.ended.store(true, Ordering::Release);
        *stream.error.lock().expect("protocol error") =
            Some("Node protocol connection ended".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stream_preserves_binary_chunks_headers_and_late_error() {
        let mut response = head(
            json!({"streamId":9001,"status":206,"statusText":"Partial Content",
            "headers":[["Content-Range","bytes 5-7/10"],["Content-Type","video/mp4"]]}),
        )
        .unwrap();
        assert_eq!(response.status, 206);
        assert_eq!(response.headers[0].1, "bytes 5-7/10");
        event(
            "protocol.chunk",
            &json!({"streamId":9001}),
            Some(vec![0, 255]),
        );
        event("protocol.chunk", &json!({"streamId":9001}), Some(vec![7]));
        event(
            "protocol.end",
            &json!({"streamId":9001,"error":"disk read failed"}),
            None,
        );
        assert_eq!(
            response.body.next().await.unwrap().unwrap().as_slice(),
            &[0, 255]
        );
        assert_eq!(
            response.body.next().await.unwrap().unwrap().as_slice(),
            &[7]
        );
        assert_eq!(
            response.body.next().await.unwrap().unwrap_err(),
            "disk read failed"
        );
        assert!(response.body.next().await.is_none());
    }
}
