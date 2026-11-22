//! The app's loopback streamable HTTP MCP server. Stdin belongs to main: EOF ends every session.

mod memory;
mod rea;
mod transport;

use std::convert::Infallible;
use std::env;
use std::ffi::OsString;
use std::io::{self, Write};
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use http_body_util::{BodyExt, Either, Full, LengthLimitError, Limited};
use hyper::body::{Body, Bytes, Frame, Incoming};
use hyper::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;

use transport::Sessions;

const SESSION_HEADER: &str = "mcp-session-id";
// Bun.serve's default limit for one request body.
const BODY_LIMIT: usize = 128 * 1024 * 1024;

struct Hub {
    expected: Vec<u8>,
    sessions: Sessions,
    memory_state: Option<PathBuf>,
}

type Answer = Response<Either<Full<Bytes>, EventStream>>;

struct EventStream(mpsc::UnboundedReceiver<Bytes>);

impl Body for EventStream {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.0
            .poll_recv(cx)
            .map(|next| next.map(|frame| Ok(Frame::data(frame))))
    }
}

fn empty(status: StatusCode) -> Answer {
    let mut res = Response::new(Either::Left(Full::default()));
    *res.status_mut() = status;
    res
}

fn json(status: StatusCode, value: &Value) -> Answer {
    let body = serde_json::to_vec(value).expect("JSON value into a Vec");
    let mut res = Response::new(Either::Left(Full::new(Bytes::from(body))));
    *res.status_mut() = status;
    res.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

fn parse_error() -> Answer {
    json(
        StatusCode::BAD_REQUEST,
        &json!({"jsonrpc":"2.0", "id":null, "error":{"code":-32700, "message":"Parse error"}}),
    )
}

fn parse_message(bytes: Bytes) -> serde_json::Result<Value> {
    // Request.text() decodes UTF-8 with replacement, consuming an optional BOM.
    let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes));
    serde_json::from_str(&text)
}

impl Hub {
    async fn handle(&self, request: Request<Incoming>) -> Answer {
        let (parts, body) = request.into_parts();
        let values = parts.headers.get_all(AUTHORIZATION);
        let mut auth = values.iter();
        let authorized = auth
            .next()
            .is_some_and(|given| given.as_bytes().ct_eq(&self.expected).into());
        if !authorized || auth.next().is_some() {
            return empty(StatusCode::UNAUTHORIZED);
        }
        let values = parts.headers.get_all(SESSION_HEADER);
        let mut ids = values.iter();
        let first = ids.next();
        let duplicate_id = ids.next().is_some();
        let id = first.filter(|id| !duplicate_id && !id.as_bytes().is_empty());
        match (parts.uri.path(), &parts.method) {
            ("/rea" | "/memory", &Method::POST) => {}
            ("/rea", &Method::DELETE) => {
                if let Some(id) = id {
                    self.sessions.remove(id);
                }
                return empty(StatusCode::OK);
            }
            ("/rea", &Method::GET) => {
                let Some((id, session)) =
                    id.and_then(|id| self.sessions.get(id).map(|client| (id, client)))
                else {
                    return empty(StatusCode::NOT_FOUND);
                };
                let Some(frames) = session.stream().await else {
                    return empty(StatusCode::NOT_FOUND);
                };
                let mut res = Response::new(Either::Right(EventStream(frames)));
                res.headers_mut().insert(SESSION_HEADER, id.clone());
                res.headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                res.headers_mut()
                    .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
                return res;
            }
            ("/rea" | "/memory", _) => return empty(StatusCode::METHOD_NOT_ALLOWED),
            _ => return empty(StatusCode::NOT_FOUND),
        }
        let bytes = match Limited::new(body, BODY_LIMIT).collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(error) if error.is::<LengthLimitError>() => {
                return empty(StatusCode::PAYLOAD_TOO_LARGE);
            }
            Err(_) => return parse_error(),
        };
        if parts.uri.path() == "/memory" {
            return memory::post(bytes, self.memory_state.as_deref())
                .await
                .map(Either::Left);
        }
        let Ok(message) = parse_message(bytes) else {
            return parse_error();
        };
        // Fetch joins repeated headers with a comma. Such an id cannot name or initialize a session.
        if duplicate_id {
            return empty(StatusCode::NOT_FOUND);
        }
        let (id, session) = if let Some(id) = id {
            let Some(session) = self.sessions.get(id) else {
                return empty(StatusCode::NOT_FOUND);
            };
            (id.clone(), session)
        } else {
            if message.get("method").and_then(Value::as_str) != Some("initialize") {
                return json(
                    StatusCode::BAD_REQUEST,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": message.get("id"),
                        "error": {"code": -32600, "message": "Initialize a session first"}
                    }),
                );
            }
            let cwd = parts.uri.query().and_then(|query| {
                url::form_urlencoded::parse(query.as_bytes())
                    .find(|(key, _)| key == "cwd")
                    .filter(|(_, value)| !value.is_empty())
                    .map(|(_, value)| PathBuf::from(value.into_owned()))
            });
            let Ok(opened) = self.sessions.open(cwd) else {
                return empty(StatusCode::INTERNAL_SERVER_ERROR);
            };
            opened
        };
        let mut res = match session.post(message).await {
            Ok(Some(reply)) => json(StatusCode::OK, &reply),
            Ok(None) => empty(StatusCode::ACCEPTED),
            Err(()) => return empty(StatusCode::NOT_FOUND),
        };
        res.headers_mut().insert(SESSION_HEADER, id);
        res
    }
}

