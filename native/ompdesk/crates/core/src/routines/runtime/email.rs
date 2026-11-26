use serde::Deserialize;

use serde_json::{Value, json};

use super::{Timing, wait};
use crate::fs::order::{is_js_space, js_trim};
use crate::routines::{
    imap::{self, MailCursor, MailMessage},
    text::clip,
};
use crate::schedules::triggers::Context;
use crate::server::Scope;

#[derive(Deserialize)]
struct Account {
    id: String,
    label: String,
    address: String,
    connection: imap::Mailbox,
}

struct Options {
    from: Option<String>,
    subject: Option<String>,
    to: Option<String>,
}

fn integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0)
        .then_some(number as i64)
}

pub(super) async fn run(
    event: &Value,
    mark: Option<Value>,
    sink: &Context,
    scope: &Scope,
    timing: Timing,
) {
    let name = event["account"].as_str().unwrap_or_default();
    let needle = |key: &str| event[key].as_str().map(|text| js_trim(text).to_lowercase());
    let options = Options {
        from: needle("from"),
        subject: needle("subject"),
        to: needle("to"),
    };
    let mut cursor = mark.as_ref().and_then(|mark| {
        Some((
            mark["accountId"].as_str()?.to_owned(),
            MailCursor {
                validity: integer(&mark["validity"])?,
                uid: integer(&mark["uid"])?,
            },
        ))
    });
    let key = format!("email {name}: read");
    let mut failures = 0u32;
    loop {
        if scope.cancelled() || !sink.current() {
            return;
        }
        let account = sink.ask::<Option<Account>>("email", Some(name)).await;
        let result = match account {
            Ok(Some(account)) => {
                let known = cursor
                    .as_ref()
                    .filter(|(id, _)| id == &account.id)
                    .map(|(_, cursor)| *cursor);
                match imap::read_mailbox(&account.connection, known, scope).await {
                    Ok(read) => {
                        cursor = Some((account.id.clone(), read.cursor));
                        if scope.cancelled() || !sink.current() {
                            return;
                        }
                        let lines = if known.is_some() {
                            read.messages
                                .iter()
                                .filter(|message| wanted(message, &account.address, &options))
                                .map(|message| describe(message, &account.label))
                                .collect()
                        } else {
                            Vec::new()
                        };
                        sink.failure(&key, None);
                        failures = 0;
                        sink.publish(json!({"accountId":account.id,"validity":read.cursor.validity,"uid":read.cursor.uid}), &lines);
                        Ok(())
                    }
                    Err(error) => Err(error.message),
                }
            }
            Ok(None) => Err(
                "no mail account has that name or id (Settings › Schedules › Email accounts)"
                    .into(),
            ),
            Err(error) => Err(error.message),
        };
        if scope.cancelled() || !sink.current() {
            return;
        }
        if let Err(error) = result {
            sink.failure(&key, Some(&error));
            failures = failures.saturating_add(1);
        }
        if !wait(scope, poll_wait(timing.email_poll_ms, failures)).await {
            return;
        }
    }
}

/// Longest wait between reads while a mailbox keeps failing (after Orca's per-account Gmail backoff).
const FAILING_POLL_MAX_MS: u64 = 30 * 60_000;

/// The wait before the next read: the poll period, doubled for each failed read in a row, at most
/// `FAILING_POLL_MAX_MS` (never below the period itself).
fn poll_wait(period: u64, failures: u32) -> u64 {
    period
        .saturating_mul(1u64.checked_shl(failures).unwrap_or(u64::MAX))
        .min(FAILING_POLL_MAX_MS.max(period))
}

fn wanted(message: &MailMessage, own_address: &str, options: &Options) -> bool {
    let headers = &message.headers;
    let field = |name: &str| headers.get(name).map_or("", String::as_str);
    let auto = js_trim(field("auto-submitted"));
    if !auto.is_empty() && !auto.eq_ignore_ascii_case("no") {
        return false;
    }
    if !field("in-reply-to").is_empty() {
        let own = js_trim(own_address).to_lowercase();
        if !own.is_empty() && addresses(&field("from").to_lowercase()).any(|address| address == own)
        {
            return false;
        }
    }
    let has = |name, needle: &String| field(name).to_lowercase().contains(needle);
    // A From line alone can be forged: it counts only on mail the receiving server says passed DMARC (FX6 (a)).
    options
        .from
        .as_ref()
        .is_none_or(|needle| has("from", needle) && dmarc_passed(field("authentication-results")))
        && options
            .subject
            .as_ref()
            .is_none_or(|needle| has("subject", needle))
        && options.to.as_ref().is_none_or(|needle| {
            // Keep the separator: the TS filter could also match across two recipient fields.
            let mut recipients = String::new();
            for field in [field("to"), field("cc"), field("delivered-to")] {
                if field.is_empty() {
                    continue;
                }
                if !recipients.is_empty() {
                    recipients.push_str(", ");
                }
                recipients.push_str(field);
            }
            recipients.to_lowercase().contains(needle)
        })
}

