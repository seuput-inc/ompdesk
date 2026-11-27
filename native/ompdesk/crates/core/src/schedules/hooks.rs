//! A routine's webhook call as the edge hands it over (`schedules.webhook`): whether its sender signed it, what of it
//! the routine's "only when" filters read, the fields its run is quoted, and the delivery id a sender's retry repeats.
//! Pure functions; the engine (`engine.rs`) keeps what a routine holds.
//!
//! Signatures after Orca's sender adapters (`shared/connector-webhook-contract.ts:41-48`,
//! `bots/webhooks/WebhookSecretDialog.tsx`; Orca checks them in its cloud, re-implemented here from each sender's
//! documented scheme): an HMAC-SHA256 over the raw body (with the id and timestamp where the sender signs them),
//! compared in constant time, and a timestamp window where the sender signs one. "Only when" after
//! `bots/webhooks/webhook-filter-text.tsx` and `cli/webhooks/webhook-trigger-spec.ts`: paths start at `body` or
//! `headers`.

use std::collections::BTreeMap;

use base64::Engine as _;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq as _;

/// How far a signed timestamp may be from now: Standard Webhooks' and Stripe's tolerance.
const SIGNED_WINDOW_MS: i64 = 5 * 60_000;
/// Linear asks a receiver to refuse a delivery whose `webhookTimestamp` is over a minute away.
const LINEAR_WINDOW_MS: i64 = 60_000;
/// The most of a picked field, or of the body's start, a run is quoted.
const QUOTED_CHARS: usize = 200;
/// Where each sender names a delivery its retries repeat (a header), checked in this order.
const DELIVERY_HEADERS: [&str; 5] = [
    "webhook-id",
    "x-github-delivery",
    "linear-delivery",
    "x-webhook-id",
    "idempotency-key",
];
/// Headers a run is never told and no filter reads: credentials.
const SECRET_HEADERS: [&str; 3] = ["authorization", "cookie", "proxy-authorization"];

/// Whose signature a call carries (`WEBHOOK_SENDERS` in `src/shared/schedules.ts`; Slack's is a bot's Slack connector's,
/// whose signing secret main hands over with each call and this never keeps).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sender {
    Standard,
    Github,
    Sentry,
    Linear,
    Pagerduty,
    Stripe,
    Slack,
}

impl Sender {
    pub fn parse(name: &str) -> Option<Sender> {
        Some(match name {
            "standard" => Sender::Standard,
            "github" => Sender::Github,
            "sentry" => Sender::Sentry,
            "linear" => Sender::Linear,
            "pagerduty" => Sender::Pagerduty,
            "stripe" => Sender::Stripe,
            "slack" => Sender::Slack,
            _ => return None,
        })
    }

    /// As `WEBHOOK_SENDERS` spells it.
    pub fn name(self) -> &'static str {
        match self {
            Sender::Standard => "standard",
            Sender::Github => "github",
            Sender::Sentry => "sentry",
            Sender::Linear => "linear",
            Sender::Pagerduty => "pagerduty",
            Sender::Stripe => "stripe",
            Sender::Slack => "slack",
        }
    }

    pub fn display(self) -> &'static str {
        match self {
            Sender::Standard => "Standard Webhooks",
            Sender::Github => "GitHub",
            Sender::Sentry => "Sentry",
            Sender::Linear => "Linear",
            Sender::Pagerduty => "PagerDuty",
            Sender::Stripe => "Stripe",
            Sender::Slack => "Slack",
        }
    }
}

/// HMAC-SHA256 (RFC 2104) of `parts` in a row, with `sha2` alone.
pub(super) fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut block = [0_u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    for part in parts {
        inner.update(part);
    }
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(&inner[..]);
    let mut mac = [0_u8; 32];
    mac.copy_from_slice(&outer.finalize());
    mac
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok())
        .collect()
}

