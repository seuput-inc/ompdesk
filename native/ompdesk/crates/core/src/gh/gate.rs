//! One gate per gh command (binary and fixed arguments) and GitHub host (the key `Gh::run` builds) in front of every
//! gh run that reaches GitHub's API (not `gh auth`, `gh config`, a version or help run, nor `gh api rate_limit`, which
//! costs no quota), so a burst of automatic reads cannot spend the person's quota (Orca's rate-limit breaker, quota
//! floor and background pacing, re-implemented).
//!
//! - **Two quotas** (Orca `gh-rate-limit-breaker.ts:3-10,81-111`): REST (`core`) and GraphQL are spent apart, so a
//!   run is held only by the one it spends (`bucket`): `gh api` by its endpoint, the other gh commands by whether gh
//!   serves them over GraphQL. A spent GraphQL quota no longer stops the Actions and release reads.
//! - **Spent**: gh said "rate limit" (stock's `GH_RATE_LIMIT_ERROR_PATTERN`, `tools/gh-run-watch.ts`), or the quota
//!   read shows a resource at 0. Every gated run of that host and quota is refused without spawning gh until the reset
//!   GitHub names (`gh api rate_limit`); when that read finds both quotas left (a secondary limit) the whole host waits
//!   `SECONDARY_PAUSE_MS`, and when it fails the run's quota waits `FALLBACK_PAUSE_MS`.
//! - **Background** (a request sent with `background: true`: routines, Autopilot's release poll, the page's automatic
//!   re-reads): before its first run, the account's quota as this computer last read it, read again at most every
//!   `QUOTA_FRESH_MS`; below `QUOTA_FLOOR` left of a quota, background requests that spend it wait for that reset while
//!   the person's own reads still go. On github.com the reading is the one the agents' gh guard keeps
//!   (`resources/gui-bridge/gh-guard.ts` `quotaReading`: `<gh-budget>/rate-limit.json`, the same 60 s age and the same
//!   floor), so the app and the agents judge one budget by one rule. At most `PACE_READS` background requests start
//!   per `PACE_WINDOW_MS` per host.
//! - A read (`gh api` GET, `gh <noun> list|view|diff|checks|status`) that gh answers with an HTTP 5xx or a dropped
//!   connection runs again after 250 ms and 1 s (Orca `gh-retry-policy.ts:4-25`); a write never runs twice.
//!
//! The host is the one the run names (`--hostname`, `--repo HOST/OWNER/NAME`), else `GH_HOST`, else github.com (Orca
//! `gh-exec-file.ts:62-77`, `gh-host-args.ts:44-72`): an Enterprise read that names its host in argv is held to that
//! host's quota, never github.com's.
//!
//! A refusal (`Wait::fault`) is the fault `gh_paused` whose message ends with `paused until <ISO time>`; the page and
//! main read that time. Only the shared reading is kept on disk: a new core starts with an open gate.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};

use serde_json::Value;

use crate::aimemory::value::iso;
use crate::server::Fault;

pub const PACE_WINDOW_MS: u64 = 5 * 60_000;
/// A guard against a runaway loop, not the quota's keeper (the floor is): several routines polling every few minutes
/// with every kind stay under it.
pub const PACE_READS: usize = 60;
/// Background reads wait for the reset below this many requests left (core or GraphQL): the gh guard's
/// `QUOTA_FLOOR` (`gh-guard-core.ts`), pinned by `floor_and_age_are_the_gh_guard_s`.
pub const QUOTA_FLOOR: u64 = 1_500;
/// The guard's `QUOTA_READING_MAX_AGE_MS`.
pub const QUOTA_FRESH_MS: u64 = 60_000;
pub const SECONDARY_PAUSE_MS: u64 = 60_000;
pub const FALLBACK_PAUSE_MS: u64 = 5 * 60_000;
pub const RETRY_DELAYS_MS: [u64; 2] = [250, 1_000];
/// The quota read's own timeout.
pub const QUOTA_READ_MS: u64 = 15_000;

