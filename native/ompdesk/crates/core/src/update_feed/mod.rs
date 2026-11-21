//! The release fields and asset the updater accepts from GitHub. Feed order is newest first.

mod metadata;

use crate::fs::order::js_trim;
use crate::git::parse::js_number;
use crate::server::Fault;
use serde_json::Value;
use std::fmt::{Display, Write};
use url::Url;

const METADATA_ERROR: &str = "ERR_OMPDESK_UPDATE_METADATA";
const PLATFORM_ERROR: &str = "ERR_OMPDESK_UPDATE_PLATFORM";
const LOOKUP_ERROR: &str = "ERR_OMPDESK_RELEASE_LOOKUP";
const NO_RELEASE_ERROR: &str = "ERR_UPDATER_LATEST_VERSION_NOT_FOUND";

fn kind(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

#[derive(Clone, Copy, Default)]
struct Path {
    release: Option<usize>,
    asset: Option<usize>,
}

impl Path {
    fn issue(self, issues: &mut String, field: &str, message: impl Display) {
        if !issues.is_empty() {
            issues.push_str("; ");
        }
        if let Some(i) = self.release {
            write!(issues, "{i}").unwrap();
            if self.asset.is_some() || !field.is_empty() {
                issues.push('.');
            }
        }
        if let Some(i) = self.asset {
            write!(issues, "assets.{i}").unwrap();
            if !field.is_empty() {
                issues.push('.');
            }
        }
        if self.release.is_none() && self.asset.is_none() && field.is_empty() {
            issues.push_str("(root)");
        }
        write!(issues, "{field}: {message}").unwrap();
    }

    fn check(self, issues: &mut String, field: &str, value: Option<&Value>, expected: &str) {
        let received = kind(value);
        if received != expected {
            self.issue(
                issues,
                field,
                format_args!("Invalid input: expected {expected}, received {received}"),
            );
        }
    }
}

fn validate_release(value: Option<&Value>, path: Path, issues: &mut String) {
    let Some(Value::Object(release)) = value else {
        path.check(issues, "", value, "object");
        return;
    };
    path.check(issues, "tag_name", release.get("tag_name"), "string");
    for key in ["name", "body"] {
        let value = release.get(key);
        if !matches!(value, None | Some(Value::Null)) {
            path.check(issues, key, value, "string");
        }
    }
    for key in ["draft", "prerelease"] {
        path.check(issues, key, release.get(key), "boolean");
    }
    let Some(Value::Array(assets)) = release.get("assets") else {
        path.check(issues, "assets", release.get("assets"), "array");
        return;
    };
    for (i, asset) in assets.iter().enumerate() {
        let at = Path {
            asset: Some(i),
            ..path
        };
        let Value::Object(asset) = asset else {
            at.check(issues, "", Some(asset), "object");
            continue;
        };
        for (key, expected) in [("id", "number"), ("name", "string"), ("size", "number")] {
            at.check(issues, key, asset.get(key), expected);
        }
        match asset.get("url") {
            Some(Value::String(s)) if Url::parse(js_trim(s)).is_err() => {
                at.issue(issues, "url", "Invalid URL")
            }
            Some(Value::String(_)) => (),
            other => at.check(issues, "url", other, "string"),
        }
    }
}

fn select(payload: Option<&Value>, allow_prerelease: bool) -> Result<&Value, Fault> {
    let mut issues = String::new();
    let mut first = None;
    let mut prerelease = None;
    if allow_prerelease {
        if let Some(Value::Array(list)) = payload {
            for (i, item) in list.iter().enumerate() {
                validate_release(
                    Some(item),
                    Path {
                        release: Some(i),
                        asset: None,
                    },
                    &mut issues,
                );
                if item["draft"].as_bool() == Some(false) {
                    first.get_or_insert(item);
                    if item["prerelease"].as_bool() == Some(true) {
                        prerelease.get_or_insert(item);
                    }
                }
            }
        } else {
            Path::default().check(&mut issues, "", payload, "array");
        }
    } else {
        validate_release(payload, Path::default(), &mut issues);
        first = payload;
    }
    if !issues.is_empty() {
        let what = if allow_prerelease {
            "release list"
        } else {
            "release"
        };
        return Err(Fault::new(
            LOOKUP_ERROR,
            format!("Unexpected {what} payload: {issues}"),
        ));
    }
    prerelease
        .or(first)
        .ok_or_else(|| Fault::new(NO_RELEASE_ERROR, "The repository has no published release"))
}

fn resolve(params: Value) -> Result<Value, Fault> {
    let allow = params["allowPrerelease"]
        .as_bool()
        .ok_or_else(|| Fault::new("invalid_params", "allowPrerelease must be a boolean"))?;
    let platform = match params["platform"].as_str() {
        Some(key @ ("mac" | "windows")) => key,
        _ => {
            return Err(Fault::new(
                "invalid_params",
                "platform must be mac or windows",
            ));
        }
    };
    let release = select(params.get("payload"), allow)?;
    let (mut update, notes) = metadata::parse(release["body"].as_str().unwrap_or_default())?;
    let tag = release["tag_name"].as_str().expect("validated release tag");
    let version = update["version"]
        .as_str()
        .expect("validated metadata version");
    if tag.strip_prefix('v') != Some(version) {
        return Err(Fault::new(
            METADATA_ERROR,
            format!("The ompdesk-update comment names {version}, but the release is {tag}"),
        ));
    }
    let file = update["files"].get(platform).ok_or_else(|| {
        Fault::new(
            PLATFORM_ERROR,
            format!("{tag} ships no {platform} installer"),
        )
    })?;
    let name = file["name"].as_str().expect("validated file name");
    let asset = release["assets"]
        .as_array()
        .expect("validated release assets")
        .iter()
        .find(|asset| asset["name"].as_str() == Some(name))
        .ok_or_else(|| {
            Fault::new(
                METADATA_ERROR,
                format!("The ompdesk-update comment lists {name}, but {tag} has no such asset"),
            )
        })?;
    let size = asset["size"].as_f64().expect("validated asset size");
    let declared = file["size"].as_f64().expect("validated metadata size");
    if size != declared {
        return Err(Fault::new(
            METADATA_ERROR,
            format!(
                "{name} is {} bytes, but the ompdesk-update comment says {}",
                js_number(size),
                js_number(declared)
            ),
        ));
    }
    if platform == "mac" {
        let floor = params["minimumDarwin"]
            .as_str()
            .ok_or_else(|| Fault::new("invalid_params", "minimumDarwin must be a string"))?;
        let minimum = file["minimumSystemVersion"].as_str().unwrap_or(floor);
        let floor_parts = metadata::system_version(floor);
        if floor_parts.is_none() || metadata::system_version(minimum) < floor_parts {
            return Err(Fault::new(
                METADATA_ERROR,
                format!("A macOS update requires a Darwin minimum of {floor} or newer"),
            ));
        }
        update["minimumSystemVersion"] = minimum.into();
    }
    let mut files = update
        .as_object_mut()
        .expect("validated metadata")
        .remove("files")
        .expect("validated files");
    update["file"] = files[platform].take();
    update["releaseName"] = release["name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(tag)
        .into();
    update["notes"] = notes.into();
    // Zod preserves the input spelling except for JS trim and ASCII tabs/newlines.
    let url = js_trim(asset["url"].as_str().expect("validated asset URL"));
    update["assetUrl"] = url.replace(['\t', '\r', '\n'], "").into();
    Ok(update)
}

pub(crate) fn register(registry: &mut crate::server::Registry) {
    registry.add("updateFeed.resolve", |call| {
        Box::pin(async move { crate::server::Reply::json(&resolve(call.params()?)?) })
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(name: &str, prerelease: bool, draft: bool) -> Value {
        let installer = "ompdesk-mac-arm64.dmg";
        let file = json!({"name":installer, "size":13, "sha512":format!("{}==", "A".repeat(86))});
        let metadata =
            json!({"files":{"mac":file}, "version":"2.1.3", "releaseDate":"2026-11-21T00:00:00Z"});
        json!({"tag_name":"v2.1.3", "name":name, "draft":draft, "prerelease":prerelease,
            "body":format!(" notes <!-- ompdesk-update {metadata} -->"),
            "assets":[{"id":3, "name":installer, "size":13, "url":"\u{feff}https://example.org/A\nB "}]})
    }

    fn request(payload: Value) -> Value {
        json!({"allowPrerelease":true,"platform":"mac","minimumDarwin":"23.0.0","payload":payload})
    }

    #[test]
    fn first_published_prerelease_wins_or_first_published_stable() {
        let draft = release("draft", true, true);
        let stable = release("stable", false, false);
        let beta = release("beta", true, false);
        let result = resolve(request(json!([
            draft,
            stable,
            beta,
            release("older", true, false)
        ])))
        .unwrap();
        assert_eq!(result["releaseName"], "beta");
        assert_eq!(result["notes"], "notes");
        assert_eq!(result["assetUrl"], "https://example.org/AB");
        assert_eq!(result["minimumSystemVersion"], "23.0.0");
        assert_eq!(
            resolve(request(json!([draft, stable]))).unwrap()["releaseName"],
            "stable"
        );
        assert_eq!(
            resolve(request(json!([draft]))).unwrap_err().code,
            NO_RELEASE_ERROR
        );
    }

    #[test]
    fn reports_every_schema_issue_even_after_the_selected_release() {
        let mut invalid = release("draft", false, true);
        invalid["name"] = json!(false);
        invalid["assets"][0] = json!({"name":"asset", "size":false, "url":"https://[bad]"});
        let err = resolve(request(json!([
            release("beta", true, false),
            invalid,
            null
        ])))
        .unwrap_err();
        assert_eq!(err.code, LOOKUP_ERROR);
        assert_eq!(
            err.message,
            concat!(
                "Unexpected release list payload: ",
                "1.name: Invalid input: expected string, received boolean; ",
                "1.assets.0.id: Invalid input: expected number, received undefined; ",
                "1.assets.0.size: Invalid input: expected number, received boolean; ",
                "1.assets.0.url: Invalid URL; 2: Invalid input: expected object, received null"
            )
        );
    }

    #[test]
    fn checks_the_selected_asset_and_the_shipped_floor() {
        let mut selected = release("", false, false);
        let mut params = request(json!([]));
        params["allowPrerelease"] = json!(false);
        params["payload"] = selected.clone();
        assert_eq!(resolve(params.clone()).unwrap()["releaseName"], "v2.1.3");

        let body = selected["body"].as_str().unwrap().replace(
            "\"size\":13",
            "\"size\":13,\"minimumSystemVersion\":\"22.10.0\"",
        );
        selected["body"] = body.into();
        selected["assets"][0]["size"] = json!(13.5);
        params["payload"] = selected;
        let mismatch = resolve(params.clone()).unwrap_err();
        assert_eq!(mismatch.code, METADATA_ERROR);
        assert_eq!(
            mismatch.message,
            "ompdesk-mac-arm64.dmg is 13.5 bytes, but the ompdesk-update comment says 13"
        );

        params["payload"]["assets"][0]["size"] = json!(13);
        let floor = resolve(params.clone()).unwrap_err();
        assert_eq!(floor.code, METADATA_ERROR);
        assert_eq!(
            floor.message,
            "A macOS update requires a Darwin minimum of 23.0.0 or newer"
        );

        params["platform"] = json!("windows");
        let missing = resolve(params).unwrap_err();
        assert_eq!(missing.code, PLATFORM_ERROR);
        assert_eq!(missing.message, "v2.1.3 ships no windows installer");
    }
}
