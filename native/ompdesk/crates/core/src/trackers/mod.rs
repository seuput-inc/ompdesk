//! Work items outside GitHub: Linear's GraphQL API and Jira's REST API (Agents › GitHub's source bar), after Orca's
//! task page (`src/main/linear/**`, `src/main/jira/**` at stablyai/orca 02cecc98). Main keeps the accounts and their
//! tokens (`src/main/tracker-accounts.ts`, the OS keystore through `SecretBox`) and hands every request the accounts it
//! reads with their ready `authorization` header; this side keeps nothing of them past the request.
//!
//! One method, `trackers.request {op, proxyPref, …}`; the rules every op shares live here:
//! - at most four requests at once per service (Orca `linear-request-concurrency.ts:1-47`, `jira/request-queue.ts`),
//!   a request waits for a slot at most 30 s (GitLab's `glab-request-admission.ts:4-58`);
//! - a read is tried again on a dropped or refused connection only: at most three tries within one second, 100 ms × n
//!   apart (`linear-request-recovery.ts:104-181`); a write never is;
//! - a 429 pauses the account until the service's `Retry-After` (or its reset header, else a minute) and every
//!   request of it meanwhile answers `tracker_rate_limited` at once, without reaching the service;
//! - the app's proxy (`proxy.rs`, the one checks and updates use) carries every non-loopback request.
//!
//! Nothing here logs a request; a fault names the service's own words or a kind, never a header.

mod adf;
mod jira;
mod linear;

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use http_body_util::{BodyExt, LengthLimitError, Limited};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Semaphore, SemaphorePermit};

use crate::http::{self, Failure, Request};
use crate::server::{Fault, Registry, Reply};

/// Requests one service has in flight at most.
const CONCURRENT: usize = 4;
/// How long a request waits for a slot.
const ADMISSION_WAIT: Duration = Duration::from_secs(30);
/// One exchange, redirects included.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);
/// A read is tried again only while this much has passed since its first try.
const RETRY_WINDOW: Duration = Duration::from_millis(1000);
const ATTEMPTS: u64 = 3;
const BODY_LIMIT: usize = 16 * 1024 * 1024;
/// A 429 without a reset the service names pauses this long.
const DEFAULT_PAUSE_MS: u64 = 60_000;
const LONGEST_PAUSE_MS: u64 = 3_600_000;
/// How long a list's paging may go on before it answers what it has (`linear-read-budget.ts`).
pub(crate) const READ_BUDGET: Duration = Duration::from_secs(20);
/// How long the proxy pick is reused (its system lookup may take seconds).
const PROXY_REUSE: Duration = Duration::from_secs(60);

#[derive(Clone, Copy)]
pub(crate) enum Service {
    Linear = 0,
    Jira = 1,
    /// glab's runs (`glab/`).
    Gitlab = 2,
}

static SLOTS: LazyLock<[Semaphore; 3]> =
    LazyLock::new(|| std::array::from_fn(|_| Semaphore::new(CONCURRENT)));

/// Account → the epoch ms its 429 pause ends.
static PAUSED: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);

/// The last proxy pick: the preference it was made for, when, and the URL.
type ProxyPick = (String, Instant, Option<String>);
static PROXY: LazyLock<Mutex<Option<ProxyPick>>> = LazyLock::new(Default::default);

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// An account as main hands it over: its id and name, where its API is and the header that signs in.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Account {
    pub id: String,
    pub label: String,
    /// Jira: the REST base (the site, or the Cloud gateway). Linear: unused.
    #[serde(default)]
    pub base: String,
    /// Jira: the site browse links point at.
    #[serde(default)]
    pub site_url: String,
    /// Jira Server/Data Center (REST v2).
    #[serde(default)]
    pub server: bool,
    pub authorization: String,
}

/// One request's way out: the proxy it goes through.
pub(crate) struct Ctx {
    pub proxy: Option<String>,
}

pub(crate) struct Exchange<'a> {
    pub service: Service,
    /// Whose pause applies (the account's id).
    pub key: &'a str,
    pub url: &'a str,
    pub authorization: Option<&'a str>,
    /// A POST of this JSON; a GET without.
    pub body: Option<&'a [u8]>,
    /// Safe to try again on a dropped connection.
    pub read: bool,
}

pub(crate) struct Answer {
    pub status: u16,
    pub body: Vec<u8>,
    pub www_authenticate: String,
}