/// The quota a run spends: REST (`core`) or GraphQL.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Bucket {
    Core,
    Graphql,
}

impl Bucket {
    const ALL: [Bucket; 2] = [Bucket::Core, Bucket::Graphql];

    fn index(self) -> usize {
        match self {
            Bucket::Core => 0,
            Bucket::Graphql => 1,
        }
    }

    /// Its name in `gh api rate_limit`'s `resources`.
    fn resource(self) -> &'static str {
        match self {
            Bucket::Core => "core",
            Bucket::Graphql => "graphql",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Bucket::Core => "REST",
            Bucket::Graphql => "GraphQL",
        }
    }
}

#[derive(Default)]
struct Host {
    /// Every gated run of a quota waits until then (ms since 1970), by `Bucket::index`.
    spent_until: [u64; 2],
    /// Background requests of a quota wait until then.
    background_until: [u64; 2],
    /// When the last background requests started, oldest first.
    starts: VecDeque<u64>,
    /// When the quota was last read (or a read was started).
    quota_read_at: Option<u64>,
}

static HOSTS: LazyLock<Mutex<HashMap<String, Host>>> = LazyLock::new(Mutex::default);

fn with_host<T>(host: &str, f: impl FnOnce(&mut Host) -> T) -> T {
    let mut hosts = HOSTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(hosts.entry(host.to_owned()).or_default())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// `gh api`'s flags that take the next argument as their value (Orca `GH_API_VALUE_FLAGS`).
const API_VALUE_FLAGS: [&str; 17] = [
    "--cache",
    "--jq",
    "-q",
    "--method",
    "-X",
    "--field",
    "-F",
    "--raw-field",
    "-f",
    "--header",
    "-H",
    "--hostname",
    "--input",
    "--template",
    "-t",
    "--preview",
    "-p",
];

/// The path of a `gh api` run's endpoint, without its leading `/` and its query (the guard's `apiCall`, Orca
/// `findGhApiEndpoint`).
fn api_endpoint<'a>(args: &[&'a str]) -> Option<&'a str> {
    if args.first().copied() != Some("api") {
        return None;
    }
    let mut rest = args[1..].iter();
    while let Some(&arg) = rest.next() {
        if !arg.starts_with('-') {
            let path = arg.trim_start_matches('/');
            return Some(path.split('?').next().unwrap_or(path));
        }
        if API_VALUE_FLAGS.contains(&arg) {
            rest.next();
        }
    }
    None
}

/// gh's commands that never reach GitHub's API: the agents' gh guard's `FREE_COMMANDS` (`gh-guard-core.ts`), pinned
/// by `classifies_runs_as_the_gh_guard_does`.
const FREE_COMMANDS: [&str; 7] = [
    "auth",
    "help",
    "config",
    "alias",
    "completion",
    "extension",
    "version",
];
/// gh's commands served over GraphQL: the guard's `GRAPHQL_COMMANDS`, pinned with `FREE_COMMANDS`.
const GRAPHQL_COMMANDS: [&str; 7] = [
    "pr",
    "issue",
    "repo",
    "project",
    "discussion",
    "label",
    "status",
];

/// Whether a gh run reaches GitHub's API at all, and spends its quota: not a free command, a version or help flag, or
/// `gh api rate_limit`, which costs nothing (Orca `isGhRateLimitProbe`).
pub fn gated(args: &[&str]) -> bool {
    match args.first().copied() {
        None | Some("--version" | "--help") => false,
        Some("api") => api_endpoint(args).is_some_and(|path| path != "rate_limit"),
        Some(command) => !FREE_COMMANDS.contains(&command),
    }
}

