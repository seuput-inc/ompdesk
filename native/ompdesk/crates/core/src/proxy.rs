//! The proxy every check, update and tab spawn of this app goes through (was `resolveProxyEnvForSpawn` and
//! `agentProxyUrl` in `src/main/index.ts`, whose system lookup asked the shell). The order:
//!
//! 1. the `proxyUrl` preference (`127.0.0.1:7890` reads as `http://127.0.0.1:7890`), set for every spawn;
//! 2. else a proxy the app inherited from a terminal launch (`PI_PROXY`, `HTTPS_PROXY`, `https_proxy`, `ALL_PROXY`,
//!    `all_proxy`): every spawn inherits it too, so nothing is added;
//! 3. else the system proxy for [`PROBE_URL`] (`ompdesk_sysproxy`: the WinINET / WinHTTP settings with their PAC or
//!    WPAD script on Windows, CFNetwork's settings and PAC on macOS), set for every spawn.
//!
//! The system lookup is bounded by [`LOOKUP_BOUND`]: one past it reads as no proxy and says so, which main logs
//! (`omp-start-input` `proxyEnv`), because a lookup that never answered held every tab's start that waited for it (the
//! shell's hung main thread on the Mac mini, 18 Nov 2026: 6 h). The PAC runs have their own 3 s inside it.
//!
//! `proxy.resolve {pref}` (the preference's stored value, any JSON) → `{url, env, lateMs}`: `url` the proxy the
//! agent's requests use, or null; `env` the variables a spawn adds; `lateMs` the bound when the system lookup ran past
//! it, else null.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::server::{Call, Fault, Registry, Reply};

/// The URL the system proxy is asked for: codex's OAuth backend, a representative of the agent's requests.
pub const PROBE_URL: &str = "https://chatgpt.com";
/// How long the system lookup may take.
pub const LOOKUP_BOUND: Duration = Duration::from_secs(5);
/// What an inherited proxy is read from, in this order.
const INHERITED: [&str; 5] = [
    "PI_PROXY",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
];
/// Every variable the agent and Bun honor, set to the one proxy.
const SPAWN_VARS: [&str; 7] = [
    "PI_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
];

pub fn register(registry: &mut Registry) {
    registry.add("proxy.resolve", |call| Box::pin(resolve(call)));
}

#[derive(Debug, PartialEq)]
pub struct Pick {
    pub url: Option<String>,
    pub env: Map<String, Value>,
    pub late: bool,
}

#[derive(Deserialize)]
struct Params {
    #[serde(default)]
    pref: Value,
}

async fn resolve(call: Call) -> Result<Reply, Fault> {
    let p: Params = call.params()?;
    let system = async {
        tokio::task::spawn_blocking(|| ompdesk_sysproxy::resolve(PROBE_URL))
            .await
            .ok()
    };
    let pick = pick(&p.pref, |name| std::env::var(name).ok(), system).await;
    let late_ms = pick.late.then(|| LOOKUP_BOUND.as_millis());
    Reply::json(&json!({ "url": pick.url, "env": pick.env, "lateMs": late_ms }))
}

/// The order above. `inherited` reads this process's environment (main's, which spawned it); `system` is the OS
/// lookup's PAC result, `None` when it failed. The lookup runs only when it decides.
pub async fn pick(
    pref: &Value,
    inherited: impl Fn(&str) -> Option<String>,
    system: impl Future<Output = Option<String>>,
) -> Pick {
    let set = |url: String| Pick {
        env: SPAWN_VARS
            .iter()
            .map(|name| (name.to_string(), Value::String(url.clone())))
            .collect(),
        url: Some(url),
        late: false,
    };
    if let Some(pref) = pref.as_str().map(str::trim).filter(|p| !p.is_empty()) {
        return set(normalize(pref));
    }
    if let Some(url) = INHERITED
        .iter()
        .find_map(|name| inherited(name).filter(|value| !value.is_empty()))
    {
        return Pick {
            url: Some(url),
            env: Map::new(),
            late: false,
        };
    }
    match tokio::time::timeout(LOOKUP_BOUND, system).await {
        Ok(pac) => match pac.as_deref().and_then(parse_pac_result) {
            Some(url) => set(url),
            None => Pick {
                url: None,
                env: Map::new(),
                late: false,
            },
        },
        Err(_) => Pick {
            url: None,
            env: Map::new(),
            late: true,
        },
    }
}

/// `127.0.0.1:7890` → `http://127.0.0.1:7890`; a URL with a scheme stays as written.
fn normalize(pref: &str) -> String {
    if pref.contains("://") {
        pref.to_string()
    } else {
        format!("http://{pref}")
    }
}

