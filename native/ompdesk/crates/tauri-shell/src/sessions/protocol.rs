//! One Node custom-scheme relay. Consumers receive binary chunks, never a collected full response body.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::host;

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
    chunks: mpsc::UnboundedSender<Result<Vec<u8>, String>>,
    ended: Arc<AtomicBool>,
}

static STREAMS: LazyLock<Mutex<HashMap<u64, Sender>>> = LazyLock::new(Mutex::default);

pub struct Body {
    id: u64,
    chunks: mpsc::UnboundedReceiver<Result<Vec<u8>, String>>,
    ended: Arc<AtomicBool>,
}

impl Body {
    pub async fn next(&mut self) -> Option<Result<Vec<u8>, String>> {
        self.chunks.recv().await
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
    let (chunks, receiver) = mpsc::unbounded_channel();
    let ended = Arc::new(AtomicBool::new(false));
    let mut streams = STREAMS.lock().expect("protocol streams");
    if streams.contains_key(&id) {
        return Err("protocol streamId was reused while active".into());
    }
    streams.insert(
        id,
        Sender {
            chunks,
            ended: ended.clone(),
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
        },
    })
}

pub async fn open(request: Request) -> Result<Response, String> {
    if !super::handles_scheme(&request.partition, &request.scheme) {
        return Err(format!(
            "No handler for {} in {}",
            request.scheme, request.partition
        ));
    }
    let has_body = !request.body.is_empty() && request.method != "GET" && request.method != "HEAD";
    let params = json!({"scheme":request.scheme,"partition":super::canonical(&request.partition),
        "url":request.url,"method":request.method,"headers":request.headers,"hasBody":has_body});
    let (tx, rx) = oneshot::channel();
    host::request(
        "protocol.request",
        params,
        has_body.then_some(request.body.as_slice()),
        move |answer, _| {
            let response = answer.map_err(|e| e.message).and_then(head);
            // Register synchronously on the host reader before its next chunk frame is consumed.
            // If the consumer went away before the header, dropping the unsent Body cancels Node's stream.
            let _ = tx.send(response);
        },
    );
    tokio::time::timeout(Duration::from_secs(30), rx)
        .await
        .map_err(|_| "protocol response header timed out".to_string())?
        .map_err(|_| "protocol response ended before its header".to_string())?
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
            if let Some(error) = params["error"].as_str() {
                let _ = stream.chunks.send(Err(error.to_string()));
            }
        }
    } else if let (Some(stream), Some(bytes)) = (streams.get(&id), bytes) {
        let _ = stream.chunks.send(Ok(bytes));
    }
    true
}

pub fn disconnected() {
    for (_, stream) in STREAMS.lock().expect("protocol streams").drain() {
        stream.ended.store(true, Ordering::Release);
        let _ = stream
            .chunks
            .send(Err("Node protocol connection ended".into()));
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
        assert_eq!(response.body.next().await.unwrap().unwrap(), vec![0, 255]);
        assert_eq!(response.body.next().await.unwrap().unwrap(), vec![7]);
        assert_eq!(
            response.body.next().await.unwrap().unwrap_err(),
            "disk read failed"
        );
        assert!(response.body.next().await.is_none());
    }
}
