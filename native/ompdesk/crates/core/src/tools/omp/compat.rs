//! The verified-omp list (`docs/design/follow-omp.md`): the twin of `src/shared/omp-compat.ts`'s reader
//! (`parseOmpCompat`, `compatEntry`, `followTarget`), which stays in TypeScript for `scripts/omp-bump`; both test
//! suites read the same vectors (`src/shared/omp-compat-vectors.json`). And where this app reads the list from (was
//! `src/main/omp-compat-source.ts`): the `omp-compat` branch of the public repository, at most every 15 minutes, 15 s,
//! 1 MiB, through the proxy the core picks; a failed or refused read keeps the last good list, which is also kept in
//! `<userData>/omp-compat.json` so a launch without network follows what an earlier one read.

use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use http_body_util::{BodyExt, Limited};
use serde_json::{Map, Value};

use super::super::Tools;
use crate::setup::compat::{FILE, MAX_BYTES, read as read_kept};
use crate::tailscale::compare_versions;

pub const URL: &str =
    "https://raw.githubusercontent.com/seuput-inc/ompdesk/omp-compat/omp-compat.json";
const FRESH_MS: u64 = 15 * 60_000;
const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// Far more than a release ever gets; a list past it is not the workflow's.
const MAX_VERIFIED: usize = 2000;
/// The largest integer a JavaScript number holds exactly (`Number.isSafeInteger`).
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `OmpCompatHolding`: a version that failed verification for one OMPdesk release.
#[derive(Clone, Debug, PartialEq)]
pub struct Holding {
    pub version: String,
    pub since: String,
}

/// `OmpCompatEntry`: one OMPdesk release's entry.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Entry {
    /// Every omp a run verified against this release, oldest first.
    pub verified: Vec<String>,
    pub holding: Option<Holding>,
}

/// `OmpCompatList`: an entry per OMPdesk release.
pub type List = Map<String, Value>;

/// `isExactVersion`: `^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$`.
pub fn is_exact(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            (1..=6).contains(&part.len())
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (*part == "0" || !part.starts_with('0'))
        })
}

/// `isNewer(latest, installed)`: an order when both are versions, else any difference.
pub fn is_newer(latest: &str, installed: &str) -> bool {
    match compare_versions(latest, installed) {
        Some(order) => order.is_gt(),
        None => crate::fs::order::js_trim(latest) != crate::fs::order::js_trim(installed),
    }
}

/// `majorOf`: the first number of a version; none when it is no version.
pub fn major_of(version: &str) -> Option<u64> {
    compare_versions(version, version)?;
    let text = crate::fs::order::js_trim(version);
    let text = text.strip_prefix('v').unwrap_or(text);
    text.split(['.', '-', '+']).next()?.parse().ok()
}

fn holding(value: &Value) -> Option<Option<Holding>> {
    let Some(object) = value.as_object() else {
        return value.is_null().then_some(None);
    };
    if !object
        .keys()
        .all(|key| ["version", "since", "issue"].contains(&key.as_str()))
    {
        return None;
    }
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .filter(|v| is_exact(v))?;
    let since = object
        .get("since")
        .and_then(Value::as_str)
        .filter(|since| crate::care::date_parse(since).is_some())?;
    let issue = object.get("issue").unwrap_or(&Value::Null);
    let issue_ok = issue.is_null()
        || issue
            .as_f64()
            .is_some_and(|n| n > 0.0 && n.fract() == 0.0 && n <= MAX_SAFE);
    issue_ok.then(|| {
        Some(Holding {
            version: version.to_owned(),
            since: since.to_owned(),
        })
    })
}