/// The quota a run spends, by the guard's rule (`apiCall`, `GRAPHQL_COMMANDS`): `gh api graphql` and the commands gh
/// serves over GraphQL spend GraphQL, everything else REST. A run that spends both is told apart by the quota read
/// after a trip.
pub fn bucket(args: &[&str]) -> Bucket {
    let graphql = match args.first().copied() {
        Some("api") => api_endpoint(args) == Some("graphql"),
        Some(command) => GRAPHQL_COMMANDS.contains(&command),
        None => false,
    };
    if graphql {
        Bucket::Graphql
    } else {
        Bucket::Core
    }
}

/// The host a run names in its arguments: `--hostname HOST`, else `--repo`/`-R HOST/OWNER/NAME` (Orca
/// `explicitGhHostname`, `explicitGhRepoHostname`).
pub fn named_host<'a>(args: &[&'a str]) -> Option<&'a str> {
    let value = |at: usize, arg: &'a str, flags: &[&str], inline: &str| {
        if flags.contains(&arg) {
            args.get(at + 1).copied()
        } else {
            arg.strip_prefix(inline)
        }
    };
    let hostname = args
        .iter()
        .enumerate()
        .find_map(|(at, &arg)| value(at, arg, &["--hostname"], "--hostname="));
    if let Some(host) = hostname.map(str::trim).filter(|host| !host.is_empty()) {
        return Some(host);
    }
    args.iter().enumerate().find_map(|(at, &arg)| {
        let repo = value(at, arg, &["--repo", "-R"], "--repo=")?;
        let parts: Vec<&str> = repo.trim().split('/').collect();
        (parts.len() == 3 && parts.iter().all(|part| !part.is_empty())).then_some(parts[0])
    })
}

/// A run that only reads, so running it twice changes nothing.
pub fn is_read(args: &[&str]) -> bool {
    match args.first().copied() {
        Some("api") => {
            let mut method = None;
            let mut fields = false;
            let mut rest = args[1..].iter();
            while let Some(&arg) = rest.next() {
                match arg {
                    "-X" | "--method" => {
                        method = rest.next().map(|value| value.to_ascii_uppercase())
                    }
                    "-f" | "-F" | "--field" | "--raw-field" | "--input" => fields = true,
                    _ => {
                        if let Some(value) = arg
                            .strip_prefix("--method=")
                            .or_else(|| arg.strip_prefix("-X"))
                            .filter(|value| !value.is_empty())
                        {
                            method = Some(value.to_ascii_uppercase());
                        }
                    }
                }
            }
            // gh api sends a request with fields as a POST unless a method is named.
            method.map_or(!fields, |method| method == "GET")
        }
        Some(_) => matches!(
            args.get(1).copied(),
            Some("list" | "view" | "diff" | "checks" | "status")
        ),
        None => false,
    }
}

/// Stock's `GH_RATE_LIMIT_ERROR_PATTERN` (`/rate limit|HTTP 429|abuse detection/i`).
pub fn rate_limited(stderr: &str) -> bool {
    let words = stderr.to_ascii_lowercase();
    ["rate limit", "http 429", "abuse detection"]
        .iter()
        .any(|phrase| words.contains(phrase))
}

/// A failure that a second try may not meet: gh's words for a GitHub server error (`HTTP 502: Bad Gateway (…)`) or
/// for a connection that dropped or never came up (Go's `connection reset by peer`, `i/o timeout`, `TLS handshake
/// timeout`, gh's `error connecting to api.github.com`; Orca's `isTransientGhError` reads node's words for them).
pub fn transient(stderr: &str) -> bool {
    let server = stderr.match_indices("HTTP 5").any(|(at, _)| {
        let digits = &stderr.as_bytes()[at + 6..];
        digits.len() >= 2 && digits[0].is_ascii_digit() && digits[1].is_ascii_digit()
    });
    let words = stderr.to_ascii_lowercase();
    server
        || [
            "connection reset",
            "i/o timeout",
            "tls handshake timeout",
            "error connecting to",
        ]
        .iter()
        .any(|phrase| words.contains(phrase))
}

