//! Real pool/connection/source admission issues the borrowed proof; no fixture constructs VerifiedCard.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ompdesk_app_contract::NativeCaller;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::agentctl::journal::Persistence;
use crate::agentctl::journal::mail_outbox::MailOutbox;
use crate::agentctl::runtime::{RuntimeConfig, start};
use crate::agentctl::service::host::Caps;
use crate::agentctl::service::tuning::Tuning;
use crate::agentctl::service::{AgentControl, Files, JournalFile};
use crate::application::launch_host::tests::concrete::World;
use crate::application::local_sources::LocalSources;
use crate::application::source::tests::{Forward, options};
use crate::pool::application::native::tests::{set_test_source, test_host_for};
use crate::pool::application::native::{CapturedEvent, Config as PoolConfig};
use crate::pool::application::{Application, Sidecar};
use crate::remote::application_devices::tests::linked;
use crate::remote::requests::tests::pair;
use crate::remotebytes::native::tests::Dir;
use crate::sidecar::native::tests::Recorder;
use crate::worktree_lifecycle::RemovalClaims;

#[tokio::test]
async fn only_the_original_admitted_card_can_keep_a_durable_observer_obligation() {
    let world = World::new("observed-card-source").await;
    let factory = LocalSources::new(world.config.clone());
    let (local_events, _local_rx) = mpsc::unbounded_channel();
    let local = factory
        .create(
            &world.spawn,
            "observed-card-recipient-lane".into(),
            Arc::new(Recorder {
                events: local_events,
                flushes: AtomicUsize::new(0),
            }),
            None,
            Default::default(),
        )
        .unwrap();
    let recipient = Arc::new(Source::from_local(local));
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let devices = linked(&folder, device.clone());
    let (tab, events) = devices.create_tab("host", options()).unwrap();
    let release = devices
        .capture_tab_release("host", "source-remote", &tab)
        .unwrap();
    let (output, mut delivered) = mpsc::unbounded_channel();
    let (remote, held) = RemoteSource::from_tab(
        tab,
        events,
        Arc::new(Forward {
            output: Mutex::new(Some(output)),
            flushes: AtomicUsize::new(0),
        }),
    );
    let child = Arc::new(Source::from_remote(remote, held, release));
    let question = json!({"id":"actual-question","method":"input","title":"Which branch?","options":["main","topic"]});
    let serving = host.clone();
    let reply_question = question.clone();
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        while let Some(request) = tokio::select! {
            request = incoming.recv() => request,
            _ = &mut stopped => None,
        } {
            let reply = match request.method.as_str() {
                "tab.open" => {
                    serving.emit("tab.event", &json!({"rtab":"source-remote","name":"status","arg":{
                        "status":"ready","processAlive":true,"cwd":"/isolated/source-workspace","omp":"original-omp"
                    }})).unwrap();
                    json!({"cwd":"/isolated/source-workspace","kind":"agent","attached":true,"boundOmp":true})
                }
                "tab.observeCard" => {
                    assert_eq!(
                        request.params,
                        json!({"rtab":"source-remote","expectedOmp":"original-omp","cardId":"actual-question"})
                    );
                    json!({"sessionPath":"/isolated/source-session.jsonl","ompEpoch":"original-omp","cardId":"actual-question","request":reply_question})
                }
                "tab.close" => Value::Null,
                method => panic!("unexpected observed-card wire effect: {method}"),
            };
            serving.answer(request.id, Ok(reply)).unwrap();
        }
    });
    let callers = Arc::clone(&world.callers);
    let page = callers
        .page(&NativeCaller::Desktop {
            win_id: 17,
            wc_id: 117,
        })
        .unwrap();
    let child_tab = "observed-remote-child";
    let reservation = callers
        .reserve_execution(&page.owner, child_tab, Some(17))
        .unwrap();
    let child_owner = callers.execution_owner(child_tab).unwrap();
    callers.finish_execution_reservation(reservation, true);
    let app = Arc::new(Application::new(test_host_for(
        Arc::clone(&callers),
        |source: &Source| source.local().map(Arc::as_ref),
    )));
    let pool = Pool::new(
        PoolConfig {
            id: 0x6f62_7365_7276_6564,
            view_epoch: "observed-card-test".into(),
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: false,
            now_ms: || 1234,
            callers,
            removal_claims: RemovalClaims::new(),
        },
        Arc::clone(&app),
    )
    .await
    .unwrap();
    pool.call("seed", json!({"tabs":[
        {"tab":world.spawn.tab,"win":17,"status":"asleep","sessionFile":"/recipient.jsonl"},
        {"tab":child_tab,"win":17,"device":"host","status":"ready","sessionFile":"/isolated/source-session.jsonl"}
    ]}), false).await.unwrap();
    set_test_source(&app, &world.spawn.tab, Arc::clone(&recipient));
    set_test_source(&app, child_tab, Arc::clone(&child));
    pool.call(
        "setTabOpener",
        json!({"tab":child_tab,"opener":world.spawn.tab}),
        false,
    )
    .await
    .unwrap();
    world.prefs.set("agentControl", json!(true)).unwrap();
    let observations = Service::new(
        Arc::clone(&pool),
        Arc::clone(&devices),
        Arc::clone(&world.prefs),
        Arc::new(SessionAuthority::open(None)),
        Arc::from("observer-host"),
    );
    let run_child = Arc::clone(&child);
    let run_host = host.clone();
    let run_device = device.clone();
    let run_prefs = Arc::clone(&world.prefs);
    let recipient_tab = world.spawn.tab.clone();
    let disk = world.fixture.dir.join("observed-source.json");
    let failing_file = world.fixture.dir.join("unwritable-source.json");
    std::fs::create_dir(&failing_file).unwrap();
    let outcome = tokio::spawn(async move {
        run_child.start();
        while run_child.facts()["processAlive"] != true {
            delivered.recv().await.unwrap();
        }
        let generation = run_child.generation();
        let feed = |request: Value| {
            pool.feed_captured(
                &child_owner,
                child_tab,
                Arc::clone(&run_child),
                CapturedEvent {
                    generation,
                    name: "extensionUi".into(),
                    payload: json!({"request":request,"kinds":{"blocking":true}}),
                    from_link: false,
                },
            )
        };
        feed(question.clone()).await.unwrap();
        let proof = observations
            .capture(&child_owner, child_tab, &recipient_tab, "actual-question")
            .await
            .unwrap();
        let keeps = Arc::new(AtomicUsize::new(0));
        let keep_count = Arc::clone(&keeps);
        assert!(
            observations
                .capture(&child_owner, child_tab, "another-opener", "actual-question")
                .await
                .is_err()
        );
        let mut changed = question.clone();
        changed["title"] = json!("Changed after capture");
        feed(changed).await.unwrap();
        assert!(
            proof
                .admit(move |_| {
                    keep_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
                .is_err()
        );
        assert_eq!(keeps.load(Ordering::SeqCst), 0);
        feed(question.clone()).await.unwrap();
        pool.call(
            "setTabOpener",
            json!({"tab":child_tab,"opener":child_tab}),
            false,
        )
        .await
        .unwrap();
        assert!(proof.admit(|_| Ok(())).await.is_err());
        pool.call(
            "setTabOpener",
            json!({"tab":child_tab,"opener":recipient_tab}),
            false,
        )
        .await
        .unwrap();
        let mut approval = question.clone();
        approval["title"] = json!("[OMPdesk] Internal approval");
        feed(approval).await.unwrap();
        assert!(
            observations
                .capture(&child_owner, child_tab, &recipient_tab, "actual-question")
                .await
                .is_err()
        );
        feed(question).await.unwrap();
        for (offset, file, expected) in [
            (0, Some(disk.clone()), Some(Persistence::Disk)),
            (1, None, Some(Persistence::Memory)),
            (2, Some(failing_file), None),
        ] {
            let id = 0x6f62_7365_7276_6570 + offset;
            let (port, lines, tx) = crate::agentctl::runtime::tests::native_port(
                id,
                json!({"enabled":true,"deviceId":"observer-host","tabs":[],"windowOf":{}}),
            );
            let control = AgentControl::new(
                Arc::clone(&port),
                Caps::default(),
                &Files {
                    mail_outbox: Some(JournalFile { file }),
                    ..Files::default()
                },
                Tuning::default(),
                crate::agentctl::journal::system_clock(),
            );
            let runtime = start(
                control,
                id,
                RuntimeConfig {
                    sweep_ms: 0,
                    ..RuntimeConfig::default()
                },
            );
            let keeping = Arc::clone(&runtime);
            let result = proof
                .admit(move |card| keeping.keep_observed_card(card))
                .await;
            if let Some(expected) = expected {
                assert_eq!(result.unwrap(), expected);
                let retrying = Arc::clone(&runtime);
                assert_eq!(
                    proof
                        .admit(move |card| retrying.keep_observed_card(card))
                        .await
                        .unwrap(),
                    expected
                );
            } else {
                assert_eq!(result.unwrap_err().code, "observed_card_persistence_failed");
            }
            port.close();
            drop(runtime);
            drop((lines, tx));
        }
        let original = MailOutbox::new(Some(disk.clone())).pending();
        assert_eq!(original.len(), 1);
        assert_eq!(original[0].id, format!("ask-{child_tab}-actual-question"));
        run_prefs.set("agentControl", json!(false)).unwrap();
        assert_eq!(
            proof.admit(|_| Ok(())).await.unwrap_err().code,
            "agent_control_forbidden"
        );
        run_prefs.set("agentControl", json!(true)).unwrap();
        run_host
            .emit(
                "tab.event",
                &json!({"rtab":"source-remote","name":"status","arg":{
                    "status":"ready","processAlive":true,"omp":"replacement-omp"
                }}),
            )
            .unwrap();
        while run_child.generation() == generation {
            delivered.recv().await.unwrap();
        }
        assert!(proof.admit(|_| Ok(())).await.is_err());
        run_device.disconnect_for_test();
        assert!(proof.admit(|_| Ok(())).await.is_err());
        assert_eq!(
            MailOutbox::new(Some(disk)).pending(),
            original,
            "SourceDisk survives the old card and transport"
        );
    })
    .await;
    // Cleanup owns every original handle even when a scenario assertion panics.
    device.disconnect_for_test();
    host.disconnect_for_test();
    let child_closed = child.retire().wait().await;
    let local_closed = recipient.retire().wait().await;
    let factory_closed = factory.close().await;
    let devices_closed = devices.dispose().await;
    let _ = stop.send(());
    let server_closed = server.await;
    world.begin_close();
    let world_closed = world.finish_close().await;
    server_closed.unwrap();
    assert_eq!(child_closed.unwrap_err().code, "remote_offline");
    local_closed.unwrap();
    factory_closed.unwrap();
    devices_closed.unwrap();
    world_closed.unwrap();
    outcome.unwrap();
}
