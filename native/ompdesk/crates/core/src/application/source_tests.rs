use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use super::*;
use crate::remote::application_client::{TabEvent, TabOptions};
use crate::remote::application_devices::tests::{linked, tab_present};
use crate::remote::native_sidecar::RemoteSink;
use crate::remote::requests::tests::pair;
use crate::remotebytes::native::Words;
use crate::remotebytes::native::tests::Dir;

async fn pending<F: Future + ?Sized>(future: &mut std::pin::Pin<Box<F>>) {
    assert!(matches!(
        std::future::poll_fn(|cx| Poll::Ready(future.as_mut().poll(cx))).await,
        Poll::Pending
    ));
}

struct Forward {
    output: Mutex<Option<mpsc::UnboundedSender<TabEvent>>>,
    flushes: AtomicUsize,
}

impl RemoteSink for Forward {
    fn event(&self, event: TabEvent) {
        if let Some(output) = self.output.lock().unwrap().as_ref() {
            let _ = output.send(event);
        }
    }
    fn before_response(&self) {
        self.flushes.fetch_add(1, Ordering::AcqRel);
    }
    fn remove_listeners(&self) {
        self.output.lock().unwrap().take();
    }
}

fn options() -> TabOptions {
    TabOptions {
        rtab: "source-remote".into(),
        cwd: "/isolated/source-workspace".into(),
        kind: "agent".into(),
        fresh: false,
        session_path: Some("/isolated/source-session.jsonl".into()),
        offline_message: "offline".into(),
        unanswered_message: "waiting".into(),
        execution_host: "original-execution-host".into(),
        sign_in_failure: Words {
            title: "Sign-in failed".into(),
            message: "Paste the callback address".into(),
        },
    }
}

#[tokio::test]
async fn remote_retirement_joins_the_original_close_and_held_fault_after_a_waiter_disappears() {
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let devices = linked(&folder, device.clone());
    let (tab, events) = devices.create_tab("host", options()).unwrap();
    let release = devices
        .capture_tab_release("host", "source-remote", &tab)
        .unwrap();
    let (output, mut delivered) = mpsc::unbounded_channel();
    let sink = Arc::new(Forward {
        output: Mutex::new(Some(output)),
        flushes: AtomicUsize::new(0),
    });
    let (service, held) = RemoteSidecar::from_tab(tab, events, sink.clone());
    let (finish, finished) = oneshot::channel::<Result<(), Fault>>();
    let original_held = Receipt::join(held);
    let observed_held = original_held.clone();
    let source = Arc::new(Source::from_remote(
        Arc::clone(&service),
        Box::pin(async move {
            let original = observed_held.wait().await;
            let final_result = finished
                .await
                .map_err(|_| Fault::new("test_held", "Held barrier ended"))?;
            original.and(final_result)
        }),
        release,
    ));
    let run = Arc::clone(&source);
    let serving = host.clone();
    let outcome = tokio::spawn(async move {
        assert!(!run.is_local());
        assert!(run.local().is_none());
        assert!(Arc::ptr_eq(run.remote().unwrap(), &service));
        assert!(run.settled().is_none());
        run.start();
        let open = incoming.recv().await.unwrap();
        assert_eq!(open.method, "tab.open");
        serving.emit("tab.event", &json!({"rtab":"source-remote","name":"status","arg":{"status":"ready","processAlive":true,"cwd":"/isolated/source-workspace","omp":"original-omp"}})).unwrap();
        serving.answer(open.id, Ok(json!({"cwd":"/isolated/source-workspace","kind":"agent","attached":true,"boundOmp":true}))).unwrap();
        while run.facts()["processAlive"] != true { delivered.recv().await.unwrap(); }
        assert_eq!(run.sleep().unwrap_err().code, "unsupported_remote_sleep");
        assert!(incoming.try_recv().is_err());
        let generation = run.generation();
        let response = run.stock_for_generation(generation, json!({"type":"set_session_name","name":"Refused"}));
        let answer = async {
            let request = incoming.recv().await.unwrap();
            assert_eq!(request.params["expectedOmp"], "original-omp");
            serving.answer(request.id, Ok(json!({"success":false,"error":"Original refusal","code":"internal"}))).unwrap();
        };
        let (response, ()) = tokio::join!(response, answer);
        assert_eq!(response.unwrap(), json!({"success":false,"error":"Original refusal","code":"internal"}));
        let retired = run.retire();
        drop(retired.wait());
        let mut completion = run.settled().unwrap().wait();
        let close = incoming.recv().await.unwrap();
        assert_eq!(close.method, "tab.close");
        pending(&mut completion).await;
        serving.answer(close.id, Ok(Value::Null)).unwrap();
        original_held.wait().await.unwrap();
        pending(&mut completion).await;
        let failure = Fault::new("held_failure", "Original source Held failed");
        finish.send(Err(failure.clone())).unwrap();
        assert_eq!(completion.await, Err(failure.clone()));
        assert_eq!(run.retire().wait().await, Err(failure));
        assert!(incoming.try_recv().is_err(), "retirement never closes the original host twice");
    }).await;
    drop(source.retire());
    if outcome.is_err() {
        device.disconnect_for_test();
        host.disconnect_for_test();
    }
    let joined = source.settled().unwrap().wait().await;
    device.disconnect_for_test();
    host.disconnect_for_test();
    outcome.unwrap();
    assert_eq!(joined.unwrap_err().code, "held_failure");
    assert_eq!(sink.flushes.load(Ordering::Acquire), 1);
    assert!(!tab_present(&devices, "host", "source-remote"));
    devices.dispose().await.unwrap();
}

