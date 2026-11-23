//! The saved SSH forwards. A failed read is not an empty store: only a missing file or a successful quarantine is.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

use super::rules::{Target, refused};
use super::{blocking, params};
use crate::disk::saves::{waiting_content, write_kept};
use crate::fs::error::{Codes, NodeError};
use crate::json::whole_surrogates;
use crate::server::{Call, Fault, Reply};

const FILE: &str = "ssh-forwards.json";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    grace_ms: u32,
    forwards: Vec<Forward>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Forward {
    id: String,
    server: String,
    target: Target,
    local_port: Number,
    remote_port: Number,
    active: bool,
}

fn normalize(mut doc: Value) -> Option<Store> {
    let grace = doc.get_mut("graceMs")?;
    let ms = grace.as_f64()?;
    if ms.fract() != 0.0 || !(60_000.0..=604_800_000.0).contains(&ms) {
        return None;
    }
    *grace = Value::from(ms as u32);
    // Serde structs also accept positional arrays. Zod required objects at all three levels.
    let forwards = doc.get("forwards")?.as_array()?;
    if forwards
        .iter()
        .any(|row| !row.get("target").is_some_and(Value::is_object))
    {
        return None;
    }
    serde_json::from_value(doc).ok()
}

fn parse(bytes: &[u8]) -> Option<Store> {
    let text = String::from_utf8_lossy(bytes);
    normalize(serde_json::from_str(&whole_surrogates(&text)).ok()?)
}

fn load(file: &Path) -> Result<Option<Store>, Fault> {
    if let Some(bytes) = waiting_content(file) {
        return parse(&bytes)
            .map(Some)
            .ok_or_else(|| refused("Invalid pending SSH forwards"));
    }
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(NodeError::new(&error, "read", file.to_str()).fault(Codes::None)),
    };
    if let Some(store) = parse(&bytes) {
        return Ok(Some(store));
    }
    fs::rename(file, file.with_added_extension("corrupt"))
        .map_err(|e| NodeError::new(&e, "rename", file.to_str()).fault(Codes::None))?;
    Ok(None)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Read {
    user_data: PathBuf,
}

pub(super) async fn read(call: Call) -> Result<Reply, Fault> {
    let Read { user_data } = params(&call)?;
    blocking(move || Reply::json(&load(&user_data.join(FILE))?)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Save {
    user_data: PathBuf,
    data: Value,
}

pub(super) async fn save(call: Call) -> Result<Reply, Fault> {
    let Save { user_data, data } = params(&call)?;
    blocking(move || {
        let store = normalize(data).ok_or_else(|| refused("Invalid saved SSH forwards"))?;
        let mut bytes = Vec::new();
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
        let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
        store
            .serialize(&mut serializer)
            .map_err(|_| Fault::new("internal", "Could not encode saved SSH forwards"))?;
        write_kept(&user_data.join(FILE), &bytes, None, 0o777)?;
        Reply::json(&())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn grace_matches_the_saved_zod_schema() {
        for (ms, accepted) in [
            ("59999", false),
            ("60000", true),
            ("6e4", true),
            ("60000.5", false),
            ("604800000", true),
            ("604800001", false),
            ("null", false),
            (r#""60000""#, false),
        ] {
            let text = format!(r#"{{"graceMs":{ms},"forwards":[]}}"#);
            assert_eq!(parse(text.as_bytes()).is_some(), accepted, "{ms}");
        }
    }

    #[test]
    fn strips_unknown_fields_and_requires_objects_and_non_null_target_fields() {
        let target = json!({"name":"box","host":"box.example"});
        let row = json!({
            "id": "x", "server": "box", "target": target,
            "localPort": 0, "remotePort": 22.5, "active": false,
        });
        let expected = json!({"graceMs": 60000, "forwards": [row]});
        let mut doc = expected.clone();
        doc["extra"] = json!(1);
        doc["forwards"][0]["extra"] = json!(2);
        doc["forwards"][0]["target"]["extra"] = json!(3);
        assert_eq!(
            serde_json::to_value(normalize(doc).unwrap()).unwrap(),
            expected
        );
        for key in ["username", "port", "keyPath"] {
            let mut doc = expected.clone();
            doc["forwards"][0]["target"][key] = Value::Null;
            assert!(normalize(doc).is_none(), "{key}");
        }
        let mut array_target = expected.clone();
        array_target["forwards"][0]["target"] = json!(["box", "box.example"]);
        for doc in [
            json!([60000, []]),
            json!({"graceMs": 60000, "forwards": [["x", "box", target, 1, 2, false]]}),
            array_target,
        ] {
            assert!(normalize(doc).is_none());
        }
    }
}
