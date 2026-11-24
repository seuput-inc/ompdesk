//! The model picker's release dates (was `src/main/model-release-dates.ts`). models.dev's catalog.json maps
//! OpenRouter ids to model-only release dates; the provider row's own date is not used, because its sync may derive it
//! from OpenRouter's `created` (listing time). Stock's well-known models cache is field-pruned and has no dates.
//! Source semantics: https://github.com/anomalyco/models.dev#api-reference
//!
//! `models.releaseDates` → `{dates: {<openrouter id>: <ms of the UTC date>}}`, never an error: unknown dates are
//! simply absent. One fetch at a time, shared by every asker; an answer is kept a day, a failure backs off five minutes
//! and keeps the last good dates. The catalog is fetched as main's Node `fetch` fetched it (`http::node_get`: Node's
//! roots, `NODE_EXTRA_CA_CERTS`, its opt-in proxy).

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::server::{Answer, Call, Reply};

const CATALOG: &str = "https://models.dev/catalog.json";
const SUCCESS_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const FAILURE_TTL: Duration = Duration::from_secs(5 * 60);
const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Cache {
    dates: Map<String, Value>,
    expires: Option<Instant>,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Mutex::default);

pub(super) fn handle(_: Call) -> Answer {
    Box::pin(async move {
        let dates = dates(&CACHE, fetch_catalog).await;
        Reply::json(&json!({ "dates": dates }))
    })
}

async fn fetch_catalog() -> Option<Vec<u8>> {
    let deadline = Instant::now() + TIMEOUT;
    let answer = tokio::time::timeout_at(
        deadline,
        crate::http::node_get(CATALOG, deadline.into_std()),
    )
    .await
    .ok()?
    .ok()?;
    (200..300).contains(&answer.status).then_some(answer.body)
}

/// The dates `cache` holds, refreshed through `fetch` once they expired; the lock makes concurrent askers share one
/// fetch.
async fn dates<F: Future<Output = Option<Vec<u8>>>>(
    cache: &Mutex<Cache>,
    fetch: impl FnOnce() -> F,
) -> Map<String, Value> {
    let mut cache = cache.lock().await;
    if cache
        .expires
        .is_some_and(|expires| Instant::now() < expires)
    {
        return cache.dates.clone();
    }
    match fetch().await.and_then(|body| parse(&body)) {
        Some(dates) => {
            cache.dates = dates;
            cache.expires = Some(Instant::now() + SUCCESS_TTL);
        }
        None => cache.expires = Some(Instant::now() + FAILURE_TTL),
    }
    cache.dates.clone()
}

