//! Where main's worker connects to the hub: a Unix socket in a folder only this user may open (main makes the folder
//! 0700 and names the socket in it), or a Windows named pipe with an unguessable name that refuses remote clients and
//! must be its first instance. Main names both, and the token every connection proves, in the core's environment.

use super::serve_conn;

/// Listens where `OMPDESK_HUB` names, if it does: from the core's start, so main's first call finds it. The listener
/// and every connection run on a thread and runtime of their own: main's thread waits on each hub call, so a hub
/// answer must never wait for the core's shared runtime, whose workers a burst of requests (or a stderr write main
/// does not drain while it waits) can hold for seconds. Packaged apps on macOS and Windows found the hub silent for
/// over 2 s at their first call under that load (runs 45351355265 and 45365781117).
pub fn listen_from_env() {
    let (Ok(address), Ok(token)) = (
        std::env::var("OMPDESK_HUB"),
        std::env::var("OMPDESK_HUB_TOKEN"),
    ) else {
        return;
    };
    let started = std::thread::Builder::new()
        .name("ompdesk-hub-io".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("ompdesk-core: the hub cannot start its connections' runtime: {error}");
                    return;
                }
            };
            if let Err(error) = runtime.block_on(accept(&address, token)) {
                eprintln!("ompdesk-core: the hub does not listen at {address}: {error}");
            }
        });
    if let Err(error) = started {
        eprintln!("ompdesk-core: the hub's connection thread did not start: {error}");
    }
}

#[cfg(unix)]
async fn accept(address: &str, token: String) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::remove_file(address);
    let listener = tokio::net::UnixListener::bind(address)?;
    std::fs::set_permissions(address, std::fs::Permissions::from_mode(0o600))?;
    loop {
        let (stream, _) = listener.accept().await?;
        let token = token.clone();
        tokio::spawn(async move {
            let (reader, writer) = stream.into_split();
            serve_conn(reader, writer, Some(token)).await;
        });
    }
}

#[cfg(windows)]
async fn accept(address: &str, token: String) -> std::io::Result<()> {
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
        let token = token.clone();
        tokio::spawn(async move {
            let (reader, writer) = tokio::io::split(connected);
            serve_conn(reader, writer, Some(token)).await;
        });
    }
}
