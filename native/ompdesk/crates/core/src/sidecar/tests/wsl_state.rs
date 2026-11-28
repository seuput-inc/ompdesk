use super::*;
use crate::sidecar::serve_guest_state;
use crate::wsl_copy::{Registration, Session, Store, Writer};

const RESERVED: &str = "ompdesk-wsl:0123456789abcdef0123456789abcdef";
const HOME: &str = "/home/synthetic";
const PROJECT: &str = r"\\wsl.localhost\Test\work";

fn registration(rig: &Rig) -> Session {
    Store::open(&rig.dir)
        .unwrap()
        .register(Registration {
            distro: "synthetic-distro".into(),
            parent: Some("host-opening-parent".into()),
            cwd: PROJECT.into(),
        })
        .unwrap()
}

async fn open_reserved(rig: &mut Rig, reference: &str) {
    let seq = rig.seq();
    let mut params = rig.open_params(seq, no_queue());
    params["sessionPath"] = json!(reference);
    params["fresh"] = false.into();
    let _open = rig.post("sidecar.open", params);
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    let status = rig.status("error").await;
    assert!(
        !status.data["payload"]["message"]
            .as_str()
            .unwrap()
            .is_empty()
    );
}

fn state(id: &Value, stock: &str, path: &str) -> Value {
    json!({
        "type":"response", "id":id, "command":"get_state", "success":true,
        "data": {"sessionId":stock, "sessionFile":path, "cwd":"/guest-project",
            "openedBySession":"guest-parent", "parentSession":"/guest-parent", "isStreaming":false,
            "messageCount":7, "queuedMessageCount":{"file":path}, "isSettled":{"stockId":stock},
            "model":{"config":{"credentials":path}}, "grants":["host-tool"], "unknown":{"sessionFile":path}}
    })
}

async fn get_state(
    rig: &mut Rig,
    writer: Writer,
    respond: impl FnOnce(Value) -> Value,
) -> (Result<Writer, crate::server::Fault>, Result<Value, Value>) {
    let tab = rig.tab.clone();
    tokio::join!(biased;
        serve_guest_state(&tab, writer, HOME, |request| async move { Ok(respond(request)) }),
        rig.tab_call("sidecar.command", json!({"command":{"type":"get_state", "brief":true}})),
    )
}

#[tokio::test]
async fn a_reserved_restore_or_restart_never_resolves_launches_or_drops_the_reference() {
    let mut rig = Rig::new("wsl-restore", "ok").await;
    open_reserved(&mut rig, RESERVED).await;
    for (options, expected) in [
        (json!({"cwd":"different"}), "wsl"),
        (
            json!({"resumeSessionPath":"OMPDESK-WSL:not-a-key"}),
            "invalid",
        ),
        (json!({}), "invalid"),
    ] {
        rig.tab_call("sidecar.restart", options).await.unwrap();
        let status = rig.status("error").await;
        assert!(
            status.data["payload"]["message"]
                .as_str()
                .unwrap()
                .to_ascii_lowercase()
                .contains(expected)
        );
    }
    assert!(rig.event("sidecar.resolve").is_none());
    assert!(rig.event("sidecar.launch").is_none());
    assert!(rig.event("sidecar.spawned").is_none());
    assert!(log(&rig).is_empty());
    let changed = rig.event("sidecar.tabSession").unwrap();
    assert_eq!(changed.data["sessionPath"], "OMPDESK-WSL:not-a-key");
    finish(rig).await;
}

