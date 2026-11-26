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
                                .filter(|message| {
                                    wanted(
                                        message,
                                        &account.address,
                                        account.connection.host(),
                                        &options,
                                    )
                                })
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

/// Whether a new mail starts the routine. `receiver` is the IMAP server the mailbox is read from: only its own
/// `Authentication-Results` can vouch for a sender.
fn wanted(message: &MailMessage, own_address: &str, receiver: &str, options: &Options) -> bool {
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
    // A From line alone can be forged: it counts only on mail the receiving server says passed DMARC for its
    // domain (FX6 (a)).
    options.from.as_ref().is_none_or(|needle| {
        sent_by(
            field("from"),
            field("authentication-results"),
            receiver,
            needle,
        )
    }) && options
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

/// Whether mail with this From header comes from `needle` (an address, or a domain with or without a leading `@`):
/// the header names exactly one address that is the needle or lies in its domain, and the receiving server vouches
/// that the address's domain passed DMARC. Without that proof the answer is no.
fn sent_by(from: &str, results: &str, receiver: &str, needle: &str) -> bool {
    let Some(address) = sole_address(from) else {
        return false;
    };
    let domain = address.rsplit_once('@').map_or("", |(_, domain)| domain);
    let matches = match needle.strip_prefix('@') {
        Some(wanted) => within(domain, wanted),
        None if needle.contains('@') => address == needle,
        None => within(domain, needle),
    };
    matches && dmarc_passed(results, receiver, domain)
}

/// `domain` is `parent` or one of its subdomains.
fn within(domain: &str, parent: &str) -> bool {
    !parent.is_empty()
        && (domain == parent
            || domain
                .strip_suffix(parent)
                .is_some_and(|head| head.ends_with('.')))
}

/// The one address a From header names (RFC 5322 `mailbox`), lower-cased. None for no address, two or more, a
/// group, or an address written in the display name: quoted text and comments are display text, never the sender.
fn sole_address(value: &str) -> Option<String> {
    let mut bare = String::new();
    let mut chars = value.chars();
    let (mut quoted, mut depth) = (false, 0u32);
    while let Some(c) = chars.next() {
        if quoted || depth > 0 {
            match c {
                '\\' => {
                    chars.next();
                }
                '"' if quoted => quoted = false,
                '(' if !quoted => depth += 1,
                ')' if !quoted => depth -= 1,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => quoted = true,
            '(' => depth = 1,
            _ => {
                bare.push(c);
                continue;
            }
        }
        bare.push(' ');
    }
    if quoted || depth > 0 || bare.contains([',', ';', ':']) {
        return None;
    }
    let spec = match (
        bare.find('<'),
        bare.rfind('<'),
        bare.find('>'),
        bare.rfind('>'),
    ) {
        (Some(open), Some(last_open), Some(close), Some(last_close))
            if open == last_open && close == last_close && open < close =>
        {
            if bare[..open].contains('@') || !js_trim(&bare[close + 1..]).is_empty() {
                return None;
            }
            &bare[open + 1..close]
        }
        (None, None, None, None) => &bare[..],
        _ => return None,
    };
    let spec = js_trim(spec);
    let (local, domain) = spec.split_once('@')?;
    (!local.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && !spec.chars().any(is_js_space))
    .then(|| spec.to_lowercase())
}

/// Whether the receiving server vouches that `from_domain` passed DMARC: the topmost `Authentication-Results`
/// (`imap::mime` keeps it alone) names an authserv-id of the mailbox's server and holds `dmarc=pass` with
/// `header.from=` that domain (RFC 8601). No header, no `header.from` or another server's id vouches for nothing.
fn dmarc_passed(results: &str, receiver: &str, from_domain: &str) -> bool {
    let mut parts = results.split(';');
    let id = parts
        .next()
        .and_then(|head| js_trim(head).split(is_js_space).next())
        .unwrap_or_default()
        .to_lowercase();
    if from_domain.is_empty() || !trusted_id(&id, receiver) {
        return false;
    }
    parts.any(|part| {
        let part = js_trim(part).to_lowercase();
        let Some(rest) = part.strip_prefix("dmarc=") else {
            return false;
        };
        let mut words = rest.split(|c: char| is_js_space(c) || c == '(' || c == ')');
        words.next() == Some("pass")
            && words.any(|word| {
                word.strip_prefix("header.from=")
                    .is_some_and(|domain| domain.trim_matches('"') == from_domain)
            })
    })
}

/// An authserv-id is the receiver's when it is the IMAP host itself or a name in the host's registrable domain
/// (`mx.example.com` for `imap.example.com`). Anything else, a sender's own header included, is not trusted.
fn trusted_id(id: &str, receiver: &str) -> bool {
    let host = js_trim(receiver).trim_end_matches('.').to_lowercase();
    if id.is_empty() || host.is_empty() {
        return false;
    }
    if id == host {
        return true;
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    let site = registrable(&host);
    site.contains('.') && within(id, site)
}

/// A host's registrable domain without a public-suffix list: its last two labels, or three under a two-letter
/// country code with a short second level (`co.uk`, `com.au`, `ne.jp`), so a suffix strangers share is never it.
/// Empty when the host has fewer labels than that.
fn registrable(host: &str) -> &str {
    let labels: Vec<&str> = host.split('.').collect();
    let keep = match labels.as_slice() {
        [.., second, top] if top.len() == 2 && second.len() <= 3 => 3,
        _ => 2,
    };
    if labels.len() < keep {
        return "";
    }
    let start: usize = labels[..labels.len() - keep]
        .iter()
        .map(|label| label.len() + 1)
        .sum();
    &host[start..]
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
    /// The mailbox's IMAP server: `mx.example.invalid` shares its registrable domain.
    const RECEIVER: &str = "imap.example.invalid";
    const PASSED: &str = "mx.example.invalid; spf=pass smtp.mailfrom=example.invalid; DMARC=pass (p=none) header.from=example.invalid";

    fn mail(from: &str, results: &str) -> MailMessage {
        MailMessage {
            uid: 1,
            headers: BTreeMap::from([
                ("from".into(), from.into()),
                ("cc".into(), "Owner+Ci@example.invalid".into()),
                ("subject".into(), "Deploy v2 please".into()),
                ("authentication-results".into(), results.into()),
            ]),
            snippet: "hello".into(),
        }
    }

    #[test]
    fn preserves_the_mail_filter_and_loop_guard_contract() {
        let options = Options {
            from: Some("ann@example.invalid".into()),
            subject: Some("deploy".into()),
            to: Some("owner+ci@".into()),
        };
        let mut message = mail("Ann <ANN@example.invalid>", PASSED);
        assert!(wanted(
            &message,
            "owner@example.invalid",
            RECEIVER,
            &options
        ));
        message
            .headers
            .insert("auto-submitted".into(), " auto-replied ".into());
        assert!(!wanted(
            &message,
            "owner@example.invalid",
            RECEIVER,
            &options
        ));
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
        assert!(!wanted(&message, " owner@example.invalid ", RECEIVER, &all));
        message.headers.remove("in-reply-to");
        assert!(wanted(&message, "owner@example.invalid", RECEIVER, &all));
        assert!(describe(&message, "Work").contains("It begins: hello"));
    }

    #[test]
    fn a_from_filter_matches_only_the_one_address_the_receiving_server_vouches_for() {
        let sender =
            |needle: &str, from: &str, results: &str| sent_by(from, results, RECEIVER, needle);
        assert!(sender(
            "ann@example.invalid",
            "Ann <ANN@example.invalid>",
            PASSED
        ));
        assert!(sender(
            "example.invalid",
            "ann@example.invalid (Ann)",
            PASSED
        ));
        // An address in the display name is no sender: the mailbox is evil@x.invalid.
        let named = "\"ann@example.invalid\" <evil@x.invalid>";
        let evil = "mx.example.invalid; dmarc=pass header.from=x.invalid";
        assert!(!sender("ann@example.invalid", named, evil));
        assert!(!sender("example.invalid", named, evil));
        assert!(!sender(
            "ann@example.invalid",
            "ann@example.invalid <evil@x.invalid>",
            evil
        ));
        // Two mailboxes, a group or none name no one sender.
        for from in [
            "ann@example.invalid, bob@example.invalid",
            "<ann@example.invalid> <bob@example.invalid>",
            "team: ann@example.invalid;",
            "Ann",
            "",
        ] {
            assert!(!sender("ann@example.invalid", from, PASSED), "{from}");
        }
        // Only the receiver's own result counts, and only a pass for the From domain.
        for results in [
            "mx.attacker.invalid; dmarc=pass header.from=example.invalid",
            "example.invalid.attacker.invalid; dmarc=pass header.from=example.invalid",
            "mx.example.invalid; dmarc=pass header.from=other.invalid",
            "mx.example.invalid; dmarc=pass header.from=sub.example.invalid",
            "mx.example.invalid; dmarc=pass",
            "mx.example.invalid; spf=pass; dmarc=fail (p=reject) header.from=example.invalid",
            "mx.example.invalid; none",
            "dmarc=pass header.from=example.invalid",
            "",
        ] {
            assert!(
                !sender("ann@example.invalid", "ann@example.invalid", results),
                "{results}"
            );
        }
    }

    #[test]
    fn trusts_the_receivers_own_names_and_no_shared_suffix() {
        assert!(trusted_id("imap.example.invalid", RECEIVER));
        assert!(trusted_id("mx.example.invalid", RECEIVER));
        assert!(trusted_id("127.0.0.1", "127.0.0.1"));
        assert!(!trusted_id("mx.example.invalid", "127.0.0.1"));
        // Under a country's second level the registrable domain keeps three labels: a stranger's .co.uk is not it.
        assert!(trusted_id("mx.mail.example.co.uk", "imap.example.co.uk"));
        assert!(!trusted_id("mx.other.co.uk", "imap.example.co.uk"));
        assert!(!trusted_id("co.uk", "imap.example.co.uk"));
        assert!(!trusted_id("", RECEIVER));
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