/// Whether one of `given` (hex, or base64 with `base64`) is `mac`, each compared in constant time.
fn one_is<'a>(mac: &[u8; 32], given: impl IntoIterator<Item = &'a str>, base64: bool) -> bool {
    given.into_iter().any(|text| {
        let bytes = if base64 {
            base64::engine::general_purpose::STANDARD
                .decode(text.trim())
                .ok()
        } else {
            unhex(text)
        };
        bytes.is_some_and(|bytes| bool::from(bytes.as_slice().ct_eq(mac.as_slice())))
    })
}

const NO_SIGNATURE: &str = "no signature";
const BAD_SIGNATURE: &str = "wrong signature";
const NO_TIMESTAMP: &str = "no signed timestamp";
const STALE: &str = "signed too long ago or ahead of this computer's clock";

fn within(signed_ms: i64, now: i64, window: i64) -> Result<(), &'static str> {
    if (now - signed_ms).abs() <= window {
        Ok(())
    } else {
        Err(STALE)
    }
}

/// A Standard Webhooks secret's key: the bytes of `whsec_<base64>`, else the text itself.
fn standard_key(secret: &str) -> Option<Vec<u8>> {
    match secret.strip_prefix("whsec_") {
        Some(encoded) => base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()
            .filter(|key| !key.is_empty()),
        None => Some(secret.as_bytes().to_vec()),
    }
}

/// Whether `secret` can sign for `sender` (a `whsec_` secret must decode).
pub fn secret_usable(sender: Sender, secret: &str) -> bool {
    !secret.is_empty() && (sender != Sender::Standard || standard_key(secret).is_some())
}

/// Whether the call is signed with `secret` as `sender` signs; why not, in the words its recent call shows.
pub fn verify(
    sender: Sender,
    secret: &str,
    headers: &BTreeMap<String, String>,
    body: &[u8],
    now: i64,
) -> Result<(), &'static str> {
    let header = |name: &str| headers.get(name).map(String::as_str).ok_or(NO_SIGNATURE);
    let over_body = || hmac_sha256(secret.as_bytes(), &[body]);
    let signed = |ok: bool| if ok { Ok(()) } else { Err(BAD_SIGNATURE) };
    match sender {
        Sender::Github => {
            let given = header("x-hub-signature-256")?;
            signed(one_is(&over_body(), given.strip_prefix("sha256="), false))
        }
        Sender::Sentry => signed(one_is(
            &over_body(),
            [header("sentry-hook-signature")?],
            false,
        )),
        Sender::Pagerduty => {
            let given = header("x-pagerduty-signature")?;
            let each = given
                .split(',')
                .filter_map(|part| part.trim().strip_prefix("v1="));
            signed(one_is(&over_body(), each, false))
        }
        Sender::Linear => {
            signed(one_is(&over_body(), [header("linear-signature")?], false))?;
            // Linear signs its body, whose `webhookTimestamp` (ms) says when the delivery was sent.
            let sent = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|body| body.get("webhookTimestamp")?.as_f64())
                .ok_or(NO_TIMESTAMP)?;
            within(sent as i64, now, LINEAR_WINDOW_MS)
        }
        Sender::Stripe => {
            let given = header("stripe-signature")?;
            let mut at = None;
            let mut signatures = Vec::new();
            for part in given.split(',') {
                match part.trim().split_once('=') {
                    Some(("t", time)) => at = Some(time),
                    Some(("v1", signature)) => signatures.push(signature),
                    _ => {}
                }
            }
            let at = at.ok_or(NO_TIMESTAMP)?;
            let mac = hmac_sha256(secret.as_bytes(), &[at.as_bytes(), b".", body]);
            signed(one_is(&mac, signatures, false))?;
            within(
                at.parse::<i64>().map_err(|_| NO_TIMESTAMP)? * 1000,
                now,
                SIGNED_WINDOW_MS,
            )
        }
        // Slack's v0: `v0=` and the hex HMAC of `v0:<timestamp>:<body>`, its timestamp (seconds) within five minutes.
        Sender::Slack => {
            let at = header("x-slack-request-timestamp").map_err(|_| NO_TIMESTAMP)?;
            let given = header("x-slack-signature")?;
            let at = at.trim();
            let mac = hmac_sha256(
                secret.as_bytes(),
                &["v0:".as_bytes(), at.as_bytes(), b":", body],
            );
            signed(!secret.is_empty() && one_is(&mac, given.trim().strip_prefix("v0="), false))?;
            within(
                at.parse::<i64>().map_err(|_| NO_TIMESTAMP)? * 1000,
                now,
                SIGNED_WINDOW_MS,
            )
        }
        Sender::Standard => {
            let id = header("webhook-id")?;
            let at = header("webhook-timestamp").map_err(|_| NO_TIMESTAMP)?;
            let given = header("webhook-signature")?;
            let key = standard_key(secret).ok_or(BAD_SIGNATURE)?;
            let mac = hmac_sha256(&key, &[id.as_bytes(), b".", at.as_bytes(), b".", body]);
            let each = given.split(' ').filter_map(|part| part.strip_prefix("v1,"));
            signed(one_is(&mac, each, true))?;
            within(
                at.trim().parse::<i64>().map_err(|_| NO_TIMESTAMP)? * 1000,
                now,
                SIGNED_WINDOW_MS,
            )
        }
    }
}

