use super::*;
use std::fs;
use std::time::Duration;
use tokio::time::timeout;

async fn reply(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn matches_the_js_handshake_but_not_reordered_ordinary_fields() {
    let dir = crate::fs::disk::make_temp_dir("rea-handshake-").unwrap();
    let store = Arc::new(Store::new(Some(dir.clone())));
    fs::write(
        dir.join(format!("rea-{}.json", catalog::CONFIG.version)),
        json!({
            "version": catalog::CONFIG.version, "client": r#"{"2":1,"10":2,"a":null,"b":0}"#,
            "initialize": {"instructions":"from disk"}, "tools":[], "prompts": null,
        })
        .to_string(),
    )
    .unwrap();
    let command = Arc::new(vec![dir.join("not-a-program").into_os_string()]);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let first = Session::new(store.clone(), command.clone(), None, tx);
    first.receive(serde_json::from_str(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"10":2,"a":null,"b":-0.0,"2":1.0}}"#).unwrap());
    assert_eq!(reply(&mut rx).await["result"]["instructions"], "from disk");
    first.receive(json!({"jsonrpc":"2.0", "id":2, "method":"prompts/list"}));
    assert_eq!(reply(&mut rx).await.get("result"), Some(&Value::Null));
    assert!(!first.running());
    first.close().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let second = Session::new(store, command, None, tx);
    second.receive(serde_json::from_str(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"2":1,"10":2,"b":0,"a":null}}"#).unwrap());
    assert_eq!(reply(&mut rx).await["error"]["message"], "REA child exited");
    second.close().await;
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn child_exit_answers_all_pending_ids_before_ending_the_stream() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let argv = ["/bin/sh", "-c", "read -r a && read -r b && read -r c"];
    let session = Session::new(
        Arc::new(Store::new(None)),
        Arc::new(argv.map(OsString::from).into()),
        None,
        tx,
    );
    let ids = [json!(17), json!("17"), Value::Null];
    for id in &ids {
        session.receive(json!({"jsonrpc":"2.0", "id":id, "method":"ping"}));
    }
    let mut waiting = ids.to_vec();
    timeout(Duration::from_secs(10), async {
        while let Some(msg) = rx.recv().await {
            assert_eq!(
                msg["error"],
                json!({"code":-32603,"message":"REA child exited"})
            );
            let index = waiting
                .iter()
                .position(|id| Some(id) == msg.get("id"))
                .unwrap();
            waiting.swap_remove(index);
        }
    })
    .await
    .unwrap();
    assert!(waiting.is_empty());
    assert!(!session.running());
    session.close().await;
}
