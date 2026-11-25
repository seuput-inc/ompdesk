//! Rows captured from the TypeScript before it was deleted (`captured.json`): the cache folders it wrote (a device
//! updating keeps its cache), what it asked the host and wrote at each step, node's base64, and the sign-in
//! listener's reading of Host headers and request targets and its failure page.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::value::RawValue;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::folder::folder;
use super::{answer, blobs, signin, transcripts};
use crate::server::{Call, Events, Fault, PushCall, Scope};

fn captured() -> Value {
    serde_json::from_str(include_str!("captured.json")).unwrap()
}

pub(super) fn temp_dir(name: &str) -> std::path::PathBuf {
    let mut salt = [0u8; 8];
    crate::sys::random(&mut salt).unwrap();
    let dir = std::env::temp_dir().join(format!(
        "ompdesk-remotebytes-{name}-{}-{}",
        std::process::id(),
        u64::from_le_bytes(salt)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn files(dir: &std::path::Path) -> BTreeMap<String, String> {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                std::fs::read_to_string(entry.path()).unwrap(),
            )
        })
        .collect()
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.to_owned()).unwrap()
}

#[tokio::test]
async fn asks_and_writes_a_journal_byte_for_byte_as_the_typescript_did() {
    let rows = captured();
    let transcripts_rows = &rows["transcripts"];
    let key = transcripts_rows["journalKey"].as_str().unwrap();
    let dir = temp_dir("journal");
    let kept = folder(&dir);
    for step in transcripts_rows["steps"].as_array().unwrap() {
        let answers = step["answers"].as_array().unwrap();
        let asked = Mutex::new(Vec::new());
        let file = transcripts::file_for_test(&dir, "j", key);
        let answer: Value = serde_json::from_str(answers[0].as_str().unwrap()).unwrap();
        let merge =
            transcripts::read_journal_with(&kept, file, raw("0"), 128 * 1024 * 1024, |fetch| {
                let mut question = serde_json::Map::new();
                question.insert(
                    "fromByte".into(),
                    serde_json::from_str(fetch.from_byte.get()).unwrap(),
                );
                if let Some(tail) = fetch.known_tail {
                    question.insert(
                        "knownTail".into(),
                        serde_json::from_str(tail.get()).unwrap(),
                    );
                }
                asked.lock().unwrap().push(Value::Object(question));
                // The answer's text as main sent it: never through `Value`, which spells a large number its own way.
                let mut fields: std::collections::HashMap<String, Box<RawValue>> =
                    serde_json::from_str(answers[0].as_str().unwrap()).unwrap();
                let data = fields.remove("data").unwrap();
                async move { Ok::<_, Fault>(Some(data)) }
            })
            .await
            .unwrap();
        assert_eq!(Value::Array(asked.into_inner().unwrap()), step["asked"]);
        let written: BTreeMap<String, String> =
            serde_json::from_value(step["files"].clone()).unwrap();
        assert_eq!(files(&dir), written);
        let mut shown: Vec<Value> = match merge {
            Some(held) => serde_json::from_str(&held).unwrap(),
            None => Vec::new(),
        };
        shown.extend(
            answer["data"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .cloned(),
        );
        assert_eq!(Value::Array(shown), step["messages"]);
    }
}

#[test]
fn reads_the_journal_and_tail_page_the_typescript_kept() {
    let rows = captured();
    let transcripts_rows = &rows["transcripts"];
    let dir = temp_dir("kept");
    for (name, text) in transcripts_rows["files"].as_object().unwrap() {
        std::fs::write(dir.join(name), text.as_str().unwrap()).unwrap();
    }
    let journal =
        transcripts::file_for_test(&dir, "j", transcripts_rows["journalKey"].as_str().unwrap());
    let held = transcripts::load_journal(&journal).expect("the journal loads");
    let (next, messages) = transcripts::held_for_test(&held);
    assert_eq!(next, transcripts_rows["next"]);
    assert_eq!(messages, transcripts_rows["held"]);
    let page = transcripts::file_for_test(&dir, "p", transcripts_rows["pageKey"].as_str().unwrap());
    let kept: Value = serde_json::from_str(&transcripts::load_page(&page).unwrap()).unwrap();
    assert_eq!(kept, transcripts_rows["page"]);
}

#[test]
fn drops_a_journal_a_crash_cut_mid_append() {
    let dir = temp_dir("cut");
    let file = dir.join("j-cut");
    std::fs::write(
        &file,
        "{\"from\":0,\"next\":10,\"tail\":\"t\",\"messages\":[1]}\n{\"from\":10,\"next\":2",
    )
    .unwrap();
    assert!(transcripts::load_journal(&file).is_none());
    assert!(!file.exists());
}

#[test]
fn reads_the_pictures_the_typescript_kept() {
    let rows = captured();
    let dir = temp_dir("blobs");
    for (name, data) in rows["blobs"]["files"].as_object().unwrap() {
        std::fs::write(dir.join(name), blobs::node_base64(data.as_str().unwrap())).unwrap();
    }
    let kept = folder(&dir);
    for reference in rows["blobs"]["refs"].as_array().unwrap() {
        let hash = reference
            .as_str()
            .unwrap()
            .strip_prefix("blob:sha256:")
            .unwrap();
        assert_eq!(
            blobs::kept(&kept, hash).as_deref(),
            rows["blobs"]["files"][hash].as_str()
        );
    }
}

/// A read whose own look in the folder missed, and that owns the host's read only after another read kept the picture,
/// takes it from the folder: each picture crosses the link once.
#[tokio::test]
async fn a_read_that_missed_takes_a_picture_another_read_kept_meanwhile() {
    let rows = captured();
    let (hash, data) = rows["blobs"]["files"]
        .as_object()
        .unwrap()
        .iter()
        .next()
        .unwrap();
    let dir = temp_dir("blobs-kept-meanwhile");
    let kept = folder(&dir);
    let reference = format!("blob:sha256:{hash}");
    assert_eq!(
        blobs::load(&kept, &reference, 1 << 20, true, || async {
            Some(data.as_str().unwrap().to_owned())
        })
        .await,
        data.as_str().map(str::to_owned)
    );
    assert_eq!(
        blobs::load(&kept, &reference, 1 << 20, true, || async {
            unreachable!("the host was asked for a picture the folder holds")
        })
        .await,
        data.as_str().map(str::to_owned)
    );
}

#[test]
fn decodes_base64_as_node_does() {
    for row in captured()["base64"].as_array().unwrap() {
        let bytes = blobs::node_base64(row["input"].as_str().unwrap());
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(hex, row["hex"].as_str().unwrap(), "{}", row["input"]);
    }
}

#[test]
fn reads_host_headers_and_callback_targets_as_node_did() {
    let rows = captured();
    for row in rows["hosts"].as_array().unwrap() {
        assert_eq!(
            signin::host_name(row["header"].as_str().unwrap()),
            row["hostname"].as_str().unwrap(),
            "{}",
            row["header"]
        );
    }
    for row in rows["targets"].as_array().unwrap() {
        let target = signin::target(row["input"].as_str().unwrap()).unwrap();
        assert_eq!(
            target.path,
            row["pathname"].as_str().unwrap(),
            "{}",
            row["input"]
        );
        assert_eq!(
            target.state.as_deref(),
            row["state"].as_str(),
            "{}",
            row["input"]
        );
        assert_eq!(
            target.query,
            row["query"].as_str().unwrap(),
            "{}",
            row["input"]
        );
    }
}

#[test]
fn writes_the_failure_page_as_the_typescript_did() {
    for row in captured()["failurePages"].as_array().unwrap() {
        assert_eq!(
            signin::failure_page(
                row["title"].as_str().unwrap(),
                row["message"].as_str().unwrap()
            ),
            row["html"].as_str().unwrap()
        );
    }
}

/// The relay ends (main's close, or the timeout) between the listener's check and its ask: main released its asker
/// with the end, so it answers the ask `failed`. Nothing was forwarded, so the browser hears the 409 of a relay that
/// was closed already, never the 502 of a host that could not take the callback.
#[tokio::test]
async fn a_callback_asked_after_the_relay_ended_is_answered_409() {
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (events, _keep, mut frames) = Events::capture();
    let start = json!({
        "relay": 7, "port": port, "path": "/callback", "state": "xyz", "hosts": ["127.0.0.1"],
        "loopbackHosts": ["127.0.0.1", "localhost"], "timeoutMs": 60_000,
    });
    let started = signin::start(Call {
        params: raw(&start.to_string()),
        bin: None,
        scope: Scope::detached(),
        events: events.clone(),
    })
    .await
    .unwrap();
    assert_eq!(started.result.get(), r#"{"listening":true}"#);

    let mut browser = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let request =
        format!("GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    browser.write_all(request.as_bytes()).await.unwrap();
    let asked: Value = {
        let frame = frames.recv().await.unwrap();
        serde_json::from_slice(frame.parts().0).unwrap()
    };
    assert_eq!(asked["event"], "remotebytes.ask");

    signin::close(PushCall {
        params: raw(r#"{"relay":7}"#),
        bin: None,
        events: events.clone(),
    });
    let failed = json!({"call": asked["data"]["call"], "failed": true});
    answer(Call {
        params: raw(&failed.to_string()),
        bin: None,
        scope: Scope::detached(),
        events,
    })
    .await
    .unwrap();

    let mut page = Vec::new();
    browser.read_to_end(&mut page).await.unwrap();
    let page = String::from_utf8_lossy(&page);
    assert!(page.starts_with("HTTP/1.1 409"), "{page}");
}