/// What the filters read and the run is quoted: `{"body": <JSON, else the text>, "headers": {...}}`, credentials left
/// out.
pub fn document(headers: &BTreeMap<String, String>, body: &[u8]) -> Value {
    let body = serde_json::from_slice::<Value>(body)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(body).into_owned()));
    let headers: Map<String, Value> = headers
        .iter()
        .filter(|(name, _)| !SECRET_HEADERS.contains(&name.as_str()))
        .map(|(name, value)| (name.clone(), Value::String(value.clone())))
        .collect();
    json!({ "body": body, "headers": headers })
}

/// The value at `path` (`body.items[0].id`, `headers.x-github-event`); none when a step is missing.
pub fn lookup<'a>(document: &'a Value, path: &str) -> Option<&'a Value> {
    let mut at = document;
    for segment in path.split('.') {
        let (name, mut rest) = match segment.find('[') {
            Some(open) => segment.split_at(open),
            None => (segment, ""),
        };
        if !name.is_empty() {
            let object = at.as_object()?;
            at = match object.get(name) {
                Some(value) => value,
                None => object.get(&name.to_ascii_lowercase())?,
            };
        }
        while let Some(inner) = rest.strip_prefix('[') {
            let (index, after) = inner.split_once(']')?;
            at = at.as_array()?.get(index.parse::<usize>().ok()?)?;
            rest = after;
        }
        if !rest.is_empty() {
            return None;
        }
    }
    Some(at)
}

/// A value as a filter compares it: text as written, anything else as JSON.
fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Whether one "only when" test holds (`WebhookWhere`); a missing or null value is absent.
fn holds(document: &Value, test: &Value) -> bool {
    let path = test.get("path").and_then(Value::as_str).unwrap_or_default();
    let found = lookup(document, path).filter(|value| !value.is_null());
    let values: Vec<&str> = test
        .get("values")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let equal = |value: &Value| values.contains(&text_of(value).as_str());
    let contains = |value: &Value| {
        let text = text_of(value).to_lowercase();
        values
            .iter()
            .any(|needle| text.contains(&needle.to_lowercase()))
    };
    match test.get("op").and_then(Value::as_str) {
        Some("=") => found.is_some_and(equal),
        Some("!=") => !found.is_some_and(equal),
        Some("contains") => found.is_some_and(|value| match value {
            Value::Array(items) => items.iter().any(contains),
            value => contains(value),
        }),
        Some("exists") => found.is_some(),
        Some("!exists") => found.is_none(),
        _ => false,
    }
}

/// Whether a call passes its routine's "only when" (`where`, every test; `contains`, in the body, case aside).
pub fn wanted(event: &Value, document: &Value, body: &[u8]) -> bool {
    let mut tests = event
        .get("where")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    let contained = event
        .get("contains")
        .and_then(Value::as_str)
        .is_none_or(|needle| {
            String::from_utf8_lossy(body)
                .to_lowercase()
                .contains(&needle.to_lowercase())
        });
    contained && tests.all(|test| holds(document, test))
}