#[tokio::test]
async fn a_direct_process_never_receives_a_reserved_session_argument_or_switch() {
    let mut rig = Rig::new("wsl-switch", "reserved-flag").await;
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("error").await;
    assert!(rig.event("sidecar.spawned").is_none());
    assert!(log(&rig).is_empty());
    rig.behaviour.lock().unwrap().mode = "ok".into();
    rig.tab_call("sidecar.restart", json!({})).await.unwrap();
    rig.status("ready").await;
    for path in [RESERVED, "OMPDESK-WSL:bad"] {
        for command in [
            json!({"type":"switch_session","sessionPath":path}),
            json!({"type":"new_session","parentSession":path}),
            json!({"type":"set_session_name","sessionPath":path,"name":"x"}),
        ] {
            assert!(
                rig.tab_call("sidecar.send", json!({"frame":command}))
                    .await
                    .is_err()
            );
            assert!(
                rig.tab_call("sidecar.command", json!({"command":command}))
                    .await
                    .is_err()
            );
        }
    }
    // Prefix lookalikes are still ordinary files; the response also fences all earlier stdin writes.
    let plain = "ompdesk-wsl-not-a-ref.jsonl";
    rig.tab_call(
        "sidecar.command",
        json!({"command":{"type":"switch_session","sessionPath":plain}}),
    )
    .await
    .unwrap();
    let written = log(&rig);
    assert!(written.contains(plain));
    assert!(!written.to_ascii_lowercase().contains("ompdesk-wsl:"));
    rig.tab_call(
        "sidecar.command",
        json!({"command":{"type":"stray_state","claimedFile":RESERVED}}),
    )
    .await
    .unwrap();
    rig.drain();
    assert!(frames(&rig).iter().all(|f| f["id"] != "not-pending"));
    let session = registration(&rig);
    let refused = serve_guest_state(&rig.tab, session.admit().unwrap(), HOME, |_| async {
        panic!("direct stock was promoted")
    })
    .await;
    assert!(refused.is_err());
    rig.behaviour.lock().unwrap().session_file = Some(RESERVED.into());
    rig.tab_call("sidecar.restart", json!({})).await.unwrap();
    rig.status("error").await;
    assert!(
        !rig.seen.iter().any(|e| {
            e.name == "sidecar.session" && e.data["identity"]["sessionFile"] == RESERVED
        })
    );
    finish(rig).await;
}

#[tokio::test]
async fn only_correlated_guest_state_reaches_the_rpc_caller_and_the_identity_observer() {
    let mut rig = Rig::new("wsl-probe", "ok").await;
    let session = registration(&rig);
    let reference = format!("ompdesk-wsl:{}", session.key());
    open_reserved(&mut rig, &reference).await;
    let other = registration(&rig);
    let mismatch = serve_guest_state(&rig.tab, other.admit().unwrap(), HOME, |_| async {
        panic!("wrong session offered")
    })
    .await;
    assert!(mismatch.is_err());
    let dir = format!("{HOME}/.ompdesk-sessions/{}", session.key());
    let file = format!("{dir}/private.jsonl");
    for path in [
        format!("/other/.ompdesk-sessions/{}/private.jsonl", session.key()),
        format!("{HOME}/.ompdesk-sessions/{}/private.jsonl", other.key()),
        format!("{dir}/../private.jsonl"),
        format!("{dir}/CON .jsonl"),
        format!("{dir}/bad\\name.jsonl"),
    ] {
        let (host, rpc) = get_state(&mut rig, session.admit().unwrap(), |req| {
            state(&req["id"], "must-not-bind", &path)
        })
        .await;
        assert_eq!(host.err().unwrap().code, "invalid_guest_state");
        assert_eq!(rpc.unwrap_err()["code"], "invalid_guest_state");
    }
    let (host, rpc) = get_state(&mut rig, session.admit().unwrap(), |_| {
        state(&json!("uncorrelated"), "must-not-bind", &file)
    })
    .await;
    assert!(host.is_err() && rpc.is_err());
    let (host, rpc) = get_state(&mut rig, session.admit().unwrap(), |req| {
        assert_eq!(req["type"], "get_state");
        assert_eq!(req["brief"], true);
        state(&req["id"], "private-stock-id", &file)
    })
    .await;
    drop(host.unwrap());
    let response = rpc.unwrap();
    let data = &response["response"]["data"];
    assert_eq!(data["sessionId"], reference);
    assert_eq!(data["sessionFile"], reference);
    assert_eq!(data["cwd"], PROJECT);
    assert_eq!(data["parentSession"], "host-opening-parent");
    assert_eq!(data["isStreaming"], false);
    assert_eq!(data["messageCount"], 7);
    for key in [
        "queuedMessageCount",
        "isSettled",
        "model",
        "grants",
        "unknown",
    ] {
        assert!(data.get(key).is_none(), "{key} crossed the boundary");
    }
    rig.drain();
    let observed = &rig.event("sidecar.session").unwrap().data["identity"];
    for key in ["sessionId", "sessionFile", "openedBySession", "cwd"] {
        assert_eq!(observed[key], data[key]);
    }
    assert!(!response.to_string().contains("private-stock-id"));
    assert!(!response.to_string().contains("/guest-"));
    assert!(!response.to_string().contains(&file));
    // New lease, same registration: changing the bound stock id cannot replace the host identity.
    let (host, rpc) = get_state(&mut rig, session.admit().unwrap(), |req| {
        state(&req["id"], "changed", &file)
    })
    .await;
    assert!(host.is_err() && rpc.is_err());
    rig.tab_call("sidecar.cwd", json!({"cwd":"unregistered"}))
        .await
        .unwrap();
    rig.tab_call(
        "sidecar.restart",
        json!({"cwd":"unregistered", "resumeSessionPath":reference}),
    )
    .await
    .unwrap();
    let blocked = rig.status("error").await;
    assert_eq!(blocked.data["payload"]["cwd"], PROJECT);
    assert!(log(&rig).is_empty());
    finish(rig).await;
}

