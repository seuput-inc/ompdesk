use std::future::Future;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::remote::application_client::{PendingTabCloses, RemoteTab, TabEvent, TabOptions};
use crate::remote::requests::tests::pair;
use crate::pool::application::Sidecar as _;
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

struct Sink {
    output: Mutex<Option<mpsc::UnboundedSender<TabEvent>>>,
    flushed: AtomicUsize,
}
impl RemoteSink for Sink {
    fn event(&self, event: TabEvent) {
        if let Some(output) = self.output.lock().unwrap().as_ref() {
            let _ = output.send(event);
        }
    }
    fn before_response(&self) { self.flushed.fetch_add(1, Ordering::AcqRel); }
    fn remove_listeners(&self) { self.output.lock().unwrap().take(); }
}

#[tokio::test]
async fn captured_local_disposal_receipt_joins_pending_work_and_close_acknowledgement() {
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let (tab, events) = RemoteTab::new(options(), device.clone(), Arc::new(PendingTabCloses::default()), Arc::new(ContentCache::new(folder.path().to_owned())));
    let original = tab.clone();
    let (output, mut delivered) = mpsc::unbounded_channel();
    let sink = Arc::new(Sink { output: Mutex::new(Some(output)), flushed: AtomicUsize::new(0) });
    let (service, held) = Service::from_tab(tab, events, sink.clone());
    assert!(service.remote_tab().same_instance(&original));
    let run_service = Arc::clone(&service);
    let run_host = host.clone();
    let outcome = tokio::spawn(async move {
        let receipt = run_service.when_disposed();
        let second_receipt = run_service.when_disposed();
        run_service.start();
        let opened = incoming.recv().await.unwrap();
        assert_eq!(opened.method, "tab.open");
        run_host.emit("tab.event", &json!({"rtab":"remote-native","name":"status","arg":{"status":"ready","statusPayload":{},"processAlive":true,"cwd":"/isolated/workspace","kind":"agent","omp":"original-omp"}})).unwrap();
        run_host.answer(opened.id, Ok(json!({"cwd":"/isolated/workspace","kind":"agent","attached":true}))).unwrap();
        while run_service.facts()["processAlive"] != true { next_status(&mut delivered).await; }
        let command = tokio::spawn(run_service.stock(json!({"type":"get_state"})));
        let pending = incoming.recv().await.unwrap();
        assert_eq!(pending.method, "tab.command");
        run_service.dispose();
        let mut receipt = Box::pin(receipt);
        assert!(matches!(std::future::poll_fn(|cx| std::task::Poll::Ready(receipt.as_mut().poll(cx))).await, std::task::Poll::Pending));
        run_host.answer(pending.id, Ok(json!({"success":true,"data":{}}))).unwrap();
        let close = incoming.recv().await.unwrap();
        assert_eq!(close.method, "tab.close");
        assert!(matches!(std::future::poll_fn(|cx| std::task::Poll::Ready(receipt.as_mut().poll(cx))).await, std::task::Poll::Pending));
        run_host.answer(close.id, Ok(Value::Null)).unwrap();
        receipt.await.unwrap();
        second_receipt.await.unwrap();
        run_service.when_disposed().await.unwrap();
        assert_eq!(command.await.unwrap().unwrap_err().code, "remote_offline");
    }).await;
    service.dispose();
    if outcome.is_err() {
        device.disconnect_for_test();
        host.disconnect_for_test();
    }
    let joined = held.await;
    device.disconnect_for_test();
    host.disconnect_for_test();
    outcome.unwrap();
    joined.unwrap();
    assert_eq!(sink.flushed.load(Ordering::Acquire), 1);
}