/// One line, at most `QUOTED_CHARS` characters.
fn short(text: &str) -> String {
    let line = super::rules::one_line(text);
    match line.char_indices().nth(QUOTED_CHARS) {
        Some((end, _)) => format!("{}…", &line[..end]),
        None => line,
    }
}

/// What a run is told of a call: who signed it, where its whole body is, then the picked fields (`path: value`), or
/// the start of the body when none are picked.
pub fn detail(
    event: &Value,
    document: &Value,
    body: &[u8],
    file: Option<&str>,
    sample: bool,
) -> String {
    let mut parts = vec![
        match (sample, event.get("signedBy").and_then(Value::as_str)) {
            (true, _) => "Sample webhook call from Settings".to_owned(),
            (false, Some(sender)) => format!(
                "Webhook call signed by {}",
                Sender::parse(sender).map_or(sender, |sender| sender.display())
            ),
            (false, None) => "Webhook call".to_owned(),
        },
    ];
    if let Some(file) = file {
        parts.push(format!("full body in {file}"));
    }
    let picks: Vec<&str> = event
        .get("pick")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if picks.is_empty() {
        let text = short(&String::from_utf8_lossy(body));
        parts.push(if text.is_empty() {
            "no body".to_owned()
        } else {
            text
        });
    }
    for path in picks {
        let value =
            lookup(document, path).map_or_else(|| "(missing)".to_owned(), |v| short(&text_of(v)));
        parts.push(format!("{path}: {value}"));
    }
    parts.join(" · ")
}

