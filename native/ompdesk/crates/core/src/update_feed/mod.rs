//! The release fields and asset the updater accepts from GitHub. Feed order is newest first.

mod metadata;
mod net;
#[cfg(test)]
mod net_tests;

use crate::fs::order::js_trim;
use crate::git::parse::js_number;
use crate::server::Fault;
use serde_json::Value;

const METADATA_ERROR: &str = "ERR_OMPDESK_UPDATE_METADATA";
const PLATFORM_ERROR: &str = "ERR_OMPDESK_UPDATE_PLATFORM";
const LOOKUP_ERROR: &str = "ERR_OMPDESK_RELEASE_LOOKUP";
const NO_RELEASE_ERROR: &str = "ERR_UPDATER_LATEST_VERSION_NOT_FOUND";

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
    let payload = params["payload"]
        .as_str()
        .ok_or_else(|| Fault::new("invalid_params", "payload must be JSON text"))?;
    let release = metadata::select(payload, allow)?;
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
        let download_name = format!("ompdesk-{version}-arm64.dmg");
        update["minimumSystemVersion"] = minimum.into();
        update["macDownloadName"] = download_name.into();
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
    net::register(registry);
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
        json!({"allowPrerelease":true,"platform":"mac","minimumDarwin":"23.0.0","payload":payload.to_string()})
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
    fn deep_unknown_fields_and_overwritten_values_do_not_hide_later_errors() {
        let deep = format!("{}1e999{}", "[".repeat(20_000), "]".repeat(20_000));
        let selected = release("beta", true, false)
            .to_string()
            .replacen('{', &format!(r#"{{"unused":{deep},"tag_name":{deep},"#), 1)
            .replace(r#""assets":[{"#, &format!(r#""assets":[{{"extra":{deep},"#));
        let mut params = request(json!([]));
        params["payload"] = format!("[{selected}]").into();
        assert_eq!(resolve(params.clone()).unwrap()["releaseName"], "beta");
        let later = selected.replace(r#""id":3"#, r#""id":-1e999"#);
        params["payload"] = format!("[{selected},{later}]").into();
        assert_eq!(
            resolve(params.clone()).unwrap_err().message,
            "Unexpected release list payload: 1.assets.0.id: Invalid input: expected number, received -Infinity"
        );
        params["payload"] = format!("[{selected},]").into();
        assert_eq!(resolve(params).unwrap_err().code, "update_invalid_payload");
    }

    #[test]
    fn checks_the_selected_asset_and_the_shipped_floor() {
        let mut selected = release("", false, false);
        let mut params = request(json!([]));
        params["allowPrerelease"] = json!(false);
        params["payload"] = selected.to_string().into();
        assert_eq!(resolve(params.clone()).unwrap()["releaseName"], "v2.1.3");

        let body = selected["body"].as_str().unwrap().replace(
            "\"size\":13",
            "\"size\":13,\"minimumSystemVersion\":\"22.10.0\"",
        );
        selected["body"] = body.into();
        selected["assets"][0]["size"] = json!(13.5);
        params["payload"] = selected.to_string().into();
        let mismatch = resolve(params.clone()).unwrap_err();
        assert_eq!(mismatch.code, METADATA_ERROR);
        assert_eq!(
            mismatch.message,
            "ompdesk-mac-arm64.dmg is 13.5 bytes, but the ompdesk-update comment says 13"
        );

        selected["assets"][0]["size"] = json!(13);
        params["payload"] = selected.to_string().into();
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