/// Each OpenRouter id whose row names a canonical model that exists under that id with an exact `YYYY-MM-DD` date.
fn parse(body: &[u8]) -> Option<Map<String, Value>> {
    let payload: Value = serde_json::from_slice(body).ok()?;
    let rows = payload
        .get("providers")?
        .as_object()?
        .get("openrouter")?
        .as_object()?
        .get("models")?
        .as_object()?;
    let models = payload.get("models")?.as_object()?;
    let mut dates = Map::new();
    for (id, row) in rows {
        let Some(row) = row.as_object() else { continue };
        if row.get("id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        let Some(canonical) = row.get("canonical_model_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(model) = models.get(canonical).and_then(Value::as_object) else {
            continue;
        };
        if model.get("id").and_then(Value::as_str) != Some(canonical) {
            continue;
        }
        if let Some(ms) = model
            .get("release_date")
            .and_then(Value::as_str)
            .and_then(day_ms)
        {
            dates.insert(id.clone(), ms.into());
        }
    }
    Some(dates)
}

/// `YYYY-MM-DD` as the milliseconds of that UTC midnight, only for a date the calendar has (`Date.parse` with the
/// round trip the TypeScript checked).
fn day_ms(date: &str) -> Option<i64> {
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        bytes[range.clone()]
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| date[range].parse().ok())?
    };
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if !(1..=days_in_month).contains(&day) {
        return None;
    }
    // Days since 1970-01-01 (Howard Hinnant's days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400_000)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn catalog() -> Vec<u8> {
        json!({
            "providers": { "openrouter": { "models": {
                "lab/exact": { "id": "lab/exact", "canonical_model_id": "lab/base", "release_date": "2026-11-12" },
                "lab/month": { "id": "lab/month", "canonical_model_id": "lab/month" },
                "lab/invalid": { "id": "lab/invalid", "canonical_model_id": "lab/invalid" },
                "lab/standalone": { "id": "lab/standalone", "release_date": "2026-11-12" },
                "lab/wrong": { "id": "other", "canonical_model_id": "lab/base" },
                "lab/mismatch": { "id": "lab/mismatch", "canonical_model_id": "lab/mismatch" },
            } } },
            "models": {
                "lab/base": { "id": "lab/base", "release_date": "2024-02-29" },
                "lab/month": { "id": "lab/month", "release_date": "2024-02" },
                "lab/invalid": { "id": "lab/invalid", "release_date": "2023-02-29" },
                "lab/mismatch": { "id": "other", "release_date": "2024-01-01" },
            },
        })
        .to_string()
        .into_bytes()
    }

    const EXACT: i64 = 1_709_164_800_000; // Date.UTC(2024, 1, 29)

    #[test]
    fn only_exact_canonical_model_dates() {
        assert_eq!(
            parse(&catalog()),
            Some(Map::from_iter([("lab/exact".into(), EXACT.into())]))
        );
        assert_eq!(parse(br#"{"providers":{}}"#), None);
        assert_eq!(day_ms("1970-01-01"), Some(0));
        assert_eq!(day_ms("0000-01-01"), Some(-62_167_219_200_000));
        assert_eq!(day_ms("2000-02-29"), Some(951_782_400_000));
        for bad in [
            "1900-02-29",
            "2024-13-01",
            "2024-00-10",
            "2024-04-31",
            "2024-1-01",
            "2024-01-01T00",
            "+202-01-01",
        ] {
            assert_eq!(day_ms(bad), None, "{bad}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn one_fetch_is_shared_and_kept_a_day() {
        let cache = Mutex::default();
        let fetches = AtomicUsize::new(0);
        let fetch = || async {
            fetches.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            Some(catalog())
        };
        let (first, second) = tokio::join!(dates(&cache, fetch), dates(&cache, fetch));
        assert_eq!(first, second);
        assert_eq!(first.get("lab/exact"), Some(&EXACT.into()));
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        tokio::time::advance(SUCCESS_TTL - Duration::from_secs(1)).await;
        dates(&cache, fetch).await;
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        dates(&cache, fetch).await;
        assert_eq!(fetches.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failure_backs_off_and_keeps_the_last_good_dates() {
        let cache = Mutex::default();
        assert!(dates(&cache, || async { None }).await.is_empty());
        let fetches = AtomicUsize::new(0);
        let counted = |answer: Option<Vec<u8>>| {
            let fetches = &fetches;
            move || async move {
                fetches.fetch_add(1, Ordering::SeqCst);
                answer
            }
        };
        assert!(dates(&cache, counted(Some(catalog()))).await.is_empty());
        assert_eq!(fetches.load(Ordering::SeqCst), 0);
        tokio::time::advance(FAILURE_TTL).await;
        assert_eq!(dates(&cache, counted(Some(catalog()))).await.len(), 1);
        tokio::time::advance(SUCCESS_TTL).await;
        // A failed refresh, or a malformed catalog, keeps what was good.
        assert_eq!(dates(&cache, counted(None)).await.len(), 1);
        tokio::time::advance(FAILURE_TTL).await;
        assert_eq!(dates(&cache, counted(Some(b"{}".to_vec()))).await.len(), 1);
        assert_eq!(fetches.load(Ordering::SeqCst), 3);
    }
}