/// The first entry of a PAC result as a URL: `PROXY h:p` → `http://h:p`, `HTTPS h:p` → `https://h:p`,
/// `SOCKS h:p`/`SOCKS5 h:p` → `socks5://h:p`; `DIRECT` and anything else → none.
fn parse_pac_result(pac: &str) -> Option<String> {
    let first = pac.split(';').next().unwrap_or("").trim();
    let mut words = first.split_whitespace();
    let kind = words.next()?;
    let endpoint = words.next()?;
    match kind {
        "PROXY" => Some(format!("http://{endpoint}")),
        "HTTPS" => Some(format!("https://{endpoint}")),
        "SOCKS" | "SOCKS5" => Some(format!("socks5://{endpoint}")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::future::pending;

    use super::*;

    fn none(_: &str) -> Option<String> {
        None
    }

    fn vars(url: &str) -> Map<String, Value> {
        SPAWN_VARS
            .iter()
            .map(|name| (name.to_string(), json!(url)))
            .collect()
    }

    fn set(url: &str) -> Pick {
        Pick {
            url: Some(url.into()),
            env: vars(url),
            late: false,
        }
    }

    fn nothing() -> Pick {
        Pick {
            url: None,
            env: Map::new(),
            late: false,
        }
    }

    async fn system(pac: &str) -> Option<String> {
        Some(pac.to_string())
    }

    #[tokio::test]
    async fn the_preference_comes_first_and_is_set_for_every_spawn() {
        let asked = Cell::new(false);
        let lookup = async {
            asked.set(true);
            Some("PROXY sys:1; DIRECT".to_string())
        };
        let inherited = |_: &str| Some("http://inherited:2".to_string());
        assert_eq!(
            pick(&json!(" 127.0.0.1:7890 "), inherited, lookup).await,
            set("http://127.0.0.1:7890")
        );
        assert!(
            !asked.get(),
            "the system is never asked when the preference names a proxy"
        );
        assert_eq!(
            pick(&json!("socks5://p:1080"), none, system("DIRECT")).await,
            set("socks5://p:1080")
        );
    }

    #[tokio::test]
    async fn a_blank_or_odd_preference_is_no_preference() {
        for pref in [
            json!(""),
            json!("   "),
            json!(null),
            json!(7890),
            json!({ "url": "a:1" }),
        ] {
            assert_eq!(
                pick(&pref, none, system("PROXY sys:1; DIRECT")).await,
                set("http://sys:1"),
                "{pref}"
            );
        }
    }

    #[tokio::test]
    async fn an_inherited_proxy_adds_nothing_and_skips_the_system() {
        let asked = Cell::new(false);
        let lookup = async {
            asked.set(true);
            Some("PROXY sys:1; DIRECT".to_string())
        };
        let env = |name: &str| match name {
            "PI_PROXY" => Some(String::new()),
            "https_proxy" => Some("http://lower:3".into()),
            "ALL_PROXY" => Some("http://all:4".into()),
            _ => None,
        };
        assert_eq!(
            pick(&json!(null), env, lookup).await,
            Pick {
                url: Some("http://lower:3".into()),
                env: Map::new(),
                late: false
            }
        );
        assert!(!asked.get());
    }

    #[tokio::test]
    async fn the_system_proxy_is_read_as_its_first_pac_entry() {
        let cases = [
            (
                "PROXY proxy.corp:8080; DIRECT",
                Some("http://proxy.corp:8080"),
            ),
            ("HTTPS secure:443", Some("https://secure:443")),
            ("SOCKS5 s:1080; DIRECT", Some("socks5://s:1080")),
            ("SOCKS  s:1080", Some("socks5://s:1080")),
            ("DIRECT", None),
            ("DIRECT; PROXY late:1", None),
            ("", None),
            ("PROXY", None),
            ("QUIC q:443", None),
        ];
        for (pac, url) in cases {
            let want = url.map_or_else(nothing, set);
            assert_eq!(pick(&json!(null), none, system(pac)).await, want, "{pac}");
        }
        assert_eq!(pick(&json!(null), none, async { None }).await, nothing());
    }

    #[tokio::test(start_paused = true)]
    async fn a_system_lookup_past_its_bound_reads_as_none_and_says_so() {
        let started = tokio::time::Instant::now();
        let late = pick(&json!(null), none, pending()).await;
        assert_eq!(
            late,
            Pick {
                url: None,
                env: Map::new(),
                late: true
            }
        );
        assert_eq!(started.elapsed(), LOOKUP_BOUND);

        let slow = async {
            tokio::time::sleep(LOOKUP_BOUND - Duration::from_millis(1)).await;
            Some("PROXY sys:1".to_string())
        };
        assert_eq!(pick(&json!(null), none, slow).await, set("http://sys:1"));
    }
}
