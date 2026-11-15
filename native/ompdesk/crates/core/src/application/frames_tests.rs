use super::*;
use serde_json::json;

#[derive(Default)]
struct Recorder(Mutex<Vec<(Vec<i64>, &'static str, Value)>>);
impl DeliverySink for Recorder {
    fn deliver(&self, delivery: Delivery) {
        lock(&self.0).push((
            delivery.windows,
            delivery.channel,
            serde_json::to_value(delivery.data).unwrap(),
        ));
    }
}

fn service() -> (Frames, Arc<Recorder>) {
    let sink = Arc::new(Recorder::default());
    (Frames::new(Handle::current(), sink.clone()), sink)
}

fn frame(name: &str) -> Value {
    json!({"type":"subagent_progress","payload":{"id":name}})
}

fn update(text: &str) -> Value {
    json!({"type":"message_update","message":{"role":"assistant","timestamp":1,"content":[{"type":"text","text":text}]},"assistantMessageEvent":{"type":"text_delta","delta":text}})
}

#[tokio::test]
async fn subagent_frames_precede_agent_events_and_reply() {
    let (frames, sink) = service();
    frames.attach("tab", 1, Arc::from("original.1"));
    frames.subagent("tab", frame("first"));
    frames.events("tab", Arc::from([json!({"type":"agent_end"})]));
    frames.subagent("tab", frame("second"));
    frames.flush("tab");
    let mut seen = lock(&sink.0);
    seen.push((vec![1], "REPLY", Value::Null));
    assert_eq!(
        seen.iter().map(|item| item.1).collect::<Vec<_>>(),
        [
            "SUBAGENT_FRAMES",
            "EVENTS_BATCH",
            "SUBAGENT_FRAMES",
            "REPLY"
        ]
    );
}

#[tokio::test]
async fn detach_flushes_to_departing_window() {
    let (frames, sink) = service();
    frames.attach("tab", 1, Arc::from("original.1"));
    frames.attach("tab", 2, Arc::from("original.2"));
    frames.subagent("tab", frame("first"));
    frames.detach("tab", 2);
    frames.forward("tab", "STATUS", json!("ready"));
    let seen = lock(&sink.0);
    assert_eq!(seen[0].0, [1]);
    assert_eq!(seen[1].0, [2]);
    assert_eq!(seen[0].2["payload"][0]["payload"]["id"], "first");
    assert_eq!(seen[1].2["payload"][0]["payload"]["id"], "first");
    assert_eq!(seen[0].2["viewId"], "original.1");
    assert_eq!(seen[1].2["viewId"], "original.2");
    assert_eq!(seen[2].0, [1]);
}

#[tokio::test]
async fn stale_timer_cannot_flush_recreated_tab_or_push_after_close() {
    let (frames, sink) = service();
    frames.attach("tab", 1, Arc::from("original.1"));
    frames.subagent("tab", frame("old"));
    let old = lock(&frames.inner.state).tabs["tab"].timer.unwrap();
    frames.release("tab");
    frames.attach("tab", 2, Arc::from("replacement.2"));
    frames.subagent("tab", frame("new"));
    timer_fired(&Arc::downgrade(&frames.inner), "tab", old);
    assert_eq!(lock(&sink.0).len(), 1);
    frames.flush("tab");
    assert_eq!(lock(&sink.0)[1].0, [2]);
    frames.subagent("tab", frame("closed"));
    let current = lock(&frames.inner.state).tabs["tab"].timer.unwrap();
    frames.close();
    timer_fired(&Arc::downgrade(&frames.inner), "tab", current);
    frames.forward("tab", "STATUS", json!("late"));
    assert_eq!(lock(&sink.0).len(), 2);
}

#[tokio::test]
async fn receiver_slimmer_survives_batches_and_resnapshot_resets_it() {
    let (frames, sink) = service();
    frames.attach("tab", 1, Arc::from("original.1"));
    frames.events("tab", Arc::from([update("first")]));
    frames.events("tab", Arc::from([update("second")]));
    frames.resnapshot("tab", 1);
    frames.events("tab", Arc::from([update("third")]));
    let seen = lock(&sink.0);
    assert_eq!(
        seen[0].2["payload"][0]["message"]["content"][0]["text"],
        "first"
    );
    assert!(seen[1].2["payload"][0]["message"].get("content").is_none());
    assert_eq!(
        seen[2].2["payload"][0]["message"]["content"][0]["text"],
        "third"
    );
}

#[tokio::test(start_paused = true)]
async fn presentation_deadline_delivers_the_waiting_subagent_batch() {
    let (frames, sink) = service();
    frames.attach("tab", 1, Arc::from("original.1"));
    frames.subagent("tab", frame("timed"));
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(31)).await;
    assert!(lock(&sink.0).is_empty());
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(lock(&sink.0)[0].2["payload"][0]["payload"]["id"], "timed");
}

#[tokio::test]
async fn actual_pool_reseed_reannounces_each_original_attachment_with_the_new_epoch() {
    use crate::application::callers::Callers;
    use crate::pool::application::{
        Application,
        effects::Notification,
        native::{
            Config, Service,
            tests::{take_notifications, test_host},
        },
    };
    use crate::worktree_lifecycle::RemovalClaims;

    let callers = Arc::new(Callers::new(0x7669_6577));
    let host = test_host(Arc::clone(&callers));
    let app = Arc::new(Application::new(Arc::clone(&host)));
    let (frames, sink) = service();
    let mut pools = Vec::new();
    let mut original = Vec::new();
    let mut reseeded = Vec::new();
    for (index, epoch) in ["original-core", "reseeded-core"].into_iter().enumerate() {
        let pool = Service::new(
            Config {
                id: 0x7669_6577_706f_6f00 + index as u64,
                view_epoch: epoch.into(),
                layout_version: 1,
                max_former_tab_ids: 8,
                stop_session_wait_ms: 60_000,
                window_tabs_hook: false,
                now_ms: || 1234,
                callers: Arc::clone(&callers),
                removal_claims: RemovalClaims::new(),
            },
            Arc::clone(&app),
        )
        .await
        .unwrap();
        pool.call(
            "seed",
            json!({"tabs": [{
                "tab": "tab", "win": 1, "viewers": [2], "full": [1, 2],
                "status": "ready", "sessionFile": "/isolated/view-source.jsonl"
            }]}),
            false,
        )
        .await
        .unwrap();
        let mut announced = Vec::new();
        for notification in take_notifications(&host) {
            if let Notification::WireFull {
                tab,
                window,
                view_id,
            } = &notification
            {
                assert_eq!(tab, "tab");
                assert!(view_id.starts_with(epoch));
                announced.push((*window, Arc::clone(view_id)));
                assert!(frames.notify(&notification));
            }
        }
        assert_eq!(
            announced
                .iter()
                .map(|(window, _)| *window)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        for (window, token) in &announced {
            let rows = pool
                .call("tabsForWindow", json!({"win": window}), false)
                .await
                .unwrap();
            assert_eq!(rows[0]["viewId"], token.as_ref());
        }
        if index == 0 {
            original = announced;
            frames.subagent("tab", frame("old epoch"));
        } else {
            reseeded = announced;
            frames.forward("tab", "STATUS", json!("new epoch"));
        }
        pools.push(pool);
    }
    for ((window, old), (same_window, new)) in original.iter().zip(&reseeded) {
        assert_eq!(window, same_window);
        assert_ne!(old, new);
        let seen = lock(&sink.0);
        let old_batch = seen
            .iter()
            .find(|item| item.0 == [*window] && item.1 == "SUBAGENT_FRAMES")
            .unwrap();
        assert_eq!(old_batch.2["viewId"], old.as_ref());
        assert_eq!(old_batch.2["payload"][0]["payload"]["id"], "old epoch");
        let current = seen
            .iter()
            .find(|item| item.0 == [*window] && item.1 == "STATUS")
            .unwrap();
        assert_eq!(current.2["viewId"], new.as_ref());
        assert_eq!(current.2["payload"], "new epoch");
    }
    // The existing NativePool host's create/prepare methods panic: a reseed must not spawn a runtime.
    assert!(app.sidecar("tab").is_none());
    frames.close();
    drop(pools);
}
