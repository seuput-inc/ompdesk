use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::{FindParams, Id, Installed, blocking, ego, find};
use crate::server::{Fault, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Params {
    native_host_browsers: Vec<Id>,
    // A spawn sends probe inputs only on a miss, without computing the login-shell PATH on hits.
    probe: Option<Probe>,
}

#[derive(Deserialize)]
struct Probe {
    #[serde(flatten)]
    find: FindParams,
    ego: Option<ego::Search>,
    refresh: bool,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Automatic {
    Ego,
    Builtin,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    auto: Automatic,
    ego_installed: bool,
    browsers: Vec<Installed>,
    native_host_browsers: Vec<Id>,
}

#[derive(Serialize)]
struct Read<'a> {
    status: &'a Status,
    changed: bool,
}

pub(super) async fn read(params: Params) -> Result<Reply, Fault> {
    // Hold through the probe so concurrent spawns reuse it and refreshes compare consecutive snapshots.
    static CACHE: Mutex<Option<Status>> = Mutex::const_new(None);
    let mut cache = CACHE.lock().await;
    if params.probe.as_ref().is_none_or(|probe| !probe.refresh)
        && let Some(status) = cache.as_ref()
        && status.native_host_browsers == params.native_host_browsers
    {
        return Reply::json(&Read {
            status,
            changed: false,
        });
    }
    let Some(probe) = params.probe else {
        return Reply::json(&());
    };
    let before = cache.take();
    let (ego, found) = tokio::join!(ego::resolve(probe.ego), blocking(move || find(probe.find)));
    let ego_installed = ego.ok().flatten().is_some();
    let browsers: Vec<Installed> = found?
        .into_iter()
        .map(|found| Installed {
            id: found.id,
            name: found.name,
        })
        .collect();
    let status = Status {
        auto: if ego_installed {
            Automatic::Ego
        } else {
            Automatic::Builtin
        },
        ego_installed,
        browsers,
        native_host_browsers: params.native_host_browsers,
    };
    let changed = before.is_some_and(|old| {
        old.ego_installed != status.ego_installed
            || old.native_host_browsers != status.native_host_browsers
            || old
                .browsers
                .iter()
                .map(|b| b.id)
                .ne(status.browsers.iter().map(|b| b.id))
    });
    Reply::json(&Read {
        status: cache.insert(status),
        changed,
    })
}