#[tokio::test]
async fn a_reply_from_before_restart_neither_binds_the_writer_nor_reaches_the_rpc_caller() {
    let mut rig = Rig::new("wsl-stale", "ok").await;
    let session = registration(&rig);
    let reference = format!("ompdesk-wsl:{}", session.key());
    open_reserved(&mut rig, &reference).await;
    let file = format!("{HOME}/.ompdesk-sessions/{}/s.jsonl", session.key());
    let tab = rig.tab.clone();
    let (asked, ready) = oneshot::channel();
    let (resume, restarted) = oneshot::channel();
    let (host, rpc) = tokio::join!(biased;
        serve_guest_state(&tab, session.admit().unwrap(), HOME, |request| async move {
            asked.send(()).unwrap();
            restarted.await.unwrap();
            Ok(state(&request["id"], "stale-stock", &file))
        }),
        async {
            let seq = rig.seq();
            let response = rig.post("sidecar.command", json!({"seq":seq,"tab":tab,"command":{"type":"get_state"}}));
            ready.await.unwrap();
            rig.tab_call("sidecar.restart", json!({})).await.unwrap();
            rig.status("error").await;
            resume.send(()).unwrap();
            settle(response).await
        },
    );
    assert!(host.is_err() && rpc.is_err());
    rig.drain();
    assert!(rig.event("sidecar.session").is_none());
    assert!(rig.event("sidecar.answer").is_none());
    session
        .admit()
        .unwrap()
        .bind_stock_id("current-stock")
        .unwrap();
    finish(rig).await;
}

