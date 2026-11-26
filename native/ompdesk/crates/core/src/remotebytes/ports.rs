//! A paired host tab's dev server in this computer's Preview (Orca H105: paired server forwards). The tab's omp, and
//! the server its commands started, run on the host, so the server listens on the HOST's loopback. Both ends of the
//! byte tunnel are here, one per computer, and main carries the bytes over the link (`host.portTunnel.*`, it keeps
//! every link request):
//! - on the device, `portListen` stands in for the server on this computer's loopback (the host's port number when it
//!   is free here, so the page's own absolute `localhost:<port>` addresses still reach it) and hands main each
//!   connection the Preview makes (`remotebytes.port` `open`, then its bytes);
//! - on the host, `portDial` connects to the tab's server; main asks only for a port the tab's own processes listen on
//!   (`procs.ports` by its tag), never an address a device names.
//!
//! Guards on the device: loopback only, and a connection whose first request does not name this loopback port as its
//! Host (DNS rebinding: a web page in the person's browser naming its own domain) is answered 421 and never crosses.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};

use super::signin::host_name;
use crate::server::{Call, Events, Fault, PushCall, Reply, Scope};

/// One read's bytes at most; the link carries each as one event.
const CHUNK: usize = 64 * 1024;
/// A first request head longer than this is no browser's.
const MAX_HEAD: usize = 16 * 1024;
/// Connection ids the core gives accepted connections, above any main gives the dials.
static NEXT_ACCEPTED: AtomicU64 = AtomicU64::new(1 << 40);

enum Command {
    Send(Vec<u8>),
    Close,
}

static CONNECTIONS: LazyLock<Mutex<HashMap<u64, mpsc::UnboundedSender<Command>>>> =
    LazyLock::new(Mutex::default);
/// Each listener's stop, by main's id.
static LISTENERS: LazyLock<Mutex<HashMap<u64, watch::Sender<bool>>>> =
    LazyLock::new(Mutex::default);

fn connections() -> MutexGuard<'static, HashMap<u64, mpsc::UnboundedSender<Command>>> {
    CONNECTIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn listeners() -> MutexGuard<'static, HashMap<u64, watch::Sender<bool>>> {
    LISTENERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn unreachable_port() -> Fault {
    Fault::new("port_unavailable", "Nothing answered on that port")
}

#[derive(Deserialize)]
struct ListenParams {
    listener: u64,
    port: u16,
}

/// `remotebytes.portListen {listener, port}` → `{port}`: listens on this computer's loopback, on `port` when it is
/// free here, else on any free port.
pub async fn listen(call: Call) -> Result<Reply, Fault> {
    let params: ListenParams = call.params()?;
    let listener = match TcpListener::bind(("127.0.0.1", params.port)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| Fault::new("port_unavailable", error.to_string()))?,
    };
    let port = listener
        .local_addr()
        .map_err(|error| Fault::new("port_unavailable", error.to_string()))?
        .port();
    let (stop, stopped) = watch::channel(false);
    if let Some(previous) = listeners().insert(params.listener, stop) {
        let _ = previous.send(true);
    }
    tokio::spawn(accept(
        params.listener,
        port,
        listener,
        stopped,
        call.events.clone(),
    ));
    Reply::json(&json!({ "port": port }))
}

#[derive(Deserialize)]
struct ListenerParams {
    listener: u64,
}

/// `remotebytes.portUnlisten {listener}`: stops taking connections; open ones stay until main closes them.
pub fn unlisten(push: PushCall) {
    let Ok(params) = serde_json::from_str::<ListenerParams>(push.params.get()) else {
        return;
    };
    if let Some(stop) = listeners().remove(&params.listener) {
        let _ = stop.send(true);
    }
}

async fn accept(
    listener_id: u64,
    port: u16,
    listener: TcpListener,
    mut stopped: watch::Receiver<bool>,
    events: Events,
) {
    loop {
        let accepted = tokio::select! {
            biased;
            _ = stopped.changed() => return,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, _)) = accepted else {
            // Out of descriptors, say: wait instead of spinning on the same error.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            continue;
        };
        let events = events.clone();
        tokio::spawn(async move {
            let _ = stream.set_nodelay(true);
            if let Some((stream, head)) = guarded(stream, port).await {
                let conn = NEXT_ACCEPTED.fetch_add(1, Ordering::Relaxed);
                events.send(
                    "remotebytes.port",
                    &json!({"conn": conn, "listener": listener_id, "kind": "open"}),
                );
                start(conn, stream, head, events);
            }
        });
    }
}

