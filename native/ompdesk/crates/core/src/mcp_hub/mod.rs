//! The app's authenticated loopback MCP server for memory.

mod host;
mod memory;

pub(crate) use host::{close_all, register};

use std::convert::Infallible;
use std::env;
use std::io::{self, Write};
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Arc;

use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::AUTHORIZATION;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinSet;

const BODY_LIMIT: usize = 128 * 1024 * 1024;
const LISTENING: &str = "mcp-hub listening http://127.0.0.1:";

struct Hub {
    expected: Vec<u8>,
    memory_state: Option<PathBuf>,
}

type Answer = Response<Full<Bytes>>;

fn empty(status: StatusCode) -> Answer {
    let mut res = Response::new(Full::default());
    *res.status_mut() = status;
    res
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
        if parts.uri.path() != "/memory" {
            return empty(StatusCode::NOT_FOUND);
        }
        if parts.method != Method::POST {
            return empty(StatusCode::METHOD_NOT_ALLOWED);
        }
        let bytes = match Limited::new(body, BODY_LIMIT).collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(error) if error.is::<LengthLimitError>() => {
                return empty(StatusCode::PAYLOAD_TOO_LARGE);
            }
            Err(_) => return memory::parse_error(),
        };
        memory::post(bytes, self.memory_state.as_deref()).await
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

/// The launcher consumes the stdout banner; everything else on stdout would be protocol noise.
pub async fn run() -> io::Result<()> {
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
    // Running omps cannot change their environment. Never substitute a different port for a published one.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
    let hub = Arc::new(Hub {
        expected: format!("Bearer {secret}").into_bytes(),
        memory_state: env::var_os("OMP_GUI_MEMORY")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from),
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
        writeln!(out, "{LISTENING}{}", listener.local_addr()?.port())?;
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
    connections.shutdown().await;
    result
}
