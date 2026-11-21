//! The edge serving (native-rust ledger 8b; was `src/main/web/server.ts`): `web.start {host, userData, port,
//! staticRoot, buildMeta, router}` → `{port}` listens on `127.0.0.1` (`port` 0 picks one; a taken port is the fault `EADDRINUSE`, as
//! node's `listen` failed), `web.stop {host}` ends the accept loop, gives the page sockets a second to close and lets the
//! port go. `host` is main's number for its `WebServer`: every ask and socket event of the edge carries it
//! (`relay.rs`, `router.rs`). The edge reads the paired devices, the blocks, the uploads, the blob tokens and the kept builds from
//! the core's own stores of that `userData`, the very objects main's clients change.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::json;

use super::archive::{self, AssetArchive};
use super::assets::Assets;
use super::auth::Policy;
use super::relay::Relay;
use super::router;
use super::server::{Deps, Edge, Running, SERVER_HOST};
use crate::server::{Call, Fault, Registry, Reply};

static RUNNING: LazyLock<Mutex<HashMap<u64, Running>>> = LazyLock::new(Mutex::default);

fn running() -> MutexGuard<'static, HashMap<u64, Running>> {
    RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The built renderer main named at the start, and the builds kept beside it.
struct Built {
    root: Option<PathBuf>,
    archive: Arc<AssetArchive>,
}

impl Assets for Built {
    fn root(&self) -> Option<PathBuf> {
        self.root.clone()
    }

    fn previous_builds(&self) -> Vec<PathBuf> {
        self.archive.roots()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    host: u64,
    user_data: PathBuf,
    port: u16,
    static_root: Option<PathBuf>,
    archive_now: Option<i64>,
    build_meta: String,
    /// The page sockets' router: `IPC_POLICY`, the web-only channels, the protocol and features.
    router: router::Config,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The PWA plugin's nonempty meta content, not the archive's hash of web.html.
fn page_build(html: &[u8], meta: &str) -> Option<String> {
    let html = String::from_utf8_lossy(html);
    let prefix = format!(r#"<meta name="{meta}" content=""#);
    html.match_indices(&prefix).find_map(|(at, _)| {
        let (build, _) = html[at + prefix.len()..].split_once('"')?;
        (!build.is_empty()).then(|| build.to_owned())
    })
}

async fn start(call: Call) -> Result<Reply, Fault> {
    let mut params: StartParams = call.params()?;
    if let Some(running) = running().get(&params.host) {
        return Reply::json(&json!({ "port": running.port }));
    }
    if let Some(root) = &params.static_root
        && let Ok(html) = tokio::fs::read(root.join("web.html")).await
    {
        params.router.build = page_build(&html, &params.build_meta);
    }
    let user_data = params.user_data;
    let stores = super::store::stores(&user_data);
    let blobs = super::blobs::open(&user_data);
    blobs.attach_events(call.events.clone());
    let relay = Relay::new(call.events.clone(), params.host);
    let router = router::open(
        params.host,
        call.events.clone(),
        params.router,
        stores.devices.clone(),
    );
    let assets = Arc::new(Built {
        root: params.static_root,
        archive: archive::open(&user_data),
    });
    let edge = Edge::new(Deps {
        // Main's policy is read for every request (`Desktop::policy`); this one only stands in until it answers.
        policy: Policy {
            host: SERVER_HOST.to_owned(),
            public_port: 0,
            secure: false,
            serve_prefix: None,
            pending_prefix: None,
            allowed_users: Vec::new(),
        },
        devices: stores.devices.clone(),
        blocks: stores.blocks.clone(),
        whois: relay.clone(),
        desktop: relay.clone(),
        router: router.clone(),
        uploads: super::uploads::open(&user_data),
        blobs,
        hooks: Some(relay),
        assets: assets.clone(),
        push_public_key: Arc::new(move || {
            super::push::loaded(&user_data)
                .map_or_else(String::new, |vapid| vapid.public_key().to_owned())
        }),
        clock: Arc::new(now_ms),
    });
    let started = edge.start(params.port).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::AddrInUse {
            // node's words for the same failure.
            Fault::new(
                "EADDRINUSE",
                format!(
                    "listen EADDRINUSE: address already in use {SERVER_HOST}:{}",
                    params.port
                ),
            )
        } else {
            Fault::new(
                "web_listen",
                format!("listen {SERVER_HOST}:{}: {error}", params.port),
            )
        }
    })?;
    let port = started.port;
    // Two starts of one host raced: the first one listening stays.
    let raced = {
        let mut table = running();
        match table.get(&params.host) {
            Some(existing) => Some((existing.port, started)),
            None => {
                if let Some(root) = &assets.root {
                    router.archive_copy.get_or_init(|| {
                        assets
                            .archive
                            .start(root, params.archive_now.unwrap_or_else(now_ms))
                    });
                }
                table.insert(params.host, started);
                None
            }
        }
    };
    if let Some((port, started)) = raced {
        started.stop().await;
        return Reply::json(&json!({ "port": port }));
    }
    Reply::json(&json!({ "port": port }))
}

#[derive(Deserialize)]
struct StopParams {
    host: u64,
}

async fn stop(call: Call) -> Result<Reply, Fault> {
    let params: StopParams = call.params()?;
    let started = running().remove(&params.host);
    if let Some(started) = started {
        started.stop().await;
    }
    if let Some(mut done) =
        router::host_of(params.host).and_then(|host| host.archive_copy.get().cloned())
    {
        let _ = done.changed().await;
    }
    Reply::json(&serde_json::Value::Null)
}

pub fn register(registry: &mut Registry) {
    registry.add("web.start", |call| Box::pin(start(call)));
    registry.add("web.stop", |call| Box::pin(stop(call)));
    super::save::register(registry);
    super::relay::register(registry);
}