/// What `gh api rate_limit` says of one quota: when it resets if it is at 0 (`spent_until`) and if it is under the
/// floor (`low_until`), in ms.
#[derive(Debug, PartialEq, Default, Clone, Copy)]
pub struct Resource {
    pub spent_until: Option<u64>,
    pub low_until: Option<u64>,
}

/// What `gh api rate_limit` says of the quotas runs here spend, by `Bucket::index`.
#[derive(Debug, PartialEq)]
pub struct Quota {
    pub resources: [Resource; 2],
}

/// `gh api rate_limit`'s answer read as a `Quota`.
pub fn read_quota(json: &str, floor: u64) -> Option<Quota> {
    let value: Value = serde_json::from_str(json).ok()?;
    quota_of(value.get("resources")?, floor)
}

/// The guard's stored reading (`{at, core, graphql}`), when it is fresh at `now`: under `QUOTA_FRESH_MS` old and no
/// resource's reset passed (the guard's `readingStale`).
pub fn stored_quota(text: &str, now: u64) -> Option<Quota> {
    let value: Value = serde_json::from_str(text).ok()?;
    let at = value.get("at")?.as_f64()? as u64;
    if now < at || now - at >= QUOTA_FRESH_MS {
        return None;
    }
    let passed = ["core", "graphql"].iter().any(|name| {
        value
            .get(name)
            .and_then(|resource| resource.get("reset"))
            .and_then(Value::as_u64)
            .is_some_and(|reset| reset.saturating_mul(1_000) <= now)
    });
    if passed {
        return None;
    }
    quota_of(&value, QUOTA_FLOOR)
}

/// The reading the guard stores (`parseRateLimit`'s shape) from `gh api rate_limit`'s answer taken at `at`.
pub fn reading_of(json: &str, at: u64) -> Option<String> {
    let value: Value = serde_json::from_str(json).ok()?;
    let resources = value.get("resources")?;
    let mut reading = serde_json::Map::new();
    reading.insert("at".into(), at.into());
    for name in ["core", "graphql"] {
        let Some(resource) = resources.get(name) else {
            continue;
        };
        let numbers: Option<Vec<Value>> = ["limit", "remaining", "reset"]
            .iter()
            .map(|key| resource.get(key).filter(|value| value.is_number()).cloned())
            .collect();
        if let Some([limit, remaining, reset]) = numbers.as_deref() {
            reading.insert(
                name.into(),
                serde_json::json!({ "limit": limit, "remaining": remaining, "reset": reset }),
            );
        }
    }
    (reading.len() > 1).then(|| Value::Object(reading).to_string())
}

fn quota_of(resources: &Value, floor: u64) -> Option<Quota> {
    let mut quota = Quota {
        resources: [Resource::default(); 2],
    };
    let mut seen = false;
    for bucket in Bucket::ALL {
        let Some(resource) = resources.get(bucket.resource()) else {
            continue;
        };
        let (Some(remaining), Some(reset)) = (
            resource.get("remaining").and_then(Value::as_u64),
            resource.get("reset").and_then(Value::as_u64),
        ) else {
            continue;
        };
        seen = true;
        let reset_ms = reset.saturating_mul(1_000);
        let kept = &mut quota.resources[bucket.index()];
        if remaining == 0 {
            kept.spent_until = Some(reset_ms);
        }
        if remaining < floor {
            kept.low_until = Some(reset_ms);
        }
    }
    seen.then_some(quota)
}

/// Why a run waits: the host's quota is spent, or a background request waits for the reset or its pace.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Wait {
    Spent(Bucket, u64),
    Background(u64),
}

impl Wait {
    pub fn until(self) -> u64 {
        match self {
            Wait::Spent(_, until) | Wait::Background(until) => until,
        }
    }