#[tokio::test]
async fn abandoning_the_remote_source_retains_actual_actor_cleanup_until_close_acknowledgement() {
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let devices = linked(&folder, device.clone());
    let (tab, events) = devices.create_tab("host", options()).unwrap();
    let release = devices
        .capture_tab_release("host", "source-remote", &tab)
        .unwrap();
    let (output, mut delivered) = mpsc::unbounded_channel();
    let sink = Arc::new(Forward {
        output: Mutex::new(Some(output)),
        flushes: AtomicUsize::new(0),
    });
    let (service, held) = RemoteSidecar::from_tab(tab, events, sink);
    let weak = Arc::downgrade(&service);
    let source = Arc::new(Source::from_remote(Arc::clone(&service), held, release));
    let actual = service.when_disposed();
    let run_devices = Arc::clone(&devices);
    let run_host = host.clone();
    let outcome = tokio::spawn(async move {
        let devices = run_devices;
        let host = run_host;
    source.start();
    let open = incoming.recv().await.unwrap();
    host.emit("tab.event", &json!({"rtab":"source-remote","name":"status","arg":{"status":"ready","processAlive":true,"omp":"original-omp"}})).unwrap();
    host.answer(open.id, Ok(json!({"cwd":"/isolated/source-workspace","kind":"agent","attached":true,"boundOmp":true}))).unwrap();
    while source.facts()["processAlive"] != true {
        delivered.recv().await.unwrap();
    }
    assert!(tab_present(&devices, "host", "source-remote"));
    let survivor = Arc::clone(&source);
    drop(source);
    assert!(
        incoming.try_recv().is_err(),
        "a non-final Arc drop cannot retire the source"
    );
    drop(service);
    drop(survivor);
    let close = incoming.recv().await.unwrap();
    assert_eq!(close.method, "tab.close");
    assert!(
        !tab_present(&devices, "host", "source-remote"),
        "final Source drop removes its exact device-map entry"
    );
    assert!(
        weak.upgrade().is_some(),
        "the detached cleanup still owns the actual original service"
    );
    let mut actual = actual;
    pending(&mut actual).await;
    host.answer(close.id, Ok(Value::Null)).unwrap();
    actual.await.unwrap();
    assert!(incoming.try_recv().is_err());
    }).await;
    device.disconnect_for_test();
    host.disconnect_for_test();
    let disposed = devices.dispose().await;
    outcome.unwrap();
    disposed.unwrap();
}

#[tokio::test]
async fn remote_keep_on_host_is_preserved_by_source_retirement() {
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let devices = linked(&folder, device.clone());
    let (tab, events) = devices.create_tab("host", options()).unwrap();
    let release = devices
        .capture_tab_release("host", "source-remote", &tab)
        .unwrap();
    let (output, mut delivered) = mpsc::unbounded_channel();
    let sink = Arc::new(Forward {
        output: Mutex::new(Some(output)),
        flushes: AtomicUsize::new(0),
    });
    let (service, held) = RemoteSidecar::from_tab(tab, events, sink);
    let source = Source::from_remote(Arc::clone(&service), held, release);
    let run_devices = Arc::clone(&devices);
    let run_host = host.clone();
    let outcome = tokio::spawn(async move {
        let devices = run_devices;
        let host = run_host;
    source.start();
    let open = incoming.recv().await.unwrap();
    host.emit("tab.event", &json!({"rtab":"source-remote","name":"status","arg":{"status":"ready","processAlive":true,"omp":"original-omp"}})).unwrap();
    host.answer(open.id, Ok(json!({"cwd":"/isolated/source-workspace","kind":"agent","attached":true,"boundOmp":true}))).unwrap();
    while source.facts()["processAlive"] != true {
        delivered.recv().await.unwrap();
    }
    service.keep_on_host();
    source.retire().wait().await.unwrap();
    assert!(!source.is_local());
    assert!(
        incoming.try_recv().is_err(),
        "local actor retirement must preserve an execution kept on its original host"
    );
    assert!(!tab_present(&devices, "host", "source-remote"));
    }).await;
    device.disconnect_for_test();
    host.disconnect_for_test();
    let disposed = devices.dispose().await;
    outcome.unwrap();
    disposed.unwrap();
}