/// Reads the connection's first request head and lets it through only when its Host is this loopback port; the bytes
/// read go first through the tunnel.
async fn guarded(mut stream: TcpStream, port: u16) -> Option<(TcpStream, Vec<u8>)> {
    let mut head = Vec::new();
    let mut buffer = [0u8; 4096];
    let end = loop {
        if let Some(end) = head.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
        if head.len() > MAX_HEAD {
            return None;
        }
        let read = stream.read(&mut buffer).await.ok()?;
        if read == 0 {
            return None;
        }
        head.extend_from_slice(&buffer[..read]);
    };
    if loopback_host(&head[..end], port) {
        return Some((stream, head));
    }
    let _ = stream
        .write_all(
            b"HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        )
        .await;
    None
}

/// Whether a request head's Host header names this computer's loopback on `port`.
fn loopback_host(head: &[u8], port: u16) -> bool {
    let text = String::from_utf8_lossy(head);
    let Some(host) = text.lines().skip(1).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("host")
            .then(|| value.trim().to_owned())
    }) else {
        return false;
    };
    let named = url::Url::parse(&format!("http://{host}"))
        .ok()
        .and_then(|url| url.port_or_known_default());
    matches!(host_name(&host).as_str(), "127.0.0.1" | "localhost") && named == Some(port)
}

#[derive(Deserialize)]
struct DialParams {
    conn: u64,
    port: u16,
}

/// `remotebytes.portDial {conn, port}`: connects to this computer's loopback `port` (IPv4, else IPv6, as a dev server
/// named `localhost` may listen on either); answers once connected, `port_unavailable` when nothing answered or the
/// call was cancelled first.
pub async fn dial(call: Call) -> Result<Reply, Fault> {
    let params: DialParams = call.params()?;
    let stream = connect(params.port, &call.scope)
        .await
        .ok_or_else(unreachable_port)?;
    start(params.conn, stream, Vec::new(), call.events.clone());
    Reply::json(&serde_json::Value::Null)
}

async fn connect(port: u16, scope: &Scope) -> Option<TcpStream> {
    let attempt = async {
        match TcpStream::connect(("127.0.0.1", port)).await {
            Ok(stream) => Some(stream),
            Err(_) => TcpStream::connect(("::1", port)).await.ok(),
        }
    };
    let stream = tokio::select! {
        biased;
        () = scope.on_cancel() => None,
        stream = attempt => stream,
    }?;
    let _ = stream.set_nodelay(true);
    Some(stream)
}

/// Holds `conn` and pumps its bytes both ways until main closes it (it hears nothing more) or the other end does
/// (main hears `close`). `first` goes to main before anything read later.
fn start(conn: u64, stream: TcpStream, first: Vec<u8>, events: Events) {
    let (commands, received) = mpsc::unbounded_channel();
    connections().insert(conn, commands);
    if !first.is_empty() {
        send_data(&events, conn, &first);
    }
    tokio::spawn(pump(conn, stream, received, events));
}

fn send_data(events: &Events, conn: u64, bytes: &[u8]) {
    events.send(
        "remotebytes.port",
        &json!({"conn": conn, "kind": "data", "data": STANDARD.encode(bytes)}),
    );
}

async fn pump(
    conn: u64,
    stream: TcpStream,
    mut commands: mpsc::UnboundedReceiver<Command>,
    events: Events,
) {
    let (mut reader, mut writer) = stream.into_split();
    let mut buffer = vec![0u8; CHUNK];
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(Command::Send(bytes)) => {
                    if writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Some(Command::Close) | None => {
                    let _ = writer.shutdown().await;
                    return;
                }
            },
            read = reader.read(&mut buffer) => match read {
                Ok(read) if read > 0 => send_data(&events, conn, &buffer[..read]),
                _ => break,
            },
        }
    }
    connections().remove(&conn);
    events.send("remotebytes.port", &json!({"conn": conn, "kind": "close"}));
}

#[derive(Deserialize)]
struct SendParams {
    conn: u64,
    data: String,
}

/// `remotebytes.portSend {conn, data}`: bytes (base64) from the other computer's end of the connection.
pub fn send(push: PushCall) {
    let Ok(params) = serde_json::from_str::<SendParams>(push.params.get()) else {
        return;
    };
    let Ok(bytes) = STANDARD.decode(params.data) else {
        return;
    };
    if let Some(conn) = connections().get(&params.conn) {
        let _ = conn.send(Command::Send(bytes));
    }
}

#[derive(Deserialize)]
struct CloseParams {
    conn: u64,
}

