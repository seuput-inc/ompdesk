//! GitHub releases and their `ompdesk-update` comments. Schema order determines diagnostic order.

use std::{borrow::Cow, fmt};

use serde::{Deserialize, Deserializer, de};
use serde_json::{Map, Value, value::RawValue};

use super::METADATA_ERROR;
use crate::fs::order::{is_js_space, js_trim};
use crate::json::whole_surrogates;
use crate::server::Fault;

const MAX_SAFE: u64 = (1 << 53) - 1;

/// The three slices are the notes before the match, the regex capture, and the notes after it.
fn comment(body: &str) -> Option<(&str, &str, &str)> {
    for (start, _) in body.match_indices("<!--") {
        let tail = body[start + 4..].trim_start_matches(is_js_space);
        if let Some(tail) = tail.strip_prefix("ompdesk-update")
            && tail.starts_with(is_js_space)
        {
            let (inside, after) = tail.split_once("-->")?;
            return Some((&body[..start], js_trim(inside), after));
        }
    }
    None
}

fn notes(before: &str, after: &str) -> String {
    let left = before.trim_start_matches(is_js_space);
    let right = after.trim_end_matches(is_js_space);
    if left.is_empty() {
        right.trim_start_matches(is_js_space).to_owned()
    } else if right.is_empty() {
        left.trim_end_matches(is_js_space).to_owned()
    } else {
        [left, right].concat()
    }
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn triplet(s: &str) -> Option<[&str; 3]> {
    let mut parts = s.split('.');
    let three = [parts.next()?, parts.next()?, parts.next()?];
    (parts.next().is_none() && three.into_iter().all(digits)).then_some(three)
}

fn semver(s: &str) -> bool {
    let identifier = |text: &str| {
        !text.is_empty()
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
    };
    let (s, build) = s.split_once('+').map_or((s, None), |(s, v)| (s, Some(v)));
    let (s, pre) = s.split_once('-').map_or((s, None), |(s, v)| (s, Some(v)));
    triplet(s).is_some() && pre.is_none_or(identifier) && build.is_none_or(identifier)
}

fn os_parts(s: &str) -> Option<[&str; 3]> {
    triplet(s).filter(|parts| parts.iter().all(|p| *p == "0" || !p.starts_with('0')))
}

pub(super) fn system_version(s: &str) -> Option<[u64; 3]> {
    let [a, b, c] = os_parts(s)?;
    let parts = [a.parse().ok()?, b.parse().ok()?, c.parse().ok()?];
    parts.into_iter().all(|p| p <= MAX_SAFE).then_some(parts)
}

/// Zod runs its safe-integer refinement even when the version regex has already failed.
fn js_safe_part(s: &str) -> bool {
    let s = js_trim(s);
    if s.is_empty() {
        return true;
    }
    let base = match s.as_bytes() {
        [b'0', b'x' | b'X', ..] => Some(16),
        [b'0', b'o' | b'O', ..] => Some(8),
        [b'0', b'b' | b'B', ..] => Some(2),
        _ => None,
    };
    if let Some(base) = base {
        return !s[2..].starts_with('+')
            && u64::from_str_radix(&s[2..], base).is_ok_and(|v| v <= MAX_SAFE);
    }
    s.parse::<f64>()
        .is_ok_and(|v| v.fract() == 0.0 && v.abs() <= MAX_SAFE as f64)
}

fn datetime(s: &str) -> bool {
    let Some(s) = s.strip_suffix('Z') else {
        return false;
    };
    let base = match s.split_once('.') {
        None => s,
        Some((base, fraction)) if digits(fraction) => base,
        Some(_) => return false,
    };
    let b = base.as_bytes();
    if b.len() != 19 || (b[4], b[7], b[10], b[13], b[16]) != (b'-', b'-', b'T', b':', b':') {
        return false;
    }
    let decimal = |part: &[u8]| {
        part.iter().try_fold(0u32, |n, &b| {
            b.is_ascii_digit().then(|| n * 10 + u32::from(b - b'0'))
        })
    };
    let (Some(year), Some(month), Some(day)) =
        (decimal(&b[..4]), decimal(&b[5..7]), decimal(&b[8..10]))
    else {
        return false;
    };
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    (1..=days).contains(&day)
        && decimal(&b[11..13]).is_some_and(|n| n < 24)
        && decimal(&b[14..16]).is_some_and(|n| n < 60)
        && decimal(&b[17..]).is_some_and(|n| n < 60)
}

fn digest(s: &str) -> bool {
    s.strip_suffix("==").is_some_and(|data| {
        data.len() == 86
            && data
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
    })
}

struct Entries<F>(F);

impl<'de, F> de::Visitor<'de> for Entries<F>
where
    F: FnMut(usize, &'de RawValue) -> serde_json::Result<()>,
{
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an array")
    }

    fn visit_seq<S: de::SeqAccess<'de>>(mut self, mut seq: S) -> Result<(), S::Error> {
        let mut i = 0;
        while let Some(raw) = seq.next_element()? {
            (self.0)(i, raw).map_err(de::Error::custom)?;
            i += 1;
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum Field {
    ReleaseList,
    Release,
    Assets,
    Asset,
    Text,
    OptionalText,
    Boolean,
    Number,
    Url,
    Metadata,
    Version,
    ReleaseDate,
    Files,
    File(&'static str),
    Name(&'static str),
    Size,
    Digest,
    Minimum,
}

/// Keep only schema fields, without decoding unknown values. RawValue also accepts JSON.parse's
/// unbounded numbers and skips deep unknown objects without recursing into the Rust call stack.
struct Fields<const N: usize>([(&'static str, Field); N]);

impl<'de, const N: usize> de::Visitor<'de> for &Fields<N> {
    type Value = [Option<&'de RawValue>; N];

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object")
    }

    fn visit_map<M: de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        #[derive(Deserialize)]
        struct Key<'a>(#[serde(borrow)] Cow<'a, str>);

        let mut found = [None; N];
        while let Some((Key(key), value)) = map.next_entry::<Key<'_>, &'de RawValue>()? {
            if let Some(i) = self.0.iter().position(|(k, _)| *k == key.as_ref()) {
                found[i] = Some(value);
            }
        }
        Ok(found)
    }
}

impl<const N: usize> Fields<N> {
    fn object(
        &self,
        raw: &str,
        path: &mut String,
        issues: &mut String,
    ) -> serde_json::Result<Value> {
        let values = serde_json::Deserializer::from_str(raw).deserialize_map(self)?;
        let mut object = Map::with_capacity(N);
        for ((key, field), value) in self.0.into_iter().zip(values) {
            let previous = path.len();
            if previous != 0 {
                path.push('.');
            }
            path.push_str(key);
            if let Some(value) = field.read(value.map_or("", RawValue::get), path, issues)? {
                object.insert(key.into(), value);
            }
            path.truncate(previous);
        }
        Ok(Value::Object(object))
    }
}

impl Field {
    fn read(
        self,
        raw: &str,
        path: &mut String,
        issues: &mut String,
    ) -> serde_json::Result<Option<Value>> {
        use Field::*;
        let first = raw.as_bytes().first().copied();
        if first == Some(b'{') {
            let object = match self {
                Release => Fields([
                    ("tag_name", Text),
                    ("name", OptionalText),
                    ("body", OptionalText),
                    ("draft", Boolean),
                    ("prerelease", Boolean),
                    ("assets", Assets),
                ])
                .object(raw, path, issues)?,
                Asset => Fields([
                    ("id", Number),
                    ("name", Text),
                    ("size", Number),
                    ("url", Url),
                ])
                .object(raw, path, issues)?,
                Metadata => Fields([
                    ("version", Version),
                    ("releaseDate", ReleaseDate),
                    ("files", Files),
                ])
                .object(raw, path, issues)?,
                Files => Fields([
                    ("mac", File("ompdesk-mac-arm64.dmg")),
                    ("windows", File("ompdesk-windows-setup.exe")),
                ])
                .object(raw, path, issues)?,
                File(name) => Fields([
                    ("name", Name(name)),
                    ("size", Size),
                    ("sha512", Digest),
                    ("minimumSystemVersion", Minimum),
                ])
                .object(raw, path, issues)?,
                _ => return Ok(self.wrong_type("object", path, issues)),
            };
            return Ok(Some(object));
        }
        if matches!(self, ReleaseList | Assets) && first == Some(b'[') {
            let list = matches!(self, ReleaseList);
            let field = if list { Release } else { Asset };
            let mut assets = Vec::new();
            let mut selected = None;
            let mut selected_prerelease = false;
            let previous = path.len();
            let entries = Entries(|i, entry: &RawValue| {
                use std::fmt::Write;
                if previous != 0 {
                    path.push('.');
                }
                write!(path, "{i}").unwrap();
                if let Some(item) = field.read(entry.get(), path, issues)? {
                    if !list {
                        assets.push(item);
                    } else if item["draft"].as_bool() == Some(false) {
                        let pre = item["prerelease"].as_bool() == Some(true);
                        if selected.is_none() || (pre && !selected_prerelease) {
                            selected = Some(item);
                            selected_prerelease = pre;
                        }
                    }
                }
                path.truncate(previous);
                Ok(())
            });
            serde_json::Deserializer::from_str(raw).deserialize_seq(entries)?;
            return Ok(if list {
                selected
            } else {
                Some(Value::Array(assets))
            });
        }
        if matches!(self, OptionalText) && matches!(first, None | Some(b'n')) {
            return Ok(None);
        }
        if matches!(self, Boolean) && matches!(first, Some(b't' | b'f')) {
            return Ok(Some(Value::Bool(first == Some(b't'))));
        }
        if first.is_none() && matches!(self, File(_) | Minimum) {
            return Ok(None);
        }
        let mut add = |msg: &str| issue(issues, path, msg);
        if first == Some(b'"')
            && matches!(
                self,
                Text | OptionalText | Url | Version | ReleaseDate | Name(_) | Digest | Minimum
            )
        {
            let text: String = serde_json::from_str(raw)?;
            match self {
                Url if url::Url::parse(js_trim(&text)).is_err() => add("Invalid URL"),
                Version if !semver(&text) => add("version must be semver"),
                ReleaseDate if !datetime(&text) => add("Invalid ISO datetime"),
                Name(name) if text != name => add(&format!("Invalid input: expected \"{name}\"")),
                Digest if !digest(&text) => add("sha512 must be a base64 SHA-512 digest"),
                Minimum if system_version(&text).is_none() => {
                    if os_parts(&text).is_none() {
                        add("minimumSystemVersion must be a numeric OS version");
                    }
                    if !text.split('.').all(js_safe_part) {
                        add("OS version parts must be safe integers");
                    }
                }
                _ => return Ok(Some(Value::String(text))),
            }
            return Ok(None);
        }
        let received = match first {
            None => "undefined",
            Some(b'n') => "null",
            Some(b't' | b'f') => "boolean",
            Some(b'[') => "array",
            Some(b'"') => "string",
            _ => {
                // RawValue has already checked JSON's numeric syntax; parse it as a JS Number.
                let n: f64 = raw.parse().expect("JSON number");
                if n == f64::INFINITY {
                    "Infinity"
                } else if n == f64::NEG_INFINITY {
                    "-Infinity"
                } else if matches!(self, Number) {
                    return Ok(Some(Value::from(n)));
                } else if matches!(self, Size) {
                    if n.fract() != 0.0 {
                        add("Invalid input: expected int, received number");
                    } else {
                        if n > MAX_SAFE as f64 {
                            add("Too big: expected int to be <=9007199254740991");
                        } else if n < -(MAX_SAFE as f64) {
                            add("Too small: expected int to be >=-9007199254740991");
                        }
                        if n <= 0.0 {
                            add("Too small: expected number to be >0");
                        } else if n <= MAX_SAFE as f64 {
                            return Ok(Some(Value::from(n as u64)));
                        }
                    }
                    return Ok(None);
                } else {
                    "number"
                }
            }
        };
        Ok(self.wrong_type(received, path, issues))
    }

    fn wrong_type(self, received: &str, path: &str, issues: &mut String) -> Option<Value> {
        let want = match self {
            Self::Release | Self::Asset | Self::Metadata | Self::Files | Self::File(_) => "object",
            Self::Size | Self::Number => "number",
            Self::ReleaseList | Self::Assets => "array",
            Self::Boolean => "boolean",
            Self::Name(name) => {
                issue(issues, path, &format!("Invalid input: expected \"{name}\""));
                return None;
            }
            _ => "string",
        };
        issue(
            issues,
            path,
            &format!("Invalid input: expected {want}, received {received}"),
        );
        None
    }
}

fn issue(issues: &mut String, path: &str, message: &str) {
    if !issues.is_empty() {
        issues.push_str("; ");
    }
    issues.push_str(if path.is_empty() { "(root)" } else { path });
    issues.push_str(": ");
    issues.push_str(message);
}

pub(super) fn select(payload: &str, allow_prerelease: bool) -> Result<Value, Fault> {
    let malformed = |_| Fault::new("update_invalid_payload", "Invalid release JSON");
    let normalized = whole_surrogates(payload);
    let root: &RawValue = serde_json::from_str(&normalized).map_err(malformed)?;
    let mut issues = String::new();
    let field = if allow_prerelease {
        Field::ReleaseList
    } else {
        Field::Release
    };
    let selected = field
        .read(root.get(), &mut String::new(), &mut issues)
        .map_err(malformed)?;
    if !issues.is_empty() {
        let what = if allow_prerelease {
            "release list"
        } else {
            "release"
        };
        return Err(Fault::new(
            super::LOOKUP_ERROR,
            format!("Unexpected {what} payload: {issues}"),
        ));
    }
    selected.ok_or_else(|| {
        Fault::new(
            super::NO_RELEASE_ERROR,
            "The repository has no published release",
        )
    })
}

pub(super) fn parse(body: &str) -> Result<(Value, String), Fault> {
    let (before, inside, after) = comment(body).ok_or_else(|| {
        Fault::new(
            METADATA_ERROR,
            "The release notes carry no ompdesk-update metadata comment",
        )
    })?;
    if comment(after).is_some() {
        return Err(Fault::new(
            METADATA_ERROR,
            "The release notes carry more than one ompdesk-update comment",
        ));
    }
    // The Node adapter uses the unmodified capture only for V8's own JSON.parse diagnostic.
    let malformed = |_| Fault::new("update_invalid_json", inside);
    let normalized = whole_surrogates(inside);
    let raw: &RawValue = serde_json::from_str(&normalized).map_err(malformed)?;
    let mut issues = String::new();
    let metadata = Field::Metadata
        .read(raw.get(), &mut String::new(), &mut issues)
        .map_err(malformed)?;
    match metadata {
        Some(metadata) if issues.is_empty() => Ok((metadata, notes(before, after))),
        _ => Err(Fault::new(
            METADATA_ERROR,
            format!("The ompdesk-update comment is invalid: {issues}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn comment_of(value: &Value) -> String {
        format!("<!-- ompdesk-update {value} -->")
    }

    fn metadata() -> Value {
        json!({"version":"01.2.3-rc.1+b.2", "releaseDate":"2000-02-29T23:59:59.00000001Z", "files":{}})
    }

    #[test]
    fn strips_only_the_complete_comment_and_js_outer_whitespace() {
        let data = metadata();
        let body = format!(
            "\u{feff} notes\n<!--\u{feff}ompdesk-update\u{2028}{data}\u{a0}-->\n\u{85} end\u{feff}"
        );
        assert_eq!(parse(&body).unwrap(), (data, "notes\n\n\u{85} end".into()));
        for body in [
            "<!--\u{85}ompdesk-update {} -->",
            "<!-- ompdesk-update{} -->",
            "<!-- ompdesk-update {",
        ] {
            assert_eq!(
                parse(body).unwrap_err(),
                Fault::new(
                    METADATA_ERROR,
                    "The release notes carry no ompdesk-update metadata comment"
                )
            );
        }
        let invalid = "<!-- ompdesk-update\u{a0}{ broken:\n x }\u{2029}-->";
        assert_eq!(
            parse(invalid).unwrap_err(),
            Fault::new("update_invalid_json", "{ broken:\n x }")
        );
        assert_eq!(
            parse(&format!("{invalid}{invalid}")).unwrap_err(),
            Fault::new(
                METADATA_ERROR,
                "The release notes carry more than one ompdesk-update comment"
            )
        );
    }

    #[test]
    fn keeps_last_duplicate_in_schema_order_and_skips_unknown_values() {
        let digest = format!("{}==", "/".repeat(86));
        let nested = format!("{}0{}", "[".repeat(160), "]".repeat(160));
        let body = format!(
            r#"<!-- ompdesk-update {{"files":{{"mac":{{"junk":1e999,"sha512":"{digest}","minimumSystemVersion":"23.0.0","size":1e2,"name":"ompdesk-mac-arm64.dmg"}},"linux":{nested}}},"releaseDate":"0000-02-29T00:00:00Z","version":null,"ver\u0073ion":"1.2.3","\ud800":"\udfff"}} -->"#
        );
        let (metadata, notes) = parse(&body).unwrap();
        assert_eq!(
            metadata.to_string(),
            format!(
                r#"{{"version":"1.2.3","releaseDate":"0000-02-29T00:00:00Z","files":{{"mac":{{"name":"ompdesk-mac-arm64.dmg","size":100,"sha512":"{digest}","minimumSystemVersion":"23.0.0"}}}}}}"#
            )
        );
        assert!(notes.is_empty());
    }

    #[test]
    fn reports_all_issues_in_schema_order_with_zod_wording() {
        let body = r#"<!-- ompdesk-update {"files":{"windows":[],"mac":{"minimumSystemVersion":"x.1.2","sha512":false,"size":-1e18}},"releaseDate":"x","version":1e999} -->"#;
        assert_eq!(
            parse(body).unwrap_err(),
            Fault::new(
                METADATA_ERROR,
                concat!(
                    "The ompdesk-update comment is invalid: version: Invalid input: expected string, received Infinity; ",
                    "releaseDate: Invalid ISO datetime; files.mac.name: Invalid input: expected \"ompdesk-mac-arm64.dmg\"; ",
                    "files.mac.size: Too small: expected int to be >=-9007199254740991; files.mac.size: Too small: expected number to be >0; ",
                    "files.mac.sha512: Invalid input: expected string, received boolean; ",
                    "files.mac.minimumSystemVersion: minimumSystemVersion must be a numeric OS version; ",
                    "files.mac.minimumSystemVersion: OS version parts must be safe integers; files.windows: Invalid input: expected object, received array"
                )
            )
        );
    }

    #[test]
    fn distinguishes_the_integer_range_from_the_positive_size_check() {
        let mut data = metadata();
        data["files"]["mac"] = json!({
            "name": "ompdesk-mac-arm64.dmg",
            "sha512": format!("{}==", "+".repeat(86))
        });
        for (size, reason) in [
            (json!(-0.5), "Invalid input: expected int, received number"),
            (json!(0), "Too small: expected number to be >0"),
            (
                json!("1"),
                "Invalid input: expected number, received string",
            ),
            (
                json!(9007199254740992u64),
                "Too big: expected int to be <=9007199254740991",
            ),
        ] {
            data["files"]["mac"]["size"] = size;
            assert_eq!(
                parse(&comment_of(&data)).unwrap_err().message,
                format!("The ompdesk-update comment is invalid: files.mac.size: {reason}")
            );
        }
    }

    #[test]
    fn checks_calendar_days_seconds_fraction_and_utc_suffix() {
        let mut data = metadata();
        assert!(parse(&comment_of(&data)).is_ok());
        for date in [
            "1900-02-29T00:00:00Z",
            "2024-02-30T23:59:59Z",
            "2024-02-29T12:00Z",
            "2024-02-29T24:00:00Z",
            "2024-02-29T00:00:60Z",
            "2024-02-29T00:00:00.Z",
            "2024-02-29T00:00:00+00:00",
        ] {
            data["releaseDate"] = json!(date);
            assert_eq!(
                parse(&comment_of(&data)).unwrap_err().message,
                "The ompdesk-update comment is invalid: releaseDate: Invalid ISO datetime",
                "{date}"
            );
        }
    }

    #[test]
    fn validates_the_minimum_on_both_platforms_at_the_safe_integer_boundary() {
        let mut data = metadata();
        data["files"]["windows"] = json!({"name":"ompdesk-windows-setup.exe", "size":9007199254740991u64, "sha512":format!("{}==", "A".repeat(86)), "minimumSystemVersion":"9007199254740991.0.3"});
        assert_eq!(parse(&comment_of(&data)).unwrap().0, data);
        assert_eq!(
            system_version("9007199254740991.0.3"),
            Some([9007199254740991, 0, 3])
        );
        for (minimum, msg) in [
            (
                "9007199254740992.0.3",
                "OS version parts must be safe integers",
            ),
            (
                "01.2.3",
                "minimumSystemVersion must be a numeric OS version",
            ),
            (
                "0xff.0b10.",
                "minimumSystemVersion must be a numeric OS version",
            ),
        ] {
            data["files"]["windows"]["minimumSystemVersion"] = json!(minimum);
            assert_eq!(
                parse(&comment_of(&data)).unwrap_err().message,
                format!(
                    "The ompdesk-update comment is invalid: files.windows.minimumSystemVersion: {msg}"
                )
            );
            assert_eq!(system_version(minimum), None);
        }
    }
}
