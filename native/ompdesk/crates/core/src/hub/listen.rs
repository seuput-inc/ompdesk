//! Where a private connection to the core listens: a Unix socket in a folder only this user may open (its owner makes
//! the folder 0700 and names the socket in it), or a Windows named pipe with an unguessable name that refuses remote
//! clients and must be its first instance. The owner names both, and the token every connection proves, in the core's
//! environment. The hub (`OMPDESK_HUB`) and the clients' listener (`OMPDESK_CLIENTS`, `crate::clients`) listen so.

use std::pin::Pin;

use tokio::io::{AsyncRead, AsyncWrite};

use super::serve_conn;

pub type Reader = Box<dyn AsyncRead + Unpin + Send>;
pub type Writer = Box<dyn AsyncWrite + Unpin + Send>;
/// Serves one accepted connection, given the token it must prove.
pub type Serve = fn(Reader, Writer, String) -> Pin<Box<dyn Future<Output = ()> + Send>>;

/// Listens where `OMPDESK_HUB` names, if it does: from the core's start, so main's first call finds it. The hub's
/// listener and connections run on a thread and runtime of their own: main's thread waits on each hub call, so a hub
/// answer must never wait for the core's shared runtime, whose workers a burst of requests (or a stderr write main
/// does not drain while it waits) can hold for seconds. Packaged apps on macOS and Windows found the hub silent for
/// over 2 s at their first call under that load (runs 45351355265 and 45365781117).
pub fn listen_from_env() {
    if std::env::var_os("OMPDESK_HUB").is_none() {
        return;
    }
    let started = std::thread::Builder::new()
        .name("ompdesk-hub-io".into())
        .spawn(|| {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!(
                        "ompdesk-core: the hub cannot start its connections' runtime: {error}"
                    );
                    return;
                }
            };
            runtime.block_on(async {
                from_env(
                    "OMPDESK_HUB",
                    "OMPDESK_HUB_TOKEN",
                    "the hub",
                    |reader, writer, token| Box::pin(serve_conn(reader, writer, Some(token))),
                );
                std::future::pending::<()>().await;
            });
        });
    if let Err(error) = started {
        eprintln!("ompdesk-core: the hub's connection thread did not start: {error}");
    }
}

/// Listens where `address_var` names, with the token `token_var` holds, if both are set; `serve` takes each connection.
pub fn from_env(address_var: &str, token_var: &str, what: &'static str, serve: Serve) {
    let (Ok(address), Ok(token)) = (std::env::var(address_var), std::env::var(token_var)) else {
        return;
    };
    tokio::spawn(async move {
        if let Err(error) = accept(&address, token, serve).await {
            eprintln!("ompdesk-core: {what} does not listen at {address}: {error}");
        }
    });
}

#[cfg(unix)]
async fn accept(address: &str, token: String, serve: Serve) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::remove_file(address);
    let listener = tokio::net::UnixListener::bind(address)?;
    std::fs::set_permissions(address, std::fs::Permissions::from_mode(0o600))?;
    loop {
        let (stream, _) = listener.accept().await?;
        let (reader, writer) = stream.into_split();
        tokio::spawn(serve(Box::new(reader), Box::new(writer), token.clone()));
    }
}

#[cfg(windows)]
async fn accept(address: &str, token: String, serve: Serve) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(address)?;
    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new()
            .reject_remote_clients(true)
            .create(address)?;
        let (reader, writer) = tokio::io::split(connected);
        tokio::spawn(serve(Box::new(reader), Box::new(writer), token.clone()));
    }
}
