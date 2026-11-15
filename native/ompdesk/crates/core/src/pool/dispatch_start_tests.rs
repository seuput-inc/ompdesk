use super::*;
use crate::pool::application::Sidecar;
use crate::pool::application::native::dispatch::tests::Rig;
use futures_util::FutureExt;
use std::panic::AssertUnwindSafe;

#[tokio::test]
async fn original_source_is_selected_before_start_and_only_its_ready_run_becomes_a_command() {
    let mut rig = Rig::new("pending-command-ready", 0x737461727431).await;
    let result = AssertUnwindSafe(async {
        let pending = rig
            .pool
            .select_page_command(
                rig.caller.clone(),
                Some(rig.world.spawn.tab.clone()),
                Some(Arc::from("rpc:command")),
                Scope::detached(),
            )
            .await
            .unwrap();
        assert!(Arc::ptr_eq(pending.source(), &rig.source));
        assert_eq!(pending.source().generation(), 0);
        rig.ready().await;
        let ready_generation = rig.source.generation();
        let admission = rig.pool.finish_page_command(pending).await.unwrap();
        assert!(Arc::ptr_eq(&admission.selected().sidecar, &rig.source));
        assert_eq!(admission.selected().generation, ready_generation);
        assert!(ready_generation > 0);
        rig.source.restart(None);
        crate::sidecar::native::tests::ready_with(&mut rig.events, |_| None).await;
        assert_ne!(rig.source.generation(), ready_generation);
        assert!(
            admission
                .stock(serde_json::json!({"type":"get_state"}))
                .await
                .is_err()
        );
    })
    .catch_unwind()
    .await;
    rig.close().await;
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[tokio::test]
async fn a_page_revoked_during_original_source_start_cannot_finish_admission() {
    let mut rig = Rig::new("pending-command-revoked", 0x737461727432).await;
    let result = AssertUnwindSafe(async {
        let pending = rig
            .pool
            .select_page_command(
                rig.caller.clone(),
                Some(rig.world.spawn.tab.clone()),
                None,
                Scope::detached(),
            )
            .await
            .unwrap();
        rig.ready().await;
        rig.world
            .callers
            .close_page(&ompdesk_app_contract::NativeCaller::Desktop {
                win_id: 17,
                wc_id: 117,
            });
        assert!(rig.pool.finish_page_command(pending).await.is_err());
        assert_eq!(rig.source.facts()["processAlive"], true);
    })
    .catch_unwind()
    .await;
    rig.close().await;
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[tokio::test]
async fn finishing_an_unstarted_source_neither_starts_it_nor_issues_a_command_grant() {
    let rig = Rig::new("pending-command-asleep", 0x737461727433).await;
    let result = AssertUnwindSafe(async {
        let pending = rig
            .pool
            .select_page_command(
                rig.caller.clone(),
                Some(rig.world.spawn.tab.clone()),
                None,
                Scope::detached(),
            )
            .await
            .unwrap();
        let error = rig.pool.finish_page_command(pending).await.err().unwrap();
        assert_eq!(error.code, "sidecar_not_ready");
        assert_eq!(error.message, "Sidecar not ready (asleep)");
        assert_eq!(rig.source.generation(), 0);
        assert_eq!(rig.source.facts()["status"], "asleep");
        assert_eq!(rig.source.facts()["processAlive"], false);
    })
    .catch_unwind()
    .await;
    rig.close().await;
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