fn entry(value: &Value) -> Option<Entry> {
    let object = value.as_object()?;
    if !object
        .keys()
        .all(|key| key == "verified" || key == "holding")
    {
        return None;
    }
    let verified = object.get("verified")?.as_array()?;
    if verified.len() > MAX_VERIFIED {
        return None;
    }
    let verified = verified
        .iter()
        .map(|v| v.as_str().filter(|v| is_exact(v)).map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    let holding = holding(object.get("holding").unwrap_or(&Value::Null))?;
    Some(Entry { verified, holding })
}

/// `parseOmpCompat`: the file's text as the workflow writes it, or none when anything in it is of another shape.
pub fn parse(text: &str) -> Option<List> {
    let Value::Object(list) = serde_json::from_str(text).ok()? else {
        return None;
    };
    list.iter()
        .all(|(app, value)| is_exact(app) && entry(value).is_some())
        .then_some(list)
}

/// The bytes as `TextDecoder("utf-8", {fatal: true})` reads them (a leading BOM dropped), parsed.
pub fn parse_bytes(bytes: &[u8]) -> Option<List> {
    let text = std::str::from_utf8(bytes).ok()?;
    parse(text.strip_prefix('\u{feff}').unwrap_or(text))
}

/// `compatEntry`: `app`'s entry; an empty one when the list names nothing for it yet.
pub fn entry_of(list: &List, app: &str) -> Entry {
    list.get(app).and_then(entry).unwrap_or_default()
}

/// `followTarget`: the newest of the tested omp and the verified ones that is newer than the installed omp (never a
/// step down) and not newer than the registry's latest; none when there is none.
pub fn follow_target(
    installed: &str,
    latest: &str,
    tested: &str,
    verified: &[String],
) -> Option<String> {
    let mut candidates: Vec<&str> = std::iter::once(tested)
        .chain(verified.iter().map(String::as_str))
        .filter(|v| is_exact(v) && is_newer(v, installed) && !is_newer(v, latest))
        .collect();
    // A stable sort, as `Array.sort`; exact versions always have an order.
    candidates.sort_by(|a, b| compare_versions(a, b).unwrap_or(std::cmp::Ordering::Equal));
    candidates.last().map(|v| (*v).to_owned())
}

/// What one read of the list's address gave.
#[derive(Debug, PartialEq)]
pub enum Fetched {
    /// 404: the branch does not exist yet, a good empty list.
    Missing,
    Body(Vec<u8>),
    /// Anything else: offline, a status other than 2xx, past 1 MiB, past 15 s.
    Failed,
}

/// The source's memory: the last good list and when it was read.
#[derive(Default)]
pub struct Source {
    list: Option<List>,
    read_at: Option<u64>,
}

/// `OmpCompatSource.read`: the newest good list, read again when the last good read is 15 minutes old.
pub async fn read(tools: &Rc<Tools>) -> Option<List> {
    let now = tools.clock.now_ms();
    {
        let part = tools.omp.borrow();
        if part
            .compat
            .read_at
            .is_some_and(|at| now.saturating_sub(at) < FRESH_MS)
        {
            return part.compat.list.clone();
        }
    }
    let deps = Rc::clone(&tools.omp.borrow().deps);
    let bytes = match deps.fetch_compat(tools).await {
        Fetched::Missing => Some(b"{}\n".to_vec()),
        Fetched::Body(bytes) => Some(bytes),
        Fetched::Failed => None,
    };
    let kept = Path::new(&tools.opts.user_data).join(FILE);
    if let Some((bytes, list)) =
        bytes.and_then(|bytes| parse_bytes(&bytes).map(|list| (bytes, list)))
        && !tools.is_closed()
    {
        let mut part = tools.omp.borrow_mut();
        part.compat.list = Some(list);
        part.compat.read_at = Some(now);
        // The core alone backs off on a full disk; the list in memory stands meanwhile.
        let _ = crate::disk::saves::write_kept(&kept, &bytes, None, 0o777);
    }
    let mut part = tools.omp.borrow_mut();
    if part.compat.list.is_none() && !tools.is_closed() {
        // An offline first read still has the copy from the previous launch.
        part.compat.list = read_kept(&kept).and_then(|bytes| parse_bytes(&bytes));
    }
    part.compat.list.clone()
}

/// The list's address read once: the test launch's file (`testOmpCompat`, or nothing in a launch with a test
/// installer), else the network through the core's proxy.
pub async fn fetch(tools: &Rc<Tools>) -> Fetched {
    let opts = &tools.opts;
    if opts.test_omp_compat.is_some() || opts.test_installer.is_some() {
        return match opts.test_omp_compat.as_deref().map(std::fs::read) {
            Some(Ok(bytes)) if bytes.len() <= MAX_BYTES => Fetched::Body(bytes),
            Some(Ok(_)) => Fetched::Failed,
            Some(Err(error)) if error.kind() != std::io::ErrorKind::NotFound => Fetched::Failed,
            _ => Fetched::Missing,
        };
    }
    let proxy = tools.proxy().await.url;
    fetch_from(URL, proxy.as_deref()).await
}

/// One GET of `url`, its body bound to 1 MiB and the whole read to 15 s, `cache: no-store` (nothing here caches).
pub async fn fetch_from(url: &str, proxy: Option<&str>) -> Fetched {
    let read = async {
        let request = crate::http::Request {
            url,
            headers: &[],
            body: None,
            proxy,
        };
        let Ok(response) = crate::http::open(request).await else {
            return Fetched::Failed;
        };
        match response.status().as_u16() {
            404 => Fetched::Missing,
            200..=299 => match Limited::new(response.into_body(), MAX_BYTES)
                .collect()
                .await
            {
                Ok(body) => Fetched::Body(body.to_bytes().to_vec()),
                Err(_) => Fetched::Failed,
            },
            _ => Fetched::Failed,
        }
    };
    tokio::time::timeout(READ_TIMEOUT, read)
        .await
        .unwrap_or(Fetched::Failed)
}