#[tokio::test]
async fn a_verified_transcript_is_read_on_the_registered_project_without_launching_stock() {
    use sha2::{Digest, Sha256};
    let mut rig = Rig::new("wsl-offline-page", "ok").await;
    let session = registration(&rig);
    let mut writer = session.admit().unwrap();
    writer.bind_stock_id("test-stock").unwrap();
    let journal = [
        json!({"type":"session","id":"test-stock","cwd":"not-host-cwd"}),
        json!({"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"question"}}),
        json!({"type":"message","id":"other","parentId":"u1","message":{"role":"assistant","content":"wrong branch"}}),
        json!({"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"answer"},{"type":"image","path":"C:private"}]}}),
    ].map(|row| format!("{row}\n")).concat();
    let prefix = json!({"v":1,"sessionKey":session.key(),"spawnId":writer.spawn_id(),"stockId":"test-stock","bytes":journal.len(),"source":"1:2"});
    let seal = json!({"sha256":crate::hex(&Sha256::digest(journal.as_bytes()))});
    let wire = format!("{prefix}\n{journal}{seal}\n");
    writer
        .receive(
            wire.as_bytes(),
            || Ok(true),
            crate::wsl_copy::TurnDisposition::SnapshotOnly,
        )
        .unwrap();
    drop(writer);
    let seq = rig.seq();
    let mut open = rig.open_params(seq, no_queue());
    open["cwd"] = PROJECT.into();
    open["sessionPath"] = format!("ompdesk-wsl:{}", session.key()).into();
    open["wslProject"] = json!({"profile":rig.dir,"bridgeDir":"not-used","tabTag":"00000000000000000000000000000001"});
    let _opened = rig.post("sidecar.open", open);
    let page = rig
        .tab_call(
            "sidecar.command",
            json!({"command":{"type":"get_transcript_page","fromEnd":true,"limit":1}}),
        )
        .await
        .unwrap();
    let data = &page["response"]["data"];
    assert_eq!(data["totalMessages"], 2);
    assert_eq!(
        data["messages"][0],
        json!({"role":"assistant","entryId":"a1","content":[{"type":"text","text":"answer"}]})
    );
    let before = rig
        .tab_call(
            "sidecar.command",
            json!({"command":{"type":"get_transcript_page","cursor":data["prevCursor"],"limit":1}}),
        )
        .await
        .unwrap();
    assert_eq!(before["response"]["data"]["messages"][0]["entryId"], "u1");
    assert!(rig.event("sidecar.resolve").is_none() && rig.event("sidecar.spawned").is_none());
    finish(rig).await;
}

#[cfg(unix)]
async fn admitted_candidate(mode: &str) -> Rig {
    use crate::sidecar::{lane::Msg, wsl_lane::Prepared};
    use std::os::unix::fs::PermissionsExt;
    let mut rig = Rig::new(&format!("wsl-candidate-{mode}"), "ok").await;
    let exe = rig.dir.join("synthetic-wsl");
    std::fs::write(&exe, include_bytes!("wsl_fixture.py")).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(rig.dir.join("guest-mode"), mode).unwrap();
    let registration = Registration {
        distro: "{06744d8e-f876-4161-955d-5beadbb75d41}".into(),
        parent: Some("host-parent".into()),
        cwd: r"C:\assigned project".into(),
    };
    let project = json!({"profile":rig.dir,"bridgeDir":"fixture","tabTag":"0123456789abcdef0123456789abcdef"});
    let seq = rig.seq();
    let mut open = rig.open_params(seq, no_queue());
    open["cwd"] = json!(registration.cwd);
    open["wslProject"] = project.clone();
    let _open = rig.post("sidecar.open", open);
    rig.tab_call("sidecar.barrier", json!({})).await.unwrap();
    let cwd = registration.cwd.clone();
    let prepared = Prepared::fixture(exe, registration, serde_json::from_value(project).unwrap());
    crate::sidecar::tell(
        &rig.tab,
        Msg::WslPrepared {
            seq: 0,
            generation: 0,
            cwd,
            result: Ok(Some(Box::new(prepared))),
        },
    );
    rig
}

#[cfg(unix)]
#[tokio::test]
async fn admitted_lane_prompts_its_guest_and_serves_only_the_verified_answer() {
    let mut rig = admitted_candidate("ok").await;
    rig.status("ready").await;
    assert_eq!(
        rig.event("sidecar.spawned").unwrap().data["executionHost"],
        "wsl"
    );
    let response = rig
        .tab_call("sidecar.command", json!({"command":{"type":"get_state"}}))
        .await
        .unwrap();
    let reference = response["response"]["data"]["sessionFile"]
        .as_str()
        .unwrap();
    assert!(reference.starts_with("ompdesk-wsl:"));
    assert!(!response.to_string().contains("stock-test"));
    rig.tab_call("sidecar.command",json!({"command":{"type":"prompt","message":"fixture question","images":[],"deliveryId":"d1","env":{"SECRET":"no"}}})).await.unwrap();
    rig.tab_call("sidecar.command", json!({"command":{"type":"get_state"}}))
        .await
        .unwrap();
    assert!(rig.dir.join("host-refused").exists());
    let page = rig
        .tab_call(
            "sidecar.command",
            json!({"command":{"type":"get_transcript_page","fromEnd":true}}),
        )
        .await
        .unwrap();
    assert_eq!(
        page["response"]["data"]["messages"][0]["content"][0]["text"],
        "fixture answer"
    );
    rig.drain();
    let delivered = frames(&rig);
    assert!(
        delivered.iter().any(|f| f["type"] == "message_end"
            && f["message"]["content"][0]["text"] == "fixture answer")
    );
    assert!(
        delivered
            .iter()
            .all(|f| f["type"] != "host_tool_call" && !f.to_string().contains("DO-NOT-FORWARD"))
    );
    assert!(rig.event("sidecar.resolve").is_none() && rig.event("sidecar.launch").is_none());
    finish(rig).await;
}

#[cfg(unix)]
#[tokio::test]
async fn fresh_no_auth_falls_back_only_after_an_exact_guest_stop() {
    let mut rig = admitted_candidate("noauth").await;
    let fallback = rig
        .until("safe fallback", |e| e.name == "sidecar.wslFallback")
        .await;
    assert_eq!(fallback.data["reason"], "noAuth");
    rig.status("ready").await;
    assert!(rig.event("sidecar.resolve").is_some());
    finish(rig).await;
    let mut rig = admitted_candidate("unknown").await;
    rig.status("error").await;
    assert!(rig.event("sidecar.wslFallback").is_none() && rig.event("sidecar.resolve").is_none());
    assert!(
        rig.event("sidecar.tabSession").unwrap().data["sessionPath"]
            .as_str()
            .unwrap()
            .starts_with("ompdesk-wsl:")
    );
    assert_eq!(
        rig.tab_call("sidecar.whenExited", json!({}))
            .await
            .unwrap_err()["code"],
        "wsl_stop_unknown"
    );
    finish(rig).await;
}
