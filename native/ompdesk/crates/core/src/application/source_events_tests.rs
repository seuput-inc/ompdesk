use super::*;

#[test]
fn outcome_keeps_only_the_last_assistant_text_and_terminal_facts() {
    let projected = project_event(&json!({
        "type": "agent_end", "isTerminal": true, "private": "not a run fact",
        "messages": [
            {"role": "assistant", "content": "old answer"},
            {"role": "toolResult", "content": "tool output"},
            {"role": "assistant", "stopReason": "error", "errorMessage": "actual failure",
             "content": [
                {"type": "thinking", "thinking": "not a summary"},
                {"type": "text", "text": "final", "requestId": "not a run fact"},
                {"type": "image", "data": "not text"}
             ]},
            {"role": "user", "content": "later user"}
        ]
    }));
    assert_eq!(
        projected,
        Some(json!({
            "type": "agent_end", "isTerminal": true,
            "messages": [{"role": "assistant", "stopReason": "error", "errorMessage": "actual failure",
                          "content": [{"type": "text", "text": "final"}]}]
        }))
    );
    assert_eq!(
        project_event(&json!({"type": "agent_end"})),
        Some(json!({"type": "agent_end", "messages": []}))
    );
}

#[test]
fn unsaved_user_summary_concatenates_text_without_attachment_data() {
    assert_eq!(
        project_event(&json!({"type": "message_end", "message": {
            "role": "user", "content": [
                {"type": "text", "text": "one"},
                {"type": "image", "data": "private image"},
                {"type": "text", "text": "two"}
            ]
        }})),
        Some(json!({"type": "message_end", "message": {"role": "user", "text": "onetwo"}}))
    );
    assert_eq!(
        project_event(&json!({"type": "message_end", "message": {
            "role": "assistant", "content": "not a user prompt"
        }})),
        Some(json!({"type": "message_end", "message": {"role": "assistant"}}))
    );
}

#[test]
fn retry_failure_and_plan_details_survive_but_streaming_deltas_do_not_enter_run_rules() {
    let retry = json!({"type": "auto_retry_end", "success": false, "attempt": 3,
                       "finalError": "connection lost", "unrelated": 42});
    assert_eq!(
        project_event(&retry),
        Some(json!({"type": "auto_retry_end", "success": false,
        "attempt": 3, "finalError": "connection lost"}))
    );
    let plan = json!({"type": "plan_proposal", "id": "original-plan", "steps": ["keep"]});
    assert_eq!(project_event(&plan), Some(plan.clone()));
    assert_eq!(
        project_event(&json!({"type": "message_update", "message": "large delta"})),
        None
    );
    assert_eq!(
        project_event(&json!({"type": "tool_execution_end", "result": "large output"})),
        Some(json!({"type": "tool_execution_end"}))
    );
}

#[test]
fn sign_in_notifications_and_blocking_cards_remain_separate() {
    for notify_type in [None, Some(Value::Null), Some(json!("info"))] {
        let mut request = json!({"method": "notify"});
        if let Some(value) = notify_type {
            request["notifyType"] = value;
        }
        assert_eq!(
            request_kinds(&request),
            json!({"blocking": false, "signIn": true, "approval": false})
        );
    }
    for notify_type in [json!("warning"), json!("error"), json!(false)] {
        assert_eq!(
            request_kinds(&json!({"method": "notify", "notifyType": notify_type})),
            json!({"blocking": false, "signIn": false, "approval": false})
        );
    }
    assert_eq!(
        request_kinds(&json!({"method": "input"})),
        json!({"blocking": true, "signIn": true, "approval": false})
    );
    assert_eq!(
        request_kinds(&json!({"method": "ask"})),
        json!({"blocking": true, "signIn": false, "approval": false})
    );
}

#[test]
fn approval_classifier_recognizes_stock_once_remember_and_session_options() {
    for options in [
        json!(["Approve", "Deny"]),
        json!(["Approve", "Approve shell for this session", "Deny"]),
        json!([
            "Approve File",
            "Approve Directory: /workspace",
            "Always Approve File",
            "Always Approve Directory: /workspace",
            "Approve Once",
            "Deny"
        ]),
        json!([
            "Approve",
            "Always Approve",
            "Approve Once",
            "Approve shell for this session",
            "Deny"
        ]),
    ] {
        let request = json!({"method": "select", "title": "Allow tool: shell", "options": options});
        assert_eq!(
            request_kinds(&request),
            json!({"blocking": true, "signIn": false, "approval": true})
        );
    }
}

