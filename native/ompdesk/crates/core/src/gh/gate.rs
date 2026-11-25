//! One gate per gh install and GitHub host (the key `Gh::run` builds) in front of every gh run that reaches GitHub's
//! API (not `gh auth`, `gh config`, a version or help run), so a burst of automatic reads cannot spend the person's
//! quota (Orca's rate-limit breaker, quota floor and background pacing, re-implemented).
//!
//! - **Spent**: gh said "rate limit" (stock's `GH_RATE_LIMIT_ERROR_PATTERN`, `tools/gh-run-watch.ts`), or the quota
//!   read shows a resource at 0. Every gated run of that host is refused without spawning gh until the reset GitHub
//!   names (`gh api rate_limit`, which costs no quota); when that read finds quota left (a secondary limit) it waits
//!   `SECONDARY_PAUSE_MS`, and when it fails `FALLBACK_PAUSE_MS`.
//! - **Background** (a request sent with `background: true`: routines, Autopilot's release poll, the page's automatic
//!   re-reads): before its first run, a quota read at most every `QUOTA_FRESH_MS`; below `QUOTA_FLOOR` left, background
//!   requests wait for that reset while the person's own reads still go. At most `PACE_READS` background requests
//!   start per `PACE_WINDOW_MS` per host.
//! - A read (`gh api` GET, `gh <noun> list|view|diff|checks|status`) that gh answers with an HTTP 5xx runs again after
//!   250 ms and 1 s; a write never runs twice.
//!
//! A refusal (`Wait::fault`) is the fault `gh_paused` whose message ends with `paused until <ISO time>`; the page and
//! main read that time. Nothing is kept on disk: a new core starts with an open gate and learns again from gh.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};

use serde_json::Value;

use crate::aimemory::value::iso;
use crate::server::Fault;

pub const PACE_WINDOW_MS: u64 = 5 * 60_000;
pub const PACE_READS: usize = 20;
/// Background reads wait for the reset below this many requests left (core or GraphQL).
pub const QUOTA_FLOOR: u64 = 50;
pub const QUOTA_FRESH_MS: u64 = 60_000;
pub const SECONDARY_PAUSE_MS: u64 = 60_000;
pub const FALLBACK_PAUSE_MS: u64 = 5 * 60_000;
pub const RETRY_DELAYS_MS: [u64; 2] = [250, 1_000];
/// The quota read's own timeout.
pub const QUOTA_READ_MS: u64 = 15_000;

