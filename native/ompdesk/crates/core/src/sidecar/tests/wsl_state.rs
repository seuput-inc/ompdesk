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