#[test]
fn ordinary_or_malformed_selects_never_gain_approval_classification() {
    for options in [
        json!([]),
        json!(["Approve"]),
        json!(["Approve Once", "Deny"]),
        json!([
            "Approve File",
            "Always Approve Directory: /workspace",
            "Approve Once",
            "Deny"
        ]),
        json!([
            "Approve Directory: ",
            "Always Approve Directory: ",
            "Approve Once",
            "Deny"
        ]),
        json!(["Approve", "Approve for this session", "Deny"]),
        json!(["Approve File", 1, "Approve Once", "Deny"]),
    ] {
        assert!(!is_approval_select(
            &json!({"method": "select", "title": "Allow tool: shell", "options": options})
        ));
    }
    assert!(!is_approval_select(
        &json!({"method": "confirm", "title": "Allow tool: shell", "options": ["Approve", "Deny"]})
    ));
    assert!(!is_approval_select(
        &json!({"method": "select", "title": "Choose a plan", "options": ["Approve", "Deny"]})
    ));
}

#[tokio::test]
async fn reply_barrier_captures_only_the_original_prefix_and_close_drains_the_rest() {
    use tokio::sync::oneshot;
    let mut pending = Pending::default();
    let (first_started, first_running) = oneshot::channel();
    let (finish_first, first_done) = oneshot::channel();
    pending
        .submit(move || {
            Box::pin(async move {
                first_started.send(()).unwrap();
                first_done.await.unwrap();
                Ok(())
            })
        })
        .unwrap();
    let prefix = pending.barrier();
    let (second_started, second_running) = oneshot::channel();
    let (finish_second, second_done) = oneshot::channel();
    pending
        .submit(move || {
            Box::pin(async move {
                second_started.send(()).unwrap();
                second_done.await.unwrap();
                Ok(())
            })
        })
        .unwrap();
    first_running.await.unwrap();
    finish_first.send(()).unwrap();
    assert_eq!(prefix.await, Ok(()));
    second_running.await.unwrap();
    let closed = pending.close();
    let (unexpected, never_started) = oneshot::channel();
    assert!(
        pending
            .submit(move || Box::pin(async move {
                unexpected.send(()).unwrap();
                Ok(())
            }))
            .is_err()
    );
    assert!(never_started.await.is_err());
    finish_second.send(()).unwrap();
    assert_eq!(closed.await, Ok(()));
    assert_eq!(pending.close().await, Ok(()));
}

#[tokio::test]
async fn losing_a_reply_waiter_does_not_cancel_the_captured_work_or_hide_its_failure() {
    use tokio::sync::oneshot;
    let mut pending = Pending::default();
    let (finish, completed) = oneshot::channel();
    let failure = Fault::new("actual_feed_failure", "The original feed failed");
    let original_failure = failure.clone();
    pending
        .submit(move || {
            Box::pin(async move {
                completed.await.unwrap();
                Err(original_failure)
            })
        })
        .unwrap();
    drop(pending.barrier());
    let (later, observed) = oneshot::channel();
    pending
        .submit(move || {
            Box::pin(async move {
                later.send(()).unwrap();
                Ok(())
            })
        })
        .unwrap();
    finish.send(()).unwrap();
    assert_eq!(pending.close().await, Err(failure.clone()));
    observed.await.unwrap();
    assert_eq!(pending.barrier().await, Err(failure));
}

struct BarrierSink {
    receipt: Mutex<Option<Held>>,
    captured: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    removed: std::sync::atomic::AtomicBool,
}

impl Sink for BarrierSink {
    fn event(&self, _: LaneEvent) {
        panic!("A barrier must not replay a domain event");
    }

    fn before_response(&self) {
        panic!("A barrier must not invoke a response callback");
    }

    fn reply_barrier(&self) -> Held {
        lock(&self.captured).take().unwrap().send(()).unwrap();
        lock(&self.receipt).take().unwrap()
    }

    fn remove_listeners(&self) {
        self.removed
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn sync_settings(&self) -> EffectFuture<'_, ()> {
        panic!("A barrier must not start a settings replay");
    }
}

#[tokio::test]
async fn a_failed_feed_still_joins_the_original_downstream_and_preserves_the_first_fault() {
    use futures_util::FutureExt;
    use tokio::sync::oneshot;
    let mut pending = Pending::default();
    let first = Fault::new("original_feed", "Original feed failure");
    let expected = first.clone();
    pending
        .submit(move || Box::pin(async move { Err(first) }))
        .unwrap();
    let (finish_domain, domain_done) = oneshot::channel();
    let (captured, capture_seen) = oneshot::channel();
    let sink = Arc::new(BarrierSink {
        receipt: Mutex::new(Some(Box::pin(async move {
            domain_done.await.unwrap();
            Err(Fault::new("original_domain", "Original domain failure"))
        }))),
        captured: Mutex::new(Some(captured)),
        removed: std::sync::atomic::AtomicBool::new(false),
    });
    let mut barrier = checkpoint(&mut pending, sink.clone(), true);
    capture_seen.await.unwrap();
    assert!(sink.removed.load(std::sync::atomic::Ordering::SeqCst));
    assert!(barrier.as_mut().now_or_never().is_none());
    finish_domain.send(()).unwrap();
    assert_eq!(barrier.await, Err(expected));
}

