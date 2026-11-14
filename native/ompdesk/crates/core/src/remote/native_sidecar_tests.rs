use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::application_client::{PendingTabCloses, RemoteTab, TabEvent, TabOptions};
use super::requests::tests::pair;
use crate::remotebytes::native::{ContentCache, Words};
use crate::remotebytes::native::tests::Dir;

fn options() -> TabOptions {
    TabOptions {
        rtab: "remote-native".into(), cwd: "/isolated/workspace".into(), kind: "agent".into(),
        fresh: false, session_path: Some("/isolated/session.jsonl".into()),
        offline_message: "offline".into(), unanswered_message: "waiting".into(),
        execution_host: "original-execution-host".into(),
        sign_in_failure: Words { title: "Sign-in failed".into(), message: "Paste the callback address".into() },
    }
}

async fn next_status(events: &mut mpsc::UnboundedReceiver<TabEvent>) {
    loop {
        if events.recv().await.unwrap().name == "status" { return; }
    }
}

#[tokio::test]
async fn captured_local_disposal_receipt_joins_pending_work_and_close_acknowledgement() {
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let (tab, mut events) = RemoteTab::new(options(), device.clone(), Arc::new(PendingTabCloses::default()), Arc::new(ContentCache::new(folder.path().to_owned())));
    let receipt = tab.when_disposed();
    let second_receipt = tab.when_disposed();
    tab.start();
    let opened = incoming.recv().await.unwrap();
    assert_eq!(opened.method, "tab.open");
    host.emit("tab.event", &json!({"rtab":"remote-native","name":"status","arg":{"status":"ready","statusPayload":{},"processAlive":true,"cwd":"/isolated/workspace","kind":"agent","omp":"original-omp"}})).unwrap();
    host.answer(opened.id, Ok(json!({"cwd":"/isolated/workspace","kind":"agent","attached":true}))).unwrap();
    while !tab.snapshot().process_alive { next_status(&mut events).await; }
    let run_tab = tab.clone();
    let command = tokio::spawn(async move { run_tab.command(json!({"type":"get_state"}), Duration::from_secs(30)).await });
    let pending = incoming.recv().await.unwrap();
    assert_eq!(pending.method, "tab.command");
    tab.dispose(false);
    let mut receipt = Box::pin(receipt);
    assert!(matches!(std::future::poll_fn(|cx| std::task::Poll::Ready(receipt.as_mut().poll(cx))).await, std::task::Poll::Pending));
    host.answer(pending.id, Ok(json!({"success":true,"data":{}}))).unwrap();
    let close = incoming.recv().await.unwrap();
    assert_eq!(close.method, "tab.close");
    assert!(matches!(std::future::poll_fn(|cx| std::task::Poll::Ready(receipt.as_mut().poll(cx))).await, std::task::Poll::Pending));
    host.answer(close.id, Ok(Value::Null)).unwrap();
    receipt.await.unwrap();
    second_receipt.await.unwrap();
    assert!(tab.when_disposed().await.is_ok(), "the same original actor result remains available after disposal");
    assert_eq!(command.await.unwrap().unwrap_err().fault.code, "remote_offline");
    device.disconnect_for_test();
    host.disconnect_for_test();
}