#[cfg(unix)]
fn termination() -> io::Result<impl Future<Output = ()>> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    Ok(async move {
        tokio::select! { _ = term.recv() => (), _ = interrupt.recv() => () }
    })
}

#[cfg(windows)]
fn termination() -> io::Result<impl Future<Output = ()>> {
    use tokio::signal::windows::{ctrl_break, ctrl_c};
    let console = match ctrl_c() {
        Ok(interrupt) => Some((interrupt, ctrl_break()?)),
        // ERROR_INVALID_HANDLE: a hidden child without a console receives shutdown through stdin.
        Err(error) if error.raw_os_error() == Some(6) => None,
        Err(error) => return Err(error),
    };
    Ok(async move {
        match console {
            Some((mut interrupt, mut brk)) => {
                tokio::select! { _ = interrupt.recv() => (), _ = brk.recv() => () }
            }
            None => std::future::pending().await,
        }
    })
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Runs `ompdesk-core --mcp-hub` with REA's resolved executable and arguments.
/// The launcher consumes the stdout banner; everything else on stdout would be protocol noise.
pub async fn run(command: Vec<OsString>) -> io::Result<()> {
    let secret = env::var("OMP_GUI_MCP_HUB_SECRET")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "mcp-hub: OMP_GUI_MCP_HUB_SECRET is required",
            )
        })?;
    let port = env::var("OMP_GUI_MCP_HUB_PORT")
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .unwrap_or(0);
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
        Err(_) if port != 0 => TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?,
        result => result?,
    };
    let hub = Arc::new(Hub {
        expected: format!("Bearer {secret}").into_bytes(),
        sessions: Sessions::new(env_path("OMP_GUI_REA_CACHE"), command),
        memory_state: env_path("OMP_GUI_MEMORY"),
    });
    let terminated = termination()?;
    tokio::pin!(terminated);
    let (eof, mut parent_gone) = oneshot::channel();
    // Tokio's blocking stdin reader can hold runtime shutdown forever when a signal wins before EOF.
    std::thread::Builder::new()
        .name("mcp-hub-stdin".into())
        .spawn(move || {
            let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
            let _ = eof.send(());
        })?;
    {
        let mut out = io::stdout().lock();
        writeln!(out, "mcp-hub listening http://{}", listener.local_addr()?)?;
        out.flush()?;
    }
    let mut connections = JoinSet::new();
    let result = loop {
        tokio::select! {
            _ = &mut parent_gone => break Ok(()),
            _ = &mut terminated => break Ok(()),
            _ = connections.join_next(), if !connections.is_empty() => {},
            socket = listener.accept() => match socket {
                Ok((socket, _)) => {
                    let hub = Arc::clone(&hub);
                    connections.spawn(async move {
                        let service = service_fn(|request| async { Ok::<_, Infallible>(hub.handle(request).await) });
                        let _ = http1::Builder::new().serve_connection(TokioIo::new(socket), service).await;
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => break Err(error),
            }
        }
    };
    drop(listener);
    // No request may open a new session after shutdown takes its snapshot of all live and closing REAs.
    connections.shutdown().await;
    hub.sessions.stop().await;
    result
}