#[tokio::test]
async fn an_original_source_release_cannot_remove_a_replacement_in_the_device_map() {
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let devices = linked(&folder, device.clone());
    let (original, events) = devices.create_tab("host", options()).unwrap();
    let release = devices
        .capture_tab_release("host", "source-remote", &original)
        .unwrap();
    let (output, _delivered) = mpsc::unbounded_channel();
    let sink = Arc::new(Forward {
        output: Mutex::new(Some(output)),
        flushes: AtomicUsize::new(0),
    });
    let (service, held) = RemoteSidecar::from_tab(original.clone(), events, sink);
    let source = Source::from_remote(service, held, release);
    let run_devices = Arc::clone(&devices);
    let outcome = tokio::spawn(async move {
        let devices = run_devices;
        devices.release_tab("host", "source-remote", &original, true);
        let (replacement, _events) = devices.create_tab("host", options()).unwrap();
        source.retire().wait().await.unwrap();
        assert!(tab_present(&devices, "host", "source-remote"));
        let release = devices
            .capture_tab_release("host", "source-remote", &replacement)
            .unwrap();
        let done = replacement.when_disposed();
        release.release(true);
        done.await.unwrap();
        assert!(!tab_present(&devices, "host", "source-remote"));
    })
    .await;
    device.disconnect_for_test();
    host.disconnect_for_test();
    let disposed = devices.dispose().await;
    outcome.unwrap();
    disposed.unwrap();
}

#[cfg(unix)]
mod local {
    use super::*;
    use crate::application::launch_host::tests::concrete::World;
    use crate::application::local_sources::LocalSources;
    use crate::machine::Environment;
    use crate::sidecar::native;

    #[tokio::test]
    async fn local_run_receipt_does_not_retire_a_restarted_source_or_release_its_application() {
        let world = World::new("source-local-run").await;
        let factory = LocalSources::new(world.config.clone());
        let (output, mut events) = mpsc::unbounded_channel();
        let sink = Arc::new(native::tests::Recorder {
            events: output,
            flushes: AtomicUsize::new(0),
        });
        let mut created = factory
            .create(
                &world.spawn,
                format!("source-{}", world.spawn.tab),
                sink,
                None,
                Environment::new(),
            )
            .unwrap();
        let original = Arc::clone(&created.source);
        let application = Arc::downgrade(&created.application);
        let cleanup_held = Receipt::join(created.held);
        created.held = cleanup_held.wait();
        let cleanup_ingress = Arc::clone(&created.ingress);
        let source = Source::from_local(created);
        assert!(source.is_local());
        assert!(Arc::ptr_eq(source.local().unwrap(), &original));
        assert!(source.remote().is_none());
        let world = Arc::new(tokio::sync::Mutex::new(world));
        let run_world = Arc::clone(&world);
        let outcome = tokio::spawn(async move {
            let world = run_world.lock().await;
            source.start();
            native::tests::ready_with(&mut events, |_| None).await;
            original.barrier().await.unwrap();
            let run_exit = source.exit_waiter();
            source.restart(None);
            native::tests::ready_with(&mut events, |_| None).await;
            run_exit.await.unwrap();
            original.barrier().await.unwrap();
            assert_eq!(source.facts()["processAlive"], true);
            assert!(source.settled().is_none());
            assert!(application.upgrade().is_some());
            world.begin_close();
            let retired = source.retire();
            drop(retired.wait());
            source.settled().unwrap().wait().await.unwrap();
            drop(source);
            assert!(application.upgrade().is_none());
        })
        .await;
        let world = Arc::try_unwrap(world)
            .ok()
            .expect("the completed scenario released its World")
            .into_inner();
        world.begin_close();
        let held = cleanup_held.wait().await;
        let ingress = cleanup_ingress.close().await;
        let factory = factory.close().await;
        let closed = world.finish_close().await;
        outcome.unwrap();
        held.unwrap();
        ingress.unwrap();
        factory.unwrap();
        closed.unwrap();
    }

