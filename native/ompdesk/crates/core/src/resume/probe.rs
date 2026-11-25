use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use serde::Deserialize;
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::server::{Call, Fault, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    first: IpAddr,
    second: Option<IpAddr>,
    port: u16,
    timeout_ms: u32,
}

pub(super) async fn probe(call: Call) -> Result<Reply, Fault> {
    let p: Params = call.params()?;
    let limit = Duration::from_millis(p.timeout_ms.into());
    let connects = |ip| async move {
        let socket = SocketAddr::new(ip, p.port);
        matches!(timeout(limit, TcpStream::connect(socket)).await, Ok(Ok(_)))
    };
    // The old Promise.all waited for both answers even when the first address accepted.
    let reachable = if let Some(second) = p.second {
        let (a, b) = tokio::join!(connects(p.first), connects(second));
        a || b
    } else {
        connects(p.first).await
    };
    Reply::json(&reachable)
}