    /// The refusal of a run of `host`.
    pub fn fault(self, host: &str) -> Fault {
        let why = match self {
            Wait::Spent(bucket, _) => {
                format!(
                    "GitHub's {} rate limit for {host} is reached",
                    bucket.label()
                )
            }
            Wait::Background(_) => {
                format!("Automatic GitHub reads for {host} keep the quota for yours")
            }
        };
        Fault::new(
            "gh_paused",
            format!("{why}: paused until {}", iso(self.until())),
        )
    }
}

/// Whether a run of `host` spending `bucket` may start now: `Err(until)` while that quota is spent, or for a
/// background request while it waits for that quota's reset or its pace. `count` records a background request's start
/// (its first run only).
pub fn admit(
    host: &str,
    bucket: Bucket,
    background: bool,
    count: bool,
    now: u64,
) -> Result<(), Wait> {
    with_host(host, |state| {
        let index = bucket.index();
        if state.spent_until[index] > now {
            return Err(Wait::Spent(bucket, state.spent_until[index]));
        }
        if !background {
            return Ok(());
        }
        if state.background_until[index] > now {
            return Err(Wait::Background(state.background_until[index]));
        }
        while state
            .starts
            .front()
            .is_some_and(|&start| start + PACE_WINDOW_MS <= now)
        {
            state.starts.pop_front();
        }
        if count {
            if state.starts.len() >= PACE_READS {
                return Err(Wait::Background(
                    state
                        .starts
                        .front()
                        .map_or(now, |&start| start + PACE_WINDOW_MS),
                ));
            }
            state.starts.push_back(now);
        }
        Ok(())
    })
}

/// Whether a background request should read the quota first; marks the read as started so concurrent requests do
/// not each read it.
pub fn quota_due(host: &str, now: u64) -> bool {
    with_host(host, |state| {
        let due = state
            .quota_read_at
            .is_none_or(|at| now.saturating_sub(at) >= QUOTA_FRESH_MS);
        if due {
            state.quota_read_at = Some(now);
        }
        due
    })
}

/// What a quota read found (`None`: it failed): a spent quota stops every run that spends it until its reset, one
/// under the floor stops background requests that spend it. A failed read invents nothing.
pub fn learn(host: &str, quota: Option<&Quota>) {
    let Some(quota) = quota else {
        return;
    };
    with_host(host, |state| {
        for (index, resource) in quota.resources.iter().enumerate() {
            if let Some(until) = resource.spent_until {
                state.spent_until[index] = state.spent_until[index].max(until);
            }
            if let Some(until) = resource.low_until {
                state.background_until[index] = state.background_until[index].max(until);
            }
        }
    });
}