#[tokio::test]
async fn failed_rpc_frames_and_original_close_fault_are_not_promoted_to_success() {
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let (tab, events) = RemoteTab::new(options(), device.clone(), Arc::new(PendingTabCloses::default()), Arc::new(ContentCache::new(folder.path().to_owned())));
    let (output, mut delivered) = mpsc::unbounded_channel();
    let sink = Arc::new(Sink { output: Mutex::new(Some(output)), flushed: AtomicUsize::new(0) });
    let (service, held) = Service::from_tab(tab, events, sink);
    let run_service = Arc::clone(&service);
    let run_host = host.clone();
    let outcome = tokio::spawn(async move {
        run_service.start();
        let opened = incoming.recv().await.unwrap();
        run_host.emit("tab.event", &json!({"rtab":"remote-native","name":"status","arg":{"status":"ready","statusPayload":{},"processAlive":true,"cwd":"/isolated/workspace","kind":"agent","omp":"original-omp"}})).unwrap();
        run_host.answer(opened.id, Ok(json!({"cwd":"/isolated/workspace","kind":"agent","attached":true}))).unwrap();
        while run_service.facts()["processAlive"] != true { next_status(&mut delivered).await; }
        let stock = run_service.stock(json!({"type":"set_session_name","name":"Original title"}));
        let answer = async {
            let request = incoming.recv().await.unwrap();
            assert_eq!(request.method, "tab.command");
            let frame = json!({"type":"response","success":false,"error":"Original rename refusal","code":"internal","command":"set_session_name"});
            run_host.answer(request.id, Ok(frame.clone())).unwrap();
            frame
        };
        let (response, original) = tokio::join!(stock, answer);
        assert_eq!(response.unwrap(), original);
        run_host.emit("tab.event", &json!({"rtab":"remote-native","name":"bridge","arg":{"connected":true,"ompVersion":"fixture-version","unavailable":[]}})).unwrap();
        loop { if delivered.recv().await.unwrap().name == "bridge" { break; } }
        assert_eq!(run_service.bridge("capabilities".into(), None, None).await.unwrap(), json!({"ompVersion":"fixture-version","unavailable":[]}));
        assert_eq!(run_service.bridge("set_session_name".into(), None, None).await.unwrap_err().code, "remote_bridge_method");
        assert_eq!(run_service.sleep().unwrap_err().code, "unsupported_remote_sleep");
        assert_eq!(run_service.facts()["sleep"], false);
        assert!(incoming.try_recv().is_err(), "unsupported bridge and sleep must not invent a host request");
        let receipt = run_service.when_disposed();
        run_service.dispose();
        let close = incoming.recv().await.unwrap();
        assert_eq!(close.method, "tab.close");
        run_host.answer(close.id, Err(crate::server::Fault::new("view_commit_unconfirmed", "Original close acknowledgement was lost").into())).unwrap();
        let error = receipt.await.unwrap_err();
        assert_eq!(error.code, "view_commit_unconfirmed");
        assert_eq!(error.message, "Original close acknowledgement was lost");
        assert_eq!(run_service.when_disposed().await.unwrap_err().code, error.code);
    }).await;
    service.dispose();
    if outcome.is_err() {
        device.disconnect_for_test();
        host.disconnect_for_test();
    }
    let joined = held.await;
    device.disconnect_for_test();
    host.disconnect_for_test();
    outcome.unwrap();
    assert_eq!(joined.unwrap_err().code, "view_commit_unconfirmed");
}