impl Answer {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

pub(crate) fn rate_limited(until: u64) -> Fault {
    let seconds = until.saturating_sub(now_ms()).div_ceil(1000);
    Fault::new(
        "tracker_rate_limited",
        format!("The service asked to wait {seconds} s before the next request"),
    )
}

fn paused_until(key: &str) -> Option<u64> {
    let mut paused = PAUSED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = now_ms();
    paused.retain(|_, until| *until > now);
    paused.get(key).copied()
}

pub(crate) fn pause(key: &str, ms: u64) -> u64 {
    let until = now_ms() + ms.clamp(1000, LONGEST_PAUSE_MS);
    PAUSED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key.to_owned(), until);
    until
}

/// How long a 429 asks to wait: `Retry-After` in seconds, else a reset time (Linear's
/// `X-RateLimit-Requests-Reset` in epoch ms, GitLab's `RateLimit-Reset` in epoch seconds), else a minute.
fn pause_ms(retry_after: Option<&str>, reset: Option<&str>, now: u64) -> u64 {
    if let Some(seconds) = retry_after.and_then(|value| value.trim().parse::<u64>().ok()) {
        return seconds * 1000;
    }
    match reset.and_then(|value| value.trim().parse::<u64>().ok()) {
        Some(ms) if ms > 1_000_000_000_000 => ms.saturating_sub(now),
        Some(seconds) if seconds > 1_000_000_000 => (seconds * 1000).saturating_sub(now),
        _ => DEFAULT_PAUSE_MS,
    }
}

fn failure_text(failure: Option<&Failure>, url: &str) -> String {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    match failure {
        None => format!("{host} did not answer within 30 s"),
        Some(Failure::Connect) => format!("Could not connect to {host}"),
        Some(Failure::Tls(words)) => format!("No secure connection to {host}: {words}"),
        Some(Failure::TooLarge) => format!("{host} answered more than this app reads"),
        Some(Failure::Proxy | Failure::ProxyUnsupported) => {
            format!("The proxy refused the connection to {host}")
        }
        Some(Failure::Request) => format!("{url} is not an address this app can reach"),
        Some(Failure::Redirect | Failure::Broken) => format!("The connection to {host} broke"),
    }
}

async fn exchange_once(ctx: &Ctx, call: &Exchange<'_>) -> Result<Answer, Failure> {
    let mut headers: Vec<(&'static str, &str)> = vec![
        ("accept", "application/json"),
        // A browser's user agent makes Atlassian refuse token writes as XSRF (Orca `authenticated-request.ts:14-15`).
        ("user-agent", "OMPdesk"),
    ];
    if call.body.is_some() {
        headers.push(("content-type", "application/json"));
    }
    if let Some(authorization) = call.authorization {
        headers.push(("authorization", authorization));
    }
    let response = http::open(Request {
        url: call.url,
        headers: &headers,
        body: call.body,
        proxy: ctx.proxy.as_deref(),
    })
    .await?;
    let status = response.status().as_u16();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    if status == 429 {
        let reset = header("x-ratelimit-requests-reset").or_else(|| header("ratelimit-reset"));
        pause(
            call.key,
            pause_ms(header("retry-after").as_deref(), reset.as_deref(), now_ms()),
        );
    }
    let www_authenticate = header("www-authenticate").unwrap_or_default();
    let body = Limited::new(response.into_body(), BODY_LIMIT)
        .collect()
        .await
        .map_err(|error| {
            if error.is::<LengthLimitError>() {
                Failure::TooLarge
            } else {
                Failure::Broken
            }
        })?
        .to_bytes()
        .to_vec();
    Ok(Answer {
        status,
        body,
        www_authenticate,
    })
}

/// One of the service's four slots, waited for at most 30 s (`tracker_busy` past it); released when dropped.
pub(crate) async fn admit(service: Service) -> Result<SemaphorePermit<'static>, Fault> {
    tokio::time::timeout(ADMISSION_WAIT, SLOTS[service as usize].acquire())
        .await
        .map_err(|_| {
            Fault::new(
                "tracker_busy",
                "Too many requests are waiting for this service; try again",
            )
        })?
        .map_err(|_| Fault::new("internal", "The request slots closed"))
}

/// One request under the service's slots, the account's pause and the read retry; a 429 is `tracker_rate_limited`.
pub(crate) async fn send(ctx: &Ctx, call: Exchange<'_>) -> Result<Answer, Fault> {
    if let Some(until) = paused_until(call.key) {
        return Err(rate_limited(until));
    }
    let _slot = admit(call.service).await?;
    let started = Instant::now();
    let mut attempt = 1;
    loop {
        let failure = match tokio::time::timeout(EXCHANGE_TIMEOUT, exchange_once(ctx, &call)).await
        {
            Ok(Ok(answer)) if answer.status == 429 => {
                return Err(rate_limited(paused_until(call.key).unwrap_or_else(now_ms)));
            }
            Ok(Ok(answer)) => return Ok(answer),
            Ok(Err(failure)) => Some(failure),
            Err(_) => None,
        };
        let transient = matches!(failure, Some(Failure::Connect | Failure::Broken));
        let wait = Duration::from_millis(100 * attempt);
        if !call.read
            || !transient
            || attempt >= ATTEMPTS
            || started.elapsed() + wait >= RETRY_WINDOW
        {
            return Err(Fault::new(
                "tracker_network",
                failure_text(failure.as_ref(), call.url),
            ));
        }
        tokio::time::sleep(wait).await;
        attempt += 1;
    }
}