/// gh said rate limit for a run spending `bucket`: `quota` is what the reset read found right after. A spent quota
/// waits for its reset (whichever the run spent: one that spends both is told apart here); with both left, a secondary
/// limit, the whole host waits; with no reading, the run's quota. Answers the time the run waits until.
pub fn trip(host: &str, bucket: Bucket, quota: Option<&Quota>, now: u64) -> u64 {
    with_host(host, |state| {
        state.quota_read_at = Some(now);
        let mut until = 0;
        for (index, resource) in quota
            .into_iter()
            .flat_map(|quota| quota.resources.iter())
            .enumerate()
        {
            if let Some(spent) = resource.spent_until.filter(|&spent| spent > now) {
                state.spent_until[index] = state.spent_until[index].max(spent);
                until = until.max(state.spent_until[index]);
            }
        }
        if until != 0 {
            return until;
        }
        let (pause, held): (u64, &[Bucket]) = match quota {
            Some(_) => (SECONDARY_PAUSE_MS, &Bucket::ALL),
            None => (FALLBACK_PAUSE_MS, std::slice::from_ref(&bucket)),
        };
        for held in held {
            let index = held.index();
            state.spent_until[index] = state.spent_until[index].max(now + pause);
            until = until.max(state.spent_until[index]);
        }
        until
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_reads_from_writes() {
        assert!(is_read(&["api", "repos/o/r/pulls/1"]));
        assert!(is_read(&[
            "api",
            "--method",
            "GET",
            "repos/o/r/actions/runs",
            "-F",
            "head_sha=1"
        ]));
        assert!(is_read(&["api", "-XGET", "x", "-f", "a=b"]));
        assert!(!is_read(&["api", "repos/o/r/issues", "-f", "title=x"]));
        assert!(!is_read(&["api", "-X", "PATCH", "repos/o/r"]));
        assert!(is_read(&["pr", "list", "--repo", "o/r"]));
        assert!(is_read(&["run", "view", "1"]));
        assert!(!is_read(&["pr", "create", "--title", "x"]));
        assert!(!is_read(&["pr", "merge", "1"]));
        assert!(!gated(&["auth", "status"]));
        assert!(gated(&["repo", "view"]));
    }

    #[test]
    fn names_the_quota_and_the_host_a_run_spends() {
        // `rate_limit` is free, so the gate never refuses the read that tells its reset (Orca `isGhRateLimitProbe`).
        assert!(!gated(&["api", "rate_limit"]));
        assert!(!gated(&["api", "--hostname", "ghe.test", "/rate_limit"]));
        assert!(gated(&["api", "repos/o/r/pulls"]));
        assert_eq!(bucket(&["api", "repos/o/r/actions/runs"]), Bucket::Core);
        assert_eq!(
            bucket(&["api", "-H", "x: y", "graphql", "-f", "query=q"]),
            Bucket::Graphql
        );
        assert_eq!(bucket(&["pr", "diff", "1"]), Bucket::Graphql);
        assert_eq!(bucket(&["run", "view", "1"]), Bucket::Core);
        assert_eq!(
            named_host(&["api", "--hostname", "ghe.test", "notifications"]),
            Some("ghe.test")
        );
        assert_eq!(
            named_host(&["issue", "list", "--repo", "ghe.test/o/r"]),
            Some("ghe.test")
        );
        assert_eq!(
            named_host(&["pr", "view", "-R", "ghe.test/o/r"]),
            Some("ghe.test")
        );
        assert_eq!(
            named_host(&["pr", "view", "--repo=ghe.test/o/r"]),
            Some("ghe.test")
        );
        assert_eq!(named_host(&["pr", "view", "--repo", "o/r"]), None);
        assert_eq!(named_host(&["pr", "view", "1"]), None);
    }

    /// One budget, one rule: which runs are free and which spend GraphQL is the agents' gh guard's word for word.
    #[test]
    fn classifies_runs_as_the_gh_guard_does() {
        let guard = include_str!("../../../../../../resources/gui-bridge/gh-guard-core.ts");
        let keys = |name: &str| {
            let at = guard
                .find(&format!("const {name}: Record<string, true> = {{"))
                .unwrap();
            let body = &guard[at..];
            let body = &body[body.find('{').unwrap() + 1..body.find("};").unwrap()];
            let mut keys: Vec<String> = body
                .split(',')
                .filter_map(|entry| entry.split(':').next())
                .map(|key| key.trim().to_owned())
                .filter(|key| !key.is_empty())
                .collect();
            keys.sort();
            keys
        };
        let sorted = |list: &[&str]| {
            let mut list: Vec<String> = list.iter().map(|key| (*key).to_owned()).collect();
            list.sort();
            list
        };
        assert_eq!(keys("FREE_COMMANDS"), sorted(&FREE_COMMANDS));
        assert_eq!(keys("GRAPHQL_COMMANDS"), sorted(&GRAPHQL_COMMANDS));
    }

    #[test]
    fn reads_gh_s_words() {
        assert!(rate_limited(
            "gh: API rate limit exceeded for user ID 1. (HTTP 403)"
        ));
        assert!(rate_limited("You have exceeded a secondary rate limit"));
        assert!(rate_limited("HTTP 429: Too Many Requests"));
        assert!(!rate_limited("HTTP 404: Not Found"));
        assert!(transient(
            "HTTP 502: Bad Gateway (https://api.github.com/x)"
        ));
        assert!(transient(
            "Post \"https://api.github.com/graphql\": read tcp 1.2.3.4:5->6.7.8.9:443: read: connection reset by peer"
        ));
        assert!(transient("dial tcp: lookup api.github.com: i/o timeout"));
        assert!(transient("net/http: TLS handshake timeout"));
        assert!(transient(
            "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com"
        ));
        assert!(!transient("HTTP 404: Not Found"));
        assert!(!transient("HTTP 5"));
    }

    #[test]
    fn reads_the_quota() {
        let json = r#"{"resources":{"core":{"limit":5000,"remaining":0,"reset":1700000000},
            "graphql":{"limit":5000,"remaining":40,"reset":1700000100},"search":{"remaining":0,"reset":9}}}"#;
        assert_eq!(
            read_quota(json, QUOTA_FLOOR),
            Some(Quota {
                resources: [
                    Resource {
                        spent_until: Some(1_700_000_000_000),
                        low_until: Some(1_700_000_000_000),
                    },
                    Resource {
                        spent_until: None,
                        low_until: Some(1_700_000_100_000),
                    },
                ],
            })
        );
        let plenty = r#"{"resources":{"core":{"remaining":4000,"reset":1},"graphql":{"remaining":4999,"reset":2}}}"#;
        assert_eq!(
            read_quota(plenty, QUOTA_FLOOR),
            Some(Quota {
                resources: [Resource::default(); 2]
            })
        );
        assert_eq!(read_quota("not json", QUOTA_FLOOR), None);
        assert_eq!(read_quota("{}", QUOTA_FLOOR), None);
    }

    #[test]
    fn paces_background_requests_and_keeps_the_person_s() {
        let host = "pace.test";
        for start in 0..PACE_READS as u64 {
            assert_eq!(admit(host, Bucket::Core, true, true, 1_000 + start), Ok(()));
        }
        assert_eq!(
            admit(host, Bucket::Graphql, true, true, 2_000),
            Err(Wait::Background(1_000 + PACE_WINDOW_MS))
        );
        // A later run of a request already admitted, and the person's own reads, still go.
        assert_eq!(admit(host, Bucket::Core, true, false, 2_000), Ok(()));
        assert_eq!(admit(host, Bucket::Core, false, true, 2_000), Ok(()));
        assert_eq!(
            admit(host, Bucket::Core, true, true, 1_000 + PACE_WINDOW_MS),
            Ok(())
        );
    }

    #[test]
    fn a_low_quota_holds_background_and_a_spent_one_everything_that_spends_it() {
        let host = "quota.test";
        let low = Quota {
            resources: [
                Resource::default(),
                Resource {
                    spent_until: None,
                    low_until: Some(50_000),
                },
            ],
        };
        learn(host, Some(&low));
        assert_eq!(
            admit(host, Bucket::Graphql, true, true, 10_000),
            Err(Wait::Background(50_000))
        );
        // REST is not low: an automatic Actions read still goes.
        assert_eq!(admit(host, Bucket::Core, true, true, 10_000), Ok(()));
        assert_eq!(admit(host, Bucket::Graphql, false, false, 10_000), Ok(()));
        learn(host, None);
        assert_eq!(admit(host, Bucket::Graphql, true, true, 50_000), Ok(()));
        let until = trip(host, Bucket::Graphql, None, 60_000);
        assert_eq!(until, 60_000 + FALLBACK_PAUSE_MS);
        assert_eq!(
            admit(host, Bucket::Graphql, false, false, 61_000),
            Err(Wait::Spent(Bucket::Graphql, until))
        );
        assert_eq!(admit(host, Bucket::Core, false, false, 61_000), Ok(()));
        // Another host is not held.
        assert_eq!(
            admit("other.test", Bucket::Graphql, false, false, 61_000),
            Ok(())
        );
        // A secondary limit (both quotas left) holds the whole host for a minute.
        let secondary = Quota {
            resources: [Resource::default(); 2],
        };
        assert_eq!(
            trip("second.test", Bucket::Core, Some(&secondary), 0),
            SECONDARY_PAUSE_MS
        );
        assert_eq!(
            admit("second.test", Bucket::Graphql, false, false, 1),
            Err(Wait::Spent(Bucket::Graphql, SECONDARY_PAUSE_MS))
        );
        // A run that tripped on the quota it did not seem to spend waits for that one's reset, and only it is held.
        let rest_spent = Quota {
            resources: [
                Resource {
                    spent_until: Some(90_000),
                    low_until: Some(90_000),
                },
                Resource::default(),
            ],
        };
        assert_eq!(
            trip("mixed.test", Bucket::Graphql, Some(&rest_spent), 0),
            90_000
        );
        assert_eq!(
            admit("mixed.test", Bucket::Graphql, false, false, 1),
            Ok(())
        );
        assert_eq!(
            admit("mixed.test", Bucket::Core, false, false, 1),
            Err(Wait::Spent(Bucket::Core, 90_000))
        );
        let fault = Wait::Spent(Bucket::Graphql, 0).fault(host);
        assert!(
            fault
                .message
                .starts_with("GitHub's GraphQL rate limit for quota.test")
        );
        assert!(
            fault
                .message
                .ends_with("paused until 1970-01-01T00:00:00.000Z")
        );
    }

    /// One budget, one rule: the agents' gh guard and the app's own reads hold at the same floor and trust a reading
    /// as long.
    #[test]
    fn floor_and_age_are_the_gh_guard_s() {
        let guard = include_str!("../../../../../../resources/gui-bridge/gh-guard-core.ts");
        let constant = |name: &str| {
            let at = guard.find(&format!("export const {name} = ")).unwrap() + name.len() + 16;
            guard[at..]
                .split(';')
                .next()
                .unwrap()
                .replace('_', "")
                .parse::<u64>()
                .unwrap()
        };
        assert_eq!(constant("QUOTA_FLOOR"), QUOTA_FLOOR);
        assert_eq!(constant("QUOTA_READING_MAX_AGE_MS"), QUOTA_FRESH_MS);
    }

    #[test]
    fn shares_the_guard_s_reading() {
        let answer = r#"{"resources":{"core":{"limit":5000,"remaining":1200,"reset":1700000600},
            "graphql":{"limit":5000,"remaining":4000,"reset":1700000700},"search":{"limit":30,"remaining":0,"reset":1}}}"#;
        let at = 1_700_000_000_000;
        let stored = reading_of(answer, at).unwrap();
        assert_eq!(
            stored,
            r#"{"at":1700000000000,"core":{"limit":5000,"remaining":1200,"reset":1700000600},"graphql":{"limit":5000,"remaining":4000,"reset":1700000700}}"#
        );
        assert_eq!(
            stored_quota(&stored, at + 1_000),
            Some(Quota {
                resources: [
                    Resource {
                        spent_until: None,
                        low_until: Some(1_700_000_600_000),
                    },
                    Resource::default(),
                ],
            })
        );
        assert_eq!(stored_quota(&stored, at + QUOTA_FRESH_MS), None);
        assert_eq!(stored_quota(&stored, at - 1), None);
        assert_eq!(reading_of("{}", at), None);
    }

    #[test]
    fn reads_the_quota_once_a_minute() {
        let host = "fresh.test";
        assert!(quota_due(host, 0));
        assert!(!quota_due(host, QUOTA_FRESH_MS - 1));
        assert!(quota_due(host, QUOTA_FRESH_MS));
    }
}