    #[tokio::test]
    async fn local_retirement_retains_the_application_and_all_effects_after_the_caller_drops() {
        let world = World::new("source-local-held").await;
        let factory = LocalSources::new(world.config.clone());
        let (output, mut events) = mpsc::unbounded_channel();
        let sink = Arc::new(native::tests::Recorder {
            events: output,
            flushes: AtomicUsize::new(0),
        });
        let mut created = factory
            .create(
                &world.spawn,
                format!("source-{}", world.spawn.tab),
                sink,
                None,
                Environment::new(),
            )
            .unwrap();
        let original = Arc::clone(&created.source);
        let application = Arc::downgrade(&created.application);
        let held = created.held;
        let (finish, finished) = oneshot::channel::<Result<(), Fault>>();
        let actual_held = Receipt::join(held);
        let observed = actual_held.clone();
        created.held = Box::pin(async move {
            let actual = observed.wait().await;
            let last = finished
                .await
                .map_err(|_| Fault::new("held_barrier", "Held barrier ended"))?;
            actual.and(last)
        });
        let cleanup_held = actual_held.clone();
        let cleanup_ingress = Arc::clone(&created.ingress);
        let source = Source::from_local(created);
        let world = Arc::new(tokio::sync::Mutex::new(world));
        let run_world = Arc::clone(&world);
        let outcome = tokio::spawn(async move {
            let world = run_world.lock().await;
            source.start();
            native::tests::ready_with(&mut events, |_| None).await;
            original.barrier().await.unwrap();
            world.begin_close();
            let receipt = source.retire();
            drop(receipt.wait());
            let retained = source.settled().unwrap();
            drop(source);
            actual_held.wait().await.unwrap();
            assert!(
                application.upgrade().is_some(),
                "Held still owns the original Application"
            );
            let mut waiting = retained.wait();
            pending(&mut waiting).await;
            let error = Fault::new("held_failure", "Original local Held failed");
            finish.send(Err(error.clone())).unwrap();
            assert_eq!(waiting.await, Err(error));
            assert!(application.upgrade().is_none());
        })
        .await;
        let world = Arc::try_unwrap(world)
            .ok()
            .expect("the completed scenario released its World")
            .into_inner();
        world.begin_close();
        let held = cleanup_held.wait().await;
        let ingress = cleanup_ingress.close().await;
        let factory = factory.close().await;
        let closed = world.finish_close().await;
        outcome.unwrap();
        held.unwrap();
        ingress.unwrap();
        factory.unwrap();
        closed.unwrap();
    }

    #[tokio::test]
    async fn abandoning_the_final_local_source_starts_its_original_child_and_lane_cleanup() {
        let world = World::new("source-local-abandoned").await;
        let factory = LocalSources::new(world.config.clone());
        let (output, mut events) = mpsc::unbounded_channel();
        let sink = Arc::new(native::tests::Recorder {
            events: output,
            flushes: AtomicUsize::new(0),
        });
        let mut created = factory
            .create(
                &world.spawn,
                format!("source-{}", world.spawn.tab),
                sink,
                None,
                Environment::new(),
            )
            .unwrap();
        let original = Arc::clone(&created.source);
        let held = Receipt::join(created.held);
        created.held = held.wait();
        let cleanup_held = held.clone();
        let cleanup_ingress = Arc::clone(&created.ingress);
        let source = Arc::new(Source::from_local(created));
        let world = Arc::new(tokio::sync::Mutex::new(world));
        let run_world = Arc::clone(&world);
        let outcome = tokio::spawn(async move {
            let world = run_world.lock().await;
            source.start();
            native::tests::ready_with(&mut events, |_| None).await;
            original.barrier().await.unwrap();
            assert_eq!(source.facts()["processAlive"], true);
            let survivor = Arc::clone(&source);
            drop(source);
            original.barrier().await.unwrap();
            assert_eq!(survivor.facts()["processAlive"], true);
            world.begin_close();
            let exited = survivor.exit_waiter();
            drop(survivor);
            exited.await.unwrap();
            held.wait().await.unwrap();
            crate::application::launch_host::tests::concrete::event(
                &mut events,
                "sidecar.disposed",
            )
            .await;
            assert_eq!(original.facts()["processAlive"], false);
        })
        .await;
        let world = Arc::try_unwrap(world)
            .ok()
            .expect("the completed scenario released its World")
            .into_inner();
        world.begin_close();
        let held = cleanup_held.wait().await;
        let ingress = cleanup_ingress.close().await;
        let factory = factory.close().await;
        let closed = world.finish_close().await;
        outcome.unwrap();
        held.unwrap();
        ingress.unwrap();
        factory.unwrap();
        closed.unwrap();
    }
}