/// Whether the receiving server's `Authentication-Results` (the topmost one, `imap::mime` keeps it alone) holds
/// `dmarc=pass`: after the authserv-id, each `;` part is a method's result (RFC 8601).
fn dmarc_passed(results: &str) -> bool {
    results.split(';').skip(1).any(|part| {
        let part = js_trim(part).to_lowercase();
        part.strip_prefix("dmarc=")
            .and_then(|rest| rest.split(|c: char| is_js_space(c) || c == '(').next())
            == Some("pass")
    })
}

fn addresses(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(|c| is_js_space(c) || matches!(c, '<' | '>' | '"' | ',' | ';'))
        .filter(|part| {
            part.match_indices('@')
                .any(|(at, _)| at > 0 && at + 1 < part.len())
        })
}

fn describe(message: &MailMessage, label: &str) -> String {
    let field = |name: &str| clip(message.headers.get(name).map_or("", String::as_str), 160);
    let subject = field("subject");
    let from = field("from");
    let to = field("to");
    let date = field("date");
    let text = clip(&message.snippet, 600);
    format!(
        "New mail in {label} from {} to {}: \"{}\"{}{}",
        if from.is_empty() {
            "an unknown sender"
        } else {
            &from
        },
        if to.is_empty() { "(no To)" } else { &to },
        if subject.is_empty() {
            "(no subject)"
        } else {
            &subject
        },
        if message
            .headers
            .get("date")
            .is_some_and(|date| !date.is_empty())
        {
            format!(" ({date})")
        } else {
            String::new()
        },
        if text.is_empty() {
            String::new()
        } else {
            format!(". It begins: {text}")
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[test]
    fn preserves_the_mail_filter_and_loop_guard_contract() {
        let options = Options {
            from: Some("ann@".into()),
            subject: Some("deploy".into()),
            to: Some("owner+ci@".into()),
        };
        let mut message = MailMessage {
            uid: 1,
            headers: BTreeMap::from([
                ("from".into(), "Ann <ANN@example.invalid>".into()),
                ("cc".into(), "Owner+Ci@example.invalid".into()),
                ("subject".into(), "Deploy v2 please".into()),
                (
                    "authentication-results".into(),
                    "mx.example.invalid; spf=pass smtp.mailfrom=example.invalid; DMARC=pass (p=none) header.from=example.invalid".into(),
                ),
            ]),
            snippet: "hello".into(),
        };
        assert!(wanted(&message, "owner@example.invalid", &options));
        // A From the receiving server did not see pass DMARC is no sender: a spoof fires nothing.
        for results in [
            "mx.example.invalid; spf=pass; dmarc=fail (p=reject) header.from=example.invalid",
            "mx.example.invalid; none",
            "dmarc=pass",
            "",
        ] {
            let mut spoof = MailMessage {
                uid: 2,
                headers: message.headers.clone(),
                snippet: String::new(),
            };
            spoof
                .headers
                .insert("authentication-results".into(), results.into());
            assert!(
                !wanted(&spoof, "owner@example.invalid", &options),
                "{results}"
            );
        }
        message
            .headers
            .insert("auto-submitted".into(), " auto-replied ".into());
        assert!(!wanted(&message, "owner@example.invalid", &options));
        message.headers.remove("auto-submitted");
        message
            .headers
            .insert("from".into(), "Owner <OWNER@example.invalid>".into());
        message
            .headers
            .insert("in-reply-to".into(), "<earlier@example.invalid>".into());
        let all = Options {
            from: None,
            subject: None,
            to: None,
        };
        assert!(!wanted(&message, " owner@example.invalid ", &all));
        message.headers.remove("in-reply-to");
        assert!(wanted(&message, "owner@example.invalid", &all));
        assert!(describe(&message, "Work").contains("It begins: hello"));
    }

    #[test]
    fn a_failing_mailbox_is_read_less_often_up_to_thirty_minutes() {
        let period = 2 * 60_000;
        assert_eq!(poll_wait(period, 0), period);
        assert_eq!(poll_wait(period, 1), 2 * period);
        assert_eq!(poll_wait(period, 3), 8 * period);
        assert_eq!(poll_wait(period, 4), FAILING_POLL_MAX_MS);
        assert_eq!(poll_wait(period, 200), FAILING_POLL_MAX_MS);
        // A test's short period still doubles; one longer than the cap is never cut below itself.
        assert_eq!(poll_wait(5, 2), 20);
        assert_eq!(
            poll_wait(FAILING_POLL_MAX_MS * 2, 3),
            FAILING_POLL_MAX_MS * 2
        );
    }
}
