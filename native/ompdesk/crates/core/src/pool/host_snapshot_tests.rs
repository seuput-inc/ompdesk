use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::FutureExt;
use tokio::sync::oneshot;

use super::*;
use crate::application::source::Source;
use crate::pool::application::native::CapturedEvent;
use crate::pool::application::native::dispatch::tests::Rig;
use crate::pool::application::native::tests::TestHost;

async fn read(
    pool: &Arc<Service<TestHost<Source>>>,
    target: &ExecutionTarget<Source>,
) -> Result<HostSnapshot<Source>, Fault> {
    let pool = Arc::clone(pool);
    let target = target.clone();
    let (reply, answer) = oneshot::channel();
    crate::hub::post(move || {
        let _ = reply.send(pool.host_snapshot_now(&target, None));
    });
    answer.await.unwrap()
}

#[tokio::test]
async fn a_host_reads_the_original_live_execution_on_its_hub_without_a_relay_or_stale_cache() {
    let mut rig = Rig::new("host-snapshot-current", 0x686f7374736e6170).await;
    let result = AssertUnwindSafe(async {
        let target = rig.pool.execution_target(&rig.world.owner, &rig.world.spawn.tab).await.unwrap();
        assert_eq!(rig.pool.host_snapshot_now(&target, None).err().unwrap().code, "native_snapshot_context");
        let asleep = read(&rig.pool, &target).await.unwrap();
        assert!(Arc::ptr_eq(&asleep.selected.sidecar, &rig.source));
        assert_eq!(asleep.selected.generation, 0);
        assert_eq!(asleep.source_facts["status"], "asleep");
        assert_eq!(asleep.source_facts["processAlive"], false);
        rig.source.start();
        let ready = crate::sidecar::native::tests::ready_with(&mut rig.events, |_| None).await;
        let generation = ready.generation;
        let payload = ready.data["payload"].clone();
        rig.pool.feed_captured(&rig.world.owner, &rig.world.spawn.tab, Arc::clone(&rig.source), CapturedEvent {
            generation, name: "status".into(), payload, from_link: false,
        }).await.unwrap();
        let current = read(&rig.pool, &target).await.unwrap();
        assert_eq!(current.selected.generation, generation);
        assert!(generation > asleep.selected.generation);
        assert_eq!(current.source_facts["status"], "ready");
        assert_eq!(current.source_facts["processAlive"], true);
        assert_eq!(current.status_detail["status"], "ready");
        assert_eq!(current.kind, rig.world.spawn.kind);
        assert_eq!(current.selected.session_file.as_deref(), Some(rig.world.unwritten.to_string_lossy().as_ref()));

        let uri_reply = serde_json::json!({"type":"host_uri_result","id":"snapshot-captured-uri","isError":true,"error":"OMPdesk serves no host URI for fixture://original"});
        let sent = rig.pool.source_effect_captured(
            &rig.world.owner, &rig.world.spawn.tab, Arc::clone(&rig.source), generation,
            move |source| Ok(source.send_for_generation(generation, uri_reply)),
        ).await.unwrap();
        sent.await.unwrap();
        rig.source.stock(serde_json::json!({"type":"get_state"})).await.unwrap();
        assert!(rig.world.stdin().iter().any(|frame| frame["type"] == "host_uri_result" && frame["id"] == "snapshot-captured-uri"));
        let refused = rig.pool.source_effect_captured(
            &rig.world.owner, &rig.world.spawn.tab, Arc::clone(&rig.source), generation + 1,
            move |source| Ok(source.send_for_generation(generation, serde_json::json!({"type":"host_uri_result","id":"stale-uri"}))),
        ).await;
        assert_eq!(refused.err().unwrap().code, "tab_stale");
        assert!(!rig.world.stdin().iter().any(|frame| frame["id"] == "stale-uri"));

        rig.world.callers.retire_execution(&rig.world.owner);
        assert!(read(&rig.pool, &target).await.is_err());
        assert_eq!(rig.source.facts()["processAlive"], true, "revocation refused the read rather than killing a different run");
    }).catch_unwind().await;
    rig.close().await;
    if let Err(error) = result { std::panic::resume_unwind(error); }
}

#[tokio::test]
async fn an_observed_event_cannot_be_rebound_to_another_original_source() {
    let mut original = Rig::new("observed-event-original", 0x6f62736572766531).await;
    let observed = AssertUnwindSafe(async {
        original.source.start();
        let ready = crate::sidecar::native::tests::ready_with(&mut original.events, |_| None).await;
        ready.observation.expect("the actual native pump issues its observation")
    }).catch_unwind().await;
    let original_source = Arc::clone(&original.source);
    // World owns the canonical MCP fixture's exclusive port lease: close it before opening another.
    original.close().await;
    let observation = match observed {
        Ok(observation) => observation,
        Err(error) => std::panic::resume_unwind(error),
    };
    let mut other = Rig::new("observed-event-other", 0x6f62736572766532).await;
    let result = AssertUnwindSafe(async {
        other.source.start();
        let ready = crate::sidecar::native::tests::ready_with(&mut other.events, |_| None).await;
        let current = ready.observation.expect("the second original pump issues its own observation");
        let before = other.world.stdin().len();
        let refused = other.pool.source_observation_captured(
            &other.world.owner, &other.world.spawn.tab, Arc::clone(&other.source),
            observation.clone(), |_| -> Result<(), Fault> {
                panic!("a foreign event cannot reach the original-source observer");
            },
        ).await;
        assert_eq!(refused.err().unwrap().code, "tab_stale");
        assert_eq!(other.world.stdin().len(), before);
        let refused = other.pool.feed_observed(
            &other.world.owner, &other.world.spawn.tab, Arc::clone(&other.source),
            CapturedEvent {
                generation: ready.generation + 1,
                name: "extensionUi".into(),
                payload: serde_json::json!({"request":{"id":"foreign-generation-card","method":"ask"},"kinds":{"blocking":true}}),
                from_link: false,
            }, current,
        ).await;
        assert_eq!(refused.err().unwrap().code, "tab_stale");
        let view = other.pool.call("deviceSnapshot", serde_json::json!({"tab":other.world.spawn.tab}), false).await.unwrap();
        assert!(!view["asks"].as_array().unwrap().iter().any(|request| request["id"] == "foreign-generation-card"));
    }).catch_unwind().await;
    other.close().await;
    drop(original_source);
    if let Err(error) = result { std::panic::resume_unwind(error); }
}
