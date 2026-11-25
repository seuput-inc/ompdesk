use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use url::form_urlencoded;

use super::front::HttpError;
use crate::web::auth::{js_space, lenient_base64};

pub(super) const RECORDS: &[u8] = b"ompdesk-stats ";

pub(super) struct Query {
    pub line: String,
    pub reply: oneshot::Sender<Vec<u8>>,
}

const MAX_SAFE: u64 = (1 << 53) - 1;
type Cursor = (i64, i64, Option<i64>, i64, String, i64);

fn cursor(text: &str, range: &str) -> Option<Cursor> {
    if text.encode_utf16().take(513).count() > 512 {
        return None;
    }
    let bytes = lenient_base64(text);
    let (at, id, cutoff, until, r, max): (f64, f64, Option<f64>, f64, String, f64) =
        serde_json::from_slice(&bytes).ok()?;
    (r == range
        && [at, id, cutoff.unwrap_or(0.0), until, max]
            .iter()
            .all(|n| n.fract() == 0.0 && n.abs() <= MAX_SAFE as f64)
        && id > 0.0
        && max >= id
        && at <= until
        && cutoff.is_none_or(|c| c <= until))
    .then(|| {
        (
            at as i64,
            id as i64,
            cutoff.map(|c| c as i64),
            until as i64,
            r,
            max as i64,
        )
    })
}

fn page_limit(text: &str) -> Option<u32> {
    let text = text.trim_matches(js_space);
    for (prefix, base) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if text
            .get(..2)
            .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
        {
            let digits = &text[2..];
            if digits.starts_with('+') {
                return None;
            }
            return u32::from_str_radix(digits, base)
                .ok()
                .filter(|n| (1..=200).contains(n));
        }
    }
    text.parse::<f64>()
        .ok()
        .filter(|n| n.fract() == 0.0 && (1.0..=200.0).contains(n))
        .map(|n| n as u32)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Records {
    rows: Vec<Value>,
    total: u64,
    more: bool,
    cutoff: Option<i64>,
    max_id: i64,
}

pub(super) async fn page(query: &str, db: &mpsc::Sender<Query>) -> Result<Value, HttpError> {
    let (mut range, mut limit, mut after) = (None, None, None);
    for (k, v) in form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "range" if range.is_none() => range = Some(v),
            "limit" if limit.is_none() => limit = Some(v),
            "cursor" if after.is_none() => after = Some(v),
            _ => {}
        }
    }
    let range = range.as_deref().unwrap_or("24h");
    let limit = page_limit(limit.as_deref().unwrap_or("50"))
        .ok_or((400, "limit must be an integer from 1 to 200"))?;
    if !matches!(range, "1h" | "24h" | "7d" | "30d" | "90d" | "all") {
        return Err((400, "Invalid request range"));
    }
    let c = after
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| cursor(s, range).ok_or((400, "Invalid request cursor")))
        .transpose()?;
    let until = c
        .as_ref()
        .map_or_else(|| crate::clock::now_ms() as i64, |c| c.3);
    // Only this process can write the worker's stdin. No HTTP caller can supply SQL.
    // Keep both timestamp bounds usable by the index, including when stock returns no lower bound.
    let bounds = "timestamp BETWEEN COALESCE(?3, -1e999) AND ?1 AND id <= ?2";
    let (seek, take) = if c.is_some() {
        (" AND (timestamp, id) < (?4, ?5)", "?6")
    } else {
        ("", "?4")
    };
    let line = json!({"range": range, "until": until, "limit": limit, "cursor": c,
        "maxSql": "SELECT COALESCE(MAX(id), 0) AS id FROM messages",
        "countSql": format!("SELECT COUNT(*) AS count FROM messages WHERE {bounds}"),
        "idsSql": format!("SELECT id FROM messages WHERE {bounds}{seek} ORDER BY timestamp DESC, id DESC LIMIT {take}")
    }).to_string();
    let (reply, rx) = oneshot::channel();
    let gone = (503, "Stats database worker is not running");
    db.send(Query { line, reply }).await.map_err(|_| gone)?;
    let raw = rx.await.map_err(|_| gone)?;
    let r: Records = serde_json::from_slice(&raw[RECORDS.len()..])
        .map_err(|_| (500, "Stats database read failed"))?;
    let next = r.rows.last().filter(|_| r.more).and_then(|row| {
        let key = (
            row.get("timestamp")?.as_i64()?,
            row.get("id")?.as_i64()?,
            r.cutoff,
            until,
            range,
            r.max_id,
        );
        Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&key).ok()?))
    });
    let mut result = json!({"total": r.total, "nextCursor": next, "snapshotAt": until});
    result["rows"] = Value::Array(r.rows);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_uses_the_previous_number_conversion() {
        for valid in ["50", " 5e1 ", "50.0", "0x32", "0b110010", "0o62"] {
            assert_eq!(page_limit(valid), Some(50));
        }
        for invalid in ["", "0", "201", "1.5", "0x+2", "Inf"] {
            assert_eq!(page_limit(invalid), None);
        }
    }

    #[test]
    fn cursor_is_pinned_to_a_range_and_snapshot() {
        let valid = URL_SAFE_NO_PAD.encode("[80,3,null,90,\"all\",4]");
        assert!(cursor(&valid, "all").is_some());
        assert!(cursor(&valid, "7d").is_none());
        for invalid in [
            "[91,3,null,90,\"all\",4]",
            "[80,5,null,90,\"all\",4]",
            "[80,3,91,90,\"all\",4]",
            "[80,0,null,90,\"all\",4]",
            "[80,3,null,9007199254740992,\"all\",4]",
        ] {
            assert!(cursor(&URL_SAFE_NO_PAD.encode(invalid), "all").is_none());
        }
    }
}