/// The app's proxy (`proxy.rs`), picked once a minute per preference.
async fn proxy(pref: &Value) -> Option<String> {
    let key = pref.to_string();
    if let Some((at, when, url)) = PROXY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        && *at == key
        && when.elapsed() < PROXY_REUSE
    {
        return url.clone();
    }
    let system = async {
        tokio::task::spawn_blocking(|| ompdesk_sysproxy::resolve(crate::proxy::PROBE_URL))
            .await
            .ok()
    };
    let url = crate::proxy::pick(pref, |name| std::env::var(name).ok(), system)
        .await
        .url;
    *PROXY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
        Some((key, Instant::now(), url.clone()));
    url
}

/// Epoch ms of an API's time (`2026-11-26T10:00:00.000Z`, Jira's `+0900` too); 0 when it is none.
pub(crate) fn time_ms(text: &str) -> f64 {
    // Jira writes its zone without a colon (`+0900`), which `parse_iso` reads as hours.
    let mut text = text.trim().to_owned();
    let bytes = text.as_bytes();
    if bytes.len() > 5
        && matches!(bytes[bytes.len() - 5], b'+' | b'-')
        && bytes[bytes.len() - 4..].iter().all(u8::is_ascii_digit)
        && text.contains('T')
    {
        text.insert(text.len() - 2, ':');
    }
    crate::agentctl::journal::items::parse_iso(&text).unwrap_or(0.0)
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Category {
    Backlog,
    Unstarted,
    Started,
    Completed,
    Canceled,
}

#[derive(Serialize, Clone)]
pub(crate) struct State {
    pub name: String,
    pub category: Category,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Serialize, Clone)]