#[tokio::test]
async fn bound_actions_refuse_old_hosts_and_never_retry_or_replay_into_a_replacement_run() {
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let (tab, events) = RemoteTab::new(options(), device.clone(), Arc::new(PendingTabCloses::default()), Arc::new(ContentCache::new(folder.path().to_owned())));
    let (output, mut delivered) = mpsc::unbounded_channel();
    let sink = Arc::new(Sink { output: Mutex::new(Some(output)), flushed: AtomicUsize::new(0) });
    let (service, held) = Service::from_tab(tab, events, sink);
    let (replacement_device, replacement_host, _replacement_keep) = pair().await;
    let mut replacement_incoming = replacement_host.take_requests().unwrap();
    let run_service = Arc::clone(&service);
    let run_host = host.clone();
    let run_replacement_host = replacement_host.clone();
    let run_replacement_device = replacement_device.clone();
    let outcome = tokio::spawn(async move {
        run_service.start();
        let opened = incoming.recv().await.unwrap();
        run_host.emit("tab.event", &json!({"rtab":"remote-native","name":"status","arg":{"status":"ready","processAlive":true,"omp":"original-omp"}})).unwrap();
        run_host.answer(opened.id, Ok(json!({"cwd":"/isolated/workspace","kind":"agent","attached":true}))).unwrap();
        while run_service.facts()["processAlive"] != true { next_status(&mut delivered).await; }
        let old_generation = run_service.generation();
        assert_eq!(run_service.stock_for_generation(old_generation, json!({"type":"set_session_name","name":"Must not run on old host"})).await.unwrap_err().code, "remote_run_binding_unavailable");
        assert_eq!(run_service.send_for_generation(old_generation, json!({"type":"host_tool_result","id":"must-not-replay"})).await.unwrap_err().code, "remote_run_binding_unavailable");
        assert!(incoming.try_recv().is_err(), "a host that ignores expectedOmp must receive no bound mutation");
        run_service.relink(run_replacement_device);
        let opened = replacement_incoming.recv().await.unwrap();
        run_replacement_host.emit("tab.event", &json!({"rtab":"remote-native","name":"status","arg":{"status":"ready","processAlive":true,"omp":"original-omp"}})).unwrap();
        run_replacement_host.answer(opened.id, Ok(json!({"cwd":"/isolated/workspace","kind":"agent","attached":true,"boundOmp":true}))).unwrap();
        while run_service.generation() == old_generation || run_service.facts()["processAlive"] != true { next_status(&mut delivered).await; }
        let captured = run_service.generation();
        assert_ne!(captured, old_generation, "link replacement changes the binding even when omp is unchanged");
        let pending = run_service.stock_for_generation(captured, json!({"type":"get_autopilot"}));
        let pending = tokio::spawn(pending);
        let request = replacement_incoming.recv().await.unwrap();
        assert_eq!(request.method, "tab.command");
        assert_eq!(request.params["expectedOmp"], "original-omp");
        run_replacement_host.emit("tab.event", &json!({"rtab":"remote-native","name":"status","arg":{"status":"ready","processAlive":true,"omp":"replacement-omp"}})).unwrap();
        while run_service.generation() == captured { next_status(&mut delivered).await; }
        run_replacement_host.answer(request.id, Ok(json!({"success":true,"data":{"~read":"old.2","base":"old.1","delta":{"~delta":"x","set":{},"unset":[]}}}))).unwrap();
        assert_eq!(pending.await.unwrap().unwrap_err().code, "remote_run_changed");
        assert_eq!(run_service.stock_for_generation(captured, json!({"type":"set_session_name","name":"Must not rename replacement"})).await.unwrap_err().code, "remote_run_changed");
        assert_eq!(run_service.send_for_generation(captured, json!({"type":"host_tool_result","id":"must-not-replay"})).await.unwrap_err().code, "remote_run_changed");
        assert_eq!(run_service.bridge_for_generation(captured, "capabilities".into(), None, None).await.unwrap_err().code, "remote_run_changed");
        assert!(replacement_incoming.try_recv().is_err(), "no fresh read retry or stale host reply may reach the replacement");
        let current = run_service.generation();
        let current_read = run_service.stock_for_generation(current, json!({"type":"get_state"}));
        let serve = async {
            let request = replacement_incoming.recv().await.unwrap();
            assert_eq!(request.params["expectedOmp"], "replacement-omp");
            run_replacement_host.answer(request.id, Ok(json!({"success":true,"data":{"sessionFile":"/isolated/replacement.jsonl"}}))).unwrap();
        };
        let (response, ()) = tokio::join!(current_read, serve);
        assert_eq!(response.unwrap()["data"]["sessionFile"], "/isolated/replacement.jsonl");
        run_service.keep_on_host();
        run_service.dispose();
        run_service.when_disposed().await.unwrap();
        assert!(replacement_incoming.try_recv().is_err(), "keeping the host execution is not a remote process close");
    }).await;
    service.keep_on_host();
    service.dispose();
    if outcome.is_err() {
        for link in [&device, &host, &replacement_device, &replacement_host] { link.disconnect_for_test(); }
    }
    let joined = held.await;
    for link in [&device, &host, &replacement_device, &replacement_host] { link.disconnect_for_test(); }
    outcome.unwrap();
    joined.unwrap();
}