/// `remotebytes.portClose {conn}`: the other end closed; nothing more is sent about it.
pub fn close(push: PushCall) {
    let Ok(params) = serde_json::from_str::<CloseParams>(push.params.get()) else {
        return;
    };
    if let Some(conn) = connections().remove(&params.conn) {
        let _ = conn.send(Command::Close);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use serde_json::value::RawValue;

    fn raw(text: &str) -> Box<RawValue> {
        RawValue::from_string(text.to_owned()).unwrap()
    }

    fn call(params: &str, events: &Events) -> Call {
        Call {
            params: raw(params),
            bin: None,
            scope: Scope::detached(),
            events: events.clone(),
        }
    }

    async fn next_event(frames: &mut mpsc::UnboundedReceiver<crate::wire::Frame>) -> Value {
        let frame = frames.recv().await.unwrap();
        let line: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(line["event"], "remotebytes.port");
        line["data"].clone()
    }

    fn decoded(event: &Value) -> Vec<u8> {
        STANDARD.decode(event["data"].as_str().unwrap()).unwrap()
    }

    /// The device's stand-in passes a request naming its own loopback port with the request's bytes, the host's dial
    /// reaches the server, and each side's bytes come out of the other's end.
    #[tokio::test]
    async fn a_loopback_request_crosses_both_ends_and_back() {
        let server = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let server_port = server.local_addr().unwrap().port();
        let (events, _keep, mut frames) = Events::capture();

        let dialed = dial(call(
            &format!(r#"{{"conn":11,"port":{server_port}}}"#),
            &events,
        ))
        .await
        .unwrap();
        assert_eq!(dialed.result.get(), "null");
        let (mut served, _) = server.accept().await.unwrap();

        let listened = listen(call(r#"{"listener":5,"port":0}"#, &events))
            .await
            .unwrap();
        let port = serde_json::from_str::<Value>(listened.result.get()).unwrap()["port"]
            .as_u64()
            .unwrap() as u16;
        let mut browser = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!("GET / HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n");
        browser.write_all(request.as_bytes()).await.unwrap();

        let opened = next_event(&mut frames).await;
        assert_eq!(opened["kind"], "open");
        assert_eq!(opened["listener"], 5);
        let conn = opened["conn"].as_u64().unwrap();
        let head = next_event(&mut frames).await;
        assert_eq!(
            (head["conn"].as_u64(), head["kind"].as_str()),
            (Some(conn), Some("data"))
        );
        assert_eq!(decoded(&head), request.as_bytes());

        // Main carries the head to the host's dial; the server answers; main carries that back.
        send(PushCall {
            params: raw(&json!({"conn": 11, "data": STANDARD.encode(decoded(&head))}).to_string()),
            bin: None,
            events: events.clone(),
        });
        let mut got = vec![0u8; request.len()];
        served.read_exact(&mut got).await.unwrap();
        assert_eq!(got, request.as_bytes());
        served
            .write_all(b"HTTP/1.1 204 No Content\r\n\r\n")
            .await
            .unwrap();
        let answer = next_event(&mut frames).await;
        assert_eq!(answer["conn"], 11);
        send(PushCall {
            params: raw(&json!({"conn": conn, "data": answer["data"]}).to_string()),
            bin: None,
            events: events.clone(),
        });
        let mut reply = vec![0u8; 27];
        browser.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, b"HTTP/1.1 204 No Content\r\n\r\n");

        // The server ends: main hears it, and closes the browser's side.
        drop(served);
        let ended = next_event(&mut frames).await;
        assert_eq!(
            (ended["conn"].as_u64(), ended["kind"].as_str()),
            (Some(11), Some("close"))
        );
        close(PushCall {
            params: raw(&json!({"conn": conn}).to_string()),
            bin: None,
            events: events.clone(),
        });
        let mut rest = Vec::new();
        browser.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
        unlisten(PushCall {
            params: raw(r#"{"listener":5}"#),
            bin: None,
            events,
        });
    }

    /// A page of another site that rebinds its name to this loopback never reaches the host's server.
    #[tokio::test]
    async fn a_request_for_another_host_name_is_refused_421_and_never_crosses() {
        let (events, _keep, mut frames) = Events::capture();
        let listened = listen(call(r#"{"listener":6,"port":0}"#, &events))
            .await
            .unwrap();
        let port = serde_json::from_str::<Value>(listened.result.get()).unwrap()["port"]
            .as_u64()
            .unwrap() as u16;
        let mut browser = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!("GET / HTTP/1.1\r\nHost: evil.example:{port}\r\n\r\n");
        browser.write_all(request.as_bytes()).await.unwrap();
        let mut reply = Vec::new();
        browser.read_to_end(&mut reply).await.unwrap();
        assert!(String::from_utf8_lossy(&reply).starts_with("HTTP/1.1 421"));
        assert!(frames.try_recv().is_err());
        unlisten(PushCall {
            params: raw(r#"{"listener":6}"#),
            bin: None,
            events,
        });
    }

    #[test]
    fn only_this_loopback_port_is_a_host_that_passes() {
        let head = |host: &str| format!("GET / HTTP/1.1\r\nHost: {host}\r\nAccept: */*");
        assert!(loopback_host(head("127.0.0.1:3000").as_bytes(), 3000));
        assert!(loopback_host(head("LOCALHOST:3000").as_bytes(), 3000));
        assert!(!loopback_host(head("localhost:3001").as_bytes(), 3000));
        assert!(!loopback_host(head("app.localhost:3000").as_bytes(), 3000));
        assert!(!loopback_host(head("evil.example:3000").as_bytes(), 3000));
        assert!(!loopback_host(b"GET / HTTP/1.1\r\nAccept: */*", 3000));
    }
}
