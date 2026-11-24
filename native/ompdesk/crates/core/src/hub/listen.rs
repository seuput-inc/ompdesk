//! Where a private connection to the core listens: a Unix socket in a folder only this user may open (its owner makes
//! the folder 0700 and names the socket in it), or a Windows named pipe with an unguessable name that refuses remote
//! clients and must be its first instance. The owner names both, and the token every connection proves, in the core's
//! environment. The hub (`OMPDESK_HUB`) and the clients' listener (`OMPDESK_CLIENTS`, `crate::clients`) listen so.
//!
//! The listener is bound before `from_env` returns, so it exists before the core announces `ready`.

use std::pin::Pin;

use tokio::io::{AsyncRead, AsyncWrite};

use super::serve_conn;

pub type Reader = Box<dyn AsyncRead + Unpin + Send>;
pub type Writer = Box<dyn AsyncWrite + Unpin + Send>;
/// Serves one accepted connection, given the token it must prove.
pub type Serve = fn(Reader, Writer, String) -> Pin<Box<dyn Future<Output = ()> + Send>>;

/// Listens where `OMPDESK_HUB` names, if it does: from the core's start, so main's first call finds it. The listener
/// and every connection run on a thread and runtime of their own (`dedicated`): main's thread waits on each hub call,
/// so a hub answer must never wait for the core's shared runtime, whose workers a burst of requests can hold for
/// seconds (packaged apps found the hub silent for over 2 s at their first call: runs 45351355265 and 45365781117).
pub fn listen_from_env() {
    from_env(
        "OMPDESK_HUB",
        "OMPDESK_HUB_TOKEN",
        "the hub",
        |reader, writer, token| Box::pin(serve_conn(reader, writer, Some(token))),
        true,
    );
}

/// Listens where `address_var` names, with the token `token_var` holds, if both are set; `serve` takes each connection.
/// The listener is bound when this returns. `dedicated`: on a thread and current-thread runtime of its own, else on the
/// runtime this is called in.
pub fn from_env(
    address_var: &str,
    token_var: &str,
    what: &'static str,
    serve: Serve,
    dedicated: bool,
) {
    let (Ok(address), Ok(token)) = (std::env::var(address_var), std::env::var(token_var)) else {
        return;
    };
    if !dedicated {
        match bind(&address) {
            Ok(listener) => {
                tokio::spawn(listen(listener, token, serve, what));
            }
            Err(error) => eprintln!("ompdesk-core: {what} does not listen at {address}: {error}"),
        }
        return;
    }
    let (bound, is_bound) = std::sync::mpsc::channel();
    let started = std::thread::Builder::new()
        .name(format!(
            "ompdesk-{}-io",
            address_var.trim_start_matches("OMPDESK_").to_lowercase()
        ))
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!(
                        "ompdesk-core: {what} cannot start its connections' runtime: {error}"
                    );
                    let _ = bound.send(());
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = bind(&address);
                let _ = bound.send(());
                match listener {
                    Ok(listener) => listen(listener, token, serve, what).await,
                    Err(error) => {
                        eprintln!("ompdesk-core: {what} does not listen at {address}: {error}")
                    }
                }
            });
        });
    match started {
        // Bound (or failed) before this returns, so the listener exists before the core says `ready`.
        Ok(_) => {
            let _ = is_bound.recv();
        }
        Err(error) => eprintln!("ompdesk-core: {what}'s connection thread did not start: {error}"),
    }
}

async fn listen(listener: Listener, token: String, serve: Serve, what: &'static str) {
    if let Err(error) = accept(listener, token, serve).await {
        eprintln!("ompdesk-core: {what} stopped listening: {error}");
    }
}

#[cfg(unix)]
type Listener = tokio::net::UnixListener;
#[cfg(windows)]
type Listener = (String, tokio::net::windows::named_pipe::NamedPipeServer);

#[cfg(unix)]
fn bind(address: &str) -> std::io::Result<Listener> {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::remove_file(address);
    let listener = tokio::net::UnixListener::bind(address)?;
    std::fs::set_permissions(address, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

#[cfg(unix)]
async fn accept(listener: Listener, token: String, serve: Serve) -> std::io::Result<()> {
    loop {
        let (stream, _) = listener.accept().await?;
        let (reader, writer) = stream.into_split();
        tokio::spawn(serve(Box::new(reader), Box::new(writer), token.clone()));
    }
}

#[cfg(windows)]
fn bind(address: &str) -> std::io::Result<Listener> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(address)?;
    Ok((address.to_owned(), server))
}

#[cfg(windows)]
async fn accept(
    (address, mut server): Listener,
    token: String,
    serve: Serve,
) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new()
            .reject_remote_clients(true)
            .create(&address)?;
        let (reader, writer) = tokio::io::split(connected);
        tokio::spawn(serve(Box::new(reader), Box::new(writer), token.clone()));
    }
}