#[derive(Default)]
struct Host {
    /// Every gated run waits until then (ms since 1970).
    spent_until: u64,
    /// Background requests wait until then.
    background_until: u64,
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

/// Whether a gh run reaches GitHub's API at all.
pub fn gated(args: &[&str]) -> bool {
    !matches!(
        args.first().copied(),
        None | Some(
            "auth"
                | "config"
                | "version"
                | "--version"
                | "help"
                | "--help"
                | "alias"
                | "completion"
        )
    )
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

/// gh's words for a GitHub server error (`HTTP 502: Bad Gateway (…)`).
pub fn server_error(stderr: &str) -> bool {
    stderr.match_indices("HTTP 5").any(|(at, _)| {
        let digits = &stderr.as_bytes()[at + 6..];
        digits.len() >= 2 && digits[0].is_ascii_digit() && digits[1].is_ascii_digit()
    })
}

/// What `gh api rate_limit` says of the quotas runs here spend (REST and GraphQL): the fewest left and when each
/// resource under `floor` resets (ms), the latest of those.
#[derive(Debug, PartialEq)]
pub struct Quota {
    pub remaining: u64,
    /// The latest reset among the resources at 0.
    pub spent_until: Option<u64>,
    /// The latest reset among the resources under the floor.
    pub low_until: Option<u64>,
}

pub fn read_quota(json: &str, floor: u64) -> Option<Quota> {
    let value: Value = serde_json::from_str(json).ok()?;
    let resources = value.get("resources")?;
    let mut quota = Quota {
        remaining: u64::MAX,
        spent_until: None,
        low_until: None,
    };
    let mut seen = false;
    for name in ["core", "graphql"] {
        let Some(resource) = resources.get(name) else {
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
        quota.remaining = quota.remaining.min(remaining);
        if remaining == 0 {
            quota.spent_until = quota.spent_until.max(Some(reset_ms));
        }
        if remaining < floor {
            quota.low_until = quota.low_until.max(Some(reset_ms));
        }
    }
    seen.then_some(quota)
}

/// Why a run waits: the host's quota is spent, or a background request waits for the reset or its pace.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Wait {
    Spent(u64),
    Background(u64),
}

impl Wait {
    pub fn until(self) -> u64 {
        match self {
            Wait::Spent(until) | Wait::Background(until) => until,
        }
    }

    /// The refusal of a run of `host`.
    pub fn fault(self, host: &str) -> Fault {
        let why = match self {
            Wait::Spent(_) => format!("GitHub's rate limit for {host} is reached"),
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

/// Whether a run of `host` may start now: `Err(until)` while the host is spent, or for a background request while
/// it waits for the reset or its pace. `count` records a background request's start (its first run only).
pub fn admit(host: &str, background: bool, count: bool, now: u64) -> Result<(), Wait> {
    with_host(host, |state| {
        if state.spent_until > now {
            return Err(Wait::Spent(state.spent_until));
        }
        if !background {
            return Ok(());
        }
        if state.background_until > now {
            return Err(Wait::Background(state.background_until));
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

/// What a quota read found (`None`: it failed): a spent resource stops every run until its reset, one under the
/// floor stops background requests. A failed read invents nothing.
pub fn learn(host: &str, quota: Option<&Quota>) {
    let Some(quota) = quota else {
        return;
    };
    with_host(host, |state| {
        if let Some(until) = quota.spent_until {
            state.spent_until = state.spent_until.max(until);
        }
        if let Some(until) = quota.low_until {
            state.background_until = state.background_until.max(until);
        }
    });
}

/// gh said rate limit: `quota` is what the reset read found right after. Answers the time the host waits until.
pub fn trip(host: &str, quota: Option<&Quota>, now: u64) -> u64 {
    let until = match quota {
        Some(Quota {
            spent_until: Some(until),
            ..
        }) if *until > now => *until,
        Some(_) => now + SECONDARY_PAUSE_MS,
        None => now + FALLBACK_PAUSE_MS,
    };
    with_host(host, |state| {
        state.spent_until = state.spent_until.max(until);
        state.quota_read_at = Some(now);
        state.spent_until
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
    fn reads_gh_s_words() {
        assert!(rate_limited(
            "gh: API rate limit exceeded for user ID 1. (HTTP 403)"
        ));
        assert!(rate_limited("You have exceeded a secondary rate limit"));
        assert!(rate_limited("HTTP 429: Too Many Requests"));
        assert!(!rate_limited("HTTP 404: Not Found"));
        assert!(server_error(
            "HTTP 502: Bad Gateway (https://api.github.com/x)"
        ));
        assert!(!server_error("HTTP 404: Not Found"));
        assert!(!server_error("HTTP 5"));
    }

    #[test]
    fn reads_the_quota() {
        let json = r#"{"resources":{"core":{"limit":5000,"remaining":0,"reset":1700000000},
            "graphql":{"limit":5000,"remaining":40,"reset":1700000100},"search":{"remaining":0,"reset":9}}}"#;
        assert_eq!(
            read_quota(json, QUOTA_FLOOR),
            Some(Quota {
                remaining: 0,
                spent_until: Some(1_700_000_000_000),
                low_until: Some(1_700_000_100_000),
            })
        );
        let plenty = r#"{"resources":{"core":{"remaining":4000,"reset":1},"graphql":{"remaining":4999,"reset":2}}}"#;
        assert_eq!(
            read_quota(plenty, QUOTA_FLOOR).map(|quota| (quota.spent_until, quota.low_until)),
            Some((None, None))
        );
        assert_eq!(read_quota("not json", QUOTA_FLOOR), None);
        assert_eq!(read_quota("{}", QUOTA_FLOOR), None);
    }

    #[test]
    fn paces_background_requests_and_keeps_the_person_s() {
        let host = "pace.test";
        for start in 0..PACE_READS as u64 {
            assert_eq!(admit(host, true, true, 1_000 + start), Ok(()));
        }
        assert_eq!(
            admit(host, true, true, 2_000),
            Err(Wait::Background(1_000 + PACE_WINDOW_MS))
        );
        // A later run of a request already admitted, and the person's own reads, still go.
        assert_eq!(admit(host, true, false, 2_000), Ok(()));
        assert_eq!(admit(host, false, true, 2_000), Ok(()));
        assert_eq!(admit(host, true, true, 1_000 + PACE_WINDOW_MS), Ok(()));
    }

    #[test]
    fn a_low_quota_holds_background_and_a_spent_one_everything() {
        let host = "quota.test";
        let low = Quota {
            remaining: 10,
            spent_until: None,
            low_until: Some(50_000),
        };
        learn(host, Some(&low));
        assert_eq!(
            admit(host, true, true, 10_000),
            Err(Wait::Background(50_000))
        );
        assert_eq!(admit(host, false, false, 10_000), Ok(()));
        learn(host, None);
        assert_eq!(admit(host, true, true, 50_000), Ok(()));
        let until = trip(host, None, 60_000);
        assert_eq!(until, 60_000 + FALLBACK_PAUSE_MS);
        assert_eq!(admit(host, false, false, 61_000), Err(Wait::Spent(until)));
        // Another host is not held.
        assert_eq!(admit("other.test", false, false, 61_000), Ok(()));
        let secondary = Quota {
            remaining: 4000,
            spent_until: None,
            low_until: None,
        };
        assert_eq!(trip("second.test", Some(&secondary), 0), SECONDARY_PAUSE_MS);
        assert!(
            Wait::Spent(0)
                .fault(host)
                .message
                .ends_with("paused until 1970-01-01T00:00:00.000Z")
        );
    }

    #[test]
    fn reads_the_quota_once_a_minute() {
        let host = "fresh.test";
        assert!(quota_due(host, 0));
        assert!(!quota_due(host, QUOTA_FRESH_MS - 1));
        assert!(quota_due(host, QUOTA_FRESH_MS));
    }
}