#[tokio::test]
async fn a_downstream_checkpoint_does_not_wait_for_a_later_captured_operation() {
    use tokio::sync::oneshot;
    let mut pending = Pending::default();
    let (finish_domain, domain_done) = oneshot::channel();
    let (captured, capture_seen) = oneshot::channel();
    let sink = Arc::new(BarrierSink {
        receipt: Mutex::new(Some(Box::pin(async move {
            domain_done.await.unwrap();
            Ok(())
        }))),
        captured: Mutex::new(Some(captured)),
        removed: std::sync::atomic::AtomicBool::new(false),
    });
    let barrier = checkpoint(&mut pending, sink.clone(), false);
    let (later, later_seen) = oneshot::channel();
    let (finish_later, later_done) = oneshot::channel();
    pending
        .submit(move || {
            Box::pin(async move {
                later.send(()).unwrap();
                later_done.await.unwrap();
                Ok(())
            })
        })
        .unwrap();
    capture_seen.await.unwrap();
    later_seen.await.unwrap();
    assert!(!sink.removed.load(std::sync::atomic::Ordering::SeqCst));
    finish_domain.send(()).unwrap();
    assert_eq!(barrier.await, Ok(()));
    finish_later.send(()).unwrap();
    assert_eq!(pending.close().await, Ok(()));
}

use crate::application::launch_host::tests::concrete::World;
use crate::application::local_sources::LocalSources;
use crate::pool::application::native::tests::{
    TestHost, set_test_source, take_notifications, test_host_for,
};
use crate::pool::application::{Application as PoolApplication, Delivery};
use crate::sidecar::native::tests::{Recorder, ready_with};
use std::sync::atomic::AtomicUsize;
use tokio::sync::mpsc;

struct Deliveries(mpsc::UnboundedSender<Delivery>);

impl super::super::frames::DeliverySink for Deliveries {
    fn deliver(&self, delivery: Delivery) {
        self.0.send(delivery).unwrap();
    }
}

struct OutputRig {
    world: World,
    factory: LocalSources,
    source: Arc<Source>,
    pool: Arc<Pool<TestHost<Source>>>,
    sink: Arc<SourceEvents<TestHost<Source>>>,
    frames: Arc<Frames>,
    events: mpsc::UnboundedReceiver<LaneEvent>,
    deliveries: mpsc::UnboundedReceiver<Delivery>,
}

impl OutputRig {
    async fn new() -> (Self, Result<(), Fault>) {
        let mut world = World::new("source-events-real-output").await;
        world.config.bridge = true;
        let host = test_host_for(Arc::clone(&world.callers), |source: &Source| {
            source.local().map(Arc::as_ref)
        });
        let app = Arc::new(PoolApplication::new(Arc::clone(&host)));
        let pool = Pool::new(
            crate::pool::application::native::Config {
                id: 0x736f_7572_6365_6f75,
                view_epoch: "source-events-real-output".into(),
                layout_version: 1,
                max_former_tab_ids: 8,
                stop_session_wait_ms: 60_000,
                window_tabs_hook: false,
                now_ms: || 100,
                callers: Arc::clone(&world.callers),
                removal_claims: crate::worktree_lifecycle::RemovalClaims::new(),
            },
            Arc::clone(&app),
        )
        .await
        .unwrap();
        let (deliver, deliveries) = mpsc::unbounded_channel();
        let frames = Arc::new(Frames::new(
            tokio::runtime::Handle::current(),
            Arc::new(Deliveries(deliver)),
        ));
        let (events, received) = mpsc::unbounded_channel();
        let sink = SourceEvents::new(Config {
            owner: world.owner.clone(),
            tab: world.spawn.tab.clone(),
            pool: Arc::downgrade(&pool),
            frames: Arc::clone(&frames),
            downstream: Arc::new(Recorder {
                events,
                flushes: AtomicUsize::new(0),
            }),
        });
        let factory = LocalSources::new(world.config.clone());
        let created = factory
            .create(
                &world.spawn,
                "source-events-real-output".into(),
                sink.clone(),
                None,
                Default::default(),
            )
            .unwrap();
        let source = Arc::new(Source::from_local(created));
        sink.event(LaneEvent {
            name: "sidecar.status".into(),
            data: json!({"cmd": 0, "payload": {"status": "asleep", "cwd": world.spawn.cwd}}),
            bin: None,
            generation: source.generation(),
            observation: None,
        });
        pool.call("seed", json!({"tabs": [{
            "tab": world.spawn.tab, "win": 17, "status": "asleep", "sessionFile": world.unwritten,
        }]}), false).await.unwrap();
        set_test_source(&app, &world.spawn.tab, Arc::clone(&source));
        sink.bind(&source).unwrap();
        let admitted = sink.reply_barrier().await;
        pool.call(
            "attachViewer",
            json!({"win": 18, "tab": world.spawn.tab}),
            false,
        )
        .await
        .unwrap();
        let notices = take_notifications(&host);
        let mut wired = false;
        for notice in &notices {
            wired |= frames.notify(notice);
        }
        assert!(wired);
        (
            Self {
                world,
                factory,
                source,
                pool,
                sink,
                frames,
                events: received,
                deliveries,
            },
            admitted,
        )
    }

