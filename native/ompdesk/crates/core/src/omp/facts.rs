//! Read-only facts from the installed stock CLI.

use std::borrow::Cow;
use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;

use super::cli;
use crate::aimemory::value::iso_now;
use crate::fs::order::is_js_space;
use crate::json::whole_surrogates;
use crate::server::{Call, Fault, Reply};

const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorReport {
    checks: Vec<Value>,
    checked_at: String,
}

fn doctor_checks(stdout: &[u8]) -> Option<Vec<Value>> {
    let text = String::from_utf8_lossy(stdout);
    let mut rows: Vec<Value> = serde_json::from_str(&whole_surrogates(&text)).ok()?;
    rows.retain_mut(|row| {
        let Some(fields) = row.as_object_mut() else {
            return false;
        };
        if !fields.get("name").is_some_and(Value::is_string)
            || !matches!(
                fields.get("status").and_then(Value::as_str),
                Some("ok" | "warning" | "error")
            )
        {
            return false;
        }
        fields.retain(|key, _| matches!(key.as_str(), "name" | "status" | "message"));
        if !fields.get("message").is_some_and(Value::is_string) {
            fields.insert("message".into(), Value::String(String::new()));
        }
        true
    });
    Some(rows)
}

// Byte keys keep distinct lone UTF-16 surrogate escapes distinct, as Object.values did.
#[derive(Deserialize, Eq, Hash, PartialEq)]
#[serde(transparent)]
struct PluginKey<'a>(#[serde(borrow)] Cow<'a, [u8]>);

fn installed_plugins(stdout: &[u8]) -> usize {
    let text = String::from_utf8_lossy(stdout);
    let count = |raw: &RawValue| {
        if !raw.get().starts_with('[') {
            return 0;
        }
        serde_json::from_str::<Vec<serde::de::IgnoredAny>>(raw.get()).map_or(0, |items| items.len())
    };
    match text
        .trim_start_matches([' ', '\n', '\r', '\t'])
        .as_bytes()
        .first()
    {
        Some(b'{') => serde_json::from_str::<HashMap<PluginKey<'_>, &RawValue>>(&text)
            .map_or(0, |fields| fields.into_values().map(count).sum()),
        Some(b'[') => serde_json::from_str::<Vec<&RawValue>>(&text)
            .map_or(0, |rows| rows.into_iter().map(count).sum()),
        _ => 0,
    }
}

pub(super) async fn plugin_count(call: Call) -> Result<Reply, Fault> {
    let launch = call.params()?;
    let output = cli::plugin_list(&launch, call.scope).await?;
    Reply::json(&if output.code == 0 {
        installed_plugins(&output.stdout)
    } else {
        0
    })
}

pub(super) async fn plugin_doctor(call: Call) -> Result<Reply, Fault> {
    let launch = call.params()?;
    let output = cli::run(&launch, ["plugin", "doctor", "--json"], call.scope, TIMEOUT).await?;
    if output.code == 0
        && let Some(checks) = doctor_checks(&output.stdout)
    {
        return Reply::json(&DoctorReport {
            checks,
            checked_at: iso_now(),
        });
    }
    Err(output.failure("doctor_failed", format_args!("plugin doctor")))
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Versions<'a> {
    current_version: &'a str,
    latest_version: &'a str,
}

/// The first matching `label` followed by JS whitespace and `\d+\.\d+\.\d+\S*`.
fn labelled_version<'a>(output: &'a str, label: &str) -> Option<&'a str> {
    output.match_indices(label).find_map(|(start, _)| {
        let rest = output[start + label.len()..].trim_start_matches(is_js_space);
        let token = &rest[..rest.find(is_js_space).unwrap_or(rest.len())];
        let mut version = token;
        for _ in 0..2 {
            let (digits, rest) = version.split_once('.')?;
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            version = rest;
        }
        version
            .as_bytes()
            .first()?
            .is_ascii_digit()
            .then_some(token)
    })
}

fn versions(output: &str) -> Option<Versions<'_>> {
    let current_version = labelled_version(output, "Current version:")?;
    let latest_version = labelled_version(output, "New version available:").or_else(|| {
        output
            .contains("Already up to date")
            .then_some(current_version)
    })?;
    Some(Versions {
        current_version,
        latest_version,
    })
}

pub(super) fn parse_update_check(call: Call) -> Result<Reply, Fault> {
    #[derive(Deserialize)]
    struct Params {
        output: String,
    }
    let params: Params = call.params()?;
    Reply::json(&versions(&params.output))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReport<'a> {
    #[serde(flatten)]
    versions: Versions<'a>,
    update_available: bool,
    checked_at: String,
    distribution: &'static str,
    install_strategy: &'static str,
}

pub(super) async fn check_update(call: Call) -> Result<Reply, Fault> {
    let launch = call.params()?;
    let output = cli::run(&launch, ["update", "--check"], call.scope, TIMEOUT).await?;
    if output.code == 0 {
        let text = String::from_utf8_lossy(&output.stdout);
        if let Some(versions) = versions(&text) {
            return Reply::json(&UpdateReport {
                update_available: versions.current_version != versions.latest_version,
                versions,
                checked_at: iso_now(),
                distribution: "system",
                install_strategy: "omp-update",
            });
        }
    }
    Err(output.failure("update_check_failed", format_args!("update --check")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_only_immediate_array_values_after_duplicate_keys_resolve() {
        for (text, expected) in [
            (
                r#"{"a":[0,1],"\u0061":[],"b":[1e999],"c":{"nested":[2]}}"#,
                1,
            ),
            (r#"{"\ud800":[1],"\ud801":[2]}"#, 2),
            ("[[],[1,2],[[]],null]", 3),
            (r#"{"installed":[1]}trailing"#, 0),
            ("null", 0),
        ] {
            assert_eq!(installed_plugins(text.as_bytes()), expected, "{text}");
        }
    }

    #[test]
    fn only_stock_rows_are_checks_and_an_empty_array_is_valid() {
        assert_eq!(doctor_checks(b"[]"), Some(Vec::new()));
        let rows = doctor_checks(
            br#"[null, 0, {}, {"name":"x","status":7}, {"name":"x","status":"toString"},
                {"name":1,"status":"ok"}, {"name":"","status":"error","message":1,"fixed":false}]"#,
        );
        assert_eq!(
            rows,
            Some(vec![json!({"name":"","status":"error","message":""})])
        );
        assert_eq!(doctor_checks(b"null"), None);
    }

    #[test]
    fn stock_versions_keep_the_first_matching_token_and_its_entire_suffix() {
        let out = "Current version: bad Current version:\u{feff}01.2.34-tag+4\r\n\
                   Already up to date\nNew version available: 1.2.a\n\
                   New version available: 5.6.7.8!\u{a0}extra\nNew version available: 9.8.7";
        assert_eq!(
            versions(out),
            Some(Versions {
                current_version: "01.2.34-tag+4",
                latest_version: "5.6.7.8!",
            })
        );
        for invalid in [
            "current version: 1.2.3 Already up to date",
            "Current version: １.2.3 Already up to date",
            "Current version:\u{85}1.2.3 Already up to date",
            "Current version: 1.2. Already up to date",
            "New version available: 1.2.3",
        ] {
            assert_eq!(versions(invalid), None, "{invalid}");
        }
    }
}
