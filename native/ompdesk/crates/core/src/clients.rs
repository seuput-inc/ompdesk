//! More connections to the core's methods beside its stdio, for the process that owns the core and its other clients
//! (docs/rust-node-removal.md, "the shell owns the core"). The owner names a private socket or pipe and a token in the
//! core's environment (`OMPDESK_CLIENTS`, `OMPDESK_CLIENTS_TOKEN`), listened on as the hub's is (`hub/listen.rs`).
//!
//! A connection's first line is `{"token": …, "client": "main" | "shell"}`; one without the token, or naming another
//! client, is closed unanswered. Then it is served as stdio is (`server::serve_as`): `ready` first, its own requests and
//! the events of what they started. Its end cancels its requests in flight and nothing else: the core ends only with its
//! stdin. `client: "main"` is main's connection: the process-wide sinks report there.
//!
//! One main connection at a time: a new one is served only once the previous one's `serve_as` returned, which is after
//! every process its requests started has exited. A restarted main's repository lock starts empty, so this is what
//! keeps its first holder from running beside a git of the old main's last request (the design's §7).

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

use crate::hub::listen::{Reader, Writer, from_env};

/// Listens where `OMPDESK_CLIENTS` names, if it does: from the core's start.
pub fn listen_from_env() {
    from_env(
        "OMPDESK_CLIENTS",
        "OMPDESK_CLIENTS_TOKEN",
        "the clients' listener",
        |reader, writer, token| Box::pin(serve_client(reader, writer, token)),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Client {
    Main,
    Shell,
}

#[derive(Deserialize)]
struct Hello {
    token: String,
    client: Client,
}

async fn serve_client(reader: Reader, writer: Writer, token: String) {
    // The same reader goes on to `serve_as`, so what the client sent after its first line is not lost.
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    let read = reader.read_line(&mut line).await;
    let hello = serde_json::from_str::<Hello>(line.trim_end())
        .ok()
        .filter(|_| matches!(read, Ok(n) if n > 0));
    let Some(Hello {
        token: given,
        client,
    }) = hello
    else {
        eprintln!("ompdesk-core: a client connection closed without its hello");
        return;
    };
    if !crate::control::conn::token_matches(Some(given), &token) {
        eprintln!("ompdesk-core: a client connection closed without its token");
        return;
    }
    let main = matches!(client, Client::Main);
    static MAIN: Mutex<()> = Mutex::const_new(());
    let _main = if main { Some(MAIN.lock().await) } else { None };
    if let Err(error) = crate::server::serve_as(reader, writer, crate::registry(), main).await {
        eprintln!("ompdesk-core: a client connection ended: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tokio::io::{AsyncWriteExt, duplex};

    type Lines = tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>;

    /// A client that has sent `hello` and then `request` in one write (the request after the hello is still served).
    async fn open(
        hello: &str,
        request: &Value,
    ) -> (
        Lines,
        tokio::io::WriteHalf<tokio::io::DuplexStream>,
        tokio::task::JoinHandle<()>,
    ) {
        let (client, server) = duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server);
        let served = tokio::spawn(serve_client(
            Box::new(server_read),
            Box::new(server_write),
            "secret".into(),
        ));
        let (client_read, mut client_write) = tokio::io::split(client);
        client_write
            .write_all(format!("{hello}\n{request}\n").as_bytes())
            .await
            .unwrap();
        (BufReader::new(client_read).lines(), client_write, served)
    }

    async fn next(lines: &mut Lines) -> Option<Value> {
        lines
            .next_line()
            .await
            .unwrap()
            .map(|line| serde_json::from_str(&line).unwrap())
    }

    /// What the client reads until its request is answered or the core hangs up.
    async fn frames(hello: &str, request: &Value) -> Vec<Value> {
        let (mut lines, mut writer, served) = open(hello, request).await;
        let mut out: Vec<Value> = Vec::new();
        while let Some(frame) = next(&mut lines).await {
            let answered = frame.get("id").is_some();
            out.push(frame);
            if answered {
                break;
            }
        }
        writer.shutdown().await.unwrap();
        served.await.unwrap();
        out
    }

    #[tokio::test(start_paused = true)]
    async fn a_second_main_waits_until_the_first_ones_requests_have_ended() {
        let main = json!({"token": "secret", "client": "main"}).to_string();
        let held =
            json!({"id": 1, "method": "core.echo", "params": {"waitFor": "clients-main-gate"}});
        let (mut first, first_writer, first_served) = open(&main, &held).await;
        assert_eq!(next(&mut first).await.unwrap()["event"], "ready");
        let echo = json!({"id": 1, "method": "core.echo", "params": {"value": 2}});
        let (mut second, second_writer, second_served) = open(&main, &echo).await;
        // The paused clock moves only once every task waits: the second connection is not served meanwhile.
        let waited =
            tokio::time::timeout(std::time::Duration::from_secs(60), next(&mut second)).await;
        assert!(waited.is_err(), "a second main was served beside the first");
        // The first main goes: its held request is cancelled and has ended before the second is served.
        let mut first_writer = first_writer;
        first_writer.shutdown().await.unwrap();
        while next(&mut first).await.is_some() {}
        first_served.await.unwrap();
        assert_eq!(next(&mut second).await.unwrap()["event"], "ready");
        let answer = next(&mut second).await.unwrap();
        assert_eq!(
            (answer["id"].clone(), answer["ok"].clone()),
            (json!(1), json!(true))
        );
        let mut second_writer = second_writer;
        second_writer.shutdown().await.unwrap();
        second_served.await.unwrap();
    }

    #[tokio::test]
    async fn a_client_with_the_token_is_served_like_stdio() {
        let echo = json!({"id": 1, "method": "core.echo", "params": {"value": 5}});
        for client in ["main", "shell"] {
            let hello = json!({"token": "secret", "client": client}).to_string();
            let got = frames(&hello, &echo).await;
            assert_eq!(got[0]["event"], "ready", "{client}");
            assert_eq!(got[1]["id"], 1, "{client}");
            assert_eq!(got[1]["ok"], true, "{client}");
        }
    }

    #[tokio::test]
    async fn a_client_without_the_token_or_a_known_kind_gets_nothing() {
        let echo = json!({"id": 1, "method": "core.echo", "params": {}});
        for hello in [
            json!({"token": "wrong", "client": "main"}).to_string(),
            json!({"token": "secret"}).to_string(),
            json!({"token": "secret", "client": "page"}).to_string(),
            "not json".to_owned(),
        ] {
            assert_eq!(frames(&hello, &echo).await, Vec::<Value>::new(), "{hello}");
        }
    }
}
