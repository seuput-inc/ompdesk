use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::{FindParams, Id, Installed, ego, installed};
use crate::server::{Fault, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Params {
    native_host_browsers: Option<Vec<Id>>,
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
    Relay { name: String, url: String },
    Builtin,
}

fn automatic(ego_installed: bool, browsers: &[Installed]) -> Automatic {
    if ego_installed {
        return Automatic::Ego;
    }
    for browser in browsers {
        if browser.relay_installed
            && let Some(port) = browser.port
        {
            return Automatic::Relay {
                name: browser.name.clone(),
                url: format!("http://127.0.0.1:{port}"),
            };
        }
    }
    Automatic::Builtin
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    auto: Automatic,
    ego_installed: bool,
    browsers: Vec<Installed>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_host_browsers: Option<Vec<Id>>,
}

impl Status {
    fn bindings(&self) -> impl Iterator<Item = (Id, bool)> + '_ {
        self.browsers.iter().map(|b| (b.id, b.relay_installed))
    }
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
    let (ego, browsers) = tokio::join!(
        ego::resolve(probe.ego),
        installed(probe.find, params.native_host_browsers.is_some()),
    );
    let ego_installed = ego.ok().flatten().is_some();
    let browsers = browsers?;
    let status = Status {
        auto: automatic(ego_installed, &browsers),
        ego_installed,
        browsers,
        native_host_browsers: params.native_host_browsers,
    };
    let changed = before.is_some_and(|old| {
        old.ego_installed != status.ego_installed
            || old.native_host_browsers != status.native_host_browsers
            || old.bindings().ne(status.bindings())
    });
    Reply::json(&Read {
        status: cache.insert(status),
        changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn automatic_matches_the_typescript_resolver() {
        #[derive(Deserialize)]
        struct Captured {
            auto: Vec<(bool, Vec<Installed>, Value)>,
        }
        let captured: Captured = serde_json::from_str(include_str!("captured.json")).unwrap();
        for (ego, browsers, expected) in captured.auto {
            let selected = serde_json::to_value(automatic(ego, &browsers)).unwrap();
            assert_eq!(selected, expected);
        }
    }
}
