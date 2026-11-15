use super::*;
use futures_util::FutureExt;
use serde_json::json;
use std::panic::AssertUnwindSafe;
use crate::pool::application::native::dispatch::tests::Rig;
use crate::server::Scope;

#[tokio::test]
async fn resume_waits_for_every_original_move_and_counts_touch_before_last_token_settles() {
    let mut rig = Rig::new("dispatch-moves", 0x6d6f76657331).await;
    let result = AssertUnwindSafe(async {
        rig.ready().await;
        let admission = rig.capture(Scope::detached()).await;
        let target = rig.pool.execution_target(&rig.world.spawn.owner, &rig.world.spawn.tab).await.unwrap();
        let first = rig.pool.begin_move_command(Arc::clone(&admission)).await.unwrap();
        let second = rig.pool.begin_move_command(Arc::clone(&admission)).await.unwrap();
        let mut settled = rig.pool.moves_settled(&target);
        assert!(futures_util::poll!(settled.as_mut()).is_pending());
        first.finish(true).await.unwrap();
        assert!(futures_util::poll!(settled.as_mut()).is_pending());
        let facts = rig.pool.call("resumeFacts", json!({}), false).await.unwrap();
        let original = facts.as_array().unwrap().iter().find(|fact| fact["tabId"] == rig.world.spawn.tab).unwrap();
        assert_eq!(original["touched"], 1);
        let third = rig.pool.begin_move_command(Arc::clone(&admission)).await.unwrap();
        drop(second);
        assert!(futures_util::poll!(settled.as_mut()).is_pending());
        drop(third);
        settled.await.unwrap();
        let cancelled = Scope::detached();
        let stale = rig.capture(cancelled.clone()).await;
        cancelled.cancel();
        assert!(rig.pool.begin_move_command(stale).await.is_err());
        rig.pool.moves_settled(&target).await.unwrap();
    }).catch_unwind().await;
    rig.close().await;
    if let Err(error) = result { std::panic::resume_unwind(error); }
}