pub(crate) struct Priority {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Serialize, Clone)]
pub(crate) struct Person {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct Container {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// A list row (`TrackerItem`, `src/shared/trackers.ts`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Item {
    pub provider: &'static str,
    pub account_id: String,
    pub account_label: String,
    pub id: String,
    pub key: String,
    pub title: String,
    pub url: String,
    pub updated_at: String,
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<Person>,
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<Container>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(skip)]
    pub updated_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Comment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub(crate) struct Child {
    pub key: String,
    pub title: String,
    pub url: String,
}

#[derive(Serialize)]
pub(crate) struct Detail {
    #[serde(flatten)]
    pub item: Item,
    pub description: String,
    pub comments: Vec<Comment>,
    pub children: Vec<Child>,
}

#[derive(Serialize)]
pub(crate) struct StateOption {
    pub id: String,
    pub name: String,
    pub category: Category,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListError {
    pub account_id: String,
    pub account_label: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub message: String,
}

impl ListError {
    pub fn of(account: &Account, fault: &Fault) -> ListError {
        ListError {
            account_id: account.id.clone(),
            account_label: account.label.clone(),
            kind: match fault.code.as_ref() {
                "tracker_auth" => "auth",
                "tracker_rate_limited" => "rate_limited",
                "tracker_network" | "tracker_busy" => "network",
                _ => "unknown",
            },
            message: fault.message.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct List {
    pub items: Vec<Item>,
    pub has_more: bool,
    pub errors: Vec<ListError>,
}

/// Newest first, at most `limit`; whether more were left out.
pub(crate) fn newest(mut items: Vec<Item>, limit: usize) -> (Vec<Item>, bool) {
    items.sort_by(|a, b| b.updated_ms.total_cmp(&a.updated_ms));
    let clipped = items.len() > limit;
    items.truncate(limit);
    (items, clipped)
}

#[derive(Serialize)]
struct Done {
    ok: bool,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Provider {
    Linear,
    Jira,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum Op {
    LinearVerify {
        authorization: String,
    },
    JiraVerify {
        site_url: String,
        authorization: String,
        server: bool,
        email: bool,
    },
    List {
        provider: Provider,
        accounts: Vec<Account>,
        preset: String,
        #[serde(default)]
        search: Option<String>,
        limit: usize,
    },
    Detail {
        provider: Provider,
        account: Account,
        id: String,
    },
    States {
        provider: Provider,
        account: Account,
        id: String,
    },
    SetState {
        provider: Provider,
        account: Account,
        id: String,
        state_id: String,
    },
    Comment {
        provider: Provider,
        account: Account,
        id: String,
        body: String,
    },
}

async fn run(op: Op, ctx: &Ctx) -> Result<Reply, Fault> {
    match op {
        Op::LinearVerify { authorization } => {
            Reply::json(&linear::verify(ctx, &authorization).await?)
        }
        Op::JiraVerify {
            site_url,
            authorization,
            server,
            email,
        } => Reply::json(&jira::verify(ctx, &site_url, &authorization, server, email).await?),
        Op::List {
            provider,
            accounts,
            preset,
            search,
            limit,
        } => {
            let search = search
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty());
            let limit = limit.clamp(1, 100);
            Reply::json(&match provider {
                Provider::Linear => linear::list(ctx, &accounts, &preset, search, limit).await?,
                Provider::Jira => jira::list(ctx, &accounts, &preset, search, limit).await?,
            })
        }
        Op::Detail {
            provider,
            account,
            id,
        } => Reply::json(&match provider {
            Provider::Linear => linear::detail(ctx, &account, &id).await?,
            Provider::Jira => jira::detail(ctx, &account, &id).await?,
        }),
        Op::States {
            provider,
            account,
            id,
        } => Reply::json(&match provider {
            Provider::Linear => linear::states(ctx, &account, &id).await?,
            Provider::Jira => jira::states(ctx, &account, &id).await?,
        }),
        Op::SetState {
            provider,
            account,
            id,
            state_id,
        } => {
            match provider {
                Provider::Linear => linear::set_state(ctx, &account, &id, &state_id).await?,
                Provider::Jira => jira::set_state(ctx, &account, &id, &state_id).await?,
            }
            Reply::json(&Done { ok: true })
        }
        Op::Comment {
            provider,
            account,
            id,
            body,
        } => {
            match provider {
                Provider::Linear => linear::comment(ctx, &account, &id, &body).await?,
                Provider::Jira => jira::comment(ctx, &account, &id, &body).await?,
            }
            Reply::json(&Done { ok: true })
        }
    }
}

pub fn register(registry: &mut Registry) {
    registry.add("trackers.request", |call| {
        Box::pin(async move {
            let params: Value = call.params()?;
            let op = Op::deserialize(&params)
                .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
            let ctx = Ctx {
                proxy: proxy(params.get("proxyPref").unwrap_or(&Value::Null)).await,
            };
            tokio::select! {
                outcome = run(op, &ctx) => outcome,
                () = call.scope.on_cancel() => Err(Fault::cancelled()),
            }
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pause_reads_retry_after_then_a_reset_then_a_minute() {
        let now = 1_800_000_000_000;
        assert_eq!(pause_ms(Some("12"), Some("1"), now), 12_000);
        assert_eq!(pause_ms(None, Some("1800000005000"), now), 5_000);
        assert_eq!(pause_ms(None, Some("1800000007"), now), 7_000);
        assert_eq!(pause_ms(Some("soon"), None, now), DEFAULT_PAUSE_MS);
    }

    #[test]
    fn a_paused_account_is_refused_until_its_pause_ends() {
        let until = pause("tests::paused", 5_000);
        assert_eq!(paused_until("tests::paused"), Some(until));
        assert_eq!(paused_until("tests::other"), None);
    }

    #[test]
    fn times_read_utc_and_jira_offsets_alike() {
        let utc = time_ms("2026-11-26T01:00:00.000Z");
        assert!(utc > 0.0);
        assert_eq!(time_ms("2026-11-26T10:00:00.000+0900"), utc);
        assert_eq!(time_ms("2026-11-25T20:00:00.000-0500"), utc);
        assert_eq!(time_ms("never"), 0.0);
    }

    fn item(updated_ms: f64) -> Item {
        Item {
            provider: "linear",
            account_id: String::new(),
            account_label: String::new(),
            id: updated_ms.to_string(),
            key: String::new(),
            title: String::new(),
            url: String::new(),
            updated_at: String::new(),
            state: State {
                name: String::new(),
                category: Category::Started,
                color: None,
            },
            priority: None,
            assignee: None,
            labels: Vec::new(),
            container: None,
            branch_name: None,
            updated_ms,
        }
    }

    #[test]
    fn newest_sorts_and_says_when_it_cut() {
        let (items, clipped) = newest(vec![item(1.0), item(3.0), item(2.0)], 2);
        assert_eq!(
            items.iter().map(|item| item.updated_ms).collect::<Vec<_>>(),
            [3.0, 2.0]
        );
        assert!(clipped);
        assert!(!newest(vec![item(1.0)], 2).1);
    }

    pub(crate) fn test_item(updated_ms: f64) -> Item {
        item(updated_ms)
    }
}