    async fn close(
        self,
    ) -> (
        Result<(), Fault>,
        Result<(), Fault>,
        Result<(), Fault>,
        Result<(), Fault>,
    ) {
        let source = self.source.retire().wait().await;
        let output = self.sink.close().await;
        let factory = self.factory.close().await;
        self.frames.close();
        self.world.begin_close();
        let world = self.world.finish_close().await;
        (source, output, factory, world)
    }
}

#[tokio::test]
async fn real_child_events_reach_the_original_pool_and_full_view_before_the_external_reply_barrier()
{
    let (mut rig, admitted) = OutputRig::new().await;
    rig.source.start();
    ready_with(&mut rig.events, |_| None).await;
    let ready = rig.sink.reply_barrier().await;
    let original_tab = rig.world.spawn.tab.clone();
    let prompt = rig
        .source
        .stock(json!({"type": "prompt", "message": "real child fixture"}))
        .await;
    // This ordered read follows prompt_result in the same child's pipe; no sleeps or guessed queue drain.
    let after_prompt = rig.source.stock(json!({"type": "get_state"})).await;
    let prompt_barrier = rig.sink.reply_barrier().await;
    let stream = rig.source.stock(json!({"type": "stream"})).await;
    let stream_barrier = rig.sink.reply_barrier().await;
    let snapshot = rig.pool.snapshot().await;
    let mut decoder = Decoder::new();
    let mut delivered_types = Vec::new();
    let mut visible_text = Vec::new();
    let mut ready_status = false;
    while let Ok(delivery) = rig.deliveries.try_recv() {
        if !delivery.windows.contains(&18) {
            continue;
        }
        let data = serde_json::to_value(&delivery.data).unwrap();
        if delivery.channel == "SIDECAR_STATUS" {
            ready_status |= data["payload"]["status"] == "ready";
        }
        if delivery.channel == "EVENTS_BATCH" {
            let batch = data["payload"].as_array().unwrap();
            for event in decoder.events(batch).iter() {
                delivered_types.push(event["type"].as_str().unwrap().to_owned());
                if event["type"] == "message_update" {
                    visible_text.push(
                        event["message"]["content"][0]["text"]
                            .as_str()
                            .unwrap()
                            .to_owned(),
                    );
                }
            }
        }
    }
    let cleanup = rig.close().await;
    assert_eq!(ready, Ok(()));
    assert_eq!(admitted, Ok(()));
    assert!(prompt.is_ok(), "{prompt:?}");
    assert!(after_prompt.is_ok(), "{after_prompt:?}");
    assert_eq!(prompt_barrier, Ok(()));
    assert!(stream.is_ok(), "{stream:?}");
    assert_eq!(stream_barrier, Ok(()));
    assert!(ready_status);
    assert!(delivered_types.iter().any(|kind| kind == "agent_start"));
    assert!(delivered_types.iter().any(|kind| kind == "message_end"));
    assert!(delivered_types.iter().any(|kind| kind == "agent_end"));
    assert_eq!(visible_text, ["a", "ab"]);
    let snapshot = snapshot.unwrap();
    assert_eq!(snapshot[0]["tab"], original_tab);
    assert_eq!(cleanup, (Ok(()), Ok(()), Ok(()), Ok(())));
}

#[tokio::test]
async fn closing_the_original_binding_gate_releases_its_waiters_without_inventing_a_source() {
    use futures_util::FutureExt;
    let (binding, receiver) = watch::channel(Binding::Waiting);
    let mut waiting = original_source(receiver);
    assert!(waiting.as_mut().now_or_never().is_none());
    binding.send_replace(Binding::Closed);
    let error = match waiting.await {
        Ok(_) => panic!("A closed binding must not supply an unrelated source"),
        Err(error) => error,
    };
    assert_eq!(error.code, "source_events_closed");
}