/// The delivery a sender's retry repeats: a delivery header, else the event id Stripe and PagerDuty put in the body.
pub fn delivery(
    headers: &BTreeMap<String, String>,
    document: &Value,
    sender: Option<Sender>,
) -> Option<String> {
    for name in DELIVERY_HEADERS {
        if let Some(value) = headers.get(name).filter(|value| !value.trim().is_empty()) {
            return Some(format!("{name}:{}", value.trim()));
        }
    }
    let id = match sender? {
        Sender::Stripe => lookup(document, "body.id"),
        Sender::Pagerduty => lookup(document, "body.event.id"),
        Sender::Slack => lookup(document, "body.event_id"),
        _ => None,
    }?;
    id.as_str()
        .filter(|id| !id.is_empty())
        .map(|id| format!("event:{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        // Test case 2: a short key.
        assert_eq!(
            crate::hex(&hmac_sha256(
                b"Jefe",
                &[b"what do ya want ", b"for nothing?"]
            )),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // Test case 6: a key longer than the block is hashed first.
        assert_eq!(
            crate::hex(&hmac_sha256(
                &[0xaa; 131],
                &[b"Test Using Larger Than Block-Size Key - Hash Key First"]
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn github_sentry_and_pagerduty_sign_the_body() {
        let body = br#"{"action":"opened"}"#;
        let mac = crate::hex(&hmac_sha256(b"s3cret", &[body]));
        let github = format!("sha256={mac}");
        let github = headers(&[("x-hub-signature-256", github.as_str())]);
        assert_eq!(verify(Sender::Github, "s3cret", &github, body, 0), Ok(()));
        assert_eq!(
            verify(Sender::Github, "other", &github, body, 0),
            Err(BAD_SIGNATURE)
        );
        assert_eq!(
            verify(Sender::Github, "s3cret", &github, b"{}", 0),
            Err(BAD_SIGNATURE)
        );
        assert_eq!(
            verify(Sender::Github, "s3cret", &headers(&[]), body, 0),
            Err(NO_SIGNATURE)
        );
        // A bare hex value without GitHub's `sha256=` is not its signature.
        let bare = headers(&[("x-hub-signature-256", mac.as_str())]);
        assert_eq!(
            verify(Sender::Github, "s3cret", &bare, body, 0),
            Err(BAD_SIGNATURE)
        );
        let sentry = headers(&[("sentry-hook-signature", mac.as_str())]);
        assert_eq!(verify(Sender::Sentry, "s3cret", &sentry, body, 0), Ok(()));
        let pagerduty = format!("v1=00ff, v1={mac}");
        let pagerduty = headers(&[("x-pagerduty-signature", pagerduty.as_str())]);
        assert_eq!(
            verify(Sender::Pagerduty, "s3cret", &pagerduty, body, 0),
            Ok(())
        );
    }

    #[test]
    fn slack_signs_v0_with_its_timestamp_within_five_minutes() {
        let body = br#"{"type":"event_callback","event_id":"Ev1"}"#;
        let at = "1700000000";
        let mac = crate::hex(&hmac_sha256(
            b"shh",
            &[b"v0:".as_slice(), at.as_bytes(), b":", body],
        ));
        let signature = format!("v0={mac}");
        let signed = headers(&[
            ("x-slack-signature", signature.as_str()),
            ("x-slack-request-timestamp", at),
        ]);
        let now = 1_700_000_000_000;
        assert_eq!(
            verify(Sender::Slack, "shh", &signed, body, now + 299_000),
            Ok(())
        );
        assert_eq!(
            verify(Sender::Slack, "shh", &signed, body, now + 301_000),
            Err(STALE)
        );
        assert_eq!(
            verify(Sender::Slack, "other", &signed, body, now),
            Err(BAD_SIGNATURE)
        );
        assert_eq!(
            verify(Sender::Slack, "", &signed, body, now),
            Err(BAD_SIGNATURE)
        );
        let bare = headers(&[
            ("x-slack-signature", mac.as_str()),
            ("x-slack-request-timestamp", at),
        ]);
        assert_eq!(
            verify(Sender::Slack, "shh", &bare, body, now),
            Err(BAD_SIGNATURE)
        );
        let document = document(&BTreeMap::new(), body);
        assert_eq!(
            delivery(&BTreeMap::new(), &document, Some(Sender::Slack)).as_deref(),
            Some("event:Ev1")
        );
    }

    #[test]
    fn stripe_signs_its_timestamp_and_refuses_an_old_one() {
        let body = br#"{"id":"evt_1"}"#;
        let mac = crate::hex(&hmac_sha256(b"whsec_x", &[b"1700000000", b".", body]));
        let given = format!("t=1700000000,v1=bad,v1={mac}");
        let given = headers(&[("stripe-signature", given.as_str())]);
        let at = 1_700_000_000_000;
        assert_eq!(
            verify(Sender::Stripe, "whsec_x", &given, body, at + 1000),
            Ok(())
        );
        assert_eq!(
            verify(
                Sender::Stripe,
                "whsec_x",
                &given,
                body,
                at + SIGNED_WINDOW_MS + 1
            ),
            Err(STALE)
        );
        // The timestamp is signed: another one breaks the signature.
        let moved = format!("t=1700000001,v1={mac}");
        let moved = headers(&[("stripe-signature", moved.as_str())]);
        assert_eq!(
            verify(Sender::Stripe, "whsec_x", &moved, body, at),
            Err(BAD_SIGNATURE)
        );
    }

    #[test]
    fn standard_webhooks_sign_id_timestamp_and_body_with_the_decoded_secret() {
        let key = b"0123456789abcdef";
        let secret = format!(
            "whsec_{}",
            base64::engine::general_purpose::STANDARD.encode(key)
        );
        let body = b"{}";
        let mac = hmac_sha256(key, &[b"msg_1", b".", b"1700000000", b".", body]);
        let signature = base64::engine::general_purpose::STANDARD.encode(mac);
        let signed = format!("v1,AAAA v1,{signature}");
        let given = headers(&[
            ("webhook-id", "msg_1"),
            ("webhook-timestamp", "1700000000"),
            ("webhook-signature", signed.as_str()),
        ]);
        let at = 1_700_000_000_000;
        assert_eq!(verify(Sender::Standard, &secret, &given, body, at), Ok(()));
        assert_eq!(
            verify(
                Sender::Standard,
                &secret,
                &given,
                body,
                at - SIGNED_WINDOW_MS - 1
            ),
            Err(STALE)
        );
        assert!(secret_usable(Sender::Standard, &secret));
        assert!(!secret_usable(Sender::Standard, "whsec_***"));
    }

    #[test]
    fn linear_signs_the_body_whose_timestamp_must_be_fresh() {
        let at = 1_700_000_000_000_i64;
        let body = format!(r#"{{"action":"create","webhookTimestamp":{at}}}"#);
        let mac = crate::hex(&hmac_sha256(b"lin", &[body.as_bytes()]));
        let given = headers(&[("linear-signature", mac.as_str())]);
        assert_eq!(
            verify(Sender::Linear, "lin", &given, body.as_bytes(), at + 500),
            Ok(())
        );
        assert_eq!(
            verify(
                Sender::Linear,
                "lin",
                &given,
                body.as_bytes(),
                at + LINEAR_WINDOW_MS + 1
            ),
            Err(STALE)
        );
    }

    #[test]
    fn only_when_reads_body_and_header_paths() {
        let given = headers(&[
            ("x-github-event", "pull_request"),
            ("authorization", "Bearer k"),
        ]);
        let body = br#"{"action":"opened","items":[{"id":7}],"labels":["Bug","ui"],"level":null}"#;
        let document = document(&given, body);
        assert_eq!(lookup(&document, "body.items[0].id"), Some(&json!(7)));
        assert_eq!(
            lookup(&document, "headers.X-GitHub-Event"),
            Some(&json!("pull_request"))
        );
        assert_eq!(lookup(&document, "headers.authorization"), None);
        let event = |tests: Value| json!({ "where": tests });
        let pass = |tests: Value| wanted(&event(tests), &document, body);
        assert!(pass(
            json!([{"path":"body.action","op":"=","values":["closed","opened"]}])
        ));
        assert!(!pass(
            json!([{"path":"body.action","op":"!=","values":["opened"]}])
        ));
        assert!(pass(
            json!([{"path":"body.missing","op":"!=","values":["x"]}])
        ));
        assert!(pass(
            json!([{"path":"body.items[0].id","op":"=","values":["7"]}])
        ));
        assert!(pass(
            json!([{"path":"body.labels","op":"contains","values":["BUG"]}])
        ));
        assert!(pass(json!([{"path":"body.level","op":"!exists"}])));
        assert!(!pass(json!([{"path":"body.level","op":"exists"}])));
        assert!(pass(
            json!([{"path":"headers.x-github-event","op":"exists"},{"path":"body.action","op":"contains","values":["OPEN"]}])
        ));
        assert!(!pass(
            json!([{"path":"body.action","op":"exists"},{"path":"body.nope","op":"exists"}])
        ));
        assert!(wanted(&json!({"contains":"OPENED"}), &document, body));
        assert!(!wanted(&json!({"contains":"merged"}), &document, body));
    }

    #[test]
    fn a_run_is_told_the_picked_fields_and_where_the_body_is() {
        let body = br#"{"action":"opened","pull_request":{"title":"Fix the build"}}"#;
        let document = document(&headers(&[]), body);
        let event = json!({"signedBy":"github","pick":["body.pull_request.title","body.nope"]});
        assert_eq!(
            detail(&event, &document, body, Some("/runs/c.webhook.json"), false),
            "Webhook call signed by GitHub · full body in /runs/c.webhook.json · body.pull_request.title: Fix the build · body.nope: (missing)"
        );
        assert_eq!(
            detail(&json!({}), &document, b"", None, true),
            "Sample webhook call from Settings · no body"
        );
    }

    #[test]
    fn a_retry_repeats_its_delivery() {
        let document = document(&headers(&[]), br#"{"id":"evt_9","event":{"id":"pd_1"}}"#);
        let github = headers(&[("x-github-delivery", "abc")]);
        assert_eq!(
            delivery(&github, &document, None).as_deref(),
            Some("x-github-delivery:abc")
        );
        assert_eq!(
            delivery(&headers(&[]), &document, Some(Sender::Stripe)).as_deref(),
            Some("event:evt_9")
        );
        assert_eq!(
            delivery(&headers(&[]), &document, Some(Sender::Pagerduty)).as_deref(),
            Some("event:pd_1")
        );
        assert_eq!(delivery(&headers(&[]), &document, None), None);
    }
}
